# Provider usage acquisition and orchestrator evidence API — discussion proposal

**Status:** proposed architecture, **not approved or implemented**. This document changes no package API, acquisition path, service, credential, schema, historical record, or orchestration policy. Baseline: public `agent-usage-telemetry` v0.5.0 at `69370d2549987b5707c4a09bb8d91ff295b6d3d8` (2026-10-13 verification). Examples below are synthetic contracts for discussion, not promises about a deployed provider interface.

## Executive summary

Keep the existing dependency-free telemetry core as the evidence authority. Add **optional, separately deployed acquisition integrations** that run where an authorized provider CLI/runtime is already authenticated, validate their own source and schema, sanitize observations, and submit them through one authoritative telemetry writer. Offer a versioned **read-only evidence interface** to orchestrators. Prefer a Unix-domain socket for a co-located, cross-user consumer; compare loopback HTTP and direct library/file reads below. The interface reports observations, provenance, quality, identity, freshness, and failures; it does **not** answer “may I dispatch?”. The orchestrator retains required-window policy, retry timing, durable provider blocks, workflow recovery, and owner gates.

This is an explicit proposed expansion of the current README boundary: v0.5.0 does **not** fetch provider accounts, own credentials, run a background service, or make orchestration decisions. No such capability may be inferred from this PR. Provider acquisition, transport, schema, and rollout require separate owner approval and implementation reviews.

```text
authorized provider CLI/runtime  (credential-owning OS principal)
             │ bounded, version-checked, sanitized observation
             ▼
optional acquisition adapter/process ──► telemetry single writer ──► append-only JSONL
                                               │                         │
                                               └── rebuildable projection◄┘
                                                         │ read-only, versioned, authenticated
                                                         ▼
                                            orchestrator capacity policy
                                            + durable workflow/owner gates
```

## Current capabilities and non-goals

The package is a Node.js 20+ library/CLI with no runtime dependencies. [`providers/openai.js`](../../providers/openai.js) and [`providers/anthropic.js`](../../providers/anthropic.js) normalize **supplied** token/cache/interruption observations; the current Anthropic adapter explicitly returns unavailable capacity. [`core/normalize.js`](../../core/normalize.js) keeps missing counters as `NOT_AVAILABLE`. [`core/telemetry.js`](../../core/telemetry.js) selects adapters. The v1 event schema and append-only JSONL store are in [`core/schema.js`](../../core/schema.js) and [`storage/jsonl.js`](../../storage/jsonl.js).

The separate lifecycle schema supports task/segment evidence, interruptions, named capacity windows and observations, and v2 interval-completeness declarations ([`core/lifecycle-schema.js`](../../core/lifecycle-schema.js)). The authoritative raw lifecycle JSONL has **one writer**; its sidecar projection is rebuildable, not authoritative ([`storage/lifecycle-jsonl.js`](../../storage/lifecycle-jsonl.js)). Replayed event IDs are idempotent through the store, but conflicting raw duplicate IDs fail closed. T2 calibration requires compatible provider/window ID/reset/source/quality and does not split tokens across boundaries. T3 requires explicit `COMPLETE` account-activity interval evidence before capacity deltas become task-attributable; historical absent completeness stays `NOT_AVAILABLE` ([`core/calibration.js`](../../core/calibration.js)). Post-task settlement preserves separate delayed captures and never proves task attribution merely from a stable capacity reading ([`core/settlement.js`](../../core/settlement.js), [`storage/settlement-jsonl.js`](../../storage/settlement-jsonl.js)).

Current non-goals remain in force: provider-account acquisition, credential management, daemon scheduling, routing, billing, automatic retry/resume, and workflow authority. This proposal asks whether optional integration packages/processes and a read-only interface should be added **alongside**, rather than silently redefining, the present core. Existing exports, CLI, schemas, JSONL, lifecycle projections, estimator artifacts, and v0.5.0 consumers must remain valid until an independently reviewed migration contract says otherwise.

## Problem and observed acquisition evidence

Orchestrators currently carry provider-specific acquisition and response parsing. That couples workflow code to provider/runtime schema drift and makes evidence freshness and source identity difficult to review separately. Moving provider interpretation into telemetry can reduce that coupling **only if** telemetry returns typed, provenance-bound observations and the orchestrator never treats a missing observation as positive authority. Account-wide quota data is not task usage.

### OpenAI through OpenClaw (observed integration, not provider-direct attestation)

A current control-plane reader invokes `openclaw status --usage --json --agent <configured-agent>`, selects `usage.providers[]` where `provider` is `openai`, and reads `windows[]` entries such as `label`, `usedPercent`, and `resetAt` (numeric Unix milliseconds when valid). It presently classifies any returned 100% window as exhausted and can classify a response with only one otherwise valid window as available. That does **not** prove the independent five-hour **and** weekly windows required by a particular consumer policy. A separate diagnostic with a **20-second** timeout returned `UNKNOWN / TIMEOUT`; the normal control-plane default is **90 seconds**, configurable up to **300 seconds**. Neither normal-timeout success nor failure was established by that diagnostic. Acquisition latency needs measurement across initialization, Gateway communication, provider retrieval, and cache effects rather than assumption.

Design questions: identify five-hour and weekly by a documented/versioned mapping rather than label guesswork; represent missing or duplicate window identities as unavailable; preserve reset identity, source freshness and capture time; establish whether each field is provider-reported, client/runtime-reported, or derived; version the OpenClaw response adapter; bound/categorize errors and timeouts; measure command cost and consider coalesced/cacheable acquisition. Investigate any alternative **supported** subscription-usage source before choosing one. The immediate sandbox's removal of OpenAI capacity preflight is an operational decision and **must not be reversed** by this architecture or migration.

Historical OpenAI observations have included five-hour/weekly percentages and resets, and session/token/cache counters where exposed. These scopes differ. An account-window change does not become one task's token or capacity consumption without the existing T3 completeness proof.

### Anthropic Claude Code subscription (not API-key billing)

The relevant execution route is an authenticated **Claude Code subscription**. It must not silently switch to Anthropic API-key billing, a metered continuation, browser cookies, private endpoints, or extracted OAuth credentials. `claude -p "/usage"` has shown per-invocation usage rather than reliable subscription windows, so it is **not** established as a durable capacity source. Unsupported/private usage endpoints have returned authorization failures (including HTTP 403); they are not a proposed fallback.

An observed, control-only integration with CLI version `2.1.296` uses stream JSON and a correlated `control_request` for `get_usage` with `skip_behaviors: true`, with hooks disabled and no model-generated answer. It validates the CLI/runtime identity, request/response correlation, successful response, Pro subscription identity, and `rate_limits_available`. The primary observed windows are `rate_limits.five_hour` and `rate_limits.seven_day`, each with `utilization` in 0–100 and optional nullable `resets_at`. This is **observed integration behavior**, not a permanently guaranteed public provider contract. Version drift, auth expiry, mismatched responses and unsupported versions must fail closed.

Compatibility history illustrates why the boundaries must separate:

| Observed condition | Earlier reader effect | Proposed telemetry treatment | Orchestrator consequence |
| --- | --- | --- | --- |
| Four nullable per-window fields (`limit_dollars`, `locked_reason`, `remaining_dollars`, `used_dollars`) | A strict parser once returned `INVALID_WINDOW`; a later correction accepted their null form without changing utilization semantics. | Treat only documented, validated values as typed optional metadata; do not change primary-window readings. | No policy change. |
| Extra usage/spend, model-scoped, weekly breakdown, other extensions | Full-schema parsing could return `UNRESOLVED_QUOTA_SCHEMA` or more specific structural errors. | Preserve bounded `UNRECOGNIZED_METADATA`/adapter-version diagnostics; never guess applicability or publish raw response. Supported fields may be typed in a later adapter version. | Current scheduling still requires only the two named primary windows. |
| Missing/invalid primary utilization or window | `INVALID_WINDOW`, missing-window, or `RATE_LIMITS_UNAVAILABLE` paths. | Explicit missing/invalid field status and sanitized error category; no empty-list success. | Consumer fails closed to UNKNOWN unless a required-window exhaustion is independently established. |
| Null, invalid, stale, or reached reset | Missing/invalid/stale reset classifications have been observed. | Reset availability and provenance are separate from utilization; only a valid future reset is a scheduling hint. | Recheck; never infer AVAILABLE merely because a reset time passed. |
| Timeout, unsupported CLI, auth/identity failure, malformed/mismatched response | UNKNOWN/failure classifications. | Bounded, versioned, sanitized failure observation; no raw stderr/body. | Keep task paused and use controller-owned bounded retry/recovery. |

An existing two-window control-plane simplification deliberately limits **scheduling interpretation** to `five_hour.utilization`, `seven_day.utilization`, and optional resets. Telemetry may understand richer metadata for reporting and later analysis, but this proposal must not make supplementary fields mandatory for that scheduling policy or invent meanings for undocumented fields.

## Proposed responsibilities and trust boundaries

| Component | Owns | Must not own |
| --- | --- | --- |
| Provider acquisition integration | Bounded CLI/runtime call; source/runtime/auth-route validation; version-specific parsing; capture failure classification; redaction; timestamp and named-window evidence. | Browser-cookie extraction, unsupported private API scraping, prompts, paid-route switching, task dispatch. |
| Telemetry core + single writer + optional read projection | Provider-neutral event validation; exact token/cache dimensions; window identities/history; quality/provenance; sanitized error taxonomy; append-only evidence; deterministic read results; schema versioning. | Credential custody in common library, scheduling, owner override, workflow mutation, quota-to-token inference. |
| Orchestrator | Required window set and threshold; provider selection/dispatch; freshness ceiling for each decision; pause/recheck/backoff; durable task/restart recovery; owner gates; provider-interruption handling. | Provider-specific undocumented field interpretation; pretending stale/missing telemetry is AVAILABLE. |

The acquisition process should run under the already authorized CLI principal; it may **use** that principal's local auth context without exporting secrets to the common package, writer, read API, or consumer. A sidecar on a different host/user needs an explicit trust, transport, and source-identity design; do not assume an orchestrator user can or should read the provider user's auth files. A sanitized, configured **local alias** (not an email, raw account ID, or unsalted hash of one) can distinguish multiple accounts and usage surfaces. Subscription, API and UNKNOWN routes must be separate evidence dimensions. No route substitution is automatic.

## Discussion-only versioned evidence interface

`GET /v1/capacity/providers/{provider}` is an **illustrative candidate**, not an approved endpoint. It should return a stored snapshot only; a read must not silently launch a provider command. The same logical response could be exposed over a Unix socket, loopback HTTP, or a library/file projection. A `min_observed_at`/observation-ID condition could let a consumer demand evidence newer than an interruption; an unsatisfied condition returns `NOT_AVAILABLE`, never a historical AVAILABLE result. Interface `v1`, acquisition-adapter version, provider source-schema/CLI version, and raw JSONL event versions are independent axes.

Illustrative provider-neutral payload (synthetic values):

```json
{
  "api_version": 1,
  "provider": "anthropic",
  "usage_surface": "claude_code_subscription",
  "account_alias": "subscription_a",
  "observation_id": "obs-example-001",
  "source_identity": "claude_code_control_usage",
  "adapter_version": "example-1",
  "source_schema_version": "cli-verified-example",
  "observed_at": "2030-01-01T12:00:00.000Z",
  "recorded_at": "2030-01-01T12:00:00.100Z",
  "capture_status": "OK",
  "evidence_quality": "PROVIDER_CLIENT_REPORTED",
  "freshness": { "status": "FRESH", "age_seconds": 2, "expires_at": "2030-01-01T12:01:00.000Z" },
  "windows": [
    {
      "window_type": "five_hour",
      "window_id": "example-five-hour-epoch",
      "used_percent": { "value": 72, "availability": "OBSERVED", "quality": "PROVIDER_CLIENT_REPORTED" },
      "remaining_percent": { "value": 28, "availability": "DERIVED", "quality": "DERIVED" },
      "reset_at": { "value": "2030-01-01T15:00:00.000Z", "availability": "OBSERVED", "quality": "PROVIDER_CLIENT_REPORTED" }
    },
    {
      "window_type": "seven_day",
      "window_id": "example-weekly-epoch",
      "used_percent": { "value": "NOT_AVAILABLE", "availability": "NOT_AVAILABLE", "quality": "NOT_AVAILABLE" },
      "remaining_percent": { "value": "NOT_AVAILABLE", "availability": "NOT_AVAILABLE", "quality": "NOT_AVAILABLE" },
      "reset_at": { "value": "NOT_AVAILABLE", "availability": "NOT_AVAILABLE", "quality": "NOT_AVAILABLE" }
    }
  ],
  "error": { "category": "MISSING_REQUIRED_WINDOW_EVIDENCE", "detail": "NOT_AVAILABLE" }
}
```

The synthetic example intentionally has **incomplete** weekly evidence: `capture_status: OK` means the command returned, **not** that any consumer's required windows are usable. The consumer must compute UNKNOWN, not AVAILABLE. An alternative design may use `PARTIAL` capture status; the owner must choose precise semantics. `expires_at` is a derived local policy/cache bound, not a provider reset claim. If the source has no trustworthy observation timestamp, expose `NOT_AVAILABLE` and prohibit positive authority; do not use a display-time fallback. If the same usage surface reports only a label without independently proving a window type/reset identity, preserve it as unidentified metadata, not `five_hour` or `seven_day` by guess. `remaining_percent = 100 - used_percent` is `DERIVED`, not provider-observed. Token counters belong to a separate usage evidence view with explicit TASK/SESSION/ACCOUNT scope and per-dimension source; they are not inferred from this capacity view.

The API should use a small bounded error vocabulary (for example `TIMEOUT`, `AUTH_OR_SCOPE`, `UNSUPPORTED_SOURCE_VERSION`, `MALFORMED_RESPONSE`, `MISSING_REQUIRED_WINDOW_EVIDENCE`, `RATE_LIMITS_UNAVAILABLE`, `STALE`, `STORAGE_UNAVAILABLE`) and optionally a source-adapter diagnostic code, never raw provider text. Missing provider, wrong surface/account alias, corrupted store, stale snapshot, replay conflict, or API outage return unavailable/UNKNOWN-equivalent evidence or an explicit error. HTTP transport success (200) is **not** capacity authorization. Error status, response freshness, and each field's availability must be machine-readable. Stable observation IDs, canonical timestamps, bounded field sizes, monotonic source sequence or equivalent replay checks, and response consistency should be independently reviewed before implementation.

## Interface alternatives and preferred direction

| Option | Strengths | Costs/risks | Suitable condition |
| --- | --- | --- | --- |
| A. Authenticated loopback HTTP | Familiar versioned API, language-neutral clients, easy inspection. | Loopback alone is not authentication; port exposure, CSRF/SSRF, token/credential handling and service lifecycle add attack surface. TLS/identity needed if extended beyond one host. | Choose only if cross-process/platform reach and access control justify it. |
| B. Unix-domain socket / local IPC **(preferred for co-located first rollout)** | OS path/peer permissions can enforce least privilege; no TCP listener; language-neutral; clean read-only boundary. | Unix-specific deployment, cross-user group/ACL setup, peer-credential verification, socket lifecycle and atomic upgrade need design. | Preferred when acquisition/writer and orchestrator share a host but not credentials. |
| C. Library or file-based snapshot | Fewest moving parts; compatible with current library/JSONL; no daemon mandatory. | Reader may race writes, trust a stale projection, bypass access policy, or gain raw-store access; cross-language consumer and freshness proof are harder. | Good for development/offline analysis or a single trusted process, not assumed safe for cross-user production authority. |

**Preferred architecture:** retain the no-daemon core package; put version-pinned provider acquisition in optional integration packages/processes deployed beside the authenticated runtime; serialize sanitized writes through one writer; expose a read-only Unix-socket projection to the local orchestrator. A loopback HTTP adapter can implement the **same** versioned contract later if independently justified. This is a recommendation for discussion, not approval to create a daemon or change v0.5.0 non-goals. Provider-specific schema versions should evolve behind the neutral response contract; adding a provider need not change the orchestrator if it already understands the neutral window names and its own policy. A new provider with a new required policy still needs an orchestrator policy decision.

## Acquisition, caching, failure and recovery design constraints

- **Invocation:** choose caller-triggered, external schedule, or service-managed polling explicitly. Recommended first design is externally scheduled/bounded capture plus snapshot reads, with a separately authorized refresh path only if freshness requirements cannot be met. The orchestrator's GET must not have hidden provider side effects.
- **Coalescing:** one acquisition per `(provider, usage surface, local account alias, source version)` within a configured cache interval; concurrent readers share the same immutable observation ID. Cache a failure as failure for a short bounded interval, not as the last AVAILABLE reading. Measure actual OpenClaw/CLI latency before choosing timeout or TTL. Acquisition backoff belongs to the integration; workflow backoff belongs to the orchestrator.
- **Freshness:** return both source-observed and telemetry-recorded times, source identity, and a computed age/expiry for a consumer-supplied maximum age. Reset timestamps are *hints to recheck*, not expiry or proof of recovery. After a provider rejection/interruption, require a newer sufficiently fresh observation; an older AVAILABLE snapshot is replay and cannot resume a task.
- **Partial/error observations:** missing named windows, invalid percent, duplicate/ambiguous identity, timeout, auth expiry, unsupported version, malformed response, unavailable API, and store corruption remain explicit. Do not collapse missing windows to `[]` with an available status or silently use an unrelated provider/model/surface. Independently proven 100% in a required window may be represented even if a sibling is invalid, with partial-evidence provenance; consumer policy decides exhaustion precedence.
- **Durability:** never rewrite historical JSONL. Preserve the existing one-authoritative-writer contract, idempotent replay and conflict rejection; any queue, sidecar or multi-process ingestion needs an explicit ordering/acknowledgment and crash-recovery design. Rebuild projections from raw evidence. A corrupted or conflicting authoritative store makes the read interface unavailable until operator repair; it must not self-heal into a positive snapshot.
- **Task scope:** capture token/cache dimensions and their TASK/SESSION/ACCOUNT scope separately. Never derive task tokens from quota percentages. T3 `COMPLETE` requires exact adjacent observation IDs and all same-account activity, including other sessions, direct calls, background activity and idle gaps; no new acquisition source automatically supplies that proof. Settlement remains observation timing, not consumption attribution. Keep OBSERVED, DERIVED, ESTIMATED, `NOT_AVAILABLE` and COMPLETE/INCOMPLETE distinct.
- **Privacy:** publish only allowlisted bounded fields and sanitized categories. Do not store raw provider bodies, stderr, prompts, credentials, private account IDs, private repository names, production logs, or sensitive local paths in public artifacts or API responses. Unknown supplementary metadata should be identified by safe category/schema-version counters or audited allowlisted names, not copied blindly. Retention, file permissions, and access logs need a separate decision.
- **Isolation:** telemetry may report a subscription or API route but must never open one route as fallback for another, authorize paid usage, dispatch agents, mutate controller SQLite/workflow state, or consume owner overrides. A dead/stale interface fails closed. The orchestrator's own durable provider blocks, reset recheck, bounded retry, process restart recovery and owner gates remain authoritative.

## Compatibility and migration sketch (not an implementation plan approval)

1. Freeze v0.5.0 fixtures and current exports/JSONL as compatibility baselines. Document a new contract without changing `normalizeObservation`, package exports, CLI semantics, or old event readers. Decide whether API snapshots are projections of current lifecycle events or require a **new** additive versioned event; never squeeze source/auth/freshness facts into fields whose existing meaning differs.
2. Prototype a synthetic offline provider-neutral response and adversarial contract suite: required-window omission/duplication, malformed utilization, stale/missing resets, source-version drift, auth-route mismatch, concurrent writes, replay/corruption, post-interruption stale AVAILABLE, API outage, private-data redaction, T3 incomplete attribution. No live provider probe is needed to discuss this PR.
3. Review acquisition methods separately. Start one opt-in source with explicit credential-owner installation and sanitized test fixtures; measure latency and version behavior. Leave currently deployed orchestrator readers and capacity gates unchanged until equivalence and rollback are independently reviewed.
4. Add a shadow read-only comparison behind a separate owner gate. Compare normalized evidence against existing readers without changing dispatch decisions. Resolve missing-window, source provenance and freshness discrepancies; do not migrate or reclassify historical records.
5. Only after owner approval, review a bounded consumer migration that preserves controller-owned required-window policy, provider blocks, recovery, owner gates and the current decision to omit OpenAI from immediate sandbox preflight. Rollback restores the old reader without rewriting telemetry history. No phase in this document authorizes activation.

## Owner decisions required before implementation

| # | Decision | Preferred discussion starting point / alternative to resolve |
| --- | --- | --- |
| 1 | Acquisition ownership | Optional telemetry integration package/process; main core stays dependency-free and no-daemon. Alternative: main package, requiring explicit reversal of current non-goal. |
| 2 | Supported vs experimental methods | Version-pinned, observed CLI/runtime only after review; unsupported private endpoints and `/usage` assumptions excluded. |
| 3 | Collector placement | Under existing authenticated CLI OS principal; sidecar if consumer principal differs. Decide host/user trust explicitly. |
| 4 | Polling trigger | External bounded schedule first; compare caller-triggered or service-managed modes after latency evidence. |
| 5 | Duplicate expensive inquiries | Per-source coalescing/cache key, TTL and single-flight policy; decide failure-cache duration. |
| 6 | Consumer transport | Unix socket for co-located first rollout vs authenticated loopback HTTP vs library/file. |
| 7 | Freshness ceiling | Per-policy maximum age, source vs recorded time, and post-interruption `min_observed_at` semantics. |
| 8 | Timeout/backoff ownership | Acquisition timeout and fetch backoff in integration; dispatch/recheck backoff in orchestrator. Choose measured budgets. |
| 9 | Access control | OS peer credentials/socket ACL vs HTTP identity; read-only consumer, writer separated from credentials. |
| 10 | Schema versions | Independent provider-adapter/source-schema, neutral API, and append-only event versions; choose compatibility rules. |
| 11 | Supplementary fields | Typed allowlist and unknown-category diagnostics vs no storage; never raw dump or guessed applicability. |
| 12 | Error taxonomy | Stable bounded capture categories plus versioned adapter diagnostics; define malformed/partial precedence. |
| 13 | Multiple accounts/surfaces | Configured opaque local aliases and separate subscription/API/unknown routes; no raw identifiers in response. |
| 14 | Provenance/quality | Define provider vs client vs runtime reporting, derived fields, timestamp authority and source attestation. |
| 15 | T3 completeness | Retain exact `COMPLETE` producer proof; decide whether any new producer can truly account for all activity. |
| 16 | New providers | Adapter extension behind same neutral API; consumer policy changes only for newly required windows/surfaces. |
| 17 | Migration | Additive opt-in/shadow comparison, exact compatibility and rollback; no historical JSONL rewrite. |
| 18 | History exposure | Latest snapshot only for orchestrator; optional separately authorized bounded/audited history for analytics. |

Additional explicit gates: approve whether acquisition may ever be a background service; define who can request a fresh capture; specify retention and storage corruption response; establish a supported OpenAI five-hour/weekly mapping and source-authority level; decide whether the Claude control-only path is acceptable as an experimental integration; and separately approve any runtime activation. Until then the v0.5.0 README capability table is the current implementation truth.

## Acceptance criteria for a later implementation proposal

The next PR, if authorized, should prove with synthetic deterministic tests that two required fresh windows cannot be inferred from one; an exhausted required window cannot be cleared by a malformed sibling; unrelated supplementary fields cannot alter consumer policy; a reached reset causes re-observation, not authorization; stale/replayed AVAILABLE cannot resume after interruption; auth-route and source-version mismatches fail closed; public output is redacted; the single-writer append-only store survives replay/restart and rejects conflict; and T3 task-attribution, settlement and existing v0.5.0 consumers remain unchanged. Exact source identity, host deployment, provider latency and real authenticated behavior require separate evidence. This architecture PR supplies **no** implementation, live probe, deployment, or independent approval.
