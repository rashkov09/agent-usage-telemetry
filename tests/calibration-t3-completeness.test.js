import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPACITY_ESTIMATOR_VERSION,
  NOT_AVAILABLE,
  buildCalibrationDataset,
  buildLifecycleProjection,
  estimateCapacity,
  isEstimatorArtifactStale,
  summarizeTaskClassCapacity,
  trainCapacityEstimator,
} from "../index.js";
import {
  intervalEvidenceEvent,
  observationEvent,
  segmentEvent,
  taskEvent,
  windowEvent,
} from "./lifecycle-helpers.js";

const RESET = "2030-01-01T05:00:00.000Z";
const scope = { provider: "provider-a", model: "model-a", window_type: "5h" };

function intervalEvents({ evidence = [], extra = [], endRemaining = 1 } = {}) {
  return [
    taskEvent("guard-task", { completed_at: "2030-01-01T03:00:00.000Z", task_kind: "review" }),
    windowEvent("guard-window", "5h", "2030-01-01T00:00:00.000Z", RESET),
    observationEvent("guard-start", "guard-window", "2030-01-01T00:30:00.000Z", {
      remaining_percent: 100,
      reset_at: RESET,
      source: "provider-client",
      quality: "PROVIDER_CLIENT_REPORTED",
    }),
    segmentEvent("guard-segment", "guard-task", "2030-01-01T01:00:00.000Z", "2030-01-01T01:00:01.000Z"),
    ...extra,
    observationEvent("guard-end", "guard-window", "2030-01-01T02:30:00.000Z", {
      remaining_percent: endRemaining,
      reset_at: RESET,
      source: "provider-client",
      quality: "PROVIDER_CLIENT_REPORTED",
    }),
    ...evidence,
  ];
}

function declaredEvidence(id, status, causes) {
  return intervalEvidenceEvent(id, "guard-window", "guard-start", "guard-end", {
    status,
    causes,
    source: status === NOT_AVAILABLE ? NOT_AVAILABLE : "account-activity-ledger",
    quality: status === NOT_AVAILABLE ? NOT_AVAILABLE : "RUNTIME_REPORTED",
  });
}

function estimatorSample(index, overrides = {}) {
  const scale = index + 1;
  return {
    sample_id: `complete-${index}`,
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
    active_execution_seconds: scale,
    task_count: 1,
    task_class: "review",
    attribution_completeness: "COMPLETE",
    attribution_completeness_causes: [],
    attribution_evidence_ids: [`evidence-${index}`],
    attribution_evidence_sources: ["account-activity-ledger"],
    attribution_evidence_qualities: ["RUNTIME_REPORTED"],
    usable_for_single_model_estimator: true,
    unusable_reason: NOT_AVAILABLE,
    ...overrides,
  };
}

test("historical intervals without completeness evidence remain NOT_AVAILABLE", () => {
  const dataset = buildCalibrationDataset(buildLifecycleProjection(intervalEvents()));
  assert.equal(dataset.calibration_dataset_version, 2);
  assert.equal(dataset.samples.length, 1);
  assert.equal(dataset.samples[0].attribution_completeness, NOT_AVAILABLE);
  assert.deepEqual(dataset.samples[0].attribution_completeness_causes, ["EVIDENCE_NOT_RECORDED"]);
  assert.equal(dataset.samples[0].usable_for_single_model_estimator, false);
  assert.equal(dataset.samples[0].unusable_reason, "EVIDENCE_COMPLETENESS_NOT_AVAILABLE");
});

test("large capacity drift with tiny recorded coverage fails closed without a percentage threshold", () => {
  const evidence = declaredEvidence("large-drift", "INCOMPLETE", [
    "IDLE_GAP_CONSUMPTION",
    "UNEXPLAINED_CAPACITY_DRIFT",
  ]);
  const dataset = buildCalibrationDataset(buildLifecycleProjection(intervalEvents({ evidence: [evidence] })));
  const sample = dataset.samples[0];
  assert.equal(sample.observed_consumption_percent, 99);
  assert.equal(sample.active_execution_seconds, 1);
  assert.equal(sample.attribution_completeness, "INCOMPLETE");
  assert.equal(sample.usable_for_single_model_estimator, false);
  assert.equal(trainCapacityEstimator(dataset.samples, scope).reason, "EVIDENCE_INCOMPLETE");
});

test("all named non-task activity classes remain qualitative INCOMPLETE evidence", () => {
  const causes = [
    "CONCURRENT_SAME_ACCOUNT_EXECUTION",
    "DIRECT_PROVIDER_CALL",
    "HEARTBEAT_ACTIVITY",
    "BACKGROUND_ACTIVITY",
    "OTHER_SESSION_ACTIVITY",
    "RETRY_OR_PROVIDER_OVERHEAD",
    "OUTSIDE_OPENCLAW_ACTIVITY",
    "IDLE_GAP_CONSUMPTION",
    "UNEXPLAINED_CAPACITY_DRIFT",
  ];
  const evidence = causes.map((cause, index) => declaredEvidence(`cause-${index}`, "INCOMPLETE", [cause]));
  const sample = buildCalibrationDataset(buildLifecycleProjection(intervalEvents({ evidence }))).samples[0];
  assert.equal(sample.attribution_completeness, "INCOMPLETE");
  assert.deepEqual(sample.attribution_completeness_causes, [...causes].sort());
  assert.equal("unexplained_residual_percent" in sample, false);
});

test("representable concurrent same-account execution cannot become task-attributed training data", () => {
  const extra = [
    taskEvent("concurrent-task", { completed_at: "2030-01-01T03:00:00.000Z" }),
    segmentEvent("concurrent-segment", "concurrent-task", "2030-01-01T01:30:00.000Z", "2030-01-01T01:45:00.000Z"),
  ];
  const evidence = [declaredEvidence("concurrent", "INCOMPLETE", ["CONCURRENT_SAME_ACCOUNT_EXECUTION"])];
  const sample = buildCalibrationDataset(buildLifecycleProjection(intervalEvents({ extra, evidence }))).samples[0];
  assert.equal(sample.task_count, 2);
  assert.equal(sample.attribution_completeness, "INCOMPLETE");
  assert.equal(sample.usable_for_single_model_estimator, false);
});

test("a COMPLETE producer determination is usable and active time stays diagnostic", () => {
  const evidence = [declaredEvidence("complete", "COMPLETE", [])];
  const sample = buildCalibrationDataset(buildLifecycleProjection(intervalEvents({ evidence, endRemaining: 87 }))).samples[0];
  assert.equal(sample.attribution_completeness, "COMPLETE");
  assert.equal(sample.usable_for_single_model_estimator, true);
  assert.equal(sample.active_execution_seconds, 1);

  const artifact = trainCapacityEstimator(Array.from({ length: 8 }, (_, index) => estimatorSample(index)), scope);
  assert.equal(artifact.availability, "AVAILABLE");
  assert.deepEqual(artifact.feature_names, [
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
  ]);
  assert.equal(artifact.feature_names.includes("active_execution_seconds"), false);
});

test("unknown plus replayed COMPLETE evidence cannot upgrade interval completeness", () => {
  const unknown = declaredEvidence("unknown", NOT_AVAILABLE, ["PRODUCER_CANNOT_DETERMINE"]);
  const complete = declaredEvidence("later-complete", "COMPLETE", []);
  const events = intervalEvents({ evidence: [unknown, complete] });
  const projection = buildLifecycleProjection(events);
  assert.equal(projection.ingest(structuredClone(complete)), false);
  const sample = buildCalibrationDataset(projection).samples[0];
  assert.equal(sample.attribution_completeness, NOT_AVAILABLE);
  assert.deepEqual(sample.attribution_evidence_ids, ["later-complete", "unknown"]);
  assert.equal(sample.usable_for_single_model_estimator, false);
});

test("malformed or estimated completeness declarations fail closed", () => {
  const versionOne = declaredEvidence("version-one", "COMPLETE", []);
  versionOne.lifecycle_event_version = 1;
  assert.throws(() => buildLifecycleProjection(intervalEvents({ evidence: [versionOne] })), /requires lifecycle_event_version 2/);

  const completeWithCause = declaredEvidence("complete-with-cause", "COMPLETE", ["BACKGROUND_ACTIVITY"]);
  assert.throws(() => buildLifecycleProjection(intervalEvents({ evidence: [completeWithCause] })), /COMPLETE requires no causes/);

  const incompleteWithoutCause = declaredEvidence("incomplete-without-cause", "INCOMPLETE", []);
  assert.throws(() => buildLifecycleProjection(intervalEvents({ evidence: [incompleteWithoutCause] })), /non-complete evidence requires at least one cause/);

  const estimated = declaredEvidence("estimated", "COMPLETE", []);
  estimated.data.quality = "ESTIMATED";
  assert.throws(() => buildLifecycleProjection(intervalEvents({ evidence: [estimated] })), /cannot be estimated/);
});

test("rejected windows cannot raise estimator or task-class confidence", () => {
  const complete = Array.from({ length: 8 }, (_, index) => estimatorSample(index));
  const rejected = Array.from({ length: 20 }, (_, index) => estimatorSample(index + 100, {
    attribution_completeness: "INCOMPLETE",
    attribution_completeness_causes: ["UNEXPLAINED_CAPACITY_DRIFT"],
    usable_for_single_model_estimator: false,
    unusable_reason: "EVIDENCE_INCOMPLETE",
  }));
  assert.deepEqual(trainCapacityEstimator([...complete, ...rejected], scope), trainCapacityEstimator(complete, scope));
  assert.deepEqual(
    summarizeTaskClassCapacity([...complete, ...rejected], scope, "review"),
    summarizeTaskClassCapacity(complete, scope, "review"),
  );
});

test("Jan-shaped historical sample class is entirely ineligible without new producer evidence", () => {
  const historical = Array.from({ length: 145 }, (_, index) => {
    const sample = estimatorSample(index, { window_id: `historical-window-${index % 21}` });
    delete sample.attribution_completeness;
    delete sample.attribution_completeness_causes;
    delete sample.attribution_evidence_ids;
    delete sample.attribution_evidence_sources;
    delete sample.attribution_evidence_qualities;
    return sample;
  });
  const artifact = trainCapacityEstimator(historical, scope);
  assert.equal(artifact.availability, NOT_AVAILABLE);
  assert.equal(artifact.reason, "EVIDENCE_COMPLETENESS_NOT_AVAILABLE");
  assert.equal(artifact.sample_count, 0);
  assert.equal(artifact.independent_window_count, 0);
  const taskClass = summarizeTaskClassCapacity(historical, scope, "review");
  assert.equal(taskClass.availability, NOT_AVAILABLE);
  assert.equal(taskClass.reason, "EVIDENCE_COMPLETENESS_NOT_AVAILABLE");
});

test("T2 artifacts and completeness-free samples are stale under T3", () => {
  const complete = Array.from({ length: 8 }, (_, index) => estimatorSample(index));
  const artifact = trainCapacityEstimator(complete, scope);
  const t2Artifact = { ...artifact, model_version: "t2-nnls-v1" };
  assert.equal(CAPACITY_ESTIMATOR_VERSION, "t3-complete-evidence-nnls-v1");
  assert.equal(isEstimatorArtifactStale(t2Artifact, complete), true);
  const result = estimateCapacity(t2Artifact, {
    ...scope,
    baseline_remaining_percent: 50,
    workload: estimatorSample(1),
  });
  assert.equal(result.availability, NOT_AVAILABLE);
  assert.equal(result.reason, "STALE_MODEL");
});
