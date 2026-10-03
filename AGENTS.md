Agent Usage Telemetry — Agent Guidance

Purpose

This repository provides a small, provider-neutral telemetry library and CLI for
recording, normalizing, storing, summarizing, and calibrating AI-agent usage
evidence.

The project exists to make provider usage evidence more honest and auditable.

It may represent:

- token counters;
- cache counters;
- provider capacity observations;
- reset times;
- interruptions;
- logical tasks;
- execution segments;
- capacity windows;
- interval-completeness evidence;
- settlement observations;
- deterministic summaries;
- conservative capacity-estimation artifacts.

The package observes and reports evidence.

It does not own workflow policy.

---

Core boundary

This package is telemetry, not orchestration.

Do NOT turn it into:

- a task scheduler;
- an agent router;
- a retry controller;
- a provider-switching engine;
- a workflow state machine;
- a quota-enforcement system;
- a billing engine;
- an account-plan decision engine;
- a background daemon;
- a messaging system;
- a credential manager.

Callers own policy.

Telemetry records what can be supported by evidence.

---

Fundamental evidence rule

Never manufacture evidence.

When a value is unavailable:

use the repository's explicit unavailable representation.

Examples include:

"NOT_AVAILABLE"

or another schema-defined unavailable state.

Do not replace missing evidence with:

- zero;
- an inferred estimate;
- a guessed percentage;
- a derived token count;
- a wall-clock approximation;
- a model assumption.

Absence of evidence must remain visible.

---

Evidence classes must remain distinct

The repository distinguishes evidence by provenance and quality.

Where applicable preserve distinctions such as:

- OBSERVED;
- DERIVED;
- ESTIMATED;
- NOT_AVAILABLE;
- COMPLETE;
- INCOMPLETE;
- UNKNOWN.

Do not relabel derived evidence as observed.

Do not relabel estimated evidence as observed.

Do not allow estimates to overwrite provider observations.

Do not silently strengthen evidence quality during normalization or projection.

---

Provider-reported counters

Use exact provider/runtime counters when they are supplied.

Do not infer hidden counters.

In particular:

- do not invent reasoning-token counts;
- do not infer quota weighting;
- do not infer hidden provider billing formulas;
- do not reverse-engineer account capacity from unsupported assumptions.

A total token count is valid only under the repository's declared source rules,
for example when provider-reported or deterministically summed from complete
dimensions.

---

Capacity observations

Provider capacity evidence is separate from token evidence.

A percentage observation must not be converted into tokens unless a separate
explicit estimator contract supports the operation.

Preserve:

- provider;
- model where relevant;
- window type;
- window identity;
- reset identity;
- source;
- quality;
- observation timestamp.

Do not combine incompatible windows.

Examples:

- 5-hour;
- weekly;
- future provider-specific windows

must remain independent unless an explicit compatible model says otherwise.

---

Account-wide versus task-attributed evidence

Account-wide provider capacity change is not automatically task consumption.

This is a critical invariant.

A task may be attributed a provider-capacity interval only when the required
account-activity completeness evidence is satisfied.

Potential competing activity includes:

- concurrent executions;
- other sessions;
- direct provider calls;
- background or heartbeat activity;
- retries;
- provider overhead;
- activity outside the recorder;
- idle-gap consumption.

If account-wide completeness cannot be established:

task-attributed capacity remains unavailable.

Do not subtract start/end percentages and label the result as task consumption
without the required evidence contract.

---

Completeness

Completeness cannot be estimated.

If an interval-evidence producer cannot prove complete attribution:

record:

- INCOMPLETE; or
- NOT_AVAILABLE

with the appropriate qualitative cause.

Do not upgrade incomplete historical evidence merely because more code now
exists.

Replay must not silently improve old evidence.

---

Logical tasks and execution segments

A logical task is not the same thing as a process, model call, run, session, or
capacity window.

One logical task may span:

- multiple execution segments;
- multiple provider windows;
- interruptions;
- sessions;
- resumes;
- providers where supported by the caller.

Preserve task identity independently from execution identity.

Do not collapse a multi-segment task into one provider run unless the evidence
actually says they are identical.

---

Time accounting

Derived time accounting must remain deterministic.

For completed tasks, calculate intervals from durable timestamps.

Do not use implicit current time for reproducible historical summaries.

For incomplete tasks where the repository contract says duration is
unavailable:

return "NOT_AVAILABLE".

Do not substitute "time so far" unless the schema explicitly defines that
different concept.

When calculating unions:

- overlapping execution segments must not double-count;
- overlapping provider interruptions must not inflate duration;
- active execution must not simultaneously count as capacity-blocked time where
  the repository contract subtracts it.

---

Raw storage authority

Raw append-only JSONL is authoritative where the current architecture declares
it authoritative.

Normalized projections and sidecars are derived.

They may be:

- missing;
- stale;
- deleted;
- rebuilt.

They must not silently become a stronger source of truth than raw evidence.

On reopen/rebuild:

derive projections deterministically from raw events.

Do not rewrite historical raw events merely to make a projection easier.

---

Append-only behavior

Preserve immutable historical evidence.

Do not edit old records to reflect a newer interpretation.

If semantics change:

- version the schema/event where required;
- rebuild derived artifacts;
- retain old raw evidence.

Conflicting evidence should fail closed according to repository rules rather
than being silently reconciled by mutation.

---

Event identity

Stable event IDs provide replay identity.

Exact replay of the same valid event may be idempotent.

Do not deduplicate unrelated events merely because:

- timestamps match;
- counters match;
- values look similar.

If duplicate IDs already exist in raw authoritative storage in a way that
violates repository invariants:

fail closed.

Do not silently repair authoritative bytes.

---

Terminal logical tasks

Terminal task evidence is durable.

Once a task reaches a terminal state such as:

- COMPLETED;
- FAILED;
- CANCELLED

later evidence must not silently:

- reopen it;
- select another terminal status;
- change terminal time.

Compatible enrichment may be allowed only where current repository contracts
explicitly permit it.

---

Settlement observations

Provider capacity may settle after immediate task completion.

Preserve timing semantics.

Do not relabel an immediate post-task observation as a settled measurement.

Settlement evidence should retain:

- sequence;
- scheduled delay;
- observed delay;
- provider/window identity;
- reset identity;
- source;
- quality;
- capture failure category.

Settlement is observation timing.

It is not proof of task attribution.

A stable post-task percentage does not by itself prove task consumption.

---

Fail closed

When evidence is malformed, incompatible, ambiguous, or insufficient:

fail closed.

Do not silently:

- coerce malformed timestamps;
- accept extra unsupported schema fields;
- accept incompatible window identities;
- infer missing reset identity;
- accept unsanitized paths or IDs;
- convert malformed values to zero;
- accept stale estimator artifacts as current.

---

Provider adapters

Provider adapters must be thin mappings.

They should map only values directly supplied by the integration/provider
observation into the common schema.

A provider adapter must not contain hidden assumptions about:

- quota size;
- token weighting;
- billing;
- model equivalence;
- reset behavior;
- task attribution.

For a new provider:

1. add the smallest adapter;
2. map directly exposed values;
3. return unavailable states for unsupported evidence;
4. add sanitized tests;
5. update capability documentation only for demonstrated behavior.

---

Calibration and estimation

Calibration is secondary to observed evidence.

Observed provider/runtime evidence always outranks model estimates.

Training must remain:

- deterministic;
- scope-bound;
- reproducible;
- conservative about missing dimensions.

Do not mix incompatible:

- providers;
- models;
- window types;
- window identities;
- reset intervals.

Do not train from evidence declared incomplete.

Do not silently coerce missing token dimensions into zeros.

Do not proportionally split token counts across capacity-window boundaries unless
a future explicit contract allows it.

Cross-boundary evidence that cannot be attributed must remain unavailable.

---

Estimator artifacts

Estimator artifacts must carry enough identity to detect staleness.

Where applicable preserve:

- estimator/model version;
- provider;
- model;
- window scope;
- training sample count;
- validation metrics;
- training-evidence digest;
- confidence.

Stale training evidence must not silently produce a current-looking model.

Rebuilding from identical append-only evidence should produce deterministic
results.

---

Confidence

Confidence is evidence metadata, not marketing language.

Do not upgrade confidence without satisfying the declared sample and validation
criteria.

Out-of-training-range usage should be conservatively downgraded where current
policy requires it.

Do not invent a confidence value merely to avoid returning unavailable.

---

Privacy and sanitization

This is a public repository.

Never commit:

- real API keys;
- OAuth tokens;
- provider credentials;
- private account identifiers;
- private project names where prohibited;
- prompts;
- raw provider error bodies;
- private source code;
- absolute private host paths;
- private logs;
- production telemetry records.

Fixtures must remain synthetic and sanitized.

Preserve useful structure without reproducing private data.

---

Raw provider errors

Do not persist raw provider error text.

Normalize interruptions into the bounded category set used by the repository.

Raw errors may contain:

- account identifiers;
- request IDs;
- provider internals;
- secrets;
- private URLs;
- user content.

Store only the bounded evidence required by the telemetry contract.

---

No credentials

The package does not read provider credentials or call private account APIs as
part of its core library contract.

Do not add:

- API-key discovery;
- browser-cookie extraction;
- OAuth token handling;
- provider login automation;
- credential storage.

Provider-specific integrations may supply sanitized observations from outside
the package.

The library consumes observations.

It does not become an account client.

---

Dependency discipline

The project intentionally has a small runtime footprint.

Do not add dependencies casually.

Before adding one, determine whether the behavior can remain deterministic and
dependency-free.

A dependency must provide meaningful value that cannot reasonably be achieved
with the current platform/runtime.

Preserve supported Node.js versions declared by the project.

---

Schema discipline

JSON schemas are public compatibility contracts.

Schema changes require careful review.

For schema modifications verify:

- backwards compatibility;
- versioning;
- required versus optional fields;
- additional-property behavior;
- canonical timestamps;
- allowed enums;
- sanitization rules;
- replay/rebuild behavior;
- fixture compatibility;
- README/API documentation.

Do not weaken validation merely to make a new fixture pass.

---

Public API stability

Exports from "index.js" and package export paths are public API.

Avoid accidental breaking changes.

When changing:

- function signatures;
- returned structures;
- CLI output;
- schema versions;
- import paths

review compatibility explicitly.

---

CLI behavior

CLI output must reflect the same evidence semantics as the library.

Do not let human-readable rendering:

- hide unavailable values;
- relabel estimates as observations;
- collapse evidence quality;
- invent percentages;
- omit material uncertainty.

Machine-readable and human-readable forms should tell the same truth.

---

Non-goals must remain non-goals

Do not opportunistically add:

- dashboards;
- orchestrator state transitions;
- agent routing;
- automated provider switching;
- retry policy;
- account-plan recommendations;
- cost/billing estimation;
- automated background schedulers;
- external messaging;
- live provider account scraping.

If such work becomes useful, it should normally live in a different integration
or control-plane project.

---

Agent roles

Implementer

The implementation agent may:

- inspect repository state;
- implement bounded changes;
- add tests;
- update documentation required by the change;
- produce a candidate commit.

The implementer must not:

- fabricate provider evidence;
- weaken validation;
- change public semantics outside task scope;
- rewrite historical fixtures merely to make tests pass;
- silently broaden the package into orchestration.

Reviewer

The reviewer independently evaluates the exact candidate revision.

The reviewer should focus on:

- evidence integrity;
- provenance;
- schema compatibility;
- deterministic reconstruction;
- privacy;
- fail-closed behavior;
- incorrect inference;
- public API compatibility;
- storage invariants;
- calibration validity.

Detailed Claude/Jan review behavior belongs in "CLAUDE.md".

---

Exact-SHA discipline

Review and validation should bind to the exact candidate SHA where the workflow
requires it.

A verdict for SHA A does not approve SHA B.

When a candidate changes:

- prior findings remain historical evidence;
- affected findings should be rechecked against the new SHA;
- unchanged evidence may be reused only where still valid.

Do not present an older verdict as current.

---

Review efficiency

Deterministic CI owns broad mechanical regression evidence.

Independent review should concentrate on claims CI does not establish.

Do not automatically duplicate the entire test suite merely to prove
independence.

Use focused probes for:

- malformed evidence;
- missing dimensions;
- incompatible capacity windows;
- duplicate event IDs;
- terminal-state conflicts;
- stale estimator artifacts;
- incomplete attribution;
- settlement-boundary behavior;
- raw-error sanitization;
- projection rebuild behavior.

Full-suite reviewer reruns should have a concrete reason.

---

Provider interruption during development/review

Provider-capacity exhaustion is an execution interruption, not evidence about
the code.

Preserve work and resume the same logical task/review when capacity returns.

Do not restart completed analysis solely because a provider window reset.

If review execution is resumable, preserve completed review stages.

---

Scope discipline

Keep changes bounded.

Do not mix unrelated:

- telemetry semantics;
- provider adapters;
- estimator changes;
- schema migrations;
- CLI changes;
- storage changes

unless the task explicitly requires them together.

New unrelated findings should be recorded rather than opportunistically fixed.

---

Testing

Run:

"npm test"

"npm run check"

"npm run pack:check"

where applicable to the change.

Also run focused tests for changed behavior.

Never claim a test passed unless it was actually executed.

Tests must include unavailable/failure evidence, not only happy paths.

---

Security checks

Run configured repository security checks.

Do not bypass or weaken a scanner to permit secret-shaped fixtures.

Prefer obviously synthetic placeholders that retain structural usefulness
without resembling real credentials.

---

Documentation

README claims must match demonstrated implementation behavior.

When a capability changes:

update the capability documentation.

Do not document unsupported provider behavior as available.

Do not use aspirational wording that looks like a current guarantee.

---

Final handoff

A completed implementation handoff should include where applicable:

- starting SHA;
- branch;
- candidate SHA;
- files changed;
- semantics changed;
- schema/API compatibility;
- tests executed;
- test results;
- security result;
- reviewer verdict and exact SHA;
- unresolved limitations;
- exact owner decision required.

Do not merge without the applicable workflow authority.

---

Operating principle

Telemetry must prefer an honest absence over a convincing fiction.

If evidence is not available:

say so.

If attribution is incomplete:

say so.

If an estimate is an estimate:

label it.

If a projection can be rebuilt:

do not confuse it with raw authority.

The purpose of this repository is not to make telemetry look complete.

The purpose is to make the evidence trustworthy.