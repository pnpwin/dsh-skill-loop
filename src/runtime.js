import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as core from './core.js';
import { initialProjection, foldProjection, selectBatch } from './projection.js';
import { GUIDE, AGENT_GUIDANCE, REFLECT_SYSTEM, buildReviewInput, collectReview } from './prompts.js';

const PROVIDER = 'local-skill-loop';
const TOOL = 'skill_loop';
const COMMAND = 'skill-loop';
const nowISO = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const enabled = config => typeof config.enabled?.get === 'function' ? config.enabled.get() : config.enabled !== false;
export function canonicalRoot(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  try { return realpathSync.native(resolve(cwd)); } catch { return null; }
}
function isRootAgent(agent) { return !!agent?.session && agent.session.header?.origin !== 'subagent'; }
function textResult(value) { return [{ type: 'text', text: JSON.stringify(value) }]; }
function compactError(error) {
  const message = String(error?.message || 'review-failed');
  return /^[a-z][a-z0-9-]{0,60}$/.test(message) ? message : 'review-failed';
}
function parseWords(input) { return String(input || '').trim().split(/\s+/).filter(Boolean); }
function revisionDiff(oldSkill, proposal) {
  const body = value => [value.description, value.trigger, ...value.steps, ...value.pitfalls, ...value.checks].join('\n');
  return { before: oldSkill ? body(oldSkill) : '', after: body(proposal) };
}

/** API bindings are injected so integration tests exercise the same runtime. */
export async function installRuntime(ctx, config, { z }) {
  const lifetime = new AbortController();
  const domain = await ctx.storageDomain.open({
    name: 'local_skill_loop', version: 1, layout: 'per-record',
    tables: {
      projects: { valueSchema: z.custom(core.validateProject, 'Invalid skill loop project') },
      controls: { valueSchema: z.object({ root: z.string(), date: z.string(), attempts: z.number().int().nonnegative(), recent: z.array(z.string()).max(100), status: z.string(), code: z.string(), cooldownUntil: z.number(), updatedAt: z.string() }) },
    },
  });
  const projects = domain.table('projects');
  const controls = domain.table('controls');
  const jobs = new Set();
  const projectLocks = new Map();
  const inFlight = new Set();
  const activeControllers = new Map();
  const scopeCuts = new Map();
  const hints = new Map();
  let invalidate = () => {};
  let stopWatch = null;
  // Install the owning cleanup before any later activation can fail.
  ctx.effect(()=>async()=>{
    lifetime.abort();
    for(const c of activeControllers.keys())c.abort();
    if(typeof stopWatch==='function')stopWatch();
    await Promise.allSettled([...jobs]);
    await Promise.allSettled([...projectLocks.values()]);
    await domain.close();
  });
  const projection = await ctx.sessionProjections.register({
    key: 'local-skill-loop-observations', stateVersion: 3,
    stateSchema: z.custom(value => value && typeof value === 'object' && value.version === 1 && Array.isArray(value.events)),
    init: initialProjection, apply: foldProjection,
  });

  function rootOf(agent) { return canonicalRoot(ctx.workingDirectory.get(agent.session)); }
  function getProject(root) {
    return projects.get(hash(root)) ?? { ...core.newProject(root), mode: config.initialMode || 'review' };
  }
  async function serial(root, fn) {
    const key = hash(root);
    const previous = projectLocks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    projectLocks.set(key, current);
    try { return await current; }
    finally { if (projectLocks.get(key) === current) projectLocks.delete(key); }
  }
  async function mutate(root, fn) {
    return serial(root, async () => {
      const next = fn(getProject(root));
      if (!core.validateProject(next)) throw new Error('invalid-project-update');
      await projects.put(hash(root), next);
      invalidate();
      return next;
    });
  }
  function scopeCut(agent, seq = agent.session.seq) {
    const root = rootOf(agent);
    const old = scopeCuts.get(agent.id);
    if (!old || old.root !== root) {
      const cut = { root, floor: seq };
      scopeCuts.set(agent.id, cut);
      return cut;
    }
    return old;
  }
  // No historical sweep on installation/restart. Only newly committed evidence
  // is eligible unless the human explicitly invokes analyze.
  for (const agent of ctx.agents.list()) if (isRootAgent(agent)) scopeCut(agent);

  function batchOf(agent, force = false) {
    const state = projection.stateOf(agent.session);
    const batch = selectBatch(state, { force, maxInputChars: Math.floor(config.maxInputChars / 2) });
    if (!batch) return null;
    const cut = scopeCut(agent);
    const floor = Math.max(state.inheritedEventCount, cut.floor);
    const evidence = batch.evidence.filter(e => e.seq >= floor).map(({seq,type,text,verified}) => ({seq,type,text,verified: !!verified}));
    if (!evidence.length) return null;
    // Filtering across a CWD/activation boundary must not retain a success flag
    // derived from evidence that is no longer supplied to the reviewer.
    const requiredSeqs = batch.confirmationSeqs || [];
    const complete = requiredSeqs.length>0 && requiredSeqs.every(seq=>evidence.some(e=>e.seq===seq));
    const confirmationSeqs = complete ? requiredSeqs : [];
    return { ...batch, evidence, confirmationSeqs, confirmed: batch.confirmed && complete };
  }

  async function runReview(agent, { force = false, manual = false, hint = '', externalSignal } = {}) {
    if (!enabled(config) || lifetime.signal.aborted || !isRootAgent(agent)) return {status: 'disabled'};
    const root = rootOf(agent);
    if (!root) return {status: 'invalid-workspace'};
    const project = getProject(root);
    if (project.paused) return {status: 'paused'};
    const batch = batchOf(agent, force);
    if (!batch) return {status: 'no-new-signal'};
    const runId = hash(`${root}\0${agent.id}\0${batch.lastSeq}`);
    const key = hash(root);
    const day = new Date().toISOString().slice(0,10);
    const selection = agent.model?.current?.();
    const provider = config.provider || selection?.provider;
    const model = config.model || selection?.model;
    if (!provider || !model) return {status: 'model-unavailable'};
    const claim = await serial(root, async () => {
      const current = controls.get(key);
      const base = current?.date === day ? current : {root,date:day,attempts:0,recent:current?.recent || [],status:'idle',code:'',cooldownUntil:0,updatedAt:nowISO()};
      if (base.recent.includes(runId)) return 'already-reviewed';
      if (base.attempts >= config.dailyReviews) return 'daily-budget';
      if (inFlight.has(key)) return 'busy';
      if (!enabled(config) || getProject(root).paused || externalSignal?.aborted) return 'cancelled';
      if (!manual && Date.now() < base.cooldownUntil) return 'cooldown';
      await controls.put(key, {...base,attempts:base.attempts+1,recent:[...base.recent,runId].slice(-100),status:'running',code:'',cooldownUntil:Date.now()+config.cooldownMs,updatedAt:nowISO()});
      inFlight.add(key);
      return 'claimed';
    });
    if (claim !== 'claimed') return {status: claim};
    const controller = new AbortController();
    activeControllers.set(controller,{root,agentId:agent.id});
    const signal = AbortSignal.any([controller.signal,lifetime.signal,AbortSignal.timeout(config.timeoutMs),...(externalSignal?[externalSignal]:[])]);
    try {
      const latest = getProject(root);
      const input = buildReviewInput({batch,project:latest,hint:core.redact(hint),maxChars:config.maxInputChars});
      if (input.length > config.maxInputChars) throw new Error('review-input-limit');
      const draft = await collectReview(options => ctx.llm.stream(options), {
        provider,model,messages:[{role:'user',content:[{type:'text',text:input}]}],
        system:REFLECT_SYSTEM,maxTokens:config.maxOutputTokens,signal,purpose:'skill-loop-review',
      });
      signal.throwIfAborted();
      if (!enabled(config) || getProject(root).paused || rootOf(agent) !== root) throw new Error('review-cancelled');
      const shownSkills = JSON.parse(input).managedSkills;
      if (draft.proposal?.baseRevision > 0 && !shownSkills.some(s=>s.name===draft.proposal.name && s.revision===draft.proposal.baseRevision)) throw new Error('unseen-update-target');
      const citesConfirmation = item => Array.isArray(item?.evidenceSeqs) && batch.confirmationSeqs.length>0 && batch.confirmationSeqs.every(seq=>item.evidenceSeqs.includes(seq));
      const confirmed = batch.confirmed && (!draft.proposal || citesConfirmation(draft.proposal)) && draft.lessons.every(citesConfirmation);
      let outcome;
      await mutate(root, current => {
        signal.throwIfAborted();
        if (!enabled(config) || current.paused || rootOf(agent)!==root) throw new Error('review-cancelled');
        outcome = core.stage(current,draft,{runId,sessionId:agent.id,turn:batch.turn,evidence:batch.evidence,confirmed,now:nowISO()});
        return outcome.project;
      });
      await serial(root, async () => {
        const c = controls.get(key);
        await controls.put(key,{...c,status:outcome.status,code:'',updatedAt:nowISO()});
      });
      return {status:outcome.status,proposalId:outcome.proposalId};
    } catch (error) {
      const code = signal.aborted ? 'review-aborted' : compactError(error);
      if (!lifetime.signal.aborted) await serial(root,async () => {
        const c = controls.get(key);
        await controls.put(key,{...c,status:'failed',code,updatedAt:nowISO()});
      });
      ctx.logger.warn('Skill loop review did not publish: %s',code);
      return {status:'failed',code};
    } finally { activeControllers.delete(controller); inFlight.delete(key); }
  }
  function launch(agent, options) {
    const job = runReview(agent,options);
    jobs.add(job);
    job.catch(error => ctx.logger.warn('Skill loop job failed: %s',compactError(error))).finally(() => jobs.delete(job));
    return job;
  }
  function status(root) {
    const project = getProject(root);
    const c = controls.get(hash(root));
    return {...core.summary(project),budget:{dailyLimit:config.dailyReviews,attempts:c?.date===new Date().toISOString().slice(0,10)?c.attempts:0},lastReview:c?{status:c.status,code:c.code,at:c.updatedAt}:null};
  }

  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate;
    function visible(cwd) {
      const root = canonicalRoot(cwd);
      return root ? getProject(root).skills.filter(s => s.status === 'active') : [];
    }
    return {
      name:PROVIDER,
      async list(options) {
        if (!enabled(config)) return [];
        const root = canonicalRoot(options.cwd);
        if (!root) return [];
        return visible(options.cwd).map(skill => ({
          name:skill.name,description:skill.description,whenToUse:skill.trigger,
          invocation:{modelInvocable:true,userInvocable:true},source:'custom',provider:PROVIDER,
          resourceBase:{kind:'opaque',description:'Project-scoped versioned skill. Review/history: /skill-loop show '+skill.name},
          rank:25,locator:{project:hash(root),name:skill.name,revision:skill.revision},
        }));
      },
      async get(candidate, options) {
        options.signal?.throwIfAborted();
        if (!enabled(config)) return undefined;
        const root = canonicalRoot(options.cwd);
        if (!root || candidate.locator?.project !== hash(root)) return undefined;
        const skill = visible(options.cwd).find(s => s.name === candidate.name && s.revision === candidate.locator.revision);
        if (!skill) return undefined;
        return {...candidate,content:skill.status==='active'?core.renderSkill(skill):'Archived skill: inspect retained revisions; restore explicitly before use.',metadata:{revision:skill.revision,scope:'project',quality:'source-and-structure-checked; not benchmark-validated'}};
      },
    };
  });
  ctx.skills.register({
    name:'skill-loop-guide',description:'Inspect and operate automatic skill learning, review, auto mode, versions and rollback.',
    content:GUIDE,source:'runtime',provider:PROVIDER,
    resourceBase:{kind:'opaque',description:'Native DSH commands and skill_loop tool; no supporting files.'},
  });
  ctx.systemPrompt.section({name:'local-skill-loop-guidance',order:870,text:({scope}) => enabled(config) && (!scope?.session || isRootAgent(scope)) ? AGENT_GUIDANCE : ''});
  ctx.systemPrompt.context({name:'local-skill-loop-status',order:870,text:({scope}) => {
    if (!enabled(config) || !isRootAgent(scope)) return '';
    const root = rootOf(scope);
    if (!root) return '';
    const p = getProject(root);
    const pending = p.proposals.filter(x => x.status==='pending').slice(-3);
    return `Skill loop: ${p.paused?'paused':p.mode}. ${pending.length?'Pending (not active instructions): '+pending.map(p=>p.id+' '+p.name+(p.confirmed?' [confirmed]':' [unconfirmed]')).join('; ')+'. Inspect with skill_loop read; human /skill-loop approve <id>.':''}`;
  }});

  ctx.tools.register({
    name:TOOL,
    description:'Inspect project learning status or a skill/proposal; request reflection after a meaningful correction. Cannot confirm results, approve skills or change mode.',
    parameters:{type:'object',properties:{action:{type:'string',enum:['status','read','reflect']},id:{type:'string',description:'Skill name or proposal id for read.'},note:{type:'string',description:'Brief correction/intervention to consider; never treated as verification.'}},required:['action'],additionalProperties:false},
    output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>textResult(value)},
    async execute(args,exec) {
      if (!isRootAgent(exec.agent)) throw new Error('Root session required');
      const root = rootOf(exec.agent);
      if (!root) throw new Error('Workspace unavailable');
      if (args.action==='status') return status(root);
      const p = getProject(root);
      if (args.action==='read') {
        const proposal = p.proposals.find(x=>x.id===args.id);
        if (proposal) return {proposal,diff:revisionDiff(p.skills.find(x=>x.name===proposal.name),proposal)};
        const skill = p.skills.find(x=>x.name===args.id);
        if (!skill) throw new Error('Skill or proposal not found');
        return {skill,content:skill.status==='active'?core.renderSkill(skill):'Archived skill: inspect retained revisions; restore explicitly before use.'};
      }
      if (args.action==='reflect') {
        if (!enabled(config) || p.paused) return {status:'disabled'};
        const note = String(args.note || '').trim();
        if (!note || note.length>1200 || core.hasSecret(note)) throw new Error('Supply a short non-sensitive intervention note');
        if (hints.size >= 100) throw new Error('Reflection queue full');
        hints.set(exec.agent.id,{note,turn:ctx.agents.turnBoundaryOf(exec.agent.session).lastTurn});
        return {status:'queued-for-turn-end',confirmation:'not granted'};
      }
      throw new Error('Unknown action');
    },
  });

  ctx.commands.register({name:COMMAND,description:'Skill learning: review drafts, confirm results, publish, switch auto/review, pause and rollback.',input:{hint:'status | pending | show ID | confirm ID | approve ID | mode auto | analyze | curate | rollback NAME N'},
    async handler(invocation) {
      try {
        const {agent,signal} = invocation;
        signal.throwIfAborted();
        if (!isRootAgent(agent)) throw new Error('Root session required');
        const root = rootOf(agent);
        if (!root) throw new Error('Workspace unavailable');
        const [action='help',id,arg] = parseWords(invocation.rawInput);
        const p = getProject(root);
        let value;
        if (action==='help') return {kind:'success',text:GUIDE};
        if (action==='status') value=status(root);
        else if (action==='pending') value=p.proposals.filter(x=>x.status==='pending').map(x=>({id:x.id,name:x.name,reason:x.reason,confirmed:x.confirmed,baseRevision:x.baseRevision}));
        else if (action==='show') {
          const proposal = p.proposals.find(x=>x.id===id);
          const skill = p.skills.find(x=>x.name===id);
          if (proposal) value={proposal,diff:revisionDiff(p.skills.find(x=>x.name===proposal.name),proposal)};
          else if (skill) value={skill,content:skill.status==='active'?core.renderSkill(skill):'Archived skill: inspect retained revisions; restore explicitly before use.'};
          else throw new Error('Skill or proposal not found');
        } else if (action==='confirm') {
          value=core.summary(await mutate(root,current=>core.confirm(current,id,{commandId:invocation.commandId,sessionId:agent.id},nowISO())));
        } else if (action==='approve') value=core.summary(await mutate(root,current=>core.approve(current,id,nowISO())));
        else if (action==='reject') value=core.summary(await mutate(root,current=>core.reject(current,id,nowISO())));
        else if (action==='mode') {
          if (!['review','auto'].includes(id)) throw new Error('Mode must be review or auto');
          value=core.summary(await mutate(root,current=>({...current,mode:id})));
        } else if (action==='pause' || action==='resume') {
          value=core.summary(await mutate(root,current=>({...current,paused:action==='pause'})));
          if (action==='pause') for (const [controller,owner] of activeControllers) if(owner.root===root)controller.abort();
        } else if (action==='rollback') {
          if (!/^\d+$/.test(arg || '')) throw new Error('Supply a retained revision number');
          value=core.summary(await mutate(root,current=>core.rollback(current,id,Number(arg),nowISO())));
        } else if (action==='archive' || action==='restore') value=core.summary(await mutate(root,current=>core[action](current,id,nowISO())));
        else if (action==='analyze') value=await launch(agent,{force:true,manual:true,externalSignal:signal});
        else if (action==='curate') {
          const skills=p.skills.filter(s=>s.status==='active');
          const pairs=[];
          const words=s=>new Set((s.description+' '+s.trigger).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[]);
          for(let i=0;i<skills.length;i++)for(let j=i+1;j<skills.length;j++){
            const a=words(skills[i]),b=words(skills[j]);
            const shared=[...a].filter(x=>b.has(x)).length;
            if(shared>=3 && shared/Math.max(1,Math.min(a.size,b.size))>=0.5) pairs.push([skills[i].name,skills[j].name]);
          }
          value={possibleOverlaps:pairs.slice(0,20),changed:false,note:'Lexical hints only; no pruning/merging without new evidence.'};
        } else throw new Error('Unknown command; /skill-loop for help');
        return {kind:'success',text:JSON.stringify(value,null,2)};
      } catch(error) { return {kind:'error',text:core.redact(String(error.message || 'Command failed')).slice(0,400)}; }
    },
  });

  ctx.on('session/event',(session,event)=>{
    if (!enabled(config)) return;
    const agent=ctx.agents.get(session.id);
    if (!isRootAgent(agent)) return;
    const cut=scopeCut(agent,event.seq);
    if (!cut.root) return;
    if(event.type==='user/message' && event.data?.source?.kind==='user') {
      for(const [controller,owner] of activeControllers)if(owner.agentId===agent.id)controller.abort();
    }
    if (event.type==='turn/end') {
      const hint=hints.get(agent.id);
      hints.delete(agent.id);
      if (event.data?.reason?.kind==='completed') void launch(agent,{force:!!hint,note:undefined,hint:hint?.note || ''});
    }
  });
  ctx.on('agent/disposed',({agent})=>{
    for(const [controller,owner] of activeControllers)if(owner.agentId===agent.id)controller.abort();
    scopeCuts.delete(agent.id);hints.delete(agent.id);
  });
  // Abort immediately when the master switch is disabled, and await all jobs
  // before releasing the borrowed storage handle on plugin unload.
  stopWatch=typeof config.enabled?.watch==='function'?config.enabled.watch(value=>{if(!value)for(const c of activeControllers.keys())c.abort();}):null;
  return {runReview,launch,status,domain,projection,drain:()=>Promise.allSettled([...jobs])};
}
