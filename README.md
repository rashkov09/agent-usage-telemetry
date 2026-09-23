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

A logical task is not assumed to be a run or a session. Lifecycle evidence uses a separate versioned envelope with a stable `event_id` and one of six provider-neutral event types. Version 1 records remain valid; the new interval-evidence event requires version 2:

- `LOGICAL_TASK`: durable task identity, lifecycle timestamps/status, optional sanitized project and full revision;
- `EXECUTION_SEGMENT`: one contiguous run with independently supplied run/session/agent/provider/model and token dimensions;
- `INTERRUPTION`: normalized `PROVIDER_CAPACITY`, `PROVIDER_ERROR`, `SESSION_INTERRUPTED`, `NO_PROGRESS`, `TOOL_FAILURE`, `OWNER_WAIT`, or `UNKNOWN` evidence;
- `CAPACITY_OBSERVATION`: percentages, reset, source, and quality for any named window type;
- `CAPACITY_WINDOW`: a generalized calibration boundary such as `5h`, `weekly`, or a provider-specific future window.
- `CAPACITY_INTERVAL_EVIDENCE`: a producer determination binding exact start/end observation IDs and declaring task-attribution evidence `COMPLETE`, `INCOMPLETE`, or `NOT_AVAILABLE` with qualitative causes and provenance.

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

T2 added a conservative built-in calibration path without changing that T1 compatibility seam:

- `deriveCapacityDelta(start, end)` accepts only two chronologically ordered, non-estimated observations with the same provider, window type, window ID, reset timestamp, source, and quality. Both remaining percentages must be present, the interval must end no later than the reset, and remaining capacity may not increase. Otherwise the result is `NOT_AVAILABLE`.
- `buildCalibrationDataset(projection)` converts adjacent compatible observations into rebuildable samples. Endpoint percentages are `OBSERVED`; their difference is `DERIVED`. It preserves input, output, cache-read, and cache-write tokens as four separate fields, records active execution independently, rejects segments crossing interval boundaries, preserves a sorted model mix, and marks mixed-model samples unusable for a single-model estimator.
- Capacity-limit events are retained as `OBSERVED` anchors. An anchor does **not** imply that accumulated tokens equal 100% of provider quota; `quota_exhaustion_percent` remains `NOT_AVAILABLE` unless separately observed.
- 5-hour, weekly, and any future window types are independent estimator scopes. Provider and model must also match exactly.

T3 adds an account-activity completeness gate. A provider capacity delta is account-wide evidence and is not task consumption merely because every visible task segment is closed and provider/model attributed.

- A `CAPACITY_INTERVAL_EVIDENCE` record binds one exact adjacent observation pair. `COMPLETE` requires observed provenance and no causes. `INCOMPLETE` and `NOT_AVAILABLE` require at least one qualitative cause. Completeness cannot be estimated.
- The producer may declare `COMPLETE` only when it can account for all same-account activity over the exact interval and attribute the provider delta to the included segments. It must consider concurrent executions, direct provider calls, heartbeat/background activity, other sessions, retries/provider overhead, activity outside the recorder, and idle-gap consumption.
- Missing historical evidence is `NOT_AVAILABLE / EVIDENCE_COMPLETENESS_NOT_AVAILABLE`. An `INCOMPLETE` declaration is `EVIDENCE_INCOMPLETE`. Unknown plus complete evidence remains unknown; incomplete plus complete evidence remains incomplete. Replay cannot upgrade either state.
- Only `COMPLETE` samples can train or contribute task-class medians/ranges. `active_execution_seconds` remains a diagnostic field and is not an estimator feature or proof of attribution. No wall-clock coverage threshold exists.
- Dataset version 2 and estimator version `t3-complete-evidence-nnls-v1` make T2 artifacts stale. Rebuilding the same append-only evidence is deterministic; old samples do not silently acquire completeness.

Current OpenClaw task records do not prove account-wide completeness: task counters are task-correlated, but provider capacity snapshots are account-wide and activity outside the instrumented run is not excluded. Historical OpenAI and Anthropic intervals therefore remain `NOT_AVAILABLE` unless a future producer records sufficient interval evidence. No quota percentage is converted into tokens or a numeric residual.

`trainCapacityEstimator(samples, scope)` uses deterministic non-negative linear coordinate descent over the four separate token features. Active execution duration is diagnostic only and never enters the fitted model. There are no provider-specific token weights or quota constants. Training requires at least **8 independent capacity windows**; fewer windows return `NOT_AVAILABLE / INSUFFICIENT_SAMPLES`. Model-mix and missing-dimension evidence is never silently coerced into training data.

Evaluation is deterministic leave-one-window-out validation. The artifact reports mean, median, and maximum absolute percentage-point error and the held-out sample count. Confidence means:

- `LOW`: an available model that does not meet the stronger thresholds below, including every 8–11-window model;
- `MEDIUM`: at least 12 independent windows and validation MAE at most 10 percentage points;
- `HIGH`: at least 25 independent windows, MAE at most 5 percentage points, and maximum held-out error at most 15 percentage points.

An out-of-training-range workload is downgraded to `LOW`. Estimates are rounded to whole percentage points. `estimateCapacity(...)` returns the current observed percentage separately from the estimated percentage; it never overwrites or relabels observed evidence. A baseline observed remaining percentage is required to turn predicted consumption into predicted remaining capacity.

`summarizeTaskClassCapacity(...)` aggregates only single-task, single-class compatible intervals. It requires at least three independent windows and returns a median and observed range, not an orchestration decision. Task classes are sanitized lifecycle values supplied by callers; this package contains no project issue names.

Fitted parameters are not persisted by this package. An artifact nevertheless carries its model version, exact provider/model/window scope, sample counts, validation metrics, and a SHA-256 training-data digest. `isEstimatorArtifactStale(...)` detects version or training-evidence drift. Rebuilding from the same append-only evidence produces the same dataset and model result.

Use `agent-usage-telemetry calibration-summary --input <lifecycle.jsonl>` for a human summary. Its lines explicitly label `OBSERVED`, `DERIVED`, `ESTIMATED`, and `NOT_AVAILABLE` evidence.

Machine-readable unavailability reasons are a small stable set: `INSUFFICIENT_SAMPLES`, `INCOMPATIBLE_WINDOWS`, `MISSING_TOKEN_DIMENSIONS`, `MODEL_MIX_UNRESOLVED`, `NO_CAPACITY_LABELS`, `PROVIDER_MODEL_MISMATCH`, `MISSING_BASELINE_OBSERVATION`, `STALE_MODEL`, `EVIDENCE_INCOMPLETE`, and `EVIDENCE_COMPLETENESS_NOT_AVAILABLE`.

Useful future calibration requires a capacity observation at task/interval start and end, stable window/reset identity, separate token counters for every resumed segment, and a categorized capacity-limit timestamp. Session-wide changes must not be attributed to a task when those interval facts are absent.

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
