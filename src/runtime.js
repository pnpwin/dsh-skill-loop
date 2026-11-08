import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import * as ace from './ace-core.js';
import { hasSecret, redact } from './core.js';
import { initialProjection, foldProjection, selectBatch } from './projection.js';
import { initialFeedback, foldFeedback, selectExposures, feedbackForBatch } from './feedback.js';
import { GUIDE, AGENT_GUIDANCE } from './prompts.js';
import {createAceLiteProposer,summarizeJudgments,refineCurator,CURATOR_SYSTEM,buildCuratorInput,assertCuratorTarget,collectRole} from './review.js';
import {CRAFT_POLICY_VERSION} from './craft-policy.js';
import {createPairedEvaluatorRegistry,validatePairedCaseSet} from './paired-evaluator.js';
import { openProjectStore } from './store.js';
import { createCallBudget, createEvaluatorRegistry,validateCaseSet } from './optimizer.js';
import {createNativeCaseRunner} from './bench/native-case.js';
import {createComparisonAdapters} from './bench/adapters.js';
import {runComparison} from './bench/runner.js';
import {createNativeFixtureSet} from './bench/native-cases.js';
import { resolveModes, shouldEscalate, heldForReserve } from './modes.js';
import { applyOutcome, recordErrorRecovery } from './impact.js';
import { extractErrorPatterns, buildAntipatternDraft, mergeProjectPatterns } from './error-patterns.js';
import { MANAGED_MARKER, resolveSkillExportDir, exportSkill, checkDrift } from './fs-export.js';
import { runGepaLite } from './evolve/gepa-lite.js';

const PROVIDER='dsh-skillgrowth',TOOL='dsh_skillgrowth',COMMAND='dsh-skillgrowth';
const hash=v=>createHash('sha256').update(v).digest('hex').slice(0,32);
const nowISO=()=>new Date().toISOString();
const enabled=c=>typeof c.enabled?.get==='function'?c.enabled.get():c.enabled!==false;
const rootAgent=a=>!!a?.session&&a.session.header?.origin!=='subagent';
const compact=e=>/^[a-z][a-z0-9-]{0,60}$/.test(String(e?.message))?e.message:'review-failed';
const textResult=value=>[{type:'text',text:JSON.stringify(value)}];
export function canonicalRoot(cwd){if(typeof cwd!=='string'||!isAbsolute(cwd))return null;try{return realpathSync.native(resolve(cwd));}catch{return null;}}
function projectDiff(old,p){return {before:old?ace.contentView(old):null,after:ace.contentView(p),operations:p.delta?.operations??[],baseRevision:p.baseRevision,candidateHash:p.candidateHash};}
function initProjection(header,floor=0){return {...initialProjection(header,floor),feedback:initialFeedback(header,floor)};}
function foldAll(state,event){const base=foldProjection(state,event);const old=state.feedback??initialFeedback({id:state.sessionId},state.inheritedEventCount);const feedback=foldFeedback(old,event);return base===state&&feedback===old?state:{...base,feedback};}

/** Native bindings are injected to exercise the same pipeline with deterministic fixtures. */
export async function installRuntime(ctx,config,{z,runCase,caseSets=[],NativeToolExecutor,createUserMessage}={}){
  let configured=[];
  if(config.declarativeCaseSetsJson){if(config.declarativeCaseSetsJson.length>250000)throw Error('case-config-too-large');if(hasSecret(config.declarativeCaseSetsJson))throw Error('sensitive-case-config');try{configured=JSON.parse(config.declarativeCaseSetsJson);}catch{throw Error('invalid-case-config');}if(!Array.isArray(configured)||configured.length>16)throw Error('invalid-case-config');}
  const trustedCaseSets=[...caseSets,...configured].map(value=>value.appliesTo?validatePairedCaseSet(value):validateCaseSet(value));
  const requirePaired=config.requirePairedEvaluation!==false;
  const modes=resolveModes(config);
  const delivery=config.skillDelivery||'filesystem';
  const exportDirCache=new Map();
  const scopeHashOf=root=>hash(root);
  const fsBody=skill=>ace.renderSkill(skill)+'\n'+MANAGED_MARKER+'\n';
  if(trustedCaseSets.length>32||new Set(trustedCaseSets.map(s=>s.id)).size!==trustedCaseSets.length)throw Error('invalid-case-config');
  const lifetime=new AbortController(),jobs=new Set(),rootJobs=new Map(),inFlight=new Set(),controllers=new Map(),cuts=new Map(),hints=new Map(),restoredRoots=new Set();
  function trackJob(root,job){jobs.add(job);if(!rootJobs.has(root))rootJobs.set(root,new Set());const group=rootJobs.get(root);group.add(job);const done=()=>{jobs.delete(job);group.delete(job);if(!group.size)rootJobs.delete(root);};job.then(done,done);return job;}
  let invalidate=()=>{},store,stopWatch;
  ctx.effect(()=>async()=>{lifetime.abort();for(const c of controllers.keys())c.abort();if(typeof stopWatch==='function')stopWatch();await Promise.allSettled([...jobs]);await store?.drain();await store?.close();});
  store=await openProjectStore(ctx,{z,initialMode:config.initialMode,invalidate:()=>invalidate()});
  const projection=await ctx.sessionProjections.register({key:'dsh-skillgrowth-observations',stateVersion:4,stateSchema:z.custom(v=>v&&v.version===1&&Array.isArray(v.events)),init:initProjection,apply:foldAll});
  const rootOf=a=>canonicalRoot(ctx.workingDirectory.get(a.session));
  const projectOf=root=>store.read(root);
  function cutOf(agent,seq=agent.session.seq){const root=rootOf(agent),old=cuts.get(agent.id);if(!old||old.root!==root){const value={root,floor:seq};cuts.set(agent.id,value);return value;}return old;}
  for(const a of ctx.agents.list())if(rootAgent(a))cutOf(a);
  function batchOf(agent,force){
    const state=projection.stateOf(agent.session),batch=selectBatch(state,{force,maxInputChars:Math.floor(config.maxInputChars/2)});if(!batch)return null;
    const floor=Math.max(state.inheritedEventCount,cutOf(agent).floor),evidence=batch.evidence.filter(e=>e.seq>=floor).map(({seq,type,text,verified})=>({seq,type,text,verified:!!verified}));
    if(!evidence.length)return null;
    const required=batch.confirmationSeqs||[],complete=required.length>0&&required.every(s=>evidence.some(e=>e.seq===s));
    return {...batch,evidence,confirmed:batch.confirmed&&complete,confirmationSeqs:complete?required:[],floor,feedbackState:state.feedback};
  }
  function knownSnapshots(project){return project.skills.flatMap(s=>s.revisions.map(r=>{try{return {name:s.name,revision:r.revision,content:ace.renderSkill({...r,status:'active',revisions:[r]})};}catch{return null;}}).filter(Boolean));}
  // Filesystem delivery: KV stays canonical; .agents/skills is the published mirror.
  function exportDirFor(root){if(!exportDirCache.has(root)){try{exportDirCache.set(root,resolveSkillExportDir(root));}catch{exportDirCache.set(root,null);}}return exportDirCache.get(root);}
  async function syncExports(root,{names,force}={}){
    if(delivery==='provider')return {status:'provider'};
    const dir=exportDirFor(root);if(!dir)return {status:'export-error',message:'unresolvable-export-dir'};
    const scopeHash=scopeHashOf(root),results=[];
    for(const skill of projectOf(root).skills.filter(s=>s.status==='active'&&(!names||names.includes(s.name)))){
      const content=fsBody(skill),target=join(dir.dir,skill.name);
      if(!force&&checkDrift({exportDir:dir.dir,name:skill.name,content,scopeHash})==='exported'){results.push({name:skill.name,status:'exported',path:join(target,'SKILL.md'),cached:true});continue;}
      const r=exportSkill({exportDir:dir.dir,name:skill.name,content,sidecar:{scopeHash,revision:skill.revision,candidateHash:skill.provenance.sourcePublication?.candidateHash??null,exportedAt:nowISO()}});
      results.push({name:skill.name,status:r.status,...(r.path?{path:r.path}:{})});
    }
    return {status:'synced',dir:dir.dir,kind:dir.kind,results};
  }
  function removeExport(root,name){
    if(delivery==='provider')return {status:'provider'};
    const dir=exportDirFor(root);if(!dir)return {status:'export-error'};
    const file=join(dir.dir,name,'SKILL.md'),sidecar=join(dir.dir,name,'.skillgrowth.json');
    try{
      if(!existsSync(file))return {status:'missing'};
      if(existsSync(sidecar)&&JSON.parse(readFileSync(sidecar,'utf8')).scopeHash===scopeHashOf(root)){
        if(!readFileSync(file,'utf8').includes(MANAGED_MARKER)&&!existsSync(sidecar))return {status:'conflict'};
        unlinkSync(file);try{unlinkSync(sidecar);}catch{}return {status:'removed'};
      }
      return {status:'conflict'};
    }catch(error){return {status:'error',message:String(error.message??error).slice(0,200)};}
  }
  function providerVisible(skill,root){
    if(delivery!=='filesystem')return true;
    const dir=exportDirFor(root);if(!dir)return true;
    try{return checkDrift({exportDir:dir.dir,name:skill.name,content:fsBody(skill),scopeHash:scopeHashOf(root)})!=='exported';}catch{return true;}
  }
  async function runReview(agent,{force=false,manual=false,hint='',externalSignal}={}){
    if(!enabled(config)||lifetime.signal.aborted||!rootAgent(agent))return {status:'disabled'};
    const root=rootOf(agent);if(!root)return {status:'invalid-workspace'};if(restoredRoots.has(root))return {status:'storage-restored'};
    if(projectOf(root).paused)return {status:'paused'};
    const batch=batchOf(agent,force);if(!batch)return {status:'no-new-signal'};
    const p=projectOf(root),runId=hash(`${root}\0${agent.id}\0${batch.lastSeq}`);
    if(inFlight.has(root))return {status:'busy'};
    const exposures=batch.feedbackState?selectExposures(batch.feedbackState,{floor:batch.floor,endSeq:batch.lastSeq,knownSkills:knownSnapshots(p)}):[];
    const feedback=feedbackForBatch(batch,{root,sessionId:agent.id,exposures,watermark:p.watermarks?.[agent.id]??-1});
    if(feedback?.alreadyProcessed)return {status:'already-reviewed'};
    if(!Object.hasOwn(p.watermarks??{},agent.id)&&Object.keys(p.watermarks??{}).length>=4096)return {status:'held-observation-capacity'};
    const selection=agent.model?.current?.(),provider=config.provider||selection?.provider,model=config.model||selection?.model;
    if(!provider||!model)return {status:'model-unavailable'};
    const controller=new AbortController(),baseSignal=AbortSignal.any([controller.signal,lifetime.signal,...(externalSignal?[externalSignal]:[])]),signal=AbortSignal.any([baseSignal,AbortSignal.timeout(config.timeoutMs)]),budget=createCallBudget(requirePaired?2+(config.verificationMaxCalls??18):2);
    const guard=()=>enabled(config)&&!projectOf(root).paused&&rootOf(agent)===root&&!restoredRoots.has(root);
    controllers.set(controller,{root,agentId:agent.id});inFlight.add(root);const stages=[],evaluations=[];let judgments=[],reflection=null,committed=null;
    const quotaOpts={dailyReviews:config.dailyReviews,maxAuxCallsPerDay:config.maxAuxCallsPerDay??40,liteMaxCallsPerDay:config.liteMaxCallsPerDay,standardMaxCallsPerDay:config.standardMaxCallsPerDay};
    async function reserve(stage,mode){return store.reserve(root,{runId,stage,manual,...quotaOpts,cooldownMs:config.cooldownMs,mode,signal,guard});}
    // Lite-only never runs the Curator; lite+standard escalates per policy; standard-only always runs it.
    const curatorGate=!modes.standard?()=>false:modes.lite?(r=>shouldEscalate({escalation:config.escalation,insights:r.insights.length,confirmed:batch.confirmed})):null;
    try{
      let held=null;
      const proposer=createAceLiteProposer({stream:o=>ctx.llm.stream(o),provider,model,sessionId:agent.id,config,project:p,reserve,curatorGate,onStage:s=>stages.push(s),onReflection:r=>{judgments=r.judgments;reflection=r;},onState:(status,code)=>{held={status,code};}});
      const {turn,lastSeq,signal:sourceSignal,confirmed,confirmationSeqs,evidence}=batch;
      const proposed=await proposer.propose({batch:{turn,lastSeq,signal:sourceSignal,confirmed,confirmationSeqs,evidence},feedback,hint},{budget,signal});
      signal.throwIfAborted();if(!guard())throw Error('review-cancelled');let outcome;
      await store.mutate(root,current=>{outcome=ace.stage(current,proposed.candidate??{lessons:[],proposal:null},{runId,sessionId:agent.id,turn:batch.turn,evidence:batch.evidence,confirmed:batch.confirmed,confirmationSeqs:batch.confirmationSeqs,outcome:feedback?.outcome??'unverified',episodeEndSeq:batch.lastSeq,now:nowISO()},{requirePaired,deferAuto:requirePaired});
        // Long-term usefulness: correlate exact-revision exposures with this episode outcome.
        let next=outcome.project;
        if(feedback?.outcome&&exposures.length)next=applyOutcome(next,{exposures,outcome:feedback.outcome,endSeq:batch.lastSeq});
        return next;},{signal,guard});
      let status=held?.status??outcome.status,code=held?.code??'';committed={status,code,proposalId:outcome.proposalId};
      if(requirePaired&&config.autoEvaluate!==false&&outcome.proposalId){
        const candidate=projectOf(root).proposals.find(x=>x.id===outcome.proposalId&&x.status==='pending');
        if(candidate){
          try{
            const result=await verify(agent,root,candidate,undefined,baseSignal,{budget,telemetry:false,onTraining:t=>evaluations.push(t),refine:async(old,trainingFeedback,{budget,signal:evalSignal})=>{
              const draft=await refineCurator({stream:o=>ctx.llm.stream(o),provider,model,sessionId:agent.id,config,project:projectOf(root),batch,reflection,candidateName:old.name,adaptationFeedback:trainingFeedback,budget,signal:evalSignal,reserve:stage=>store.reserve(root,{runId,stage,manual,dailyReviews:config.dailyReviews,maxAuxCallsPerDay:config.maxAuxCallsPerDay??12,cooldownMs:0,signal:evalSignal,guard}),onStage:s=>stages.push(s)});
              if(!draft)return null;let revised;
              await store.mutate(root,current=>{revised=ace.stage(current,{lessons:[],proposal:draft},{runId:hash(runId+'\\0refine'),sessionId:agent.id,turn:batch.turn,evidence:batch.evidence,confirmed:batch.confirmed,confirmationSeqs:batch.confirmationSeqs,outcome:feedback?.outcome??'unverified',now:nowISO()},{requirePaired:true,deferAuto:true});return revised.project;},{signal:evalSignal,guard});
              return revised.proposalId?projectOf(root).proposals.find(x=>x.id===revised.proposalId&&x.status==='pending')??null:null;
            }});
            outcome.proposalId=result.proposalId??outcome.proposalId;evaluations.push({receipt:result.receipt??null,publication:result.publication,budget:result.budget??budget.snapshot()});status=result.publication;code=result.receipt?.metrics?.comparison?.verdict??result.publication;
          }catch(error){if(error.telemetry)stages.push(error.telemetry);status='held-evaluation';code=baseSignal.aborted?'evaluation-aborted':compact(error);}
        }
      }
      committed={status,code,proposalId:outcome.proposalId};
      let exportSync=null;if(committed.status==='published')exportSync=await syncExports(root).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));
      await store.finish(root,status,code,{runId,stages,judgments,evaluations,budget:budget.snapshot(),craftPolicy:CRAFT_POLICY_VERSION,modes:{lite:modes.lite,standard:modes.standard,heavy:modes.heavy},exportSync});return exportSync?{...committed,exportSync}:committed;
    }catch(error){
      if(committed){ctx.logger.warn('ACE project committed; telemetry unavailable: %s',compact(error));return {...committed,telemetry:'unavailable',telemetryCode:compact(error)};}
      if(error.telemetry&&!stages.includes(error.telemetry))stages.push(error.telemetry);
      const code=signal.aborted?'review-aborted':compact(error),status=error.reviewStatus??(code.startsWith('held-')?code:'failed');if(!lifetime.signal.aborted)await store.finish(root,status,code,{runId,stages,judgments}).catch(()=>{});
      ctx.logger.warn('ACE-lite review did not publish: %s',code);return {status,code};
    }finally{controllers.delete(controller);inFlight.delete(root);}
  }
  function launch(agent,options){if(!modes.any)return {status:'learning-off'};const root=rootOf(agent),job=trackJob(root,runReview(agent,options));job.catch(e=>ctx.logger.warn('ACE review failed: %s',compact(e)));return job;}
  function status(root){const p=projectOf(root),c=store.control(root);return {...ace.summary(p),engine:'skillgrowth',version:'0.3.0',modes:{...modes,learning:modes.any},craft:{policy:CRAFT_POLICY_VERSION,requirePairedEvaluation:requirePaired,autoEvaluate:config.autoEvaluate!==false,maxRefinements:config.maxRefinements??1,escalation:config.escalation,liteSoftAuto:config.liteSoftAuto===true,skillDelivery:delivery,matchingCaseSets:trustedCaseSets.filter(s=>s.appliesTo?.root===root).map(s=>({id:s.id,names:s.appliesTo.names}))},budget:{dailyLimit:config.dailyReviews,attempts:c.attempts,maxAuxCallsPerDay:config.maxAuxCallsPerDay??40,auxCalls:c.auxCalls,liteMaxCallsPerDay:config.liteMaxCallsPerDay,liteCalls:c.liteCalls,standardMaxCallsPerDay:config.standardMaxCallsPerDay,standardCalls:c.standardCalls,heavyRuns:c.heavyRuns},lastReview:{status:c.status,code:c.code,at:c.updatedAt,telemetry:c.telemetry?.at(-1)??null},storageRestored:restoredRoots.has(root)};}
  // Human/agent note -> unconfirmed staged lesson (zero-LLM). Evidence seq 0 marks a human-origin note.
  async function stageHumanLesson(agent,root,note){
    const text=String(note||'').trim();if(!text||text.length>1200||hasSecret(text))throw Error('Supply a short non-sensitive note');
    const runId=hash(`${root}\0${agent.id}\0lesson\0${randomUUID()}`),clean=redact(text).slice(0,1000);
    let outcome;await store.mutate(root,current=>{outcome=ace.stage(current,{lessons:[{kind:'intervention',trigger:'Human-supplied note',lesson:clean,evidenceSeqs:[0]}],proposal:null},{runId,sessionId:agent.id,turn:0,evidence:[{seq:0,type:'user/message',text:clean,verified:true,turn:0}],confirmed:false,outcome:'unverified',now:nowISO()},{requirePaired,deferAuto:false});return outcome.project;});
    return {status:outcome.status,proposalId:outcome.proposalId,confirmation:'not granted'};
  }
  ctx.skills.registerProvider(control=>{invalidate=control.invalidate;const visible=cwd=>{const root=canonicalRoot(cwd);return root?projectOf(root).skills.filter(s=>s.status==='active'):[];};return {
    name:PROVIDER,
    async list(options){if(!enabled(config))return [];const root=canonicalRoot(options.cwd);if(!root)return [];return visible(options.cwd).filter(s=>providerVisible(s,root)).map(s=>({name:s.name,description:s.description,whenToUse:s.trigger,invocation:{modelInvocable:true,userInvocable:true},source:'custom',provider:PROVIDER,resourceBase:{kind:'opaque',description:'Project-scoped versioned skill; history: /dsh-skillgrowth show '+s.name},rank:25,locator:{project:hash(root),name:s.name,revision:s.revision}}));},
    async get(candidate,options){options.signal?.throwIfAborted();if(!enabled(config))return undefined;const root=canonicalRoot(options.cwd);if(!root||candidate.locator?.project!==hash(root))return undefined;const skill=visible(options.cwd).find(s=>s.name===candidate.name&&s.revision===candidate.locator.revision);if(!skill||!providerVisible(skill,root))return undefined;return {...candidate,content:ace.renderSkill(skill),metadata:{revision:skill.revision,scope:'project',quality:'evidence-linked; not universal benchmark validation'}};},
  };});
  ctx.skills.register({name:'dsh-skillgrowth-guide',description:'Inspect automatic ACE-lite learning, review, soft auto, entry deltas and rollback.',content:GUIDE,source:'runtime',provider:PROVIDER,resourceBase:{kind:'opaque',description:'Native commands and dsh_skillgrowth tool; no supporting files.'}});
  ctx.systemPrompt.section({name:'dsh-skillgrowth-guidance',order:870,text:({scope})=>enabled(config)&&(!scope?.session||rootAgent(scope))?AGENT_GUIDANCE:''});
  ctx.systemPrompt.context({name:'dsh-skillgrowth-status',order:870,text:({scope})=>{if(!enabled(config)||!rootAgent(scope))return '';const root=rootOf(scope);if(!root)return '';const p=projectOf(root),pending=p.proposals.filter(x=>x.status==='pending').slice(-3);return `Skillgrowth: ${p.paused?'paused':p.mode}. ${pending.length?'Pending (not active instructions): '+pending.map(x=>x.id+' '+x.name+(x.confirmed?' [evidence confirmed]':' [unconfirmed]')).join('; ')+'. Inspect with dsh_skillgrowth read; human /dsh-skillgrowth approve <id>.':''}`;}});
  ctx.tools.register({name:TOOL,description:'Inspect project learning status or a skill/proposal; request reflection after a correction; record a short lesson note. Cannot confirm, approve or change mode.',parameters:{type:'object',properties:{action:{type:'string',enum:['status','read','reflect','lesson']},id:{type:'string',description:'Skill name or proposal id for read.'},note:{type:'string',description:'Brief intervention or lesson; never verification.'}},required:['action'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>textResult(v)},async execute(args,exec){
    if(!rootAgent(exec.agent))throw Error('Root session required');const root=rootOf(exec.agent);if(!root)throw Error('Workspace unavailable');if(args.action==='status')return status(root);const p=projectOf(root);
    if(args.action==='read')return readItem(p,args.id);
    if(args.action==='reflect'){if(!enabled(config)||p.paused||restoredRoots.has(root))return {status:'disabled'};const note=String(args.note||'').trim();if(!note||note.length>1200||hasSecret(note))throw Error('Supply a short non-sensitive intervention note');if(hints.size>=100)throw Error('Reflection queue full');hints.set(exec.agent.id,{note,turn:ctx.agents.turnBoundaryOf(exec.agent.session).lastTurn});return {status:'queued-for-turn-end',confirmation:'not granted'};}
    if(args.action==='lesson'){if(!enabled(config)||!modes.any||p.paused||restoredRoots.has(root))return {status:'disabled'};return stageHumanLesson(exec.agent,root,args.note);}
    throw Error('Unknown action');
  }});
  function readItem(p,id){const telemetry=store.control(p.root).telemetry;const proposal=p.proposals.find(x=>x.id===id);if(proposal)return {schemaVersion:2,proposal:{...proposal,...ace.contentView(proposal)},diff:projectDiff(p.skills.find(x=>x.name===proposal.name),proposal),modelJudgments:summarizeJudgments(proposal,telemetry)};const skill=p.skills.find(x=>x.name===id);if(!skill)throw Error('Skill or proposal not found');return {schemaVersion:2,skill:{...skill,...ace.contentView(skill)},modelJudgments:summarizeJudgments(skill,telemetry),content:skill.status==='active'?ace.renderSkill(skill):'Archived skill; restore explicitly before use.'};}
  async function verify(agent,root,candidate,caseSetId,externalSignal,options={}){
    const controller=new AbortController();controllers.set(controller,{root,agentId:agent.id});
    const signal=AbortSignal.any([controller.signal,lifetime.signal,...(externalSignal?[externalSignal]:[]),AbortSignal.timeout(config.verificationTimeoutMs??120000)]);
    const guard=()=>enabled(config)&&rootOf(agent)===root&&!projectOf(root).paused&&!restoredRoots.has(root);
    const budget=options.budget??createCallBudget(config.verificationMaxCalls??18),selection=agent.model?.current?.()??{},model={provider:config.provider||selection.provider,model:config.model||selection.model,...(selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{})};
    let nativeCase;const executeCase=args=>{nativeCase??=runCase??createNativeCaseRunner(ctx,{NativeToolExecutor,createUserMessage,ownerAgent:agent,provider:model.provider,model:model.model,preloadCandidate:requirePaired,onDispatch:async()=>{signal.throwIfAborted();if(!guard())throw Error('verification-cancelled');if(requirePaired){const claim=await store.reserve(root,{runId:'evaluation-'+candidate.id,stage:'evaluator',manual:true,dailyReviews:config.dailyReviews,maxAuxCallsPerDay:config.maxAuxCallsPerDay??12,cooldownMs:0,signal,guard});if(claim!=='claimed')throw Error(claim);}}});return nativeCase(args);};
    const job=(async()=>{
      signal.throwIfAborted();if(!guard())throw Error('verification-cancelled');
      let registry,receipt,report=null,refined=false;
      if(requirePaired){
        registry=createPairedEvaluatorRegistry({runCase:executeCase,hashCandidate:ace.candidateHash,hashBaseline:ace.snapshotHash,model});
        for(const cases of trustedCaseSets){try{registry.registerCaseSet(cases);}catch{ctx.logger.warn('Paired evaluator skipped incompatible trusted suite %s',cases.id);}}
        caseSetId=caseSetId??registry.select(root,candidate.name);
        if(!caseSetId)return {publication:'held-no-trusted-cases',receipt:null,policy:CRAFT_POLICY_VERSION};
        const baseline=projectOf(root).skills.find(s=>s.name===candidate.name&&s.status==='active')??null;
        let training=await registry.train(candidate,caseSetId,{baseline,scope:root,budget,signal});options.onTraining?.(training);
        if(training.verdict==='candidate-failed'&&typeof options.refine==='function'&&(config.maxRefinements??1)>0&&budget.snapshot().remaining>=5){
          const updated=await options.refine(candidate,registry.feedback(training),{budget,signal});
          if(updated){candidate=updated;refined=true;training=await registry.train(candidate,caseSetId,{baseline,scope:root,budget,signal});options.onTraining?.(training);}
        }
        const evaluated=await registry.finalize(candidate,caseSetId,{baseline,scope:root,budget,signal,training});receipt=evaluated.receipt;report=evaluated.report;
      }else{
        registry=createEvaluatorRegistry({runCase:executeCase,hashCandidate:ace.candidateHash});for(const cases of trustedCaseSets)registry.registerCaseSet(cases);
        receipt=await registry.evaluate(candidate,caseSetId,{scope:root,budget,signal,timeoutMs:config.verificationTimeoutMs??120000});
      }
      signal.throwIfAborted();if(!guard()||!registry.owns(receipt,{candidateHash:candidate.candidateHash,scope:root}))throw Error('invalid-evaluation-receipt');
      let decision;await store.mutate(root,c=>{let next=ace.attachEvaluation(c,candidate.id,receipt,nowISO());if(next.mode==='auto'){decision=ace.autoPublish(next,candidate.id,nowISO(),{requirePaired});next=decision.project;}return next;},{signal,guard});
      const value={receipt,proposalId:candidate.id,publication:decision?.status??'pending-review',refined,...(report?{report}:{}),budget:budget.snapshot()};
      if(value.publication==='published')value.exportSync=await syncExports(root).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));
      if(options.telemetry!==false)await store.finish(root,value.publication,receipt.metrics?.comparison?.verdict??'',{runId:receipt.runId,evaluation:receipt,budget:value.budget,policy:CRAFT_POLICY_VERSION});
      return value;
    })();trackJob(root,job);try{return await job;}finally{controllers.delete(controller);}
  }
  async function benchmark(agent,root,seed,cap,externalSignal){
    if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||!Number.isSafeInteger(cap)||cap<1||cap>200)throw Error('benchmark-budget-invalid');
    const controller=new AbortController();controllers.set(controller,{root,agentId:agent.id});
    const signal=AbortSignal.any([controller.signal,lifetime.signal,externalSignal,AbortSignal.timeout(300000)]);
    const guard=()=>enabled(config)&&rootOf(agent)===root&&!projectOf(root).paused&&!restoredRoots.has(root);
    const job=(async()=>{
      signal.throwIfAborted();if(!guard())throw Error('benchmark-cancelled');
      const adapters=createComparisonAdapters(ctx,{ownerAgent:agent,NativeToolExecutor,createUserMessage,root,config,onDispatch:()=>{signal.throwIfAborted();if(!guard())throw Error('benchmark-cancelled');}});
      const result=await runComparison({caseSet:createNativeFixtureSet(),snapshots:adapters.snapshots,runCase:adapters.runCase,propose:adapters.propose,seed,maxLogicalCalls:cap,timeoutMs:300000,signal});
      return {...result,storage:'Experiment-only in-memory snapshots; production library and its mode were not mutated.',methodology:'Controlled declarative ReAct workflow fixtures; not a JavaScript-generation benchmark or a general quality/savings claim.'};
    })();trackJob(root,job);try{return await job;}finally{controllers.delete(controller);}
  }
  async function evolveSkill(agent,root,name,{epochs,population,seed=42}={},externalSignal){
    if(!enabled(config)||lifetime.signal.aborted)return {status:'disabled'};
    if(restoredRoots.has(root))throw Error('storage-restored-stop-v02-before-downgrade');
    const project=projectOf(root),baseline=project.skills.find(s=>s.name===name&&s.status==='active');
    if(!baseline)return {status:'skill-not-found'};
    const registry=createPairedEvaluatorRegistry({runCase:createNativeCaseRunner(ctx,{NativeToolExecutor,createUserMessage,ownerAgent:agent,provider:(config.provider||agent.model?.current?.()?.provider),model:(config.model||agent.model?.current?.()?.model),preloadCandidate:requirePaired,onDispatch:async()=>{externalSignal?.throwIfAborted();}}),hashCandidate:ace.candidateHash,hashBaseline:ace.snapshotHash,model:{provider:config.provider||agent.model?.current?.()?.provider,model:config.model||agent.model?.current?.()?.model}});
    for(const cases of trustedCaseSets){try{registry.registerCaseSet(cases);}catch{/* skip incompatible */}}
    const caseSetId=registry.select(root,name);
    if(!caseSetId)return {status:'held-no-trusted-cases'};
    const guard=()=>enabled(config)&&rootOf(agent)===root&&!projectOf(root).paused&&!restoredRoots.has(root);
    const claim=await store.reserve(root,{runId:hash(`${root}\0evolve\0${name}\0${nowISO()}`),stage:'heavy',manual:true,heavyMaxRunsPerDay:config.heavyMaxRunsPerDay??1,maxAuxCallsPerDay:config.maxAuxCallsPerDay??40,signal:externalSignal,guard});
    if(claim!=='claimed')return {status:heldForReserve(claim)};
    const controller=new AbortController();controllers.set(controller,{root,agentId:agent.id});
    const signal=AbortSignal.any([controller.signal,lifetime.signal,...(externalSignal?[externalSignal]:[]),AbortSignal.timeout(config.verificationTimeoutMs??120000)]);
    const budget=createCallBudget(config.heavyMaxCallsPerRun??60),trainings=new Map(),selection=agent.model?.current?.()??{};
    const provider=config.provider||selection.provider,model=config.model||selection.model;
    // Identity candidate: lets the paired evaluator run the baseline through the candidate arm too.
    const asCandidate=skill=>({...skill,baseRevision:skill.revision,candidateHash:ace.candidateHash({name:skill.name,description:skill.description,trigger:skill.trigger,entries:skill.entries,baseRevision:skill.revision}),delta:{name:skill.name,baseRevision:skill.revision,baseHash:ace.snapshotHash(skill),reason:'baseline-identity',evidenceSeqs:[0],operations:[{op:'insert',section:'check',text:'baseline identity',afterId:null}]}});
    const baselineCandidate=asCandidate(baseline);
    const synthEvidence=[{seq:0,type:'user/message',text:'evolve synthetic context',verified:false,turn:0}];
    const evolveRunId=hash(`${root}\0${agent.id}\0evolve\0${Date.now()}`);
    async function stageVariant(proposal,suffix){
      let outcome;await store.mutate(root,current=>{outcome=ace.stage(current,{lessons:[],proposal},{runId:`${evolveRunId}:${suffix}`,sessionId:agent.id,turn:0,evidence:synthEvidence,confirmed:false,outcome:'unverified',now:nowISO()},{requirePaired:true,deferAuto:true});return outcome.project;},{signal,guard});
      return outcome.proposalId?projectOf(root).proposals.find(x=>x.id===outcome.proposalId)??null:null;
    }
    function aspectHint(feedback){
      if(!feedback?.adaptation)return 'improve the weakest checks';
      const f=feedback.adaptation;
      return `adaptation gains ${f.gains}, regressions ${f.regressions}, failed ${f.candidateFailed}; fix failed checks minimally, keep everything else`;
    }
    async function proposeVariant({parent,feedback,index,attempt}){
      try{
        const training=trainings.get(parent);
        const adaptationFeedback=training?registry.feedback(training):undefined;
        const insight={targetName:name,trigger:`evolution aspect ${index}:${attempt}`,lesson:aspectHint(feedback).slice(0,400),evidenceSeqs:[0]};
        const input=buildCuratorInput({reflection:{lessons:[],insights:[insight],judgments:[]},batch:{confirmed:false,confirmationSeqs:[],evidence:synthEvidence,turn:0},project:projectOf(root),maxChars:config.heavyMaxInputChars??24000,adaptationFeedback});
        const claim=await store.reserve(root,{runId:`${evolveRunId}:c:${index}:${attempt}`,stage:'curator',manual:true,...quotaOpts,cooldownMs:0,mode:'heavy',signal,guard});
        if(claim!=='claimed')return null;
        budget.reserve('curator');
        const result=await collectRole(o=>ctx.llm.stream(o),{provider,model,sessionId:agent.id,messages:[{role:'user',content:[{type:'text',text:input.input}]}],system:CURATOR_SYSTEM,maxTokens:config.maxOutputTokens-Math.floor(config.maxOutputTokens/3),signal,purpose:'dsh-skillgrowth-curator'});
        const proposal=result.value?.proposal;if(!proposal)return null;
        assertCuratorTarget(proposal,input.target,projectOf(root));
        return await stageVariant(proposal,`v${index}:${attempt}`);
      }catch(error){ctx.logger.warn('evolve variant failed: %s',compact(error));return null;}
    }
    function mergeContents(a,b){
      const baseMap=new Map(baseline.entries.map(e=>[e.id,e]));
      const aMap=new Map(a.entries.map(e=>[e.id,e.text])),bMap=new Map(b.entries.map(e=>[e.id,e.text]));
      const seen=new Set(),entries=[];
      for(const e of baseline.entries){
        const at=aMap.get(e.id)??e.text,bt=bMap.get(e.id)??e.text;
        const text=at!==e.text&&bt===e.text?at:bt!==e.text&&at===e.text?bt:at;
        seen.add(text);entries.push({...e,text});
      }
      for(const src of [a,b])for(const e of src.entries){if(baseMap.has(e.id)||seen.has(e.text))continue;seen.add(e.text);entries.push({...e,id:`merge-${hash(e.text).slice(0,8)}`,entryVersion:1,protected:false,status:'active',evidenceRefs:[0]});}
      return {name:baseline.name,description:baseline.description,trigger:baseline.trigger,entries};
    }
    function deltaFrom(merged,reason){
      const baseMap=new Map(baseline.entries.map(e=>[e.id,e])),ops=[];
      for(const e of merged.entries){const b=baseMap.get(e.id);
        if(!b){if(ops.length>=8)return null;ops.push({op:'insert',section:e.section,text:e.text,afterId:null});}
        else if(b.status==='active'&&b.text!==e.text){if(ops.length>=8)return null;ops.push({op:'replace',entryId:e.id,expectedHash:ace.entryHash(b),text:e.text});}}
      if(!ops.length)return null;
      return {name:baseline.name,baseRevision:baseline.revision,baseHash:ace.snapshotHash(baseline),reason:reason.slice(0,400),evidenceSeqs:[0],operations:ops};
    }
    async function recombine(a,b){
      try{const delta=deltaFrom(mergeContents(a,b),`recombine of two pareto variants`);return delta?await stageVariant(delta,'re'):null;}catch(error){ctx.logger.warn('evolve recombine failed: %s',compact(error));return null;}
    }
    let state='evolve-started',receipt=null,publication=null,report=null;
    try{
      const rng=(()=>{let s=(seed>>>0)||1;return()=> (s=(Math.imul(s,1664525)+1013904223)>>>0)/2**32;})();
      const run=await runGepaLite({
        baseline:baselineCandidate,
        evaluate:async variant=>{const candidate=variant.revisions?asCandidate(variant):variant;const training=await registry.train(candidate,caseSetId,{baseline,scope:root,budget,signal});trainings.set(variant,training);const s=training.adaptation;return {adaptation:{gains:s.gains,regressions:s.regressions,candidateFailed:s.candidateFailed,complete:s.complete,coverage:variant===baselineCandidate?0:s.gains}};},
        proposeVariant,recombine,budget,signal,
        epochs:epochs??config.heavyEpochs??2,population:population??config.heavyPopulation??3,maxRefineAttempts:1,rng,
      });
      report=run;
      if(run.winner&&run.reason==='candidate-found'){
        const training=trainings.get(run.winner);
        const evaluated=await registry.finalize(run.winner,caseSetId,{baseline,scope:root,budget,signal,training});
        receipt=evaluated.receipt;
        let winner=projectOf(root).proposals.find(x=>x.id===run.winner.id&&x.status==='pending');
        if(!winner){const restaged=await stageVariant(run.winner.delta,`final:${hash(run.winner.candidateHash).slice(0,8)}`);winner=restaged?projectOf(root).proposals.find(x=>x.id===restaged.id&&x.status==='pending'):null;}
        if(winner){await store.mutate(root,current=>{let next=ace.attachEvaluation(current,winner.id,receipt,nowISO());let decision;if(next.mode==='auto'){decision=ace.autoPublish(next,winner.id,nowISO(),{requirePaired:true});next=decision.project;}publication=decision?.status??'pending-review';return next;},{signal,guard});}
        else publication='winner-superseded';
        if(publication==='published'){const sync=await syncExports(root).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));receipt={...receipt,exportSync:sync};}
      }
      state=run.reason;
      await store.finish(root,`evolve-${run.reason}`,receipt?.metrics?.comparison?.verdict??'',{runId:evolveRunId,evaluations:run.evaluations.length,epochs:run.epochs,budget:budget.snapshot(),craftPolicy:CRAFT_POLICY_VERSION});
      return {status:publication??`evolve-${run.reason}`,reason:run.reason,verdict:receipt?.metrics?.comparison?.verdict??null,winnerGains:run.winnerMetrics?.adaptation?.gains??null,baselineGains:run.baselineMetrics?.adaptation?.gains??0,evaluations:run.evaluations.length,epochs:run.epochs,budget:budget.snapshot(),receipt,methodology:'GEPA-lite: pareto-constrained reflection evolution; adaptation-only feedback to proposer; holdout only at finalize.'};
    }catch(error){await store.finish(root,signal.aborted?'evolve-aborted':'evolve-failed',compact(error),{runId:evolveRunId,budget:budget.snapshot()}).catch(()=>{});throw error;}
    finally{controllers.delete(controller);}
  }
  ctx.commands.register({name:COMMAND,description:'Skillgrowth: ACE-lite review, lite lessons, heavy evolve, source confirmation, publication, entry protection, verification, filesystem export, migration restore.',input:{hint:'status | show ID | confirm ID | approve ID | mode auto | lesson TEXT | evolve NAME | export [NAME] [--force] | impact [NAME] | pin NAME ENTRY | verify ID CASESET | storage-backups'},async handler(invocation){try{
    const {agent,signal}=invocation;signal.throwIfAborted();if(!rootAgent(agent))throw Error('Root session required');const root=rootOf(agent);if(!root)throw Error('Workspace unavailable');const [action='help',id,arg]=String(invocation.rawInput||'').trim().split(/\s+/).filter(Boolean);const p=projectOf(root);let value;
    const mutate=fn=>{if(restoredRoots.has(root))throw Error('storage-restored-stop-v02-before-downgrade');return store.mutate(root,fn,{signal,guard:()=>!lifetime.signal.aborted&&!restoredRoots.has(root)&&rootOf(agent)===root});};
    if(action==='help')return {kind:'success',text:GUIDE};
    if(action==='status')value=status(root);
    else if(action==='pending')value=p.proposals.filter(x=>x.status==='pending').map(x=>({id:x.id,name:x.name,reason:x.reason,confirmed:x.confirmed,evidenceStatus:x.evidenceStatus,evaluationStatus:x.evaluationStatus,baseRevision:x.baseRevision,...(x.origin?{origin:x.origin}:{})}));
    else if(action==='lesson')value=await stageHumanLesson(agent,root,String(invocation.rawInput||'').trim().slice(action.length).trim()||id);
    else if(action==='impact')value=id?(readItem(projectOf(root),id).skill?.impact??null):projectOf(root).skills.map(x=>({name:x.name,revision:x.revision,...(x.impact?{impact:x.impact}:{})}));
    else if(action==='show')value=readItem(p,id);
    else if(action==='confirm')value=ace.summary(await mutate(c=>ace.confirm(c,id,{commandId:invocation.commandId,sessionId:agent.id},nowISO())));
    else if(action==='approve'){value=ace.summary(await mutate(c=>ace.approve(c,id,nowISO())));value.exportSync=await syncExports(root).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));}
    else if(action==='reject')value=ace.summary(await mutate(c=>ace.reject(c,id,nowISO())));
    else if(action==='mode'){if(!['review','auto'].includes(id))throw Error('Mode must be review or auto');value=ace.summary(await mutate(c=>({...c,mode:id})));}
    else if(action==='pause'||action==='resume'){value=ace.summary(await mutate(c=>({...c,paused:action==='pause'})));if(action==='pause')for(const [c,owner]of controllers)if(owner.root===root)c.abort();}
    else if(action==='rollback'){if(!/^\d+$/.test(arg||''))throw Error('Supply retained revision');value=ace.summary(await mutate(c=>ace.rollback(c,id,Number(arg),nowISO())));value.exportSync=await syncExports(root,{names:[id]}).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));}
    else if(action==='archive'){value=ace.summary(await mutate(c=>ace.archive(c,id,nowISO())));value.exportRemoval=removeExport(root,id);}
    else if(action==='restore'){value=ace.summary(await mutate(c=>ace.restore(c,id,nowISO())));value.exportSync=await syncExports(root,{names:[id]}).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));}
    else if(action==='pin'||action==='unpin'){value=ace.summary(await mutate(c=>ace.pin(c,id,arg,action==='pin',nowISO())));value.exportSync=await syncExports(root,{names:[id]}).catch(e=>({status:'export-error',message:String(e?.message??e).slice(0,200)}));}
    else if(action==='export'){const force=[id,arg].includes('--force');value=await syncExports(root,{names:id&&id!=='--force'&&!force?[id]:undefined,force});}
    else if(action==='evolve'){const opts={};for(const t of String(invocation.rawInput||'').trim().split(/\s+/).slice(2)){const m=/^--(epochs|population|seed)=(\d+)$/.exec(t);if(m)opts[m[1]]=Number(m[2]);}value=await evolveSkill(agent,root,id,opts,signal);}
    else if(action==='analyze')value=await launch(agent,{force:true,manual:true,externalSignal:signal});
    else if(action==='curate')value={changed:false,note:'Use a new evidence-backed delta; no automatic semantic merge/prune.'};
    else if(action==='benchmark')value=await benchmark(agent,root,id===undefined?42:Number(id),arg===undefined?96:Number(arg),signal);
    else if(action==='verifiers')value=trustedCaseSets.map(s=>({id:s.id,adaptationCases:s.cases.filter(c=>c.split==='adaptation').length,holdoutCases:s.cases.filter(c=>c.split==='holdout').length,appliesTo:s.appliesTo??null,automaticMatch:s.appliesTo?.root===root,environment:'trusted registered paired cases only under strict policy; memory-only declarative, not JS execution'}));
    else if(action==='storage-backups')value=store.backups(root);
    else if(action==='storage-restore'){if(!store.backups(root).some(s=>s.id===id&&s.kind==='project'&&s.format===1))throw Error('invalid-v1-backup');restoredRoots.add(root);for(const[c,owner]of controllers)if(owner.root===root)c.abort();await Promise.allSettled([...rootJobs.get(root)??[]]);value=await store.restore(root,id,{signal,guard:()=>!lifetime.signal.aborted&&rootOf(agent)===root});}
    else if(action==='verify'){
      const candidate=p.proposals.find(x=>x.id===id&&x.status==='pending');if(!candidate)throw Error('Pending proposal not found');
      value=await verify(agent,root,candidate,arg,signal);
    }else throw Error('Unknown command; /dsh-skillgrowth for help');
    return {kind:'success',text:JSON.stringify(value,null,2)};
  }catch(error){return {kind:'error',text:redact(String(error.message||'Command failed')).slice(0,400)};}}});
  // Deterministic tool-error antipattern capture: buffer per-agent turn events,
  // extract resolved repeated-error patterns at turn end, stage lesson+delta.
  const patternBuffers=new Map();
  const patternWords=s=>new Set(String(s).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu)||[]);
  function patternText(content){if(typeof content==='string')return content;if(!Array.isArray(content))return '';return content.slice(0,50).flatMap(b=>b&&b.type==='text'&&typeof b.text==='string'?[b.text]:[]).join('\n');}
  function bestSkillFor(pattern,project){
    const query=patternWords(pattern.tool+' '+pattern.sample);let best=null,score=0;
    for(const s of project.skills.filter(x=>x.status==='active')){const sc=[...patternWords(s.description+' '+s.trigger)].filter(w=>query.has(w)).length;if(sc>score){score=sc;best=s;}}
    return best;
  }
  async function processErrorPatterns(agent,root,buffer){
    if(config.errorPatternEnabled===false||!modes.any||!buffer.events.length)return;
    const patterns=extractErrorPatterns(buffer.events,{minRepeats:config.errorPatternMinRepeats??2});
    if(!patterns.length)return;
    for(const pattern of patterns){
      try{
        const skill=bestSkillFor(pattern,projectOf(root));
        const draft=buildAntipatternDraft(pattern,{skillName:skill?.name,baseRevision:skill?.revision??0,baseHash:skill?ace.snapshotHash(skill):null});
        if(!draft)continue;
        const evidence=draft.lessons[0].evidenceSeqs.map(seq=>{const e=buffer.events.find(x=>x.seq===seq);return {seq,type:'tool/result',text:redact(String(e?.text??'tool error')).slice(0,1000),verified:false,turn:buffer.turn??0};});
        const runId=hash(`${root}\0${agent.id}\0pattern\0${pattern.signature}`);
        await store.mutate(root,current=>{
          let next={...current,errorPatterns:mergeProjectPatterns(current.errorPatterns??[],[{signature:pattern.signature,tool:pattern.tool,count:pattern.count,resolvedCount:1,lastSeq:pattern.recoverySeq}])};
          const outcome=ace.stage(next,{lessons:draft.lessons,proposal:draft.proposal},{runId,sessionId:agent.id,turn:buffer.turn??0,evidence,confirmed:false,outcome:'unverified',now:nowISO()},{requirePaired,deferAuto:draft.proposal?(requirePaired?true:!config.liteSoftAuto):false,origin:draft.proposal?'error-pattern':undefined});
          next=outcome.project;
          if(draft.proposal&&skill&&next.skills.some(s=>s.name===skill.name)){
            const state=projection.stateOf(agent.session);
            const exps=state.feedback?selectExposures(state.feedback,{floor:0,endSeq:buffer.lastSeq??pattern.recoverySeq,knownSkills:knownSnapshots(next)}):[];
            if(exps.some(e=>e.match==='matched'&&e.name===skill.name&&e.revision===skill.revision))next=recordErrorRecovery(next,skill.name);
          }
          return next;
        });
      }catch(error){ctx.logger.warn('error-pattern staging failed: %s',compact(error));}
    }
  }
  ctx.on('session/event',(session,event)=>{if(!enabled(config))return;const agent=ctx.agents.get(session.id);if(!rootAgent(agent))return;const cut=cutOf(agent,event.seq);if(!cut.root)return;
    if(event.type==='user/message'&&event.data?.source?.kind==='user')for(const[c,owner]of controllers)if(owner.agentId===agent.id)c.abort();
    if(event.type==='turn/start')patternBuffers.set(agent.id,{turn:event.data?.turn??null,lastSeq:event.seq,events:[],calls:new Map()});
    if(event.type==='tool/call'&&typeof event.data?.callId==='string'){const b=patternBuffers.get(agent.id);if(b&&typeof event.data?.name==='string')b.calls.set(event.data.callId,event.data.name);}
    if(event.type==='tool/result'){const b=patternBuffers.get(agent.id);if(b){const callId=event.data?.message?.toolCallId;b.lastSeq=event.seq;const message=event.data?.message;b.events.push({seq:event.seq,type:'tool/result',turn:event.data?.turn??b.turn,name:b.calls.get(callId)??'tool',isError:message?.isError===true||Boolean(event.data?.error),text:patternText(message?.content).slice(0,600)});}}
    if(event.type==='turn/end'){const buffer=patternBuffers.get(agent.id);patternBuffers.delete(agent.id);const hint=hints.get(agent.id);hints.delete(agent.id);
      if(event.data?.reason?.kind==='completed'){void launch(agent,{force:!!hint,hint:hint?.note||''});if(buffer){buffer.lastSeq=event.seq;const job=processErrorPatterns(agent,cut.root,buffer);trackJob(cut.root,job);job.catch(e=>ctx.logger.warn('error-pattern failed: %s',compact(e)));}}}});
  ctx.on('agent/disposed',({agent})=>{for(const[c,owner]of controllers)if(owner.agentId===agent.id)c.abort();cuts.delete(agent.id);hints.delete(agent.id);});
  stopWatch=typeof config.enabled?.watch==='function'?config.enabled.watch(v=>{if(!v)for(const c of controllers.keys())c.abort();}):null;
  return {runReview:launch,launch,status,domain:store.domain,projection,store,drain:()=>Promise.allSettled([...jobs])};
}
