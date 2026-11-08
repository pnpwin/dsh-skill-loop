# Curator + separate paired evaluator — v0.2.1

## What changed

The DSH skill creator supplies the authoring methodology. [Compact policy](../src/creator-policy.js) adds a small fixed rubric to the no-tools Curator: project applicability, positive triggers/near misses, minimal procedure/output/checks, genuine agent RED, no forced skill when baseline already succeeds, preservation of identities/protection, adaptation-only refinement and no invented receipts. The full authoring manual is not injected into every auxiliary request.

[Independent paired evaluator](../src/paired-evaluator.js) uses trusted immutable suites and fresh native ReAct agents. It is Host code, not the Curator scoring its own prose. There is no GEPA search, arbitrary shell execution, model-generated verifier authority, external model client or new server.

## Automatic sequence

1. Reflector → one typed Curator proposal under the existing payload/output bounds.
2. Stage pending using the strict Host-only publication option. Even a confirmed additive create is NOT published before evaluation.
3. Select exactly one trusted suite matching canonical project root AND exact candidate name. No match or ambiguous match → held-no-trusted-cases, no extra model calls and no fabricated tests.
4. Freeze active baseline (or no skill), candidate, selected model/reasoning and suite. Run paired adaptation agents with identical inputs/tools/step limits; only skill treatment differs. Candidate is preloaded through the checked scoped native registry. The built-in runner retains its controlled finite declarative environment, never generated-JS execution.
5. If adaptation fails for the candidate, at most one no-tools Curator refinement may use adaptation task/outcome feedback. No expected oracle or holdout feedback is supplied. Preserve the failed training report/cost, stage a new hash-bound pending revision, repeat both adaptation arms.
6. Only a complete adaptation gain with no candidate failure/regression advances to untouched holdout. Baseline already succeeds → no-gain, not forced refinement. Provider errors, shared cap truncation and unknown outcomes → inconclusive, never baseline RED.
7. Auto publication requires confirmed source evidence AND exact Host-owned paired receipt, adaptation+holdout gains, all candidate cases passed and no regressions. It still does not establish general causality or use of every entry. No-gain, no-holdout-gain, failed or incomplete evaluation stays pending. Explicit human approve remains independent authority.

Mode auto, source confirmation, protected entries, existing proposals and current50/50 settings are not reset. Old queue entries are not retro-published by activation. Core storage schema remains V2/backend domain1, no new table migration.

## Trusted suites

Native Config: requirePairedEvaluation=true, autoEvaluate=true, maxRefinements=1. requirePairedEvaluation=false explicitly restores the legacy soft-auto risk; models cannot change this through skill_loop. Trusted suites remain empty by default. Existing legacy holdout-only suites can remain configured but cannot qualify for strict paired automatic evaluation.

Use owner-reviewed declarativeCaseSetsJson or a trusted Host adapter. Suites have at most8cases, both adaptation and holdout, and automatic selection additionally requires:

```json
{"appliesTo":{"root":"/canonical/project","names":["learned-specific-procedure"]}}
```

The [native fixture format](../src/bench/native-cases.js) is a controlled operations interpreter, NOT a generic coding/browser/OS sandbox. Do not register unrelated math fixtures to certify a DSH-plugin skill. Non-supported domains need a relevant separately authorized trusted Host runner. The authoring workbench's model-authored spec is NOT imported as a trusted production verifier automatically. Human command `/skill-loop verifiers` reports applicability and splits; `/skill-loop verify ID CASESET` runs an already trusted suite manually.

## Authority / isolation

Receipts are process-local identity capabilities: copied/serialized objects, different registries, edited candidates, changed active bases, suites, scopes and a substituted budget handle are rejected. The strict Core gate also checks persisted protocol/baseline/comparison metadata. Entries/evidence remain governed by the existing Core grammar and confirmation gates; a callback cannot put confirmation/publication fields in a delta. All experimental native validation uses a separate project scope and cannot approve a main-library candidate.

The agent-facing skill_loop tool still only exposes status/read/reflect. No verify/register/confirm/approve/mode action was added to that tool. Pending text is not active instructions.

## Budgets / telemetry

Daily maxAuxCallsPerDay is shared by initial Reflector, Curator, optional refinement and EVERY evaluator dispatch/failure in the controlled agent scope. Persistent reservations serialize at the canonical project root; evaluator reservations do not increment review-cycle attempts. Existing counters survive upgrade (UTC rollover is unchanged).

Initial roles retain maxInputChars summed JSON cap and maxOutputTokens split1/3+2/3, role deadline timeoutMs. A single refinement may use up to maxInputChars and Curator's output allocation again. An automatic cycle has a hard logical cap2+verificationMaxCalls (default20), including that refinement. Evaluator deadline verificationTimeoutMs defaults120seconds after roles, plus cancellation/lifetime guards; manual verification defaults18calls and uses the daily auxiliary quota. Insufficient budget holds rather than granting new calls. Provider-reported usage, logical reservations, characters and UTF-8 bytes stay separate; unknown counters remain unknown.

Status now reports authoring policy/version/matching suites; bounded telemetry keeps all adaptation attempts, optional revision and receipt/comparison. Holdout outcomes never become Curator feedback. Native token totals/cache/reasoning are retained when reported; no character→token conversion or cost-savings claim is made.

## Activation / source generation

The final installed patch is v0.2.2: a no-suite default test exposed eager SDK initialization; the native runner is now created only when a registered case actually dispatches. A checksum-verified versioned runtime snapshot under src/runtime-v0.2.2 gives the installed update fresh physical ESM module URLs. This avoids claiming a source edit reloaded an already cached module, without patching the SDK or starting another GUI server. Build with node src/build-runtime.js, then node src/check-package.js. The generated files must match their source hashes before packing; tests still exercise editable source modules. Native storage/provider/tool/command identities remain unchanged.

See [README](../README.md), [Русский README](../README.ru.md) and [source attribution](../UPSTREAM.md). Live validation outcomes are reported separately and must not be replaced with the offline mock's positive scores.
