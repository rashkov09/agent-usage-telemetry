import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NOT_AVAILABLE,
  assertLifecycleEvent,
  buildLifecycleProjection,
  readLifecycleEvents,
} from "../index.js";
import { interruptionEvent, segmentEvent, taskEvent } from "./lifecycle-helpers.js";

test("one logical task with one segment has separate lifecycle and execution timing", () => {
  const projection = buildLifecycleProjection([
    taskEvent("one"),
    segmentEvent("one-segment", "one", "2030-01-01T00:10:00.000Z", "2030-01-01T00:20:00.000Z"),
  ]);
  const summary = projection.taskSummary("one");
  assert.equal(summary.segment_ids.length, 1);
  assert.equal(summary.active_execution_seconds, 600);
  assert.equal(summary.other_wait_seconds, 3000);
  assert.equal(summary.total_lead_seconds, 3600);
});

test("one task can span multiple sessions, providers, models, and agents", () => {
  const projection = buildLifecycleProjection([
    taskEvent("multi"),
    segmentEvent("segment-a", "multi", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z"),
    segmentEvent("segment-b", "multi", "2030-01-01T00:20:00.000Z", "2030-01-01T00:30:00.000Z", {
      session_id: "session-b", agent: "agent-b", provider: "provider-b", model: "model-b",
    }),
  ]);
  const summary = projection.taskSummary("multi");
  assert.equal(summary.resumed, true);
  assert.deepEqual(summary.session_ids, ["session-a", "session-b"]);
  assert.deepEqual(summary.providers, ["provider-a", "provider-b"]);
  assert.deepEqual(summary.models, ["model-a", "model-b"]);
  const report = projection.report();
  assert.deepEqual(report.tasks_by_provider, { "provider-a": 1, "provider-b": 1 });
  assert.equal(report.token_dimensions_by_task.multi.input_tokens, 20);
});

test("capacity and no-progress interruptions remain distinct", () => {
  const projection = buildLifecycleProjection([
    taskEvent("interruptions"),
    segmentEvent("before", "interruptions", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z"),
    interruptionEvent("capacity", "interruptions", "2030-01-01T00:10:00.000Z", "2030-01-01T00:40:00.000Z", "PROVIDER_CAPACITY"),
    interruptionEvent("no-progress", "interruptions", "2030-01-01T00:50:00.000Z", "2030-01-01T00:55:00.000Z", "NO_PROGRESS"),
    segmentEvent("after", "interruptions", "2030-01-01T00:40:00.000Z", "2030-01-01T00:50:00.000Z"),
  ]);
  assert.equal(projection.queryInterruptions({ category: "PROVIDER_CAPACITY" }).length, 1);
  assert.equal(projection.queryInterruptions({ category: "NO_PROGRESS" }).length, 1);
  assert.equal(projection.taskSummary("interruptions").capacity_blocked_seconds, 1800);
});

test("same-session resume remains one logical task", () => {
  const projection = buildLifecycleProjection([
    taskEvent("same-session"),
    segmentEvent("same-a", "same-session", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z"),
    segmentEvent("same-b", "same-session", "2030-01-01T00:20:00.000Z", "2030-01-01T00:30:00.000Z"),
  ]);
  const summary = projection.taskSummary("same-session");
  assert.equal(summary.resumed, true);
  assert.deepEqual(summary.session_ids, ["session-a"]);
});

test("missing counters remain NOT_AVAILABLE in task totals", () => {
  const projection = buildLifecycleProjection([
    taskEvent("missing"),
    segmentEvent("known", "missing", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z"),
    segmentEvent("unknown", "missing", "2030-01-01T00:20:00.000Z", "2030-01-01T00:30:00.000Z", {
      input_tokens: NOT_AVAILABLE, output_tokens: NOT_AVAILABLE, cache_read_tokens: NOT_AVAILABLE,
      cache_write_tokens: NOT_AVAILABLE, total_tokens: NOT_AVAILABLE,
      total_tokens_source: NOT_AVAILABLE, usage_scope: "UNKNOWN", usage_quality: "UNKNOWN",
    }),
  ]);
  const summary = projection.taskSummary("missing");
  assert.equal(summary.input_tokens, NOT_AVAILABLE);
  assert.equal(summary.total_tokens, NOT_AVAILABLE);
});

test("active, capacity-blocked, other-wait, and lead arithmetic cannot double count overlaps", () => {
  const projection = buildLifecycleProjection([
    taskEvent("overlap"),
    segmentEvent("overlap-a", "overlap", "2030-01-01T00:00:00.000Z", "2030-01-01T00:30:00.000Z"),
    segmentEvent("overlap-b", "overlap", "2030-01-01T00:20:00.000Z", "2030-01-01T00:40:00.000Z"),
    interruptionEvent("overlap-capacity", "overlap", "2030-01-01T00:35:00.000Z", "2030-01-01T00:50:00.000Z", "PROVIDER_CAPACITY"),
  ]);
  const summary = projection.taskSummary("overlap");
  assert.equal(summary.active_execution_seconds, 2400);
  assert.equal(summary.capacity_blocked_seconds, 600);
  assert.equal(summary.other_wait_seconds, 600);
  assert.equal(summary.total_lead_seconds, 3600);
});

test("terminal and incomplete task queries stay distinct", () => {
  const projection = buildLifecycleProjection([
    taskEvent("done"),
    taskEvent("open", { completed_at: NOT_AVAILABLE, status: "IN_PROGRESS" }),
    segmentEvent("open-segment", "open", "2030-01-01T00:00:00.000Z", NOT_AVAILABLE),
  ]);
  assert.deepEqual(projection.queryTasks({ completed: true }).map((task) => task.task_id), ["done"]);
  assert.deepEqual(projection.queryTasks({ completed: false }).map((task) => task.task_id), ["open"]);
  assert.equal(projection.taskSummary("open").total_lead_seconds, NOT_AVAILABLE);
});

test("terminal logical tasks reject reopening and terminal-status changes", () => {
  const transitions = [
    ["COMPLETED", "IN_PROGRESS"],
    ["COMPLETED", "BLOCKED"],
    ["COMPLETED", "FAILED"],
    ["FAILED", "IN_PROGRESS"],
    ["FAILED", "CANCELLED"],
    ["CANCELLED", "PLANNED"],
  ];

  for (const [from, to] of transitions) {
    const taskId = `${from.toLowerCase()}-to-${to.toLowerCase()}`;
    const initial = taskEvent(taskId, { status: from });
    const update = taskEvent(taskId, {
      status: to,
      completed_at: ["COMPLETED", "FAILED", "CANCELLED"].includes(to)
        ? initial.data.completed_at
        : NOT_AVAILABLE,
    });
    update.event_id = `${taskId}-update`;
    assert.throws(() => buildLifecycleProjection([initial, update]), /terminal state cannot change/, `${from} -> ${to}`);
  }
});

test("terminal logical tasks accept idempotent restatement and compatible metadata fill", () => {
  const initial = taskEvent("terminal-restatement", {
    task_kind: NOT_AVAILABLE,
    project: NOT_AVAILABLE,
    revision: NOT_AVAILABLE,
  });
  const identical = structuredClone(initial);
  identical.event_id = "terminal-restatement-identical";
  const restatement = structuredClone(initial);
  restatement.event_id = "terminal-restatement-metadata";
  restatement.data.task_kind = "implementation";
  restatement.data.project = "example/project";
  restatement.data.revision = "0123456789abcdef0123456789abcdef01234567";

  const projection = buildLifecycleProjection([initial]);
  assert.equal(projection.ingest(identical), true);
  assert.equal(projection.ingest(restatement), true);
  assert.equal(projection.taskSummary("terminal-restatement").status, "COMPLETED");
  assert.equal(projection.taskSummary("terminal-restatement").completed_at, initial.data.completed_at);
  assert.equal(projection.taskSummary("terminal-restatement").task_kind, "implementation");
  assert.equal(projection.taskSummary("terminal-restatement").revision, restatement.data.revision);
});

test("non-terminal logical-task evidence remains ingestion ordered", () => {
  const planned = taskEvent("non-terminal-order", {
    status: "PLANNED",
    started_at: NOT_AVAILABLE,
    completed_at: NOT_AVAILABLE,
  });
  const inProgress = taskEvent("non-terminal-order", {
    status: "IN_PROGRESS",
    completed_at: NOT_AVAILABLE,
  });
  inProgress.event_id = "non-terminal-order-in-progress";

  const projection = buildLifecycleProjection([planned, inProgress]);
  assert.equal(projection.taskSummary("non-terminal-order").status, "IN_PROGRESS");
  assert.equal(projection.taskSummary("non-terminal-order").started_at, inProgress.data.started_at);
});

test("same terminal event replay remains a no-op", () => {
  const event = taskEvent("terminal-replay");
  const projection = buildLifecycleProjection([event]);
  assert.equal(projection.ingest(structuredClone(event)), false);
  assert.equal(projection.eventIds.size, 1);
  assert.equal(projection.taskSummary("terminal-replay").status, "COMPLETED");
});

test("terminal logical tasks reject a changed completed_at", () => {
  const initial = taskEvent("changed-completed-at");
  const update = taskEvent("changed-completed-at", { completed_at: "2030-01-01T02:00:00.000Z" });
  update.event_id = "changed-completed-at-update";
  assert.throws(() => buildLifecycleProjection([initial, update]), /terminal state cannot change/);
});

test("malformed and non-canonical timestamps fail closed", () => {
  const invalid = taskEvent("invalid", { created_at: "not-a-time" });
  assert.throws(() => assertLifecycleEvent(invalid), /ISO-8601/);
  const nonCanonical = taskEvent("noncanonical", { created_at: "2030-01-01T00:00:00Z" });
  assert.throws(() => assertLifecycleEvent(nonCanonical), /canonical UTC/);
});

test("normalized projection fails closed on orphaned task references", () => {
  const segment = segmentEvent("orphan", "missing-task", "2030-01-01T00:00:00.000Z", "2030-01-01T00:10:00.000Z");
  assert.throws(() => buildLifecycleProjection([segment]), /unknown task/);
});

test("Gin #164-shaped sanitized fixture keeps the 2584-second segment below task lead time", () => {
  const path = new URL("./fixtures/gin-164-shaped.jsonl", import.meta.url);
  const projection = buildLifecycleProjection(readLifecycleEvents(path));
  const summary = projection.taskSummary("gin-164");
  assert.equal((Date.parse("2035-01-01T00:43:04.000Z") - Date.parse("2035-01-01T00:00:00.000Z")) / 1000, 2584);
  assert.equal(summary.segment_ids.length, 2);
  assert.equal(summary.total_lead_seconds, 11400);
  assert.equal(summary.active_execution_seconds, 3184);
  assert.equal(summary.capacity_blocked_seconds, 8216);
  assert.equal(summary.input_tokens, NOT_AVAILABLE);
});

test("Jan O2-shaped sanitized fixture preserves one task across capacity and no-progress resumes", () => {
  const path = new URL("./fixtures/jan-o2-review-shaped.jsonl", import.meta.url);
  const projection = buildLifecycleProjection(readLifecycleEvents(path));
  const summary = projection.taskSummary("jan-o2-review");
  assert.equal(summary.revision, "561aa5cbcf10b2ebd0217846f11ebc63a92ac9d3");
  assert.equal(summary.segment_ids.length, 3);
  assert.deepEqual(summary.session_ids, ["review-session"]);
  assert.equal(projection.queryInterruptions({ category: "PROVIDER_CAPACITY" }).length, 1);
  assert.equal(projection.queryInterruptions({ category: "NO_PROGRESS" }).length, 1);
  assert.equal(summary.total_lead_seconds, 25200);
  assert.equal(summary.input_tokens, NOT_AVAILABLE);
});

test("lifecycle JSON Schema is valid JSON and covers every public event kind", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/lifecycle-event.schema.json", import.meta.url), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.properties.event_type.enum, [
    "LOGICAL_TASK", "EXECUTION_SEGMENT", "INTERRUPTION", "CAPACITY_OBSERVATION", "CAPACITY_WINDOW",
  ]);
});
