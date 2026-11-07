# Skill loop MVP implementation contract

Lead owns runtime/config/prompts/projection/provider/commands. Core teammate owns `src/core.js` + `tests/core.test.mjs` only. Storage is native DSH storageDomain, one immutable project record per canonical cwd. No filesystem skill overwrites, generated skills use a workspace-filtered SkillProvider.

## Pure core API (no DSH imports, no I/O)

- `newProject(root)` => JSON project `{root,mode:'review',paused:false,skills:[],proposals:[],runs:[],lessons:[]}`.
- `validateProject(value)` => boolean, bounded shallow/structural guard sufficient for schema custom; reject malformed state.
- `stage(project, draft, context)` => `{project, proposalId: string|null, status: string}`. context `{runId,sessionId,turn,evidence:[{seq,type,text,verified?:boolean}],confirmed:boolean,now:ISO}`. Draft `{lessons:[{kind:'success'|'correction'|'antipattern'|'intervention',trigger,lesson,evidenceSeqs:number[]}], proposal:null|{name,description,trigger,steps:string[],pitfalls:string[],checks:string[],reason,evidenceSeqs:number[],baseRevision:number}}`. Proposal names `learned-...` only, max64. Save lessons even unconfirmed (not discoverable skills). Null proposal allowed. All evidenceSeqs must exist in context evidence. At least one source; confirmed required to publish, NOT to stage. Unknown target with baseRevision !=0 invalid; update must match current version. Dedup identical skill content; if pending same name/base, replace/supersede old pending, not duplicate. Duplicate runId no-op. Max50 active skills,50pending,200lessons,100runs. Revisions retained last10. New candidate status pending with baseRevision and confirmed stored; auto publication ONLY project.mode==='auto' && context.confirmed. Redact possible secret candidates fail closed, never raw secret retained. Return status explains held/noop.
- `approve(project,id,now)`=>new project; cannot approve stale base or unconfirmed candidate. Approving is human command-only; reject if pending confirmed=false (must collect success first).
- `reject(project,id,now)`=>new project.
- `rollback(project,name,revision,now)`=>new project; creates NEW monotonically-increasing revision from retained revision, never rewinds counter. Invalidates pending updates to name. Evidence recorded.
- `archive(project,name,now)`=>new project; mark archived, do NOT delete. `restore(project,name,now)` optional.
- `summary(project)`=>compact JSON (mode,paused, counts, pending summaries, skills name/revision/status).
- `renderSkill(skill)` => Markdown BODY (not frontmatter): trigger, steps, pitfalls, checks, version, provenance source refs. skill has name,description,trigger,steps,pitfalls,checks,revisions + revision,current provenance.
- `hasSecret(text)`=>boolean, `redact(text)`=>sanitized string, shared with runtime projection. Common keys/bearer/privatekey, assignment secrets, credentials URLs. Safety is heuristic not universal.

Returned objects immutable: no mutation of input. Use node:crypto randomUUID/hash if needed. Draft loops are NOT executable; max lengths bounded, unsafe permissions/policy override instructions rejected. No secondary LLM evaluator in core. Don't label structural checks as semantic validation.
