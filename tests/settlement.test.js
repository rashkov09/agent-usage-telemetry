import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NOT_AVAILABLE,
  SETTLEMENT_FAILURE_KINDS,
  SettlementCaptureError,
  SettlementObservationStore,
  captureSettlementObservation,
  createImmediateAfterObservationFromTaskRecord,
  createSettlementObservation,
  deriveSettlementState,
  readSettlementObservations,
} from "../index.js";

const COMPLETED_AT = "2030-01-01T00:00:00.000Z";
const RESET_5H = "2030-01-01T05:00:00.000Z";
const RESET_WEEK = "2030-01-08T00:00:00.000Z";
const CORRELATION = {
  taskId: "task-1",
  runId: "run-1",
  sessionId: "session-1",
  agent: "Sol",
  provider: "OpenAI",
  model: "example-model",
};

function window(windowType, remainingPercent, resetAt, overrides = {}) {
  return {
    window_type: windowType,
    window_id: `${windowType}-window-1`,
    remaining_percent: remainingPercent,
    reset_at: resetAt,
    source: "openclaw.gateway.usage.status",
    quality: "RUNTIME_REPORTED",
    ...overrides,
  };
}

function observation(kind, sequence, at, windows, overrides = {}) {
  const scheduled = kind === "IMMEDIATE_AFTER" ? 0 : sequence === 1 ? 60 : 180;
  return createSettlementObservation({
    observationId: `observation-${sequence}`,
    recordedAt: at,
    ...CORRELATION,
    observationKind: kind,
    sequence,
    scheduledDelaySeconds: scheduled,
    observedDelaySeconds: scheduled,
    observedAt: at,
    windows,
    ...overrides,
  });
}

function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "settlement-observations-"));
  return {
    directory,
    path: join(directory, "records.jsonl"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("immediate, T+60, and T+180 observations remain append-only and settle only on delayed stability", () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    const immediate = observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [
      window("5h", 56, RESET_5H),
      window("weekly", 93, RESET_WEEK),
    ]);
    const plus60 = observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [
      window("5h", 33, RESET_5H),
      window("weekly", 89, RESET_WEEK),
    ]);
    const plus180 = observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
      window("5h", 33, RESET_5H),
      window("weekly", 89, RESET_WEEK),
    ]);
    assert.equal(store.ingest(immediate), true);
    assert.equal(store.ingest(plus60), true);
    assert.equal(store.ingest(plus180), true);
    assert.deepEqual(store.observations.map((item) => item.data.observation_kind), [
      "IMMEDIATE_AFTER", "SETTLEMENT_OBSERVATION", "SETTLEMENT_OBSERVATION",
    ]);
    const settled = deriveSettlementState(store.observations, { taskId: "task-1", runId: "run-1" });
    assert.equal(settled.status, "SETTLED");
    assert.deepEqual(settled.windows.map((item) => [item.window_type, item.remaining_percent]), [
      ["5h", 33], ["weekly", 89],
    ]);
    assert.equal(settled.windows[0].settled_after_seconds, 180);
    assert.equal(settled.task_attributed_capacity_delta, NOT_AVAILABLE);
  } finally {
    temporary.cleanup();
  }
});

test("the current task record capacity_after shape becomes an explicit immediate observation", () => {
  const immediate = createImmediateAfterObservationFromTaskRecord({
    task_id: "run-1",
    session_id: "session-1",
    agent: "Sol",
    provider: "OpenAI",
    model: "example-model",
    finished_at: COMPLETED_AT,
    capacity_after: {
      five_hour_remaining_pct: 56,
      five_hour_reset_at: RESET_5H,
      weekly_remaining_pct: 93,
      weekly_reset_at: RESET_WEEK,
      source: "openclaw.gateway.usage.status",
      provider_native_windows: NOT_AVAILABLE,
    },
  }, {
    observationId: "immediate-from-task-record",
    quality: "RUNTIME_REPORTED",
    windowIds: { "5h": "5h-window-1", weekly: "weekly-window-1" },
  });
  assert.equal(immediate.data.observation_kind, "IMMEDIATE_AFTER");
  assert.deepEqual(immediate.data.windows.map((item) => item.remaining_percent), [56, 93]);
  assert.equal(immediate.data.task_attributed_capacity_delta, NOT_AVAILABLE);
});

test("changing delayed values, reset identity changes, and missing reset fail closed", () => {
  const immediate = observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [window("5h", 56, RESET_5H)]);
  const plus60 = observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [
    window("5h", 34, RESET_5H),
  ]);
  const changing = observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
    window("5h", 33, RESET_5H),
  ]);
  assert.equal(deriveSettlementState([immediate, plus60, changing], CORRELATION).status, NOT_AVAILABLE);
  assert.equal(deriveSettlementState([immediate, plus60, changing], CORRELATION)
    .windows[0].settled_after_seconds, NOT_AVAILABLE);

  const resetChanged = observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
    window("5h", 34, "2030-01-01T10:00:00.000Z", { window_id: "5h-window-2" }),
  ]);
  assert.equal(deriveSettlementState([immediate, plus60, resetChanged], CORRELATION).status, NOT_AVAILABLE);

  const missingReset = observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
    window("5h", 34, NOT_AVAILABLE),
  ]);
  assert.deepEqual(missingReset.data.failure_kinds, ["MISSING_RESET_AT"]);
  assert.equal(deriveSettlementState([immediate, plus60, missingReset], CORRELATION).status, NOT_AVAILABLE);
});

test("a failed T+60 can recover at T+180 but one available delayed observation is not settled", async () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    await captureSettlementObservation({
      store,
      correlation: CORRELATION,
      observationId: "observation-1",
      sequence: 1,
      scheduledDelaySeconds: 60,
      completedAt: COMPLETED_AT,
      now: () => Date.parse("2030-01-01T00:01:00.000Z"),
      captureCapacity: async () => { throw new SettlementCaptureError("TIMEOUT"); },
    });
    await captureSettlementObservation({
      store,
      correlation: CORRELATION,
      observationId: "observation-2",
      sequence: 2,
      scheduledDelaySeconds: 180,
      completedAt: COMPLETED_AT,
      now: () => Date.parse("2030-01-01T00:03:00.000Z"),
      captureCapacity: async () => ({ windows: [window("5h", 33, RESET_5H)] }),
    });
    assert.deepEqual(store.observations[0].data.failure_kinds, ["TIMEOUT"]);
    assert.equal(store.observations[1].data.capture_status, "AVAILABLE");
    assert.equal(deriveSettlementState(store.observations, CORRELATION).status, NOT_AVAILABLE);
  } finally {
    temporary.cleanup();
  }
});

test("all delayed failures remain unavailable and store no raw provider errors", async () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    for (const [index, kind] of ["AUTH_OR_SCOPE", "RATE_LIMIT"].entries()) {
      await captureSettlementObservation({
        store,
        correlation: CORRELATION,
        observationId: `observation-${index + 1}`,
        sequence: index + 1,
        scheduledDelaySeconds: index === 0 ? 60 : 180,
        completedAt: COMPLETED_AT,
        now: () => Date.parse(index === 0 ? "2030-01-01T00:01:00.000Z" : "2030-01-01T00:03:00.000Z"),
        captureCapacity: async () => { throw new SettlementCaptureError(kind); },
      });
    }
    assert.equal(deriveSettlementState(store.observations, CORRELATION).status, NOT_AVAILABLE);
    assert.doesNotMatch(readFileSync(temporary.path, "utf8"), /token|credential|provider exploded/i);
  } finally {
    temporary.cleanup();
  }
});

test("malformed delayed responses append sanitized NOT_AVAILABLE evidence", async () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    const record = await captureSettlementObservation({
      store,
      correlation: CORRELATION,
      observationId: "malformed-observation",
      sequence: 1,
      scheduledDelaySeconds: 60,
      completedAt: COMPLETED_AT,
      now: () => Date.parse("2030-01-01T00:01:00.000Z"),
      captureCapacity: async () => ({ windows: [{ raw_error: "secret provider body" }] }),
    });
    assert.deepEqual(record.data.failure_kinds, ["MALFORMED_RESPONSE"]);
    assert.equal(record.data.capture_status, NOT_AVAILABLE);
    assert.doesNotMatch(readFileSync(temporary.path, "utf8"), /secret provider body|raw_error/);
  } finally {
    temporary.cleanup();
  }
});

test("duplicate replay is idempotent and conflicting duplicate or sequence fails closed", () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    const event = observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [window("5h", 56, RESET_5H)]);
    assert.equal(store.ingest(event), true);
    const bytes = readFileSync(temporary.path, "utf8");
    assert.equal(store.ingest(event), false);
    assert.equal(readFileSync(temporary.path, "utf8"), bytes);
    const conflict = structuredClone(event);
    conflict.data.windows[0].remaining_percent = 55;
    assert.throws(() => store.ingest(conflict), /conflicts with existing evidence/);
    const slotConflict = structuredClone(event);
    slotConflict.observation_id = "different-id";
    assert.throws(() => store.ingest(slotConflict), /slot conflicts/);
  } finally {
    temporary.cleanup();
  }
});

test("out-of-order delivery derives by sequence and reopen preserves evidence", () => {
  const temporary = tempStore();
  try {
    const store = new SettlementObservationStore(temporary.path);
    const plus180 = observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
      window("5h", 33, RESET_5H),
    ]);
    const plus60 = observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [
      window("5h", 33, RESET_5H),
    ]);
    store.ingest(plus180);
    store.ingest(plus60);
    const before = deriveSettlementState(store.observations, CORRELATION);
    const reopened = new SettlementObservationStore(temporary.path);
    assert.deepEqual(deriveSettlementState(reopened.observations, CORRELATION), before);
    assert.deepEqual(before.windows[0].observation_ids, ["observation-1", "observation-2"]);
  } finally {
    temporary.cleanup();
  }
});

test("historical task records load unchanged beside settlement observations", () => {
  const temporary = tempStore();
  try {
    const historical = { task_id: "historical-run", capacity_after: { five_hour_remaining_pct: 56 } };
    writeFileSync(temporary.path, `${JSON.stringify(historical)}\n`, { mode: 0o600 });
    const store = new SettlementObservationStore(temporary.path);
    assert.equal(store.observations.length, 0);
    store.ingest(observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [window("5h", 56, RESET_5H)]));
    assert.equal(readSettlementObservations(temporary.path).length, 1);
    assert.deepEqual(JSON.parse(readFileSync(temporary.path, "utf8").split("\n")[0]), historical);
  } finally {
    temporary.cleanup();
  }
});

test("only T+0 and one delayed observation never settle", () => {
  const records = [
    observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [window("5h", 56, RESET_5H)]),
    observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [
      window("5h", 33, RESET_5H),
    ]),
  ];
  const state = deriveSettlementState(records, CORRELATION);
  assert.equal(state.status, NOT_AVAILABLE);
  assert.equal(state.windows[0].settled_after_seconds, NOT_AVAILABLE);
});

test("fixture retains T+0 and T+120 values without percentage or token inference", () => {
  const records = [
    observation("IMMEDIATE_AFTER", 0, COMPLETED_AT, [
      window("5h", 56, RESET_5H), window("weekly", 93, RESET_WEEK),
    ]),
    observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:02:00.000Z", [
      window("5h", 33, RESET_5H), window("weekly", 89, RESET_WEEK),
    ], { scheduledDelaySeconds: 120, observedDelaySeconds: 120 }),
  ];
  assert.deepEqual(records.map((record) => record.data.windows.map((item) => item.remaining_percent)), [
    [56, 93], [33, 89],
  ]);
  for (const record of records) {
    assert.equal(record.data.task_attributed_capacity_delta, NOT_AVAILABLE);
    assert.equal("observed_consumption_percent" in record.data, false);
    assert.equal("tokens" in record.data, false);
  }
  assert.equal(deriveSettlementState(records, CORRELATION).task_attributed_capacity_delta, NOT_AVAILABLE);
});

test("5h and weekly windows settle independently", () => {
  const records = [
    observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [
      window("5h", 33, RESET_5H), window("weekly", 89, RESET_WEEK),
    ]),
    observation("SETTLEMENT_OBSERVATION", 2, "2030-01-01T00:03:00.000Z", [
      window("5h", 33, RESET_5H), window("weekly", 88, RESET_WEEK),
    ]),
  ];
  const state = deriveSettlementState(records, CORRELATION);
  assert.equal(state.status, NOT_AVAILABLE);
  assert.deepEqual(state.windows.map((item) => [item.window_type, item.status]), [
    ["5h", "SETTLED"], ["weekly", NOT_AVAILABLE],
  ]);
});

test("all explicit fail-closed failure classifications are accepted without raw error fields", () => {
  assert.deepEqual(SETTLEMENT_FAILURE_KINDS, [
    "ENDPOINT_UNAVAILABLE", "TIMEOUT", "AUTH_OR_SCOPE", "RATE_LIMIT",
    "MALFORMED_RESPONSE", "MISSING_REMAINING_PERCENT", "MISSING_RESET_AT",
    "PROCESS_EXIT", "GATEWAY_RESTART",
  ]);
  for (const failureKind of SETTLEMENT_FAILURE_KINDS) {
    const record = observation("SETTLEMENT_OBSERVATION", 1, "2030-01-01T00:01:00.000Z", [], {
      observationId: `failure-${failureKind.toLowerCase()}`,
      failureKinds: [failureKind],
    });
    assert.deepEqual(record.data.failure_kinds, [failureKind]);
    assert.equal(record.data.capture_status, NOT_AVAILABLE);
  }
});

test("settlement JSON Schema is valid JSON and does not mutate lifecycle schema version", () => {
  const settlementSchema = JSON.parse(readFileSync(
    new URL("../schema/settlement-observation.schema.json", import.meta.url),
    "utf8",
  ));
  const lifecycleSchema = JSON.parse(readFileSync(
    new URL("../schema/lifecycle-event.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(settlementSchema.properties.settlement_observation_version.const, 1);
  assert.deepEqual(lifecycleSchema.properties.lifecycle_event_version.enum, [1, 2]);
});
