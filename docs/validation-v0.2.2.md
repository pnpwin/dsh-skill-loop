# v0.2.2 — Curator / separate evaluator validation

2026-11-08, Europe/Moscow. This patch integrates the methodology of the ONE dsh-skill-creator0.1.0 into skill-loop; it does not install a second authoring skill or import model-authored evaluation specs as trusted authority.

## Implemented / offline checked

- Compact fixed [Curator rubric](../src/creator-policy.js), provenance/body hash pinned.979characters/979UTF-8bytes vs7735characters/7739bytes of the full source skill body. This is a structural context comparison, **not provider-token savings**. Native Curator system measured2840characters.
- [Separate Host paired evaluator](../src/paired-evaluator.js): no-skill/current-active baseline, frozen body/base/suite/scope/model, identical task/tool/step conditions, adaptation first, untouched holdout only after gain.
- At most one no-tools refinement receives adaptation task/outcome feedback only, with fresh candidate hash and repeated pairs. Failed training remains in bounded telemetry. No expected oracle/holdout feedback enters Curator.
- Strict default applies to every auto publication, including additive creates. Staging is deferred until a fresh registry-owned evaluation; old persisted passes cannot publish before current suite checks. Identity receipts bind exact hashes; copies, altered baselines/scopes/cases and substituted budgets lose authority.
- Missing/ambiguous relevant project suite → held-no-trusted-cases. Passing baseline → no-gain, no forced skill or wasted holdout. Errors/global truncation → inconclusive, not agent RED. Explicit human approval/source confirmation/protection/mode boundaries preserved.
- Evaluator dispatches and refinement share persistent daily auxiliary quota. Local total-cycle budget includes initial roles, native task/auxiliary calls, errors and revision. Unknown tokens remain null.

**315 offline tests pass.** Positive auto-publication, one-refinement path, exact binding, suite relevance, no-gain, regressions, failure/cancel, no holdout leakage, persistent shared quota and legacy compatibility are covered. The final default-policy test caught eager SDK initialization before detecting no suite; fixed by lazy runner construction in v0.2.2. The complete suite was rerun successfully after that correction.

## Actual native check —9/18 calls

Disposable native helper loaded the actual versioned runtime's Curator/evaluator/driver, not a separate simulated LLM. Selected model: openai-codex / gpt-6.1-sol / high.

The controlled source was explicitly an **unconfirmed hypothesis**, not a fabricated successful work episode or baseline-agent failure. One real no-tools Curator drafted a pending procedure; source evidence stayed unconfirmed. Two fresh native ReAct agents then attempted the same finite stable-uniqueness task with identical inputs/tools: baseline without the target skill and candidate with the exact scoped native-registry body. The interpreter selects predefined operations only; no generated JavaScript executed.

Candidate: learned-stable-first-occurrence-uniqueness. Hash `4bc465cbe44e2ee515f21a3c9c29214bda693c33c8df4cc1cf738a7b7a903714`. Candidate-only evaluation status did not imply publication. [Portable measured data](../src/validation/v0.2.1/native-summary.json).

| Component | Actual calls | Input tokens | Output tokens | Native totalTokens | Elapsed |
|---|---:|---:|---:|---:|---:|
| Curator |1|759|383|1142|12814ms|
| Baseline adaptation agent |4|3342|70|8916|7558.59ms|
| With-skill adaptation agent |4|4375|88|10735|12528.50ms|

Both adaptation agents passed; protected fixture metadata remained unchanged. **Verdict:no-gain.** Evaluator returned passed=false for the publication criterion. No refinement or holdout dispatch was warranted;9calls of18remained unused. Local budget and separate durable validation ledger both recorded9, zero denied reservations. No generated skill was approved/published to the main library.

This validates the native Curator and paired-control path plus an honest stop, **not** a native observed RED→GREEN improvement or a generally useful new learned skill. Positive gain/holdout/publication/refinement branches were exercised offline with clearly synthetic Host callbacks, not passed off as real model gains.

Totals reported by native provider fields: input8476, output541, totalTokens20793. Native totalTokens is retained as reported and is not recomputed from input+output; cache/reasoning decomposition and hidden HTTP/billing totals remain unknown. The candidate used more measured tokens/time in this single finite task; no cost, speed, causality or transfer claim is supported.

The native component run used v0.2.1 generation. v0.2.2 changes only lazy no-suite runner setup/version in runtime wiring; the executed Curator policy, review implementation, paired evaluator, Core gate and native case-driver modules are byte-identical in the final generation. No additional paid run was used to conceal the default-path regression.

## Live installation / state

Installation uses Plugin Manager only, preserving local-skill-loop/skill_loop identities and V2/backend-domain1. Fresh checksum-verified versioned module paths prevent claiming a cached source edit became live. Final active runtime version is verified through native status after installation.

Main project stays auto, unpaused, limits50cycles/50combined auxiliary reservations per UTC day; new UTC date already rolled counters to0before upgrade. Skills0, pending8, lessons11, runs14 and all prior pending IDs/hashes remain unchanged. Old queue was not retro-published. The temporary validation bundle/tool was removed and its job collected; tiny isolated test ledger/artifacts remain for audit. No credentials, SDK, GUI server, main-library confirmations or publication were modified.

**There are currently no matching trusted production case sets for this project.** The pipeline is connected, but new auto proposals cannot gain a publication receipt without a relevant owner-reviewed suite or trusted adapter. Unrelated generic fixtures and a model-authored workbench spec are deliberately not substituted. See [configuration/boundaries](curator-evaluator-v0.2.1.md).

Source is a local installed patch; no GitHub release/CI publication is claimed. Existing metadata/icon remain applicable; no new visual UI was requested or visually verified. Two coding subagent attempts failed at the product layer, so no independent-agent audit result is claimed; the Lead reviewed the critical diff and ran tests.
