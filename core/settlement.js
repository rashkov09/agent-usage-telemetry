import { NOT_AVAILABLE } from "./schema.js";

export const SETTLEMENT_OBSERVATION_KINDS = Object.freeze([
  "IMMEDIATE_AFTER",
  "SETTLEMENT_OBSERVATION",
]);

export const SETTLEMENT_FAILURE_KINDS = Object.freeze([
  "ENDPOINT_UNAVAILABLE",
  "TIMEOUT",
  "AUTH_OR_SCOPE",
  "RATE_LIMIT",
  "MALFORMED_RESPONSE",
  "MISSING_REMAINING_PERCENT",
  "MISSING_RESET_AT",
  "PROCESS_EXIT",
  "GATEWAY_RESTART",
]);

const OBSERVED_QUALITIES = new Set([
  "PROVIDER_REPORTED",
  "PROVIDER_CLIENT_REPORTED",
  "RUNTIME_REPORTED",
]);

const WINDOW_KEYS = [
  "window_type", "window_id", "remaining_percent", "reset_at", "source", "quality",
];

const DATA_KEYS = [
  "task_id", "run_id", "session_id", "agent", "provider", "model",
  "observation_kind", "sequence", "scheduled_delay_seconds", "observed_delay_seconds",
  "observed_at", "capture_status", "failure_kinds", "windows",
  "task_attributed_capacity_delta",
];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
  if (missing.length) throw new TypeError(`${label} is missing fields: ${missing.join(", ")}`);
}

function identifier(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(value) ||
      value.startsWith("/") || value.includes("..")) {
    throw new TypeError(`${label} must be a sanitized identifier`);
  }
}

function text(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${label} must be a short sanitized string`);
  }
}

function timestamp(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp${allowUnavailable ? ` or ${NOT_AVAILABLE}` : ""}`);
  }
}

function delay(value, label, { allowUnavailable = false, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    const range = Number.isFinite(maximum) ? ` from 0 through ${maximum}` : " non-negative";
    throw new TypeError(`${label} must be a${range} integer${allowUnavailable ? ` or ${NOT_AVAILABLE}` : ""}`);
  }
}

function percentage(value, label) {
  if (value !== NOT_AVAILABLE && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new TypeError(`${label} must be between 0 and 100 or ${NOT_AVAILABLE}`);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function observationOrder(left, right) {
  return left.data.sequence - right.data.sequence ||
    left.data.observed_at.localeCompare(right.data.observed_at) ||
    left.observation_id.localeCompare(right.observation_id);
}

export function assertSettlementObservation(record) {
  assertObject(record, "settlement observation");
  assertExactKeys(record, [
    "settlement_observation_version", "record_type", "observation_id", "recorded_at", "data",
  ], "settlement observation");
  if (record.settlement_observation_version !== 1) {
    throw new TypeError("settlement_observation_version must be 1");
  }
  if (record.record_type !== "CAPACITY_SETTLEMENT_OBSERVATION") {
    throw new TypeError("record_type must be CAPACITY_SETTLEMENT_OBSERVATION");
  }
  identifier(record.observation_id, "observation_id");
  timestamp(record.recorded_at, "recorded_at");
  assertObject(record.data, "settlement observation data");
  assertExactKeys(record.data, DATA_KEYS, "settlement observation data");

  const data = record.data;
  for (const key of ["task_id", "run_id"]) identifier(data[key], key);
  identifier(data.session_id, "session_id", { allowUnavailable: true });
  for (const key of ["agent", "provider", "model"]) text(data[key], key, { allowUnavailable: true });
  if (!SETTLEMENT_OBSERVATION_KINDS.includes(data.observation_kind)) {
    throw new TypeError("unsupported observation_kind");
  }
  if (!Number.isInteger(data.sequence) || data.sequence < 0 || data.sequence > 3) {
    throw new TypeError("sequence must be an integer from 0 through 3");
  }
  delay(data.scheduled_delay_seconds, "scheduled_delay_seconds", { maximum: 300 });
  delay(data.observed_delay_seconds, "observed_delay_seconds", { allowUnavailable: true });
  timestamp(data.observed_at, "observed_at");
  if (data.observation_kind === "IMMEDIATE_AFTER" && (data.sequence !== 0 || data.scheduled_delay_seconds !== 0)) {
    throw new TypeError("IMMEDIATE_AFTER requires sequence 0 and zero scheduled delay");
  }
  if (data.observation_kind === "SETTLEMENT_OBSERVATION" &&
      (data.sequence < 1 || data.scheduled_delay_seconds < 1)) {
    throw new TypeError("SETTLEMENT_OBSERVATION requires a positive sequence and scheduled delay");
  }
  if (!["AVAILABLE", NOT_AVAILABLE].includes(data.capture_status)) {
    throw new TypeError("capture_status must be AVAILABLE or NOT_AVAILABLE");
  }
  if (!Array.isArray(data.failure_kinds) || new Set(data.failure_kinds).size !== data.failure_kinds.length ||
      data.failure_kinds.some((kind) => !SETTLEMENT_FAILURE_KINDS.includes(kind))) {
    throw new TypeError("failure_kinds must contain unique supported values");
  }
  if (!Array.isArray(data.windows)) throw new TypeError("windows must be an array");
  const windowTypes = new Set();
  for (const window of data.windows) {
    assertObject(window, "settlement capacity window");
    assertExactKeys(window, WINDOW_KEYS, "settlement capacity window");
    text(window.window_type, "window_type");
    if (windowTypes.has(window.window_type)) throw new TypeError("window_type must be unique within an observation");
    windowTypes.add(window.window_type);
    identifier(window.window_id, "window_id", { allowUnavailable: true });
    percentage(window.remaining_percent, "remaining_percent");
    timestamp(window.reset_at, "reset_at", { allowUnavailable: true });
    identifier(window.source, "source", { allowUnavailable: true });
    if (![...OBSERVED_QUALITIES, NOT_AVAILABLE].includes(window.quality)) {
      throw new TypeError("settlement capacity quality must be observed or NOT_AVAILABLE");
    }
  }
  const hasCompleteWindow = data.windows.some((window) =>
    typeof window.remaining_percent === "number" && window.reset_at !== NOT_AVAILABLE &&
    window.source !== NOT_AVAILABLE && OBSERVED_QUALITIES.has(window.quality));
  if ((data.capture_status === "AVAILABLE") !== hasCompleteWindow) {
    throw new TypeError("capture_status AVAILABLE requires at least one complete observed window");
  }
  if (data.task_attributed_capacity_delta !== NOT_AVAILABLE) {
    throw new TypeError("task_attributed_capacity_delta must remain NOT_AVAILABLE without independent COMPLETE evidence");
  }
  return record;
}

function normalizeWindow(window) {
  assertObject(window, "captured capacity window");
  return {
    window_type: window.window_type,
    window_id: window.window_id ?? NOT_AVAILABLE,
    remaining_percent: window.remaining_percent ?? NOT_AVAILABLE,
    reset_at: window.reset_at ?? NOT_AVAILABLE,
    source: window.source ?? NOT_AVAILABLE,
    quality: window.quality ?? NOT_AVAILABLE,
  };
}

function assertCapturedWindow(window) {
  const normalized = normalizeWindow(window);
  text(normalized.window_type, "window_type");
  identifier(normalized.window_id, "window_id", { allowUnavailable: true });
  percentage(normalized.remaining_percent, "remaining_percent");
  timestamp(normalized.reset_at, "reset_at", { allowUnavailable: true });
  identifier(normalized.source, "source", { allowUnavailable: true });
  if (![...OBSERVED_QUALITIES, NOT_AVAILABLE].includes(normalized.quality)) {
    throw new TypeError("settlement capacity quality must be observed or NOT_AVAILABLE");
  }
  return normalized;
}

function missingFailureKinds(windows) {
  const failures = [];
  if (windows.some((window) => window.remaining_percent === NOT_AVAILABLE)) {
    failures.push("MISSING_REMAINING_PERCENT");
  }
  if (windows.some((window) => window.reset_at === NOT_AVAILABLE)) failures.push("MISSING_RESET_AT");
  return failures;
}

export function createSettlementObservation({
  observationId,
  recordedAt,
  taskId,
  runId,
  sessionId = NOT_AVAILABLE,
  agent = NOT_AVAILABLE,
  provider,
  model = NOT_AVAILABLE,
  observationKind,
  sequence,
  scheduledDelaySeconds,
  observedDelaySeconds = NOT_AVAILABLE,
  observedAt,
  windows = [],
  failureKinds = [],
}) {
  const normalizedWindows = windows.map(normalizeWindow);
  const allFailureKinds = [...new Set([...failureKinds, ...missingFailureKinds(normalizedWindows)])].sort();
  const hasCompleteWindow = normalizedWindows.some((window) =>
    typeof window.remaining_percent === "number" && window.reset_at !== NOT_AVAILABLE &&
    window.source !== NOT_AVAILABLE && OBSERVED_QUALITIES.has(window.quality));
  const record = {
    settlement_observation_version: 1,
    record_type: "CAPACITY_SETTLEMENT_OBSERVATION",
    observation_id: observationId,
    recorded_at: recordedAt,
    data: {
      task_id: taskId,
      run_id: runId,
      session_id: sessionId,
      agent,
      provider,
      model,
      observation_kind: observationKind,
      sequence,
      scheduled_delay_seconds: scheduledDelaySeconds,
      observed_delay_seconds: observedDelaySeconds,
      observed_at: observedAt,
      capture_status: hasCompleteWindow ? "AVAILABLE" : NOT_AVAILABLE,
      failure_kinds: allFailureKinds,
      windows: normalizedWindows,
      task_attributed_capacity_delta: NOT_AVAILABLE,
    },
  };
  return assertSettlementObservation(record);
}

export function createImmediateAfterObservationFromTaskRecord(taskRecord, {
  observationId,
  recordedAt = taskRecord?.finished_at,
  observedAt = taskRecord?.finished_at,
  quality = NOT_AVAILABLE,
  windowIds = {},
} = {}) {
  assertObject(taskRecord, "task record");
  const snapshot = taskRecord.capacity_after && typeof taskRecord.capacity_after === "object"
    ? taskRecord.capacity_after
    : {};
  const windows = [
    {
      window_type: "5h",
      window_id: windowIds["5h"] ?? NOT_AVAILABLE,
      remaining_percent: snapshot.five_hour_remaining_pct ?? NOT_AVAILABLE,
      reset_at: snapshot.five_hour_reset_at ?? NOT_AVAILABLE,
      source: snapshot.source ?? NOT_AVAILABLE,
      quality,
    },
    {
      window_type: "weekly",
      window_id: windowIds.weekly ?? NOT_AVAILABLE,
      remaining_percent: snapshot.weekly_remaining_pct ?? NOT_AVAILABLE,
      reset_at: snapshot.weekly_reset_at ?? NOT_AVAILABLE,
      source: snapshot.source ?? NOT_AVAILABLE,
      quality,
    },
  ];
  return createSettlementObservation({
    observationId,
    recordedAt,
    taskId: taskRecord.task_id,
    runId: taskRecord.task_id,
    sessionId: taskRecord.session_id ?? NOT_AVAILABLE,
    agent: taskRecord.agent ?? NOT_AVAILABLE,
    provider: taskRecord.provider ?? NOT_AVAILABLE,
    model: taskRecord.model ?? NOT_AVAILABLE,
    observationKind: "IMMEDIATE_AFTER",
    sequence: 0,
    scheduledDelaySeconds: 0,
    observedDelaySeconds: 0,
    observedAt,
    windows,
  });
}

export class SettlementCaptureError extends Error {
  constructor(kind) {
    if (!SETTLEMENT_FAILURE_KINDS.includes(kind)) throw new TypeError("unsupported settlement failure kind");
    super(kind);
    this.name = "SettlementCaptureError";
    this.kind = kind;
  }
}

export async function captureSettlementObservation({
  store,
  captureCapacity,
  correlation,
  observationId,
  sequence,
  scheduledDelaySeconds,
  completedAt,
  now = () => Date.now(),
}) {
  if (!store || typeof store.ingest !== "function") throw new TypeError("store must support ingest(record)");
  if (typeof captureCapacity !== "function") throw new TypeError("captureCapacity must be a function");
  let windows = [];
  let failureKinds = [];
  try {
    const capture = await captureCapacity();
    if (!capture || typeof capture !== "object" || Array.isArray(capture) || !Array.isArray(capture.windows)) {
      throw new SettlementCaptureError("MALFORMED_RESPONSE");
    }
    try {
      windows = capture.windows.map(assertCapturedWindow);
    } catch {
      throw new SettlementCaptureError("MALFORMED_RESPONSE");
    }
  } catch (error) {
    failureKinds = [error instanceof SettlementCaptureError ? error.kind : "ENDPOINT_UNAVAILABLE"];
  }
  const observedMs = now();
  const observedAt = new Date(observedMs).toISOString();
  const completedMs = Date.parse(completedAt);
  const observedDelaySeconds = Number.isFinite(completedMs)
    ? Math.max(0, Math.round((observedMs - completedMs) / 1000))
    : NOT_AVAILABLE;
  const record = createSettlementObservation({
    observationId,
    recordedAt: observedAt,
    ...correlation,
    observationKind: "SETTLEMENT_OBSERVATION",
    sequence,
    scheduledDelaySeconds,
    observedDelaySeconds,
    observedAt,
    windows,
    failureKinds,
  });
  store.ingest(record);
  return record;
}

function comparable(left, right) {
  if (!left || !right || typeof left.remaining_percent !== "number" ||
      typeof right.remaining_percent !== "number") return false;
  return ["window_type", "window_id", "reset_at", "source", "quality"].every((key) =>
    left[key] !== NOT_AVAILABLE && left[key] === right[key]) &&
    OBSERVED_QUALITIES.has(left.quality) && OBSERVED_QUALITIES.has(right.quality);
}

export function deriveSettlementState(records, { taskId, runId }) {
  const matching = records.filter((record) =>
    record.record_type === "CAPACITY_SETTLEMENT_OBSERVATION" &&
    record.data.task_id === taskId && record.data.run_id === runId).sort(observationOrder);
  const delayed = matching.filter((record) => record.data.observation_kind === "SETTLEMENT_OBSERVATION");
  const allKeys = [...new Set(matching.flatMap((record) => record.data.windows.map((window) =>
    `${record.data.provider}\u0000${window.window_type}`)))].sort();
  const finalPair = delayed.length >= 2 ? delayed.slice(-2) : [];
  const windows = allKeys.map((key) => {
    const [provider, windowType] = key.split("\u0000");
    const previous = finalPair[0]?.data.windows.find((window) => window.window_type === windowType);
    const current = finalPair[1]?.data.windows.find((window) => window.window_type === windowType);
    const previousObservedAt = Date.parse(finalPair[0]?.data.observed_at);
    const currentObservedAt = Date.parse(finalPair[1]?.data.observed_at);
    const resetAt = Date.parse(current?.reset_at);
    const stable = comparable(previous, current) && previous.remaining_percent === current.remaining_percent &&
      finalPair[0].data.provider === provider && finalPair[1].data.provider === provider &&
      previousObservedAt < currentObservedAt && currentObservedAt <= resetAt;
    return {
      provider,
      window_type: windowType,
      status: stable ? "SETTLED" : NOT_AVAILABLE,
      remaining_percent: stable ? current.remaining_percent : NOT_AVAILABLE,
      window_id: stable ? current.window_id : NOT_AVAILABLE,
      reset_at: stable ? current.reset_at : NOT_AVAILABLE,
      source: stable ? current.source : NOT_AVAILABLE,
      quality: stable ? current.quality : NOT_AVAILABLE,
      settled_after_seconds: stable ? finalPair[1].data.observed_delay_seconds : NOT_AVAILABLE,
      observation_ids: stable ? finalPair.map((record) => record.observation_id) : [],
    };
  });
  return {
    task_id: taskId,
    run_id: runId,
    status: windows.length > 0 && windows.every((window) => window.status === "SETTLED")
      ? "SETTLED"
      : NOT_AVAILABLE,
    windows,
    task_attributed_capacity_delta: NOT_AVAILABLE,
  };
}

export function settlementRecordsEqual(left, right) {
  return same(left, right);
}
