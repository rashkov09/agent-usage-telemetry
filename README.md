# agent-usage-telemetry

> Track token usage, provider capacity, resets, and interruptions across AI coding agents.

AI coding agents expose usage in different shapes, and some providers do not expose quota windows at all. `agent-usage-telemetry` turns supported observations into honest records: provider observations retain exact counters when supplied, while the lifecycle API represents one logical task across any number of execution segments, sessions, providers, interruptions, and capacity windows. Missing evidence stays explicit as `NOT_AVAILABLE`.

It is a dependency-free Node.js library and CLI. It does **not** read credentials, call provider account APIs, estimate billing, route work, or decide retry/recovery policy.

## Provider capabilities

| Capability | OpenAI | Anthropic |
| --- | --- | --- |
| Token counters | Supported where exposed | Supported where exposed |
| Cache counters | Supported where exposed | Supported where exposed |
| Rolling capacity window | Supported where exposed | Not currently available |
| Reset time | Supported where exposed | Not currently available |
| Provider interruptions | Supported | Supported |

“Supported where exposed” means the calling agent or integration must provide the observation. The package never fabricates missing counters or fetches private account data.

## Install and run

Requires Node.js 20 or newer.

```bash
git clone https://github.com/rashkov09/agent-usage-telemetry.git
cd agent-usage-telemetry
npm install
npm test

node cli.js ingest \
  --provider openai \
  --input examples/openai-observation.json \
  --output agent-usage.jsonl

node cli.js summary --input agent-usage.jsonl

node cli.js lifecycle-summary \
  --input tests/fixtures/gin-164-shaped.jsonl \
  --task gin-164
```

Use `--input -` to read an observation from stdin. JSONL files are created with owner-only permissions where the operating system supports them.

## Output

```json
{
  "event_version": 1,
  "observed_at": "2030-01-01T00:00:00.000Z",
  "provider": "openai",
  "model": "example-openai-model",
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 430,
    "cache_read_tokens": 800,
    "cache_write_tokens": "NOT_AVAILABLE",
    "total_tokens": 1630
  },
  "capacity": {
    "status": "AVAILABLE",
    "windows": [
      {
        "label": "5h",
        "remaining_percent": 55,
        "reset_at": "2030-01-01T05:00:00.000Z"
      }
    ]
  },
  "interruptions": {
    "count": 0,
    "last_category": "NOT_AVAILABLE"
  }
}
```

If a provider or integration does not expose capacity, the result stays explicit:

```json
{
  "capacity": {
    "status": "NOT_AVAILABLE"
  }
}
```

Raw provider error messages are not persisted. Interruptions are reduced to a count and a small category set to avoid accidentally storing sensitive response data.

## Library API

```js
import {
  appendEvent,
  normalizeObservation,
  renderSummary,
} from "agent-usage-telemetry";

const event = normalizeObservation("openai", providerObservation);
appendEvent("agent-usage.jsonl", event);
console.log(renderSummary(event));
```

The input examples document the supported provider shapes. A JSON Schema for normalized output lives at `schema/telemetry-event.schema.json`.

## Logical-task lifecycle

A logical task is not assumed to be a run or a session. Lifecycle evidence uses a separate versioned envelope with a stable `event_id` and one of five provider-neutral event types:

- `LOGICAL_TASK`: durable task identity, lifecycle timestamps/status, optional sanitized project and full revision;
- `EXECUTION_SEGMENT`: one contiguous run with independently supplied run/session/agent/provider/model and token dimensions;
- `INTERRUPTION`: normalized `PROVIDER_CAPACITY`, `PROVIDER_ERROR`, `SESSION_INTERRUPTED`, `NO_PROGRESS`, `TOOL_FAILURE`, `OWNER_WAIT`, or `UNKNOWN` evidence;
- `CAPACITY_OBSERVATION`: percentages, reset, source, and quality for any named window type;
- `CAPACITY_WINDOW`: a generalized calibration boundary such as `5h`, `weekly`, or a provider-specific future window.

The runtime validator rejects extra fields, non-canonical timestamps, absolute/parent project paths, non-sanitized IDs, short SHAs, raw content fields, and inconsistent terminal timestamps. It never accepts a prompt or raw provider error body as lifecycle data. The full envelope is documented by `schema/lifecycle-event.schema.json`.

```js
import { LifecycleStore } from "agent-usage-telemetry";

const store = new LifecycleStore("agent-lifecycle.jsonl");
store.ingest(lifecycleEvent);

const task = store.projection.taskSummary("task-123");
const completed = store.projection.queryTasks({ completed: true });
const limits = store.projection.queryInterruptions({ category: "PROVIDER_CAPACITY" });
const fiveHour = store.projection.queryCapacityWindows({ window_type: "5h" });
```

### Deterministic time accounting

For a completed task:

- `active_execution_seconds` is the union of completed segment intervals clipped to the task lifecycle;
- `capacity_blocked_seconds` is the union of `PROVIDER_CAPACITY` intervals, with active execution subtracted;
- `other_wait_seconds` is the remaining lead-time interval;
- `total_lead_seconds` is `completed_at - started_at`.

Overlapping segments and interruptions cannot inflate duration. An incomplete task reports all four derived durations as `NOT_AVAILABLE` because no implicit “now” value is durable or reproducible.

Token dimensions remain separate. A task aggregate becomes `NOT_AVAILABLE` for a dimension if any contributing segment lacks that dimension. `total_tokens` is accepted only with an explicit `PROVIDER_REPORTED` source or a checked `DETERMINISTIC_SUM`; no reasoning-token count or hidden quota weighting is invented.

### Raw and normalized storage

Raw append-only JSONL is authoritative. Each JSONL file must have exactly one authoritative writer; concurrent independent writers are unsupported. `LifecycleStore` writes a normalized schema-version-1 projection sidecar atomically, but that sidecar is non-authoritative and may be missing or stale. On every reopen, the normalized projection is rebuilt from raw evidence.

Stable `event_id` values make same-event replay through `LifecycleStore.ingest` a no-op, while unrelated events are never deduplicated merely because their numbers match. If duplicate IDs are already present in raw JSONL (for example, after unsupported concurrent writes), those raw bytes are preserved and reconstruction or other file use fails closed until the operator repairs or quarantines the file externally. This package intentionally does not add locking, SQLite, quarantine, consensus, or recovery machinery.

Once a `LOGICAL_TASK` reaches `COMPLETED`, `FAILED`, or `CANCELLED`, later evidence cannot reopen it, select another terminal status, or change `completed_at`. A distinct event may restate the same terminal status and timestamp and may fill compatible previously unavailable metadata; conflicting evidence fails closed. Non-terminal statuses remain ingestion/observation ordered rather than forming a workflow state machine.

SQLite was considered for task/segment/window joins. T1 uses a deterministic in-process projection instead: it preserves zero runtime dependencies and Node 20/22/24 compatibility while the current dataset is local and append-only. The storage boundary can later gain a SQLite projection without changing raw lifecycle events or query semantics.

### Capacity calibration seam

`buildCalibrationInput(projection, windowId)` returns window boundaries, overlapping/crossing segment IDs, the four token dimensions, observations, and observed limit events. A segment crossing a boundary is listed deterministically, but its tokens are **not** proportionally split; affected window totals remain `NOT_AVAILABLE`.

`runCapacityEstimator(input, estimator)` is an interface for later empirical work. It supplies no coefficients or quota assumptions and forces every result to carry `quality: "ESTIMATED"`, an estimator ID, and confidence. Observed provider/client/runtime evidence outranks estimates and is never overwritten.

The fixtures under `tests/fixtures/` are synthetic and sanitized. They preserve the shapes of a multi-segment implementation interrupted by capacity and an exact-SHA review interrupted by both capacity and no-progress detection; they contain no production records, prompts, account identifiers, local paths, or private source.

## Add another provider

1. Add a module under `providers/` that maps only directly exposed values into `usage`, `capacity`, and `interruptions`.
2. Return `NOT_AVAILABLE` instead of estimating missing values.
3. Register the adapter in `core/telemetry.js`.
4. Add sanitized tests proving both available and unavailable fields.
5. Update the capability table with claims demonstrated by the adapter and tests.

## Scope and status

This is an intentionally small MVP for normalizing and storing observations supplied by AI-agent integrations. It has been extracted from real OpenAI and Anthropic telemetry work, but it is not a universal account-quota client and is not presented as production-ready.

Non-goals: dashboards, billing estimates, provider routing, orchestration/state transitions, automatic retry/resume, provider switching, external messaging/integrations, account-plan decisions, and credential handling. Telemetry observes and stores; callers own policy.
