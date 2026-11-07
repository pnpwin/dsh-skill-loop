# Native ReAct + ACE-lite validation — 2026-11-07

## What was actually checked

- Model/provider: **gpt-6.1-sol / openai-codex**. Shared admission ledger: **18/18 logical model calls**, across all three attempts; never reset. Logical dispatches are not guaranteed HTTP-request counts.
- Automatic path: 2/2 controlled task executions passed; Reflector retained **1 lesson**, proposed **0 skills**, and correctly skipped Curator when no insight was selected.
- Separate Curator component: a test author promoted the actual lesson to a **gold insight** against an intentionally wrong, hand-authored fixture baseline. One model call generated a typed delta. **This is not automatic skill discovery.**
- The first evaluator attempt failed closed with 2 SDK setup errors and no generator dispatch. Fixed a factory-context injection mistake with checked scoped service lookup; regression mocks reject the old access.
- Retried only evaluation of the **same candidate**, not reflection/curation. Both preselected holdout fixtures passed (2/2), including protected project config and an immutable numeric operation. Candidate loaded through the native case-scoped skill registry; parent registry restored: **true**.
- Native KV migration, durable backup, budget preservation and V1 restore: **5/5 passed**, in fresh synthetic domain names; production domains were not opened by that storage check.
- No production library writes, mode switches or test-skill publication. Temporary fixture bundles removed after checking; their disposable icon/locale omission was explicit. Small synthetic native test-domain records remain isolated from the real library.

Candidate SHA256: 171ffba18cf99316331d765ce43c06b8ef9a47675ad664dbf4a06ab7b7676c23

Case-set SHA256: 417569db419b7c40e29f5e5b49db224861d04ee783d72814e2780d22860b7720

## Reported provider usage — not estimates

| Role/group | Usage-reported calls | Input tokens | Output tokens | Cache-read tokens |
|---|---:|---:|---:|---:|
| Case-session model calls (includes case-scoped overhead) | 16 | 18214 | 277 | unknown |
| Reflector | 1 | 607 | 224 | unknown |
| Curator (explicit gold-insight component) | 1 | 1177 | 242 | unknown |

These are adapter-reported counters for the covered logical calls. Missing cache values stay unknown. No currency estimate, hidden-retry billing claim or quality-gain claim is inferred.

## Paired rendering footprint — NOT provider tokens

| Same synthetic procedure | JavaScript characters | UTF-8 bytes |
|---|---:|---:|
| v0.1.3 body with provenance | 948 | 948 |
| V2 entries + compact manifest | 807 | 807 |

Same synthetic procedure text; six synthetic source observations of480+characters before normal baseline provenance clipping. Only the loaded skill body is compared. No provider calls/tokenizer, no startup/whole-cycle savings inference.

The permission/action surface remains one agent tool with status/read/reflect; skills remain lazy native catalog entries. No paired first-turn provider-token measurement was performed. Two auxiliary roles can cost more than the old single call. This body-only example does not establish end-to-end context or token savings.

## Limits

These fixtures interpret only finite predefined JSON operations in memory. **No generated JavaScript is executed.** Both baseline and adapted procedures are tested in this narrow environment, not a general coding benchmark. Loading a candidate and passing its bounded cases does not prove entries were used, helped, or are universally safe. No GEPA experiment or quantitative three-arm quality reproduction was run. Larger three-arm comparisons require the explicit human benchmark command.
