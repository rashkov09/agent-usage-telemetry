import { NOT_AVAILABLE } from "../index.js";

export const NA = NOT_AVAILABLE;

export function lifecycleEvent(event_id, event_type, recorded_at, data) {
  return { lifecycle_event_version: 1, event_id, event_type, recorded_at, data };
}

export function taskEvent(id, overrides = {}) {
  const data = {
    task_id: id,
    created_at: "2030-01-01T00:00:00.000Z",
    started_at: "2030-01-01T00:00:00.000Z",
    completed_at: "2030-01-01T01:00:00.000Z",
    status: "COMPLETED",
    task_kind: "test",
    project: "example/project",
    revision: NA,
    ...overrides,
  };
  return lifecycleEvent(`${id}-task-${data.status.toLowerCase()}`, "LOGICAL_TASK", data.completed_at === NA ? data.created_at : data.completed_at, data);
}

export function segmentEvent(id, task_id, started_at, ended_at, overrides = {}) {
  const data = {
    segment_id: id,
    task_id,
    run_id: `${id}-run`,
    session_id: "session-a",
    agent: "agent-a",
    provider: "provider-a",
    model: "model-a",
    started_at,
    ended_at,
    outcome: ended_at === NA ? "IN_PROGRESS" : "SUCCEEDED",
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 3,
    cache_write_tokens: 1,
    total_tokens: 16,
    total_tokens_source: "DETERMINISTIC_SUM",
    usage_scope: "SEGMENT",
    usage_quality: "EXACT",
    ...overrides,
  };
  return lifecycleEvent(`${id}-event`, "EXECUTION_SEGMENT", ended_at === NA ? started_at : ended_at, data);
}

export function interruptionEvent(id, task_id, occurred_at, ended_at, category, overrides = {}) {
  return lifecycleEvent(id, "INTERRUPTION", occurred_at, {
    task_id,
    segment_id: NA,
    occurred_at,
    ended_at,
    provider: "provider-a",
    model: "model-a",
    category,
    reset_at: category === "PROVIDER_CAPACITY" ? ended_at : NA,
    resume_session_id: NA,
    source: "runtime",
    quality: "RUNTIME_REPORTED",
    ...overrides,
  });
}

export function windowEvent(id, type, started_at, ended_at, overrides = {}) {
  return lifecycleEvent(`${id}-event`, "CAPACITY_WINDOW", started_at === NA ? ended_at : started_at, {
    window_id: id,
    provider: "provider-a",
    model: "model-a",
    window_type: type,
    started_at,
    reset_at: ended_at,
    ended_at,
    source: "runtime",
    quality: "RUNTIME_REPORTED",
    ...overrides,
  });
}

export function observationEvent(id, window_id, observed_at, overrides = {}) {
  return lifecycleEvent(`${id}-event`, "CAPACITY_OBSERVATION", observed_at, {
    observation_id: id,
    task_id: NA,
    segment_id: NA,
    window_id,
    provider: "provider-a",
    model: "model-a",
    window_type: "5h",
    observed_at,
    used_percent: NA,
    remaining_percent: NA,
    reset_at: NA,
    source: "runtime",
    quality: "RUNTIME_REPORTED",
    confidence: NA,
    ...overrides,
  });
}

export function intervalEvidenceEvent(id, window_id, start_observation_id, end_observation_id, overrides = {}) {
  const event = lifecycleEvent(`${id}-event`, "CAPACITY_INTERVAL_EVIDENCE", "2030-01-01T02:31:00.000Z", {
    evidence_id: id,
    window_id,
    start_observation_id,
    end_observation_id,
    status: "COMPLETE",
    causes: [],
    source: "account-activity-ledger",
    quality: "RUNTIME_REPORTED",
    ...overrides,
  });
  event.lifecycle_event_version = 2;
  return event;
}
