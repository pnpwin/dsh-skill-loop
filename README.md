# Skillgrowth for DeepSeek Harness

[GitHub release v0.3.0](<docs/release-v0.3.0.md>): three independently configurable learning modes — **lite** (ReAct-lessons, no evaluator), **standard** (ACE-lite delta curation with paired evaluation) and **heavy** (GEPA-lite evolution) — deterministic tool-error antipattern capture, long-term impact telemetry, and filesystem delivery of published skills to `.agents/skills` / `~/.agents/skills` per the [agentskills.io](<https://agentskills.io/specification>) convention. Code/build/CLI/bench scripts remain under `src/`; root files are documentation, manifests and DSH discovery metadata. Companion package: [dsh-skillcraft](<https://github.com/pnpwin/dsh-skillcraft>).

[Русская версия](<README.ru.md>) · [GitHub](<https://github.com/pnpwin/dsh-skillgrowth>) · [MIT](<LICENSE>) · `@pnpwin/dsh-skillgrowth`

**v0.3.0 highlights:** mode checkboxes (default lite+standard) with `escalation` policy; `schemaVersion:3` additive migration (error-pattern ledger, per-skill impact counters, proposal origin); repeated tool errors → antipattern lessons + templated pitfall inserts (zero LLM); published skills exported as `<gitRoot>/.agents/skills/<name>/SKILL.md` (foreign files never overwritten, drift detected); `/dsh-skillgrowth evolve` runs Pareto-constrained reflection evolution on a registered trusted paired case set and publishes only an observed-gain winner; budgets extended (40/day aux rail + per-mode quotas lite16/standard24, heavy 60 calls/run, 1 run/day). [Full release notes](<docs/release-v0.3.0.md>) · [Skill layout conventions](<docs/skills-layout.md>).

**v0.2.5:** Curator now follows a compact rubric derived from the ONE DSH skill creator; a separate native paired evaluator gates automatic publication, with at most one adaptation-only refinement. Existing mode/data/budgets are preserved. [Integration, trusted suites and limits](<docs/curator-evaluator-v0.2.1.md>). A matching owner-reviewed project suite is required; none is invented from model prose.

**ACE-lite v0.2:** project-scoped procedural learning inside the existing DSH ReAct workflow. Visible work produces bounded reflection, atomic lessons and a small skill delta—not another agent loop, a memory server, model-weight training or a new UI.

**Historical v0.2.0 validation:** offline unit/integration coverage plus a bounded native smoke used exactly **18 logical model calls**. The automatic path retained one lesson without proposing a skill; a separately labelled gold-insight Curator component generated a delta that passed two native heldout fixtures. Native KV migration/backup/budget/restore passed five isolated checks. See the [measured validation report](<docs/validation-v0.2.0.md>). This is integration evidence, **not** a quality-gain or end-to-end token-saving claim.

## Installation and compatibility

Use DSH's Plugin Manager to install the bundle; do not edit profile manifests manually. Installation affects every session in the selected profile. This source tree targets **DSH 0.2.2-rc.1 and Node.js ≥22** and uses ready-to-run ESM, with no third-party runtime dependencies or install/prepare hooks.

For a reviewed local checkout, ask the agent to invoke Plugin Manager with its actual absolute directory:

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-skillgrowth","enabled":true}
```

The local directory may remain linked; keep it in place. For the tagged release, use Plugin Manager with:

```json
{"action":"install_bundle","target":"github:pnpwin/dsh-skillgrowth#v0.2.5","enabled":true}
```

Read the manager's application result and inspect the live `dsh_skillgrowth` status after upgrading; saved package selection alone does not establish activation.

Remove the previous active bundle before enabling its replacement. Public row/provider/tool/command names change to Skillgrowth; capture and restore its existing public config through native ConfigEditor as described in the [migration notes](<docs/release-v0.2.5.md>). Private storage domains `local_skill_loop`/`local_skill_loop_backups` are intentionally unchanged, preserving library, pending IDs/hashes, mode and counters. **V2 binary downgrade precautions still apply.** See [Storage and downgrade](<#storage-and-downgrade>).

## How ACE-lite works

1. After a normal user turn, inspect bounded visible observations for a checked outcome, correction, antipattern or explicit intervention. No signal or no useful insight is a valid no-op.
2. A **Reflector**, without tools, extracts up to three lessons and proposes narrow insights. Helpful/harmful/neutral entry judgments are hypotheses, not proven causal credit.
3. Only when insights exist, a separate **Curator**, also without tools, returns at most one structured delta. The complete selected target or pending preview must fit the input budget; otherwise the update is held rather than editing a truncated body.
4. Host code validates sources, ownership, exact base hashes/revision, entry protection, capacities and operation schema, then stages the candidate. Publication follows the policy below.

The existing DSH agent remains the task **Generator**. The learning roles do not run shell commands, execute proposed regression suites, change permissions or directly write the skill library.

### Stable entries rather than repeated whole-document rewrites

Each skill has a description, trigger and stable entries in `step`, `pitfall` and `check` sections. Entries retain IDs, versions, protection flags and evidence references. Unchanged entries are preserved; pending refinement is bound to the exact pending preview as well as the active base. Names are primitive strings of at most 64 characters: `learned-` followed by nonempty ASCII `[a-z0-9]` segments joined by single hyphens; invalid input is rejected rather than trimmed or normalized.

The delta grammar is deliberately small:

- `create`: one new skill, at most eight entries including at least two steps;
- `insert`: one new entry at a specified section position;
- `replace`: an existing entry ID plus its expected hash;
- `archive`: an existing entry ID plus its expected hash.

There are at most four operations per candidate, one project-owned target, and no rename, scope, permission or arbitrary JSON-patch operations. New entry text is bounded to 1,200 characters. Protected entries cannot be replaced or archived by a model delta.

Published `learned-*` skills are native, workspace-filtered provider entries, loaded with DSH's standard `skill` tool—not generated files overwriting a user's library. The loaded body includes active entries, a compact identity manifest and a pointer to history. Bulk provenance is available on demand through `show`/`read` rather than copied into every skill body. This controls context placement; it does **not** establish token savings.

## Review, paired default and legacy soft auto

**Native v0.2.1 default:** requirePairedEvaluation=true. Every auto publication, including additive creates, needs an exact confirmed candidate plus independent adaptation AND holdout gains with no regression. Missing relevant trusted project cases → pending, not invented proof. The table below describes review and the explicitly opted-in legacy requirePairedEvaluation=false policy; it is NOT the new strict default.

**New scopes default to `review`; an existing mode is preserved.** No approval-count threshold switches the mode automatically. Enabling auto does not publish the old queue retroactively.

| Policy | Publication rule |
|---|---|
| `review` | A human explicitly approves a structurally valid, evidence-confirmed candidate. A benchmark is not required for this manual decision. |
| `auto`, bounded additive change | Confirmed new skills or at most two section-tail inserts may publish without an evaluator pass. All previous constraints and metadata must remain intact. This is the chosen **soft-auto policy**, not a quality guarantee. |
| `auto`, replacement/archive or other non-additive change | Requires confirmed evidence **and** a passing host-issued evaluation bound to the exact candidate and scope. Otherwise it stays pending. |

The additive gate compares the **net final preview against the active skill**, not merely the last operation. Appending to a pending destructive change cannot bypass evaluation. A failed evaluation blocks auto publication even for additive changes. Migrated V1 proposals are not silently auto-published.

`evidenceStatus` (`verified`, `unverified`, `contradicted`) and `evaluationStatus` (`not-run`, `passed`, `failed`) are separate. `confirmed` means source evidence was confirmed—not that the skill is generally correct, useful or production-safe. Human `confirm` never publishes. A manual `approve` is an explicit human decision, not an evaluator certificate. A bounded `sourcePublication` origin record retains the exact publication method/hash/receipt even after proposal history is evicted; pin/rollback never reinterpret origin evidence as current-revision validation. Soft entry judgments are bound to exact entry version/hash, counted only over the last100 retained episodes, and are never publication/pruning authority.

### What counts as source confirmation

- Short, unambiguous success feedback from the actual human user.
- A recognized test/typecheck command with a successful **native outcome** and no contradictory result. Native `job/settled` is correlated with owner/session, call ID, label and turn; numeric structured exit metadata is another supported authority. Test stdout cannot certify its own exit status.

An assistant saying “done”, `isError:false`, a generic successful read/echo, zero-test output or a model-supplied receipt is not confirmation. Negative evidence can invalidate an apparent success. Recognition is conservative; unsupported/background results fail closed. A human may explicitly confirm an independently checked result.

Exposure tracking matches durable native skill-load events against exact retained skill bodies/revisions. A catalog entry alone is not exposure; **loaded ≠ used ≠ helpful**. Ambiguous or unavailable identity remains unknown. No private reasoning is used for learning.

### Evaluator boundary—not a generic certification service

The host evaluator accepts only explicitly registered **trusted case-set IDs**. The registry is empty by default. An owner can set `declarativeCaseSetsJson` to a JSON array of relevant case sets for the built-in memory-only runner, or a trusted Host integration can inject a runner. The [native fixture definitions](<src/bench/native-cases.js>) show the finite operation format; generated JavaScript is never executed. No unrelated generic case set automatically certifies arbitrary skills. Use `/dsh-skillgrowth verifiers` to inspect registered IDs.

Receipts bind the candidate hash, case-set hash, scope and run. Runtime checks registry ownership before attaching them; model-written JSON or copied receipt objects are not authority. A pass establishes only the checks actually performed. The plugin neither invents model-supplied shell tests nor executes arbitrary generated JavaScript to obtain a receipt.

[Optimizer interfaces](<src/optimizer.js>) provide `CandidateProposer` and `CandidateEvaluator` extension seams. **There is no GEPA optimizer, GEPA mode, dependency, search/recombination loop or claim to run GEPA.** ACE-lite is the implemented proposal strategy; the seam is not a second algorithm.

## Human commands and agent tool

These are native human slash commands, not requests for the LLM to execute shell text:

| Command | Purpose |
|---|---|
| `/dsh-skillgrowth status` | Mode, counts, queue and separate review/auxiliary-call budgets |
| `/dsh-skillgrowth pending` | Pending proposals with evidence/evaluation status |
| `/dsh-skillgrowth show ID_OR_NAME` | Content, delta, hashes, history and provenance |
| `/dsh-skillgrowth confirm ID` | Attest that the underlying outcome was checked; no publication |
| `/dsh-skillgrowth approve ID`, `/dsh-skillgrowth reject ID` | Explicit publication/rejection |
| `/dsh-skillgrowth mode review`, `/dsh-skillgrowth mode auto` | Set this scope's policy explicitly |
| `/dsh-skillgrowth analyze` | Analyze a new completed window; no confirmation or budget bypass |
| `/dsh-skillgrowth curate` | Advisory/no-op boundary; no automatic semantic merge or pruning |
| `/dsh-skillgrowth pin NAME ENTRY_ID`, `/dsh-skillgrowth unpin NAME ENTRY_ID` | Protect/unprotect an entry; creates a revision and invalidates stale candidates |
| `/dsh-skillgrowth verify ID CASESET` | Evaluate against an explicitly registered host case set; unavailable without a runner/case set |
| `/dsh-skillgrowth archive NAME`, `/dsh-skillgrowth restore NAME` | Hide/restore a skill without deleting history |
| `/dsh-skillgrowth rollback NAME N` | Create a new revision from a retained revision |
| `/dsh-skillgrowth storage-backups` | List this scope's migration snapshots |
| `/dsh-skillgrowth storage-restore BACKUP_ID` | Explicitly restore a valid V1 project snapshot; see downgrade procedure |
| `/dsh-skillgrowth pause`, `/dsh-skillgrowth resume` | Pause/resume learning in this scope |

The agent's `dsh_skillgrowth` tool remains limited to **`status`, `read`, `reflect`**. `reflect` queues a short intervention for turn-end analysis; it grants no confirmation. Agents cannot confirm, approve, set mode, pin, verify or restore storage through this tool. This is an API authority boundary, not a sandbox against arbitrary code already running with machine access.

## Scope and privacy

- Scope is the **canonical absolute session cwd**, not a Git remote or repository-wide alias. A subdirectory or worktree is a different scope; there is no automatic cross-worktree merge or global promotion.
- Observation starts at activation/restart and cuts off old observations after cwd changes. Inherited fork history is not new evidence. Native subagents do not train the production library.
- Local durable state does not mean local inference. Bounded observations, relevant skill content and lessons go to the session's selected DSH model/provider unless Config overrides it.
- Secret redaction is heuristic, **not complete DLP/PII protection**. Do not enable learning for material that must not reach that provider. Use per-scope `pause` or plugin `enabled:false`.
- Observations and stored bodies are untrusted data. Schema checks, source binding, framing checks and protection flags reduce risk; they do not prove semantic safety against every prompt injection.

## Budgets and limits

Default limits are per canonical scope; daily counters use UTC:

| Limit | Default |
|---|---:|
| Auxiliary model dispatches, **Reflector + Curator + refinement + evaluator combined** | **12 total/day**, not 12 per role |
| Review cycles (`dailyReviews`, separate ceiling) | 12/day |
| Automatic cooldown | 60 seconds |
| Sum of both roles' input JSON payload lengths | 16,000 characters |
| Initial two-role output-token cap (one refinement may reuse Curator allocation) | 3,000: Reflector 1,000 + Curator 2,000 |
| Shared initial two-role deadline | 45 seconds, not 45 seconds per role |
| Strict automatic cycle logical cap | 2 + verificationMaxCalls (default20), refinement included |
| Explicit verification budget/deadline | 18 logical calls / 120 seconds per invocation |
| Active/all skills; pending/all proposals | 50/100; 50/100 |
| Lessons; run records; retained skill revisions | 200; 100; 10 per skill |
| Active entries per skill | 32 |

A full two-role cycle consumes two auxiliary reservations; a Reflector no-op can consume one. Each reservation occurs before dispatch, and failed/aborted dispatched work still counts. There are no recursive reviewers or automatic retry loops. Existing daily attempts survive migration and consume the new auxiliary budget conservatively; upgrading does not reset spent quota.

The 16,000 limit is **characters in summed role payloads**, not provider tokens or the full request: system prompts and message envelopes add overhead. Config can override supported limits and provider/model; it does not force a temperature. Context savings and costs must be measured, not inferred from the cap.

## Storage and downgrade

The native `local_skill_loop` domain keeps backend version 1 and its existing tables. The application project/control records move to `schemaVersion:2`. Before the first V2 rewrite of valid V1 data, the store durably writes a checksummed snapshot to `local_skill_loop_backups`. IDs, mode, history, source links and spent budgets are preserved where applicable; valid imported content is not silently truncated.

Writes are serialized per root in this process. A canonical project is committed with one native record write; there is **no claim of a cross-table transaction** across project, control and backup data. Invalid/unreadable formats fail closed rather than being silently downgraded or reset.

For an intentional downgrade:

1. Pause work; inspect `/dsh-skillgrowth storage-backups` and choose a valid V1 **project** snapshot for this scope.
2. Run `/dsh-skillgrowth storage-restore BACKUP_ID`. The current V2 state is archived before restoring V1; quota is not reset.
3. Stop/disable v0.2 before installing the older binary. Learning stays held for the restored scope in this runtime; starting v0.2 again can migrate it back to V2.

An old binary cannot read V2 merely because the domain's backend version is unchanged. Snapshot restore is explicit, not automatic lossless bidirectional migration. Entry rollback does not undo actions an agent already performed in the project.

New user input, cancellation, pause/disable or unload aborts pending work and publication is guarded again before the durable write. An already-started/completed commit cannot be revoked retroactively; use explicit rollback. Unload drains owned jobs and store operations.

## Tests, comparisons and honest measurement

From the package root:

```sh
node --test --test-reporter=spec tests/*.test.mjs
npm run build
npm run pack:release
```

The current suite—not a frozen test-count claim—is authoritative for that checkout. Offline tests cover pure V2 migration/deltas, net-diff publication gates, stale/protected entries, native evidence, exact exposure matching, fake-receipt rejection, storage faults, cancellation and budgets. Fake Host/LLM fixtures make no paid provider calls. Passing them establishes tested mechanics, not general extraction quality or real-provider performance.

The [comparison runner](<src/bench/runner.js>) accepts an injected bounded native-ReAct `runCase` callback and independent immutable snapshots. It compares `no-memory`, `legacy` and `ace` arms with seeded ordering, separate adaptation/holdout instances and a **shared** logical-call cap across all roles/arms. Only adaptation observations reach the proposer; holdout expected checks do not. Experiment artifacts must not update or publish production skills. The [case definitions](<src/bench/cases.js>) are tiny controlled fixtures, **not a general JavaScript coding benchmark**. The runner itself does not execute model-generated programs or supply a security sandbox.

The generic callback boundary can support other explicitly trusted case executors. The built-in native adapter is narrower: a **controlled declarative ReAct environment** in which the model chooses JSON operations over fixed known primitives, not generated JavaScript or a VM execution path. It is a workflow-fixture smoke, not a JavaScript code-generation benchmark.

The [concrete adapters](<src/bench/adapters.js>) use the actual preserved v0.1.3 single-role updater and the two-role ACE-lite proposer, with identical lexical active-skill selection. `/dsh-skillgrowth benchmark [seed=42] [logical-call-cap=96]` runs an explicitly paid, isolated three-arm comparison (at most five minutes; cap1–200). It does not update production skills or their daily budget. The public `./optimizer` and `./bench` exports expose the extension/test contracts without introducing GEPA.

The [native validation report](<docs/validation-v0.2.0.md>) distinguishes automatic lesson-only behavior from the manually labelled Curator component and exact-candidate execution. It reports provider usage separately from a paired synthetic body-size comparison. No paired first-turn provider-token saving or broad skill-quality benefit is claimed.

Report measurements separately:

- **Provider-reported** input/output/cache usage, with coverage and missing usage marked `unknown` rather than invented zeros.
- **Logical dispatches**, including errors/aborts and every participating role; these are not tokens or guaranteed HTTP-request counts.
- **UTF-8 bytes**, JavaScript character counts and any tokenizer heuristic, each with its unit/method; never sum them into provider-token totals.
- Case outcomes, seed, immutable snapshot/case hashes, order, latency and incomplete/budget-exhausted status.

A context-saving claim needs a paired comparison on the same task/model/settings, including both ordinary task context and all learning/evaluation overhead. No controlled end-to-end provider-token saving or broad quality gain is established by this release documentation. Added memory can increase context and can hurt performance.

## Source layout and attribution

All plugin implementation, build helpers and benchmark code live under [src](<src/index.js>). Existing [tests](<tests/core.test.mjs>) and [locale resources](<locale/en.json>) stay in their original directories. Root files are documentation, license and package/DSH discovery metadata; release archives belong in ignored `.release/`, not the root.

- [Host entry](<src/index.js>), [runtime](<src/runtime.js>), [V2 core](<src/ace-core.js>), [legacy compatibility core](<src/core.js>)
- [Observations](<src/projection.js>), [feedback/exposure](<src/feedback.js>), [bounded review](<src/review.js>), [storage](<src/store.js>)
- [Optimizer/evaluator seam](<src/optimizer.js>), [comparison runner](<src/bench/runner.js>), [packaging checks](<src/check-package.js>)

See [UPSTREAM](<UPSTREAM.md>) for pinned design references and license distinctions. ACE-lite is an independent implementation inspired by ACE, RHI and recoverable skill curation, not an official upstream port or a reproduction of their reported benchmark gains. The icon is original artwork.
