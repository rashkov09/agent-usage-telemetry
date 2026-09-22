import test from "node:test";
import assert from "node:assert/strict";
import {
  NOT_AVAILABLE,
  buildCalibrationDataset,
  buildLifecycleProjection,
  deriveCapacityDelta,
  estimateCapacity,
  isEstimatorArtifactStale,
  summarizeTaskClassCapacity,
  trainCapacityEstimator,
} from "../index.js";
import {
  interruptionEvent,
  observationEvent,
  segmentEvent,
  taskEvent,
  windowEvent,
} from "./lifecycle-helpers.js";

const RESET = "2030-01-01T05:00:00.000Z";

function endpoint(overrides = {}) {
  return {
    observation_id: "observation",
    provider: "provider-a",
    model: "model-a",
    window_type: "5h",
    window_id: "window-a",
    observed_at: "2030-01-01T01:00:00.000Z",
    remaining_percent: 92,
    reset_at: RESET,
    source: "provider-client",
    quality: "PROVIDER_CLIENT_REPORTED",
    ...overrides,
  };
}

function validIntervalEvents({ secondModel = false, weekly = false, limit = false } = {}) {
  const type = weekly ? "weekly" : "5h";
  const windowId = weekly ? "weekly-window" : "five-hour-window";
  const events = [
    taskEvent("calibration-task", {
      completed_at: "2030-01-01T03:00:00.000Z",
      task_kind: "review",
    }),
    windowEvent(windowId, type, "2030-01-01T00:00:00.000Z", RESET),
    observationEvent("start", windowId, "2030-01-01T00:30:00.000Z", {
      window_type: type,
      remaining_percent: 92,
      reset_at: RESET,
      source: "provider-client",
      quality: "PROVIDER_CLIENT_REPORTED",
    }),
    segmentEvent("segment-a", "calibration-task", "2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z", {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_tokens: 300,
      cache_write_tokens: 40,
      total_tokens: 460,
    }),
    observationEvent("end", windowId, "2030-01-01T02:30:00.000Z", {
      window_type: type,
      remaining_percent: 79,
      reset_at: RESET,
      source: "provider-client",
      quality: "PROVIDER_CLIENT_REPORTED",
    }),
  ];
  if (secondModel) {
    events.splice(-1, 0, segmentEvent(
      "segment-b", "calibration-task", "2030-01-01T02:00:00.000Z", "2030-01-01T02:15:00.000Z",
      { model: "model-b" },
    ));
  }
  if (limit) {
    events.splice(-1, 0, interruptionEvent(
      "capacity-limit", "calibration-task", "2030-01-01T02:20:00.000Z", RESET, "PROVIDER_CAPACITY",
      { reset_at: RESET, source: "provider-client", quality: "PROVIDER_CLIENT_REPORTED" },
    ));
  }
  return events;
}

function trainingSample(index, overrides = {}) {
  const scale = index + 1;
  return {
    sample_id: `sample-${index}`,
    provider: "provider-a",
    model: "model-a",
    model_mix: ["model-a"],
    window_type: "5h",
    window_id: `window-${index}`,
    observed_consumption_percent: scale * 2,
    input_tokens: scale * 100,
    output_tokens: scale * 10,
    cache_read_tokens: scale * 50,
    cache_write_tokens: scale * 5,
    active_execution_seconds: scale * 60,
    task_count: 1,
    task_class: "review",
    usable_for_single_model_estimator: true,
    ...overrides,
  };
}

const scope = { provider: "provider-a", model: "model-a", window_type: "5h" };

test("compatible observed endpoints produce one derived calibration sample", () => {
  const dataset = buildCalibrationDataset(buildLifecycleProjection(validIntervalEvents()));
  assert.equal(dataset.samples.length, 1);
  const sample = dataset.samples[0];
  assert.equal(sample.endpoint_evidence_class, "OBSERVED");
  assert.equal(sample.consumption_evidence_class, "DERIVED");
  assert.equal(sample.observed_consumption_percent, 13);
  assert.equal(sample.segment_count, 1);
  assert.equal(sample.task_count, 1);
});

test("incompatible window IDs and reset boundaries are rejected", () => {
  const start = endpoint();
  assert.equal(deriveCapacityDelta(start, endpoint({ window_id: "window-b", observed_at: "2030-01-01T02:00:00.000Z" })).reason, "INCOMPATIBLE_WINDOWS");
  assert.equal(deriveCapacityDelta(start, endpoint({ reset_at: "2030-01-01T06:00:00.000Z", observed_at: "2030-01-01T02:00:00.000Z" })).reason, "INCOMPATIBLE_WINDOWS");
  assert.equal(deriveCapacityDelta(start, endpoint({ observed_at: "2030-01-01T05:00:01.000Z", remaining_percent: 70 })).reason, "INCOMPATIBLE_WINDOWS");
});

test("NOT_AVAILABLE and estimated endpoints cannot create a derived label", () => {
  const start = endpoint();
  assert.equal(deriveCapacityDelta(start, endpoint({ observed_at: "2030-01-01T02:00:00.000Z", remaining_percent: NOT_AVAILABLE })).reason, "NO_CAPACITY_LABELS");
  assert.equal(deriveCapacityDelta(start, endpoint({ observed_at: "2030-01-01T02:00:00.000Z", quality: "ESTIMATED" })).reason, "NO_CAPACITY_LABELS");
});

test("token dimensions remain separate and cache-read never becomes input", () => {
  const sample = buildCalibrationDataset(buildLifecycleProjection(validIntervalEvents())).samples[0];
  assert.equal(sample.input_tokens, 100);
  assert.equal(sample.output_tokens, 20);
  assert.equal(sample.cache_read_tokens, 300);
  assert.equal(sample.cache_write_tokens, 40);
  assert.equal("weighted_tokens" in sample, false);
});

test("multi-model intervals preserve model mix and are unusable for a single-model estimator", () => {
  const sample = buildCalibrationDataset(buildLifecycleProjection(validIntervalEvents({ secondModel: true }))).samples[0];
  assert.equal(sample.model, NOT_AVAILABLE);
  assert.deepEqual(sample.model_mix, ["model-a", "model-b"]);
  assert.equal(sample.usable_for_single_model_estimator, false);
  assert.equal(sample.unusable_reason, "MODEL_MIX_UNRESOLVED");
});

test("5h and weekly samples never train the same model", () => {
  const fiveHour = Array.from({ length: 8 }, (_, index) => trainingSample(index));
  const weekly = Array.from({ length: 8 }, (_, index) => trainingSample(index + 20, {
    sample_id: `weekly-${index}`,
    window_id: `weekly-window-${index}`,
    window_type: "weekly",
  }));
  const artifact = trainCapacityEstimator([...fiveHour, ...weekly], scope);
  assert.equal(artifact.sample_count, 8);
  assert.equal(artifact.window_type, "5h");
});

test("a real capacity-limit event remains an observed anchor without becoming 100 percent", () => {
  const dataset = buildCalibrationDataset(buildLifecycleProjection(validIntervalEvents({ limit: true })));
  assert.equal(dataset.samples[0].capacity_limit_reached, true);
  assert.equal(dataset.capacity_limit_anchors.length, 1);
  assert.equal(dataset.capacity_limit_anchors[0].evidence_class, "OBSERVED");
  assert.equal(dataset.capacity_limit_anchors[0].quota_exhaustion_percent, NOT_AVAILABLE);
});

test("insufficient independent samples produce a machine-readable NOT_AVAILABLE result", () => {
  const artifact = trainCapacityEstimator([trainingSample(0), trainingSample(1)], scope);
  assert.equal(artifact.availability, NOT_AVAILABLE);
  assert.equal(artifact.reason, "INSUFFICIENT_SAMPLES");
  const attemptedBypass = trainCapacityEstimator([trainingSample(0), trainingSample(1)], scope, {
    minimumIndependentWindows: 1,
  });
  assert.equal(attemptedBypass.availability, NOT_AVAILABLE);
  assert.equal(attemptedBypass.minimum_independent_windows, 8);
});

test("estimates cannot masquerade as observations and confidence is deterministic", () => {
  const samples = Array.from({ length: 8 }, (_, index) => trainingSample(index));
  const first = trainCapacityEstimator(samples, scope);
  const second = trainCapacityEstimator([...samples].reverse(), scope);
  assert.deepEqual(first, second);
  assert.equal(first.confidence, "LOW");
  const result = estimateCapacity(first, {
    ...scope,
    baseline_remaining_percent: 50,
    observed_remaining_percent: 32,
    workload: trainingSample(2),
    generated_at: "2030-01-02T00:00:00.000Z",
  });
  assert.equal(result.observed.source, "OBSERVED");
  assert.equal(result.observed.remaining_percent, 32);
  assert.equal(result.estimated.source, "ESTIMATED");
  assert.equal(result.confidence, "LOW");
});

test("validation is leave-one-window-out and excludes each held-out window", () => {
  const artifact = trainCapacityEstimator(Array.from({ length: 8 }, (_, index) => trainingSample(index)), scope);
  assert.equal(artifact.validation_error.method, "LEAVE_ONE_WINDOW_OUT");
  assert.equal(artifact.validation_error.sample_count, 8);
});

test("duplicate and out-of-order evidence rebuild to the identical dataset", () => {
  const events = validIntervalEvents();
  const ordered = buildCalibrationDataset(buildLifecycleProjection(events));
  const outOfOrder = buildCalibrationDataset(buildLifecycleProjection([
    events[0], events[1], events[4], events[3], events[2],
  ]));
  const duplicate = buildCalibrationDataset(buildLifecycleProjection([...events, events[2], events[4]]));
  assert.deepEqual(outOfOrder, ordered);
  assert.deepEqual(duplicate, ordered);
});

test("persisted estimator identity detects stale training data", () => {
  const samples = Array.from({ length: 8 }, (_, index) => trainingSample(index));
  const artifact = trainCapacityEstimator(samples, scope);
  assert.equal(isEstimatorArtifactStale(artifact, samples), false);
  assert.equal(isEstimatorArtifactStale(artifact, [...samples, trainingSample(9)]), true);
});

test("task-class aggregation stays unavailable until independent evidence exists", () => {
  const insufficient = summarizeTaskClassCapacity([trainingSample(0), trainingSample(1)], scope, "review");
  assert.equal(insufficient.availability, NOT_AVAILABLE);
  assert.equal(insufficient.reason, "INSUFFICIENT_SAMPLES");
  const available = summarizeTaskClassCapacity(Array.from({ length: 3 }, (_, index) => trainingSample(index)), scope, "review");
  assert.equal(available.availability, "AVAILABLE");
  assert.equal(available.source, "DERIVED");
  assert.equal(available.confidence, "LOW");
});

test("provider or model mismatch is rejected", () => {
  const artifact = trainCapacityEstimator(Array.from({ length: 8 }, (_, index) => trainingSample(index)), scope);
  const result = estimateCapacity(artifact, {
    ...scope,
    model: "model-b",
    baseline_remaining_percent: 50,
    workload: trainingSample(2),
  });
  assert.equal(result.availability, NOT_AVAILABLE);
  assert.equal(result.reason, "PROVIDER_MODEL_MISMATCH");
});
