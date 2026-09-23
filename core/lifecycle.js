import { NOT_AVAILABLE } from "./schema.js";
import { assertLifecycleEvent } from "./lifecycle-schema.js";

const QUALITY_RANK = new Map([
  ["PROVIDER_REPORTED", 4],
  ["PROVIDER_CLIENT_REPORTED", 3],
  ["RUNTIME_REPORTED", 2],
  ["ESTIMATED", 1],
  [NOT_AVAILABLE, 0],
]);

const TERMINAL_TASK_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

function clone(value) {
  return structuredClone(value);
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

function milliseconds(value) {
  return Date.parse(value);
}

function interval(start, end) {
  return [milliseconds(start), milliseconds(end)];
}

function clip([start, end], lower, upper) {
  const clipped = [Math.max(start, lower), Math.min(end, upper)];
  return clipped[1] > clipped[0] ? clipped : null;
}

function union(intervals) {
  const sorted = intervals.filter(Boolean).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const result = [];
  for (const current of sorted) {
    const previous = result.at(-1);
    if (!previous || current[0] > previous[1]) result.push([...current]);
    else previous[1] = Math.max(previous[1], current[1]);
  }
  return result;
}

function subtract(intervals, excluded) {
  let result = union(intervals);
  for (const [excludedStart, excludedEnd] of union(excluded)) {
    result = result.flatMap(([start, end]) => {
      if (excludedEnd <= start || excludedStart >= end) return [[start, end]];
      const pieces = [];
      if (excludedStart > start) pieces.push([start, excludedStart]);
      if (excludedEnd < end) pieces.push([excludedEnd, end]);
      return pieces;
    });
  }
  return result;
}

function seconds(intervals) {
  return union(intervals).reduce((total, [start, end]) => total + end - start, 0) / 1000;
}

function strictTokenTotal(segments, key) {
  if (!segments.length || segments.some((segment) => segment[key] === NOT_AVAILABLE)) return NOT_AVAILABLE;
  return segments.reduce((sum, segment) => sum + segment[key], 0);
}

function compareByTimeAndId(left, right, timeKey, idKey) {
  return milliseconds(left[timeKey]) - milliseconds(right[timeKey]) || left[idKey].localeCompare(right[idKey]);
}

export class LifecycleProjection {
  constructor() {
    this.schemaVersion = 2;
    this.eventIds = new Set();
    this.eventsById = new Map();
    this.tasks = new Map();
    this.segments = new Map();
    this.interruptions = new Map();
    this.capacityObservations = new Map();
    this.capacityWindows = new Map();
    this.capacityIntervalEvidence = new Map();
  }

  ingest(event) {
    assertLifecycleEvent(event);
    if (this.eventIds.has(event.event_id)) {
      if (!same(this.eventsById.get(event.event_id), event)) {
        throw new Error(`event_id ${event.event_id} conflicts with existing evidence`);
      }
      return false;
    }
    const data = clone(event.data);
    if (event.event_type === "LOGICAL_TASK") {
      const previous = this.tasks.get(data.task_id);
      if (previous) {
        if (TERMINAL_TASK_STATUSES.has(previous.status) && (
          data.status !== previous.status || data.completed_at !== previous.completed_at
        )) {
          throw new Error(`logical task ${data.task_id} terminal state cannot change`);
        }
        for (const key of ["created_at", "started_at", "task_kind", "project", "revision"]) {
          if (previous[key] !== data[key] && previous[key] !== NOT_AVAILABLE && data[key] !== NOT_AVAILABLE) {
            throw new Error(`logical task ${data.task_id} conflicts on ${key}`);
          }
        }
      }
      const merged = { ...previous, ...data };
      for (const key of ["started_at", "task_kind", "project", "revision"]) {
        if (previous && previous[key] !== NOT_AVAILABLE && data[key] === NOT_AVAILABLE) merged[key] = previous[key];
      }
      this.tasks.set(data.task_id, merged);
    } else if (event.event_type === "EXECUTION_SEGMENT") {
      if (!this.tasks.has(data.task_id)) throw new Error(`execution segment references unknown task ${data.task_id}`);
      this.#insertUnique(this.segments, data.segment_id, data, "execution segment");
    } else if (event.event_type === "INTERRUPTION") {
      if (!this.tasks.has(data.task_id)) throw new Error(`interruption references unknown task ${data.task_id}`);
      if (data.segment_id !== NOT_AVAILABLE) {
        const segment = this.segments.get(data.segment_id);
        if (!segment || segment.task_id !== data.task_id) throw new Error(`interruption references unknown task segment ${data.segment_id}`);
      }
      this.#insertUnique(this.interruptions, event.event_id, { event_id: event.event_id, ...data }, "interruption");
    } else if (event.event_type === "CAPACITY_OBSERVATION") {
      const window = this.capacityWindows.get(data.window_id);
      if (!window) throw new Error(`capacity observation references unknown window ${data.window_id}`);
      if (data.provider !== window.provider || data.window_type !== window.window_type || (
        data.model !== NOT_AVAILABLE && window.model !== NOT_AVAILABLE && data.model !== window.model
      )) throw new Error(`capacity observation conflicts with window ${data.window_id}`);
      if (data.task_id !== NOT_AVAILABLE && !this.tasks.has(data.task_id)) throw new Error(`capacity observation references unknown task ${data.task_id}`);
      if (data.segment_id !== NOT_AVAILABLE && !this.segments.has(data.segment_id)) throw new Error(`capacity observation references unknown segment ${data.segment_id}`);
      this.#insertUnique(this.capacityObservations, data.observation_id, data, "capacity observation");
    } else if (event.event_type === "CAPACITY_WINDOW") {
      this.#insertUnique(this.capacityWindows, data.window_id, data, "capacity window");
    } else if (event.event_type === "CAPACITY_INTERVAL_EVIDENCE") {
      const window = this.capacityWindows.get(data.window_id);
      const start = this.capacityObservations.get(data.start_observation_id);
      const end = this.capacityObservations.get(data.end_observation_id);
      if (!window || !start || !end || start.window_id !== data.window_id || end.window_id !== data.window_id) {
        throw new Error(`capacity interval evidence references unknown or mismatched evidence ${data.evidence_id}`);
      }
      if (milliseconds(start.observed_at) >= milliseconds(end.observed_at)) {
        throw new Error(`capacity interval evidence ${data.evidence_id} is not chronological`);
      }
      this.#insertUnique(this.capacityIntervalEvidence, data.evidence_id, data, "capacity interval evidence");
    }
    this.eventIds.add(event.event_id);
    this.eventsById.set(event.event_id, clone(event));
    return true;
  }

  #insertUnique(map, id, data, label) {
    const previous = map.get(id);
    if (previous && !same(previous, data)) throw new Error(`${label} ${id} conflicts with existing evidence`);
    if (!previous) map.set(id, data);
  }

  taskSummary(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const segments = [...this.segments.values()]
      .filter((segment) => segment.task_id === taskId)
      .sort((left, right) => compareByTimeAndId(left, right, "started_at", "segment_id"));
    const interruptions = [...this.interruptions.values()]
      .filter((event) => event.task_id === taskId)
      .sort((left, right) => compareByTimeAndId(left, right, "occurred_at", "event_id"));

    const timing = this.#timeSummary(task, segments, interruptions);
    const providers = [...new Set(segments.map((segment) => segment.provider).filter((value) => value !== NOT_AVAILABLE))].sort();
    const models = [...new Set(segments.map((segment) => segment.model).filter((value) => value !== NOT_AVAILABLE))].sort();
    const agents = [...new Set(segments.map((segment) => segment.agent).filter((value) => value !== NOT_AVAILABLE))].sort();
    const sessions = [...new Set(segments.map((segment) => segment.session_id).filter((value) => value !== NOT_AVAILABLE))].sort();

    return {
      ...clone(task),
      segment_ids: segments.map((segment) => segment.segment_id),
      interruption_event_ids: interruptions.map((event) => event.event_id),
      providers,
      models,
      agents,
      session_ids: sessions,
      resumed: segments.length > 1,
      ...timing,
      input_tokens: strictTokenTotal(segments, "input_tokens"),
      output_tokens: strictTokenTotal(segments, "output_tokens"),
      cache_read_tokens: strictTokenTotal(segments, "cache_read_tokens"),
      cache_write_tokens: strictTokenTotal(segments, "cache_write_tokens"),
      total_tokens: strictTokenTotal(segments, "total_tokens"),
    };
  }

  #timeSummary(task, segments, interruptions) {
    if (task.started_at === NOT_AVAILABLE || task.completed_at === NOT_AVAILABLE) {
      return {
        active_execution_seconds: NOT_AVAILABLE,
        capacity_blocked_seconds: NOT_AVAILABLE,
        other_wait_seconds: NOT_AVAILABLE,
        total_lead_seconds: NOT_AVAILABLE,
      };
    }
    const lower = milliseconds(task.started_at);
    const upper = milliseconds(task.completed_at);
    const active = union(segments.flatMap((segment) =>
      segment.ended_at === NOT_AVAILABLE ? [] : [clip(interval(segment.started_at, segment.ended_at), lower, upper)]));
    const capacity = union(interruptions.flatMap((event) => {
      if (event.category !== "PROVIDER_CAPACITY") return [];
      const end = event.ended_at !== NOT_AVAILABLE ? event.ended_at : event.reset_at;
      return end === NOT_AVAILABLE ? [] : [clip(interval(event.occurred_at, end), lower, upper)];
    }));
    const nonOverlappingCapacity = subtract(capacity, active);
    const lead = upper - lower;
    const activeMs = union(active).reduce((sum, [start, end]) => sum + end - start, 0);
    const capacityMs = union(nonOverlappingCapacity).reduce((sum, [start, end]) => sum + end - start, 0);
    return {
      active_execution_seconds: activeMs / 1000,
      capacity_blocked_seconds: capacityMs / 1000,
      other_wait_seconds: (lead - activeMs - capacityMs) / 1000,
      total_lead_seconds: lead / 1000,
    };
  }

  queryTasks(filters = {}) {
    return [...this.tasks.keys()].map((taskId) => this.taskSummary(taskId)).filter((task) => {
      if (filters.status && task.status !== filters.status) return false;
      if (filters.completed === true && task.completed_at === NOT_AVAILABLE) return false;
      if (filters.completed === false && task.completed_at !== NOT_AVAILABLE) return false;
      for (const [filter, field] of [["provider", "providers"], ["model", "models"], ["agent", "agents"]]) {
        if (filters[filter] && !task[field].includes(filters[filter])) return false;
      }
      return true;
    }).sort((left, right) => left.created_at.localeCompare(right.created_at) || left.task_id.localeCompare(right.task_id));
  }

  queryInterruptions(filters = {}) {
    return [...this.interruptions.values()].filter((event) =>
      (!filters.task_id || event.task_id === filters.task_id) &&
      (!filters.category || event.category === filters.category) &&
      (!filters.provider || event.provider === filters.provider)
    ).sort((left, right) => compareByTimeAndId(left, right, "occurred_at", "event_id")).map(clone);
  }

  capacityWindowSummary(windowId) {
    const window = this.capacityWindows.get(windowId);
    if (!window) return undefined;
    const observations = [...this.capacityObservations.values()]
      .filter((observation) => observation.window_id === windowId)
      .sort((left, right) => compareByTimeAndId(left, right, "observed_at", "observation_id"));
    const start = window.started_at === NOT_AVAILABLE ? null : milliseconds(window.started_at);
    const endValue = window.ended_at !== NOT_AVAILABLE ? window.ended_at : window.reset_at;
    const end = endValue === NOT_AVAILABLE ? null : milliseconds(endValue);
    const allProviderSegments = [...this.segments.values()].filter((segment) =>
      segment.provider === window.provider && (window.model === NOT_AVAILABLE || segment.model === window.model));
    const overlapping = start === null || end === null ? [] : allProviderSegments.filter((segment) => {
      if (segment.ended_at === NOT_AVAILABLE) return false;
      return milliseconds(segment.started_at) < end && milliseconds(segment.ended_at) > start;
    });
    const contained = overlapping.filter((segment) =>
      milliseconds(segment.started_at) >= start && milliseconds(segment.ended_at) <= end);
    const crossing = overlapping.filter((segment) => !contained.includes(segment));
    const limitEvents = [...this.interruptions.values()].filter((event) =>
      event.category === "PROVIDER_CAPACITY" && event.provider === window.provider &&
      (window.model === NOT_AVAILABLE || event.model === window.model) &&
      (event.reset_at === NOT_AVAILABLE || window.reset_at === NOT_AVAILABLE || event.reset_at === window.reset_at) &&
      (start === null || milliseconds(event.occurred_at) >= start) &&
      (end === null || milliseconds(event.occurred_at) <= end));
    const tokenSource = crossing.length ? [] : contained;
    return {
      ...clone(window),
      observation_ids: observations.map((observation) => observation.observation_id),
      best_observation_id: selectBestCapacityObservation(observations)?.observation_id ?? NOT_AVAILABLE,
      overlapping_segment_ids: overlapping.map((segment) => segment.segment_id).sort(),
      contained_segment_ids: contained.map((segment) => segment.segment_id).sort(),
      crossing_segment_ids: crossing.map((segment) => segment.segment_id).sort(),
      input_tokens: crossing.length ? NOT_AVAILABLE : strictTokenTotal(tokenSource, "input_tokens"),
      output_tokens: crossing.length ? NOT_AVAILABLE : strictTokenTotal(tokenSource, "output_tokens"),
      cache_read_tokens: crossing.length ? NOT_AVAILABLE : strictTokenTotal(tokenSource, "cache_read_tokens"),
      cache_write_tokens: crossing.length ? NOT_AVAILABLE : strictTokenTotal(tokenSource, "cache_write_tokens"),
      limit_event_ids: limitEvents.map((event) => event.event_id).sort(),
    };
  }

  queryCapacityWindows(filters = {}) {
    return [...this.capacityWindows.keys()].map((windowId) => this.capacityWindowSummary(windowId)).filter((window) =>
      (!filters.provider || window.provider === filters.provider) &&
      (!filters.model || window.model === filters.model) &&
      (!filters.window_type || window.window_type === filters.window_type)
    ).sort((left, right) => left.window_id.localeCompare(right.window_id));
  }

  report() {
    const tasks = this.queryTasks();
    const interruptions = this.queryInterruptions();
    return {
      schema_version: this.schemaVersion,
      completed_tasks: tasks.filter((task) => task.completed_at !== NOT_AVAILABLE).length,
      incomplete_tasks: tasks.filter((task) => task.completed_at === NOT_AVAILABLE).length,
      successfully_resumed_tasks: tasks.filter((task) => task.resumed && task.status === "COMPLETED").length,
      tasks_requiring_owner_intervention: new Set(interruptions.filter((event) => event.category === "OWNER_WAIT").map((event) => event.task_id)).size,
      tasks_by_provider: groupMembershipCounts(tasks, "providers"),
      tasks_by_model: groupMembershipCounts(tasks, "models"),
      tasks_by_agent: groupMembershipCounts(tasks, "agents"),
      token_dimensions_by_task: Object.fromEntries(tasks.map((task) => [task.task_id, {
        input_tokens: task.input_tokens,
        output_tokens: task.output_tokens,
        cache_read_tokens: task.cache_read_tokens,
        cache_write_tokens: task.cache_write_tokens,
        total_tokens: task.total_tokens,
      }])),
      capacity_limit_events: interruptions.filter((event) => event.category === "PROVIDER_CAPACITY").length,
      provider_interruption_counts: Object.fromEntries([...new Set(interruptions.map((event) => event.provider))].sort().map((provider) => [
        provider, interruptions.filter((event) => event.provider === provider).length,
      ])),
      capacity_windows: this.capacityWindows.size,
      capacity_observations: this.capacityObservations.size,
      capacity_interval_evidence: this.capacityIntervalEvidence.size,
      interruption_counts: Object.fromEntries([...new Set(interruptions.map((event) => event.category))].sort().map((category) => [
        category, interruptions.filter((event) => event.category === category).length,
      ])),
      active_execution_seconds: sumAvailable(tasks, "active_execution_seconds"),
      capacity_blocked_seconds: sumAvailable(tasks, "capacity_blocked_seconds"),
      other_wait_seconds: sumAvailable(tasks, "other_wait_seconds"),
      total_lead_seconds: sumAvailable(tasks, "total_lead_seconds"),
    };
  }

  toJSON() {
    const sortMap = (map) => [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => clone(value));
    return {
      schema_version: this.schemaVersion,
      event_ids: [...this.eventIds].sort(),
      tasks: sortMap(this.tasks),
      segments: sortMap(this.segments),
      interruptions: sortMap(this.interruptions),
      capacity_observations: sortMap(this.capacityObservations),
      capacity_windows: sortMap(this.capacityWindows),
      capacity_interval_evidence: sortMap(this.capacityIntervalEvidence),
    };
  }
}

function groupMembershipCounts(records, key) {
  const values = [...new Set(records.flatMap((record) => record[key]))].sort();
  return Object.fromEntries(values.map((value) => [value, records.filter((record) => record[key].includes(value)).length]));
}

function sumAvailable(records, key) {
  if (records.some((record) => record[key] === NOT_AVAILABLE)) return NOT_AVAILABLE;
  return records.reduce((sum, record) => sum + record[key], 0);
}

export function selectBestCapacityObservation(observations) {
  return [...observations].sort((left, right) =>
    (QUALITY_RANK.get(right.quality) ?? -1) - (QUALITY_RANK.get(left.quality) ?? -1) ||
    milliseconds(right.observed_at) - milliseconds(left.observed_at) ||
    left.observation_id.localeCompare(right.observation_id))[0];
}

export function buildLifecycleProjection(events) {
  const projection = new LifecycleProjection();
  for (const event of events) projection.ingest(event);
  return projection;
}

export function deriveTaskTiming(task, segments, interruptions) {
  const projection = new LifecycleProjection();
  projection.tasks.set(task.task_id, clone(task));
  for (const segment of segments) projection.segments.set(segment.segment_id, clone(segment));
  for (const [index, event] of interruptions.entries()) {
    projection.interruptions.set(event.event_id ?? `derived-${index}`, { event_id: event.event_id ?? `derived-${index}`, ...clone(event) });
  }
  const summary = projection.taskSummary(task.task_id);
  return {
    active_execution_seconds: summary.active_execution_seconds,
    capacity_blocked_seconds: summary.capacity_blocked_seconds,
    other_wait_seconds: summary.other_wait_seconds,
    total_lead_seconds: summary.total_lead_seconds,
  };
}

export function intervalSeconds(intervals) {
  return seconds(intervals);
}
