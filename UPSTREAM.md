# Sources, attribution and implementation boundaries

This is an independent native DeepSeek Harness implementation, distributed under this repository's [MIT license](<LICENSE>). The SVG icon is original artwork. **No ACE, AppWorld, Hermes, ECC or GEPA runtime code is copied or vendored here.** No upstream Python runtime, training framework, server database or vector store is installed by this bundle.

Design inspiration does not make this an official upstream port, a reproduction of a paper's experiment, or a transfer of its reported performance gains.

## ACE: pinned paper and official code

- **Paper:** [Agentic Context Engineering, arXiv v3](<https://arxiv.org/html/2510.04618v3>), dated 2026-03-29. This version, rather than a moving latest-paper URL, is the reference for scientific claims.
- **Official code inspected:** [ace-agent/ace at `82709de050e1db6e6ef2f07bcb0393560b94992a`](<https://github.com/ace-agent/ace/tree/82709de050e1db6e6ef2f07bcb0393560b94992a>), commit dated 2026-08-24.
- **Official upstream license:** [Apache License 2.0](<https://github.com/ace-agent/ace/blob/82709de050e1db6e6ef2f07bcb0393560b94992a/LICENSE.txt>), not this plugin's MIT license.
- **AppWorld gitlink pinned by that ACE tree:** [`9f3e92155345a9159f3a8b25abc334eeca05b545`](<https://github.com/ace-agent/ace-appworld/tree/9f3e92155345a9159f3a8b25abc334eeca05b545>).
- **Later AppWorld tree separately inspected:** [`928e86877d34cd10eaba159606386f93a1765090`](<https://github.com/ace-agent/ace-appworld/tree/928e86877d34cd10eaba159606386f93a1765090>), with its own [Apache-2.0 license](<https://github.com/ace-agent/ace-appworld/blob/928e86877d34cd10eaba159606386f93a1765090/LICENSE>).

The later code trees are **not established as the exact artifacts that produced paper-v3 results**. The AppWorld gitlink and later AppWorld HEAD are different revisions. A source audit is not benchmark reproduction or provider-token measurement. The official research repository must also not be confused with similarly named community SDKs.

### Ideas adopted, not runtime code

ACE-lite adopts the architectural idea of a task Generator, bounded Reflector and Curator, stable instruction entries, local deltas and a recoverable revision trail. DSH's existing ReAct agent remains the Generator; there is no replacement agent loop. Native DSH storage and on-demand skill loading are retained.

These are **local design choices**, not claims of exact upstream compatibility:

- V2 canonical entries and strict `create`/`insert`/`replace`/`archive` deltas, with host-assigned IDs and expected hashes;
- review by default, explicit human confirmation/approval and chosen soft auto for bounded additive changes;
- replacement/archive auto gates based on relevant host-owned evaluation receipts;
- canonical-cwd isolation, bounded budgets, secret heuristics, protected entries and durable source references;
- native skill-load identity evidence, kept separate from causal usefulness or quality.

In the inspected official main research code, the applied Curator operation is **ADD-only**; additional operation names appearing in validation/TODO text do not mean they are implemented. Main-repository helpful/harmful tags are model feedback, not proven causal credit. The inspected AppWorld formatter/adaptation path does not preserve those counters in the same way. ACE-lite must not claim to reproduce a shared persistent upstream helpful/harmful/neutral scoring algorithm.

Upstream full-playbook prompting, optional embedding/LLM deduplication, late batch/ComBEE behavior and research evaluation environments are not transplanted here. Exact source/structure checks do not make generated advice true or immune to poisoning.

### License distinction

This project borrows ideas and independently implements JavaScript/native DSH integration. It does **not** relicense Apache-2.0 code as MIT. If future work copies upstream implementation, it must preserve the applicable license, copyright/NOTICE attribution and modification notices, and document the precise borrowed files/revisions. Merely calling copied code “ACE-inspired” would not satisfy those obligations.

## Other design references

- [Recursive Harness Self-Improvement](<https://arxiv.org/abs/2607.15524>): feedback-driven refinement and bounded revision history. “RHI-inspired” is not a reproduction of its optimizer or evaluation.
- [Hermes skill curator, pinned source](<https://github.com/NousResearch/hermes-agent/blob/6b21d0564de0492e2ebd0d8f63fca86c03b5c892/agent/curator.py>): skill lifecycle and recoverable curation.
- [ECC Continuous Learning v2, pinned source](<https://github.com/affaan-m/ECC/blob/d2ef2680594f9a17526a6e1a2e18b3d242c5d17b/skills/continuous-learning-v2/SKILL.md#how-it-works>): observations, atomic lessons and project-scoped proposals.
- [GEPA paper v2](<https://arxiv.org/html/2507.19457v2>): a reference for independently evaluated candidate optimization, **not an implemented feature**. This bundle provides proposer/evaluator contracts but no GEPA dependency, mode, search, Pareto selection or recombination algorithm.

## Measurement and evaluation boundaries

- Paper results are upstream experimental claims, not measurements of this DSH plugin. Adaptation-compute savings do not imply smaller inference context or lower end-to-end cost.
- A confirmed source is not a semantic-quality certificate. A host receipt proves only a registered case set for the bound candidate/scope; an empty-by-default registry must not be replaced with unrelated generic “proof”.
- The generic comparison harness accepts trusted injected case executors. The native adapter being developed uses a **controlled declarative ReAct environment**: the model selects JSON operations over fixed known primitives; it does not execute generated JavaScript or use a VM as a security boundary. This is a workflow-fixture smoke, not a general JavaScript code-generation benchmark or proof of skill gain.
- Native adapter/live smoke verification and end-to-end provider-token comparisons are not claimed complete by these documents. No measured shadow-context savings are asserted.
- Actual provider input/output/cache usage, logical dispatch counts, JSON characters, UTF-8 bytes and tokenizer estimates are distinct quantities. Missing usage is unknown, not evidence of zero cost. Include every learning/evaluation role and errors/aborts when comparing costs.

See the [English README](<README.md>) or [Russian README](<README.ru.md>) for policy, commands, scope, budgets, methodology and downgrade precautions.

## Preserved DSH identities

The bundle retains `local-skill-loop` row/provider, `skill_loop` tool and `local_skill_loop` main storage domain. The main backend domain version remains 1 while application records migrate to V2 with checksummed native backups. Old binaries cannot read V2 without an explicit supported restore; preserving identifiers is not a claim of automatic downgrade compatibility.
