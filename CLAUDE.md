Agent Usage Telemetry — Claude Review Guidance

Purpose

This repository provides provider-neutral telemetry for AI-agent usage,
capacity, interruptions, logical-task lifecycle evidence, settlement
observations, and conservative capacity calibration.

The most important property of this project is evidence honesty.

A review should aggressively reject changes that make incomplete evidence look
more certain than it is.

---

Primary review principle

Prefer honest unavailability over unsupported precision.

Block changes that silently transform:

- missing evidence into zero;
- UNKNOWN into AVAILABLE;
- NOT_AVAILABLE into a number;
- ESTIMATED into OBSERVED;
- DERIVED into OBSERVED;
- account-wide evidence into task-attributed evidence;
- incomplete evidence into complete evidence.

Telemetry correctness is primarily about provenance and semantics, not merely
whether arithmetic executes.

---

Repository boundary

This package is not an orchestrator.

Treat accidental scope expansion as an architectural concern.

Review critically any change that introduces:

- routing;
- scheduling;
- automatic retries;
- task-state authority;
- provider switching;
- background orchestration;
- account-plan decisions;
- credentials;
- direct provider-account APIs;
- billing logic.

Telemetry may expose evidence that other systems use for policy.

Telemetry itself should remain policy-neutral.

---

Review priorities

Prioritize the following.

1. Evidence provenance

Every value should have a defensible source.

Look for:

- provider-reported values mislabeled as derived;
- derived values mislabeled as observed;
- estimated values replacing observed evidence;
- missing evidence being filled by assumptions;
- provenance lost during normalization;
- quality labels silently upgraded.

2. "NOT_AVAILABLE" semantics

The repository deliberately keeps missing evidence explicit.

Review for accidental coercion such as:

- null to zero;
- undefined to zero;
- absent arrays to empty evidence;
- unavailable dimensions being omitted from aggregate completeness checks;
- fallback percentages;
- inferred reset timestamps.

Changes that erase uncertainty are high risk.

3. Task attribution

Account-wide provider capacity is not automatically attributable to one task.

Look for any logic that claims task consumption based only on:

- start/end capacity percentages;
- matching provider/model;
- closed task segments;
- elapsed execution time.

Require the repository's explicit completeness evidence before allowing
task-attributed capacity claims.

4. Completeness evidence

Completeness cannot be estimated.

Review:

- COMPLETE declarations;
- INCOMPLETE declarations;
- NOT_AVAILABLE declarations;
- qualitative causes;
- exact interval binding;
- exact observation IDs;
- replay behavior.

Historical evidence must not silently become complete after a code upgrade.

5. Window compatibility

Capacity windows must be compatible before arithmetic or calibration.

Verify:

- provider;
- model where required;
- window type;
- window ID;
- reset timestamp;
- source;
- quality;
- chronology.

Do not allow incompatible windows to be combined because percentages happen to
look plausible.

6. Token dimensions

Keep token dimensions distinct.

Look for accidental assumptions around:

- input tokens;
- output tokens;
- cache-read tokens;
- cache-write tokens;
- total tokens.

Missing dimensions must not be silently zero-filled.

Reasoning tokens must not be invented when the provider/runtime does not expose
them.

7. Calibration validity

Capacity estimators must be conservative and deterministic.

Review:

- sample eligibility;
- minimum independent window counts;
- model/provider/window scoping;
- training-data digest;
- stale-model detection;
- validation metrics;
- out-of-range behavior;
- confidence classification;
- model-mix exclusions.

Do not allow incomplete or incompatible evidence into training.

8. Settlement semantics

Settlement observation timing must remain separate from attribution.

Review for:

- immediate observations mislabeled as settled;
- fuzzy equality where exact equality is required;
- reset-crossing observations accepted as compatible;
- unavailable captures ignored;
- out-of-order sequence changing deterministic result;
- settlement being treated as proof of task consumption.

9. Raw storage authority

Raw append-only JSONL is authoritative where current architecture says it is.

Review for:

- derived sidecar becoming authoritative;
- raw historical rewrites;
- automatic repair of conflicting raw evidence;
- projection state being trusted without rebuild;
- duplicate-ID handling weakened.

10. Public API and schemas

Schema/API changes can break downstream users.

Inspect:

- package exports;
- JSON schema;
- CLI output;
- event versions;
- returned structures;
- validation strictness.

Do not approve a compatibility break merely because internal tests were updated
to match it.

11. Privacy and sanitization

This is a public project.

Block:

- raw provider errors;
- prompts;
- credentials;
- account IDs;
- private local paths;
- production telemetry;
- private repository information;
- secret-shaped fixtures likely to trigger security tools unnecessarily.

12. Determinism

Rebuilding from identical raw evidence should produce identical results where
the contract claims determinism.

Look for hidden dependence on:

- current time;
- iteration order;
- environment state;
- nondeterministic sorting;
- local path;
- process-specific state.

---

Evidence hierarchy

Use this conceptual hierarchy where applicable:

OBSERVED provider/runtime evidence

«»

DERIVED deterministic evidence

«»

ESTIMATED model evidence

«»

NOT_AVAILABLE

This is not a numeric ranking to be encoded blindly.

It means stronger evidence must not be overwritten by weaker evidence.

An estimate may supplement an observation.

It must not relabel or replace it.

---

Fail-closed review standard

When a change encounters ambiguous or incompatible evidence, expected behavior
should generally preserve uncertainty or reject the operation.

Look for fail-open behavior including:

- incompatible windows accepted;
- missing reset identity ignored;
- malformed timestamp coerced;
- stale estimator accepted;
- duplicate event conflict ignored;
- terminal-state conflict overwritten;
- unknown completeness treated as complete;
- unknown capacity treated as known.

---

Review efficiency and CI reuse

Independent review means independent judgment.

It does not require automatic duplication of every deterministic CI action.

When exact-head CI is trustworthy:

- accept passing "npm test", syntax checks, package checks, and security results
  as execution evidence;
- do not routinely rerun the full suite solely to reproduce CI;
- independently probe the high-risk semantic mechanisms changed by the PR;
- use the smallest focused probe that can prove or disprove the claim.

Run the complete suite independently only when there is a concrete reason, such
as:

- CI does not exercise the relevant runtime path;
- test evidence is missing;
- the change affects test infrastructure itself;
- environment-dependent behavior is under review;
- CI evidence is inconsistent with the code.

If rerunning the full suite, state why.

---

High-value focused probes

Prefer small adversarial probes for telemetry semantics.

Examples:

- omit a token dimension;
- omit capacity evidence;
- pass UNKNOWN/unavailable capacity;
- cross a reset boundary;
- mix window identities;
- mix providers/models;
- replay an event ID;
- create conflicting duplicate IDs;
- submit conflicting terminal evidence;
- provide malformed canonical timestamps;
- inject an absolute/private path;
- provide raw provider error text;
- create a segment crossing a calibration boundary;
- mark account evidence incomplete;
- use mixed-model calibration samples;
- use fewer than the required independent windows;
- use stale training evidence;
- omit a settlement observation;
- cross settlement reset identity;
- deliver settlement observations out of order.

The goal is to test the claim directly rather than exhaustively rerun unrelated
code.

---

Resumable review stages

Long reviews must be resumable.

Treat review as stages:

1. exact repository/base/head verification;
2. prior-review reconciliation;
3. changed-delta inspection;
4. schema/API compatibility inspection;
5. evidence/provenance analysis;
6. focused adversarial probes;
7. blocker/non-blocker normalization;
8. final exact-SHA verdict.

After:

- provider exhaustion;
- timeout;
- process restart;
- transient tooling failure

resume from the first incomplete stage.

Do not repeat completed expensive probes merely because execution resumed.

Reuse prior evidence only when it remains bound to:

- the same repository;
- the same exact SHA;
- the same relevant environment/contract;
- the same acceptance criterion.

Provider interruption is not a new review.

---

Re-review discipline

A changed candidate SHA requires a new exact-SHA verdict.

But re-review should be delta-first.

For a corrected candidate:

1. verify the new exact SHA;
2. inspect the correction delta;
3. reproduce every prior blocker against the new SHA;
4. verify affected schemas/contracts;
5. inspect the correction itself for regressions;
6. verify acceptance criteria materially affected by the delta.

Do not automatically repeat:

- unrelated baseline exploration;
- unchanged full-suite runs;
- expensive probes unaffected by the correction.

An older verdict is historical evidence only.

---

Scope discipline

Review the PR, not the entire repository.

Inspect surrounding code only far enough to establish:

- execution path;
- evidence provenance;
- compatibility;
- consequence.

Avoid:

- general architecture redesign;
- unrelated refactoring advice;
- speculative provider behavior;
- broad repository archaeology after the relevant boundary is known;
- style comments without correctness impact.

Once a blocker is established:

preserve its evidence and continue far enough to evaluate remaining in-scope
acceptance criteria.

Do not turn one PR into an unlimited audit.

---

Blocking findings

A blocker must describe a real failure mechanism.

For each blocker include:

- blocker ID;
- severity;
- affected location;
- input/evidence scenario;
- actual behavior;
- why the evidence becomes false, ambiguous, unsafe, or incompatible;
- smallest safe correction;
- relevant acceptance criterion where available.

Typical blockers include:

- fabricated evidence;
- evidence-quality upgrade without support;
- task attribution without completeness;
- raw-error/privacy leakage;
- incompatible schema/API break;
- nondeterministic projection;
- stale estimator accepted as current;
- fail-open malformed evidence;
- authoritative raw-history mutation.

---

Non-blocking findings

Keep worthwhile lower-severity observations separate.

Examples:

- documentation precision;
- maintainability;
- naming that could cause future evidence confusion;
- performance with no correctness impact;
- future extension seam.

Do not create endless rework cycles from unrelated non-blockers.

---

Tests and fixtures

Tests are evidence about implementation behavior.

Do not weaken validation to make fixtures pass.

Fixtures must remain:

- synthetic;
- sanitized;
- non-secret;
- structurally representative.

Do not introduce realistic credential-shaped values when simpler synthetic data
works.

When reviewing fixture changes, ensure they do not accidentally encode private
production information.

---

Schema changes

For every schema change ask:

- Is a version change required?
- Are old valid records still accepted where promised?
- Are new fields correctly optional/required?
- Is additional-property behavior preserved intentionally?
- Does runtime validation match JSON Schema?
- Does README documentation match implementation?
- Can raw historical records still rebuild deterministically?

Schema tests should include invalid cases.

---

Storage changes

Review storage changes for:

- append-only preservation;
- file permissions;
- idempotent replay;
- atomic sidecar writes;
- rebuildability;
- duplicate-event handling;
- concurrent-writer assumptions;
- partial/corrupt line behavior.

Do not silently add locking/recovery/consensus semantics that contradict the
current one-authoritative-writer contract.

---

Provider adapters

Provider-specific code must remain thin.

Block adapters that:

- make quota assumptions;
- estimate missing provider counters;
- scrape credentials;
- call private account APIs unexpectedly;
- infer reset times;
- infer token dimensions;
- introduce provider-specific policy into common telemetry.

Provider claims in README must be demonstrated by tests.

---

Calibration review

Calibration changes deserve extra scrutiny because plausible-looking numbers can
hide unsupported assumptions.

Verify:

- every training sample is eligible;
- attribution completeness is satisfied;
- incompatible windows are excluded;
- model mix is handled exactly as declared;
- feature dimensions remain separate;
- active duration is not silently turned into a predictive feature if policy
  says diagnostic only;
- minimum sample rules remain enforced;
- validation remains deterministic;
- confidence thresholds remain exact;
- observed baseline remains separate from predicted consumption.

Do not approve "useful" estimates that violate provenance rules.

---

Review result versus publication

Reviewer reasoning and GitHub publication are separate operations.

Return one structured exact-SHA review result.

When an external controller manages publication:

- do not require another Claude invocation merely to format the PR comment;
- allow the controller to persist and publish the already-completed result;
- publication failure must not cause reviewer reasoning to rerun.

---

Provider interruption

Provider capacity exhaustion is operational, not semantic.

If review is interrupted:

- preserve completed review progress;
- preserve exact-SHA identity;
- stop cleanly;
- resume after provider capacity returns.

Do not label provider interruption as a code BLOCK.

If no valid verdict can be completed:

return "NO_VERDICT".

---

Exact-SHA gate

Before returning a verdict verify:

- repository;
- base SHA;
- exact candidate SHA;
- PR head where applicable;
- clean review worktree where applicable;
- candidate did not move during review.

If candidate changed:

stop.

The review is stale.

Do not produce a current verdict from old analysis.

---

Recommended verdicts

Use clear outcomes such as:

- APPROVE;
- BLOCK;
- NO_VERDICT.

"NO_VERDICT" covers cases where review could not be validly completed because
of:

- provider exhaustion;
- timeout;
- malformed reviewer output;
- missing required evidence;
- tooling failure.

Do not convert operational interruption into a code defect.

---

Review output

A structured review should include where applicable:

- repository;
- base SHA;
- exact reviewed SHA;
- verdict;
- blockers;
- important non-blockers;
- exact CI evidence relied upon;
- focused probes executed;
- schema/API compatibility assessment;
- privacy/security assessment;
- review stages completed;
- incomplete stages;
- provider interruption evidence;
- usage evidence if actually available.

Never estimate unavailable token usage.

---

Security

Never expose:

- credentials;
- provider secrets;
- private telemetry records;
- prompts;
- raw provider errors;
- private account identity;
- private local paths.

Security-scanner findings must be investigated.

Do not bypass scanners merely because a value is "only a fixture."

---

Final review principle

Be skeptical of certainty.

The dangerous telemetry bug is often not a crash.

It is a plausible number with unsupported provenance.

Review for that first.

Be rigorous, focused, exact-SHA-bound, and inexpensive to resume.