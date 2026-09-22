import test from "node:test";
import assert from "node:assert/strict";
import {
  NOT_AVAILABLE,
  buildCalibrationInput,
  buildLifecycleProjection,
  runCapacityEstimator,
} from "../index.js";
import {
  interruptionEvent,
  observationEvent,
  segmentEvent,
  taskEvent,
  windowEvent,
} from "./lifecycle-helpers.js";

test("5h observations and a limit event anchor the matching window", () => {
  const events = [
    taskEvent("capacity-task"),
    windowEvent("five-hour-1", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    observationEvent("before-limit", "five-hour-1", "2030-01-01T01:00:00.000Z", {
      used_percent: 64, remaining_percent: 36, reset_at: "2030-01-01T05:00:00.000Z",
      quality: "PROVIDER_CLIENT_REPORTED", source: "provider-client",
    }),
    interruptionEvent("limit-reached", "capacity-task", "2030-01-01T04:59:00.000Z", "2030-01-01T05:00:00.000Z", "PROVIDER_CAPACITY", {
      reset_at: "2030-01-01T05:00:00.000Z",
    }),
  ];
  const summary = buildLifecycleProjection(events).capacityWindowSummary("five-hour-1");
  assert.deepEqual(summary.observation_ids, ["before-limit"]);
  assert.deepEqual(summary.limit_event_ids, ["limit-reached"]);
});

test("reset creates a distinct 5h window and weekly capacity stays independent", () => {
  const projection = buildLifecycleProjection([
    windowEvent("five-hour-before", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    windowEvent("five-hour-after", "5h", "2030-01-01T05:00:00.000Z", "2030-01-01T10:00:00.000Z"),
    windowEvent("weekly", "weekly", "2030-01-01T00:00:00.000Z", "2030-01-08T00:00:00.000Z"),
    observationEvent("after-reset", "five-hour-after", "2030-01-01T05:01:00.000Z", { remaining_percent: 100 }),
    observationEvent("weekly-observation", "weekly", "2030-01-01T05:01:00.000Z", {
      window_type: "weekly", remaining_percent: 72,
    }),
  ]);
  assert.deepEqual(projection.queryCapacityWindows({ window_type: "5h" }).map((window) => window.window_id), [
    "five-hour-after", "five-hour-before",
  ]);
  assert.deepEqual(projection.capacityWindowSummary("five-hour-before").observation_ids, []);
  assert.deepEqual(projection.capacityWindowSummary("five-hour-after").observation_ids, ["after-reset"]);
  assert.deepEqual(projection.capacityWindowSummary("weekly").observation_ids, ["weekly-observation"]);
});

test("segments crossing a capacity boundary are attributed without invented token splitting", () => {
  const projection = buildLifecycleProjection([
    taskEvent("crossing-task", { completed_at: "2030-01-01T06:00:00.000Z" }),
    windowEvent("crossing-window", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    segmentEvent("contained", "crossing-task", "2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z"),
    segmentEvent("crossing", "crossing-task", "2030-01-01T04:30:00.000Z", "2030-01-01T05:30:00.000Z"),
  ]);
  const summary = projection.capacityWindowSummary("crossing-window");
  assert.deepEqual(summary.overlapping_segment_ids, ["contained", "crossing"]);
  assert.deepEqual(summary.contained_segment_ids, ["contained"]);
  assert.deepEqual(summary.crossing_segment_ids, ["crossing"]);
  assert.equal(summary.input_tokens, NOT_AVAILABLE);
  assert.equal(summary.output_tokens, NOT_AVAILABLE);
});

test("repeated event IDs are idempotent but unrelated identical observations remain distinct", () => {
  const projection = buildLifecycleProjection([
    windowEvent("idempotent-window", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
  ]);
  const first = observationEvent("observation-a", "idempotent-window", "2030-01-01T01:00:00.000Z", { remaining_percent: 50 });
  const second = observationEvent("observation-b", "idempotent-window", "2030-01-01T01:00:00.000Z", { remaining_percent: 50 });
  assert.equal(projection.ingest(first), true);
  assert.equal(projection.ingest(first), false);
  const conflicting = structuredClone(first);
  conflicting.data.remaining_percent = 49;
  assert.throws(() => projection.ingest(conflicting), /conflicts with existing evidence/);
  assert.equal(projection.ingest(second), true);
  assert.deepEqual(projection.capacityWindowSummary("idempotent-window").observation_ids, ["observation-a", "observation-b"]);
});

test("cache, input, and output dimensions remain separate calibration inputs", () => {
  const projection = buildLifecycleProjection([
    taskEvent("dimensions-task", { completed_at: "2030-01-01T05:00:00.000Z" }),
    windowEvent("dimensions-window", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    segmentEvent("dimensions-segment", "dimensions-task", "2030-01-01T01:00:00.000Z", "2030-01-01T02:00:00.000Z", {
      input_tokens: 100, output_tokens: 20, cache_read_tokens: 300, cache_write_tokens: 40,
      total_tokens: 460,
    }),
  ]);
  const input = buildCalibrationInput(projection, "dimensions-window");
  assert.equal(input.input_tokens, 100);
  assert.equal(input.output_tokens, 20);
  assert.equal(input.cache_read_tokens, 300);
  assert.equal(input.cache_write_tokens, 40);
  assert.equal("weighted_tokens" in input, false);
});

test("known limit evidence remains useful without percentages", () => {
  const projection = buildLifecycleProjection([
    taskEvent("limit-only-task"),
    windowEvent("limit-only-window", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    interruptionEvent("limit-only", "limit-only-task", "2030-01-01T04:59:00.000Z", "2030-01-01T05:00:00.000Z", "PROVIDER_CAPACITY", {
      reset_at: "2030-01-01T05:00:00.000Z",
    }),
  ]);
  const input = buildCalibrationInput(projection, "limit-only-window");
  assert.deepEqual(input.capacity_observation_ids, []);
  assert.deepEqual(input.limit_event_ids, ["limit-only"]);
});

test("observed capacity outranks estimates and estimator output is always labeled ESTIMATED", () => {
  const projection = buildLifecycleProjection([
    windowEvent("quality-window", "5h", "2030-01-01T00:00:00.000Z", "2030-01-01T05:00:00.000Z"),
    observationEvent("observed", "quality-window", "2030-01-01T01:00:00.000Z", {
      remaining_percent: 40, quality: "PROVIDER_REPORTED", source: "provider",
    }),
    observationEvent("estimated", "quality-window", "2030-01-01T02:00:00.000Z", {
      remaining_percent: 60, quality: "ESTIMATED", source: "estimator", confidence: 0.5,
    }),
  ]);
  const summary = projection.capacityWindowSummary("quality-window");
  assert.equal(summary.best_observation_id, "observed");
  const estimate = runCapacityEstimator(buildCalibrationInput(projection, "quality-window"), () => ({
    used_percent: 40,
    remaining_percent: 60,
    confidence: 0.25,
    estimator_id: "example-estimator",
  }));
  assert.equal(estimate.quality, "ESTIMATED");
  assert.equal(estimate.confidence, 0.25);
});
