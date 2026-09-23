import { NOT_AVAILABLE } from "./schema.js";

export const LIFECYCLE_EVENT_TYPES = Object.freeze([
  "LOGICAL_TASK",
  "EXECUTION_SEGMENT",
  "INTERRUPTION",
  "CAPACITY_OBSERVATION",
  "CAPACITY_WINDOW",
  "CAPACITY_INTERVAL_EVIDENCE",
]);

export const CAPACITY_COMPLETENESS_STATES = Object.freeze([
  "COMPLETE", "INCOMPLETE", NOT_AVAILABLE,
]);

export const CAPACITY_COMPLETENESS_CAUSES = Object.freeze([
  "CONCURRENT_SAME_ACCOUNT_EXECUTION",
  "DIRECT_PROVIDER_CALL",
  "HEARTBEAT_ACTIVITY",
  "BACKGROUND_ACTIVITY",
  "OTHER_SESSION_ACTIVITY",
  "RETRY_OR_PROVIDER_OVERHEAD",
  "OUTSIDE_OPENCLAW_ACTIVITY",
  "IDLE_GAP_CONSUMPTION",
  "UNEXPLAINED_CAPACITY_DRIFT",
  "OPEN_SEGMENT",
  "PROVIDER_NOT_AVAILABLE",
  "MODEL_NOT_AVAILABLE",
  "EVIDENCE_NOT_RECORDED",
  "PRODUCER_CANNOT_DETERMINE",
]);

export const TASK_STATUSES = Object.freeze([
  "PLANNED", "IN_PROGRESS", "BLOCKED", "WAITING", "COMPLETED", "FAILED", "CANCELLED",
]);

export const SEGMENT_OUTCOMES = Object.freeze([
  "IN_PROGRESS", "SUCCEEDED", "FAILED", "INTERRUPTED", "CANCELLED", "UNKNOWN",
]);

export const INTERRUPTION_EVENT_CATEGORIES = Object.freeze([
  "PROVIDER_CAPACITY",
  "PROVIDER_ERROR",
  "SESSION_INTERRUPTED",
  "NO_PROGRESS",
  "TOOL_FAILURE",
  "OWNER_WAIT",
  "UNKNOWN",
]);

export const EVIDENCE_QUALITIES = Object.freeze([
  "PROVIDER_REPORTED",
  "PROVIDER_CLIENT_REPORTED",
  "RUNTIME_REPORTED",
  "ESTIMATED",
  NOT_AVAILABLE,
]);

export const USAGE_SCOPES = Object.freeze(["SEGMENT", "TASK", "SESSION", "UNKNOWN"]);
export const USAGE_QUALITIES = Object.freeze(["EXACT", "PARTIAL", "UNKNOWN"]);

const TASK_KEYS = [
  "task_id", "created_at", "started_at", "completed_at", "status", "task_kind",
  "project", "revision",
];
const SEGMENT_KEYS = [
  "segment_id", "task_id", "run_id", "session_id", "agent", "provider", "model",
  "started_at", "ended_at", "outcome", "input_tokens", "output_tokens",
  "cache_read_tokens", "cache_write_tokens", "total_tokens", "total_tokens_source",
  "usage_scope", "usage_quality",
];
const INTERRUPTION_KEYS = [
  "task_id", "segment_id", "occurred_at", "ended_at", "provider", "model", "category",
  "reset_at", "resume_session_id", "source", "quality",
];
const OBSERVATION_KEYS = [
  "observation_id", "task_id", "segment_id", "window_id", "provider", "model",
  "window_type", "observed_at", "used_percent", "remaining_percent", "reset_at",
  "source", "quality", "confidence",
];
const WINDOW_KEYS = [
  "window_id", "provider", "model", "window_type", "started_at", "reset_at", "ended_at",
  "source", "quality",
];
const INTERVAL_EVIDENCE_KEYS = [
  "evidence_id", "window_id", "start_observation_id", "end_observation_id",
  "status", "causes", "source", "quality",
];

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, keys, label) {
  const expected = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !(key in value));
  if (unexpected.length) throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(", ")}`);
  if (missing.length) throw new TypeError(`${label} is missing fields: ${missing.join(", ")}`);
}

function assertIdentifier(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,199}$/.test(value)) {
    throw new TypeError(`${label} must be a sanitized identifier`);
  }
  if (value.startsWith("/") || value.includes("..")) {
    throw new TypeError(`${label} must not contain an absolute or parent path`);
  }
}

function assertText(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${label} must be a short sanitized string`);
  }
}

function timestamp(value, label, { allowUnavailable = false } = {}) {
  if (allowUnavailable && value === NOT_AVAILABLE) return;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be an ISO-8601 timestamp${allowUnavailable ? ` or ${NOT_AVAILABLE}` : ""}`);
  }
  if (new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
}

function count(value, label) {
  if (value !== NOT_AVAILABLE && (!Number.isInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative integer or ${NOT_AVAILABLE}`);
  }
}

function percentage(value, label) {
  if (value !== NOT_AVAILABLE && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) {
    throw new TypeError(`${label} must be between 0 and 100 or ${NOT_AVAILABLE}`);
  }
}

function assertTask(data) {
  assertExactKeys(data, TASK_KEYS, "logical task");
  assertIdentifier(data.task_id, "task_id");
  timestamp(data.created_at, "created_at");
  timestamp(data.started_at, "started_at", { allowUnavailable: true });
  timestamp(data.completed_at, "completed_at", { allowUnavailable: true });
  if (!TASK_STATUSES.includes(data.status)) throw new TypeError("unsupported task status");
  assertText(data.task_kind, "task_kind", { allowUnavailable: true });
  assertIdentifier(data.project, "project", { allowUnavailable: true });
  if (data.revision !== NOT_AVAILABLE && !/^[0-9a-f]{40}$/.test(data.revision)) {
    throw new TypeError("revision must be a full lowercase SHA or NOT_AVAILABLE");
  }
  if (data.started_at !== NOT_AVAILABLE && Date.parse(data.started_at) < Date.parse(data.created_at)) {
    throw new TypeError("started_at cannot precede created_at");
  }
  if (data.completed_at !== NOT_AVAILABLE) {
    if (data.started_at === NOT_AVAILABLE || Date.parse(data.completed_at) < Date.parse(data.started_at)) {
      throw new TypeError("completed_at requires and cannot precede started_at");
    }
  }
  const terminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(data.status);
  if (terminal !== (data.completed_at !== NOT_AVAILABLE)) {
    throw new TypeError("terminal task status and completed_at must agree");
  }
}

function assertSegment(data) {
  assertExactKeys(data, SEGMENT_KEYS, "execution segment");
  assertIdentifier(data.segment_id, "segment_id");
  assertIdentifier(data.task_id, "task_id");
  for (const key of ["run_id", "session_id"]) assertIdentifier(data[key], key, { allowUnavailable: true });
  for (const key of ["agent", "provider", "model"]) assertText(data[key], key, { allowUnavailable: true });
  timestamp(data.started_at, "started_at");
  timestamp(data.ended_at, "ended_at", { allowUnavailable: true });
  if (data.ended_at !== NOT_AVAILABLE && Date.parse(data.ended_at) < Date.parse(data.started_at)) {
    throw new TypeError("ended_at cannot precede started_at");
  }
  if (!SEGMENT_OUTCOMES.includes(data.outcome)) throw new TypeError("unsupported segment outcome");
  if ((data.outcome === "IN_PROGRESS") !== (data.ended_at === NOT_AVAILABLE)) {
    throw new TypeError("IN_PROGRESS outcome and ended_at must agree");
  }
  for (const key of ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens"]) {
    count(data[key], key);
  }
  if (!["PROVIDER_REPORTED", "DETERMINISTIC_SUM", NOT_AVAILABLE].includes(data.total_tokens_source)) {
    throw new TypeError("unsupported total_tokens_source");
  }
  if (data.total_tokens === NOT_AVAILABLE && data.total_tokens_source !== NOT_AVAILABLE) {
    throw new TypeError("unavailable total_tokens requires an unavailable source");
  }
  if (data.total_tokens !== NOT_AVAILABLE && data.total_tokens_source === NOT_AVAILABLE) {
    throw new TypeError("available total_tokens requires its source");
  }
  if (data.total_tokens_source === "DETERMINISTIC_SUM") {
    const dimensions = [data.input_tokens, data.output_tokens, data.cache_read_tokens, data.cache_write_tokens];
    if (dimensions.some((value) => value === NOT_AVAILABLE) || dimensions.reduce((sum, value) => sum + value, 0) !== data.total_tokens) {
      throw new TypeError("DETERMINISTIC_SUM total_tokens must equal all four available dimensions");
    }
  }
  if (!USAGE_SCOPES.includes(data.usage_scope)) throw new TypeError("unsupported usage_scope");
  if (!USAGE_QUALITIES.includes(data.usage_quality)) throw new TypeError("unsupported usage_quality");
}

function assertInterruption(data) {
  assertExactKeys(data, INTERRUPTION_KEYS, "interruption");
  assertIdentifier(data.task_id, "task_id");
  assertIdentifier(data.segment_id, "segment_id", { allowUnavailable: true });
  timestamp(data.occurred_at, "occurred_at");
  timestamp(data.ended_at, "ended_at", { allowUnavailable: true });
  timestamp(data.reset_at, "reset_at", { allowUnavailable: true });
  if (data.ended_at !== NOT_AVAILABLE && Date.parse(data.ended_at) < Date.parse(data.occurred_at)) {
    throw new TypeError("interruption ended_at cannot precede occurred_at");
  }
  for (const key of ["provider", "model"]) assertText(data[key], key, { allowUnavailable: true });
  assertIdentifier(data.source, "source", { allowUnavailable: true });
  assertIdentifier(data.resume_session_id, "resume_session_id", { allowUnavailable: true });
  if (!INTERRUPTION_EVENT_CATEGORIES.includes(data.category)) throw new TypeError("unsupported interruption category");
  if (!EVIDENCE_QUALITIES.includes(data.quality)) throw new TypeError("unsupported evidence quality");
}

function assertObservation(data) {
  assertExactKeys(data, OBSERVATION_KEYS, "capacity observation");
  for (const key of ["observation_id", "window_id"]) assertIdentifier(data[key], key);
  for (const key of ["task_id", "segment_id"]) assertIdentifier(data[key], key, { allowUnavailable: true });
  for (const key of ["provider", "model", "window_type"]) assertText(data[key], key, { allowUnavailable: key === "model" });
  assertIdentifier(data.source, "source");
  timestamp(data.observed_at, "observed_at");
  timestamp(data.reset_at, "reset_at", { allowUnavailable: true });
  percentage(data.used_percent, "used_percent");
  percentage(data.remaining_percent, "remaining_percent");
  if (!EVIDENCE_QUALITIES.includes(data.quality)) throw new TypeError("unsupported evidence quality");
  if ((data.used_percent !== NOT_AVAILABLE || data.remaining_percent !== NOT_AVAILABLE) && data.quality === NOT_AVAILABLE) {
    throw new TypeError("available capacity percentages require evidence quality");
  }
  if (data.confidence !== NOT_AVAILABLE && (
    data.quality !== "ESTIMATED" || typeof data.confidence !== "number" ||
    !Number.isFinite(data.confidence) || data.confidence < 0 || data.confidence > 1
  )) throw new TypeError("confidence must be 0..1 and is only valid for ESTIMATED evidence");
  if (data.quality === "ESTIMATED" && data.confidence === NOT_AVAILABLE) {
    throw new TypeError("ESTIMATED evidence requires confidence");
  }
}

function assertWindow(data) {
  assertExactKeys(data, WINDOW_KEYS, "capacity window");
  assertIdentifier(data.window_id, "window_id");
  for (const key of ["provider", "window_type"]) assertText(data[key], key);
  assertIdentifier(data.source, "source");
  assertText(data.model, "model", { allowUnavailable: true });
  timestamp(data.started_at, "started_at", { allowUnavailable: true });
  timestamp(data.reset_at, "reset_at", { allowUnavailable: true });
  timestamp(data.ended_at, "ended_at", { allowUnavailable: true });
  if (data.started_at !== NOT_AVAILABLE && data.ended_at !== NOT_AVAILABLE && Date.parse(data.ended_at) < Date.parse(data.started_at)) {
    throw new TypeError("capacity window ended_at cannot precede started_at");
  }
  if (!EVIDENCE_QUALITIES.includes(data.quality)) throw new TypeError("unsupported evidence quality");
}

function assertIntervalEvidence(data) {
  assertExactKeys(data, INTERVAL_EVIDENCE_KEYS, "capacity interval evidence");
  for (const key of ["evidence_id", "window_id", "start_observation_id", "end_observation_id"]) {
    assertIdentifier(data[key], key);
  }
  if (data.start_observation_id === data.end_observation_id) {
    throw new TypeError("capacity interval evidence requires distinct observations");
  }
  if (!CAPACITY_COMPLETENESS_STATES.includes(data.status)) {
    throw new TypeError("unsupported capacity completeness status");
  }
  if (!Array.isArray(data.causes) || new Set(data.causes).size !== data.causes.length ||
      data.causes.some((cause) => !CAPACITY_COMPLETENESS_CAUSES.includes(cause))) {
    throw new TypeError("capacity completeness causes must be unique supported values");
  }
  if ((data.status === "COMPLETE") !== (data.causes.length === 0)) {
    throw new TypeError("COMPLETE requires no causes and non-complete evidence requires at least one cause");
  }
  assertIdentifier(data.source, "source", { allowUnavailable: true });
  if (!["PROVIDER_REPORTED", "PROVIDER_CLIENT_REPORTED", "RUNTIME_REPORTED", NOT_AVAILABLE].includes(data.quality)) {
    throw new TypeError("capacity completeness cannot be estimated");
  }
  if (data.status === "COMPLETE" && (data.source === NOT_AVAILABLE || data.quality === NOT_AVAILABLE)) {
    throw new TypeError("COMPLETE requires observed provenance");
  }
}

export function assertLifecycleEvent(event) {
  assertObject(event, "lifecycle event");
  assertExactKeys(event, ["lifecycle_event_version", "event_id", "event_type", "recorded_at", "data"], "lifecycle event");
  if (![1, 2].includes(event.lifecycle_event_version)) throw new TypeError("lifecycle_event_version must be 1 or 2");
  assertIdentifier(event.event_id, "event_id");
  if (!LIFECYCLE_EVENT_TYPES.includes(event.event_type)) throw new TypeError("unsupported lifecycle event type");
  if (event.event_type === "CAPACITY_INTERVAL_EVIDENCE" && event.lifecycle_event_version !== 2) {
    throw new TypeError("CAPACITY_INTERVAL_EVIDENCE requires lifecycle_event_version 2");
  }
  timestamp(event.recorded_at, "recorded_at");
  assertObject(event.data, "lifecycle event data");
  const validators = {
    LOGICAL_TASK: assertTask,
    EXECUTION_SEGMENT: assertSegment,
    INTERRUPTION: assertInterruption,
    CAPACITY_OBSERVATION: assertObservation,
    CAPACITY_WINDOW: assertWindow,
    CAPACITY_INTERVAL_EVIDENCE: assertIntervalEvidence,
  };
  validators[event.event_type](event.data);
  return event;
}
