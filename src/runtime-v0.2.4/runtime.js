import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import * as ace from './ace-core.js';
import { hasSecret, redact } from './core.js';
import { initialProjection, foldProjection, selectBatch } from './projection.js';
import { initialFeedback, foldFeedback, selectExposures, feedbackForBatch } from './feedback.js';
import { GUIDE, AGENT_GUIDANCE } from './prompts.js';
import {createAceLiteProposer,summarizeJudgments,refineCurator} from './review.js';
import {CREATOR_POLICY_VERSION} from './creator-policy.js';
import {createPairedEvaluatorRegistry,validatePairedCaseSet} from './paired-evaluator.js';
import { openProjectStore } from './store.js';
import { createCallBudget, createEvaluatorRegistry,validateCaseSet } from './optimizer.js';
import {createNativeCaseRunner} from './bench/native-case.js';
import {createComparisonAdapters} from './bench/adapters.js';
import {runComparison} from './bench/runner.js';
import {createNativeFixtureSet} from './bench/native-cases.js';

const PROVIDER='local-skill-loop',TOOL='skill_loop',COMMAND='skill-loop';
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
  if(trustedCaseSets.length>32||new Set(trustedCaseSets.map(s=>s.id)).size!==trustedCaseSets.length)throw Error('invalid-case-config');
  const lifetime=new AbortController(),jobs=new Set(),rootJobs=new Map(),inFlight=new Set(),controllers=new Map(),cuts=new Map(),hints=new Map(),restoredRoots=new Set();
  function trackJob(root,job){jobs.add(job);if(!rootJobs.has(root))rootJobs.set(root,new Set());const group=rootJobs.get(root);group.add(job);const done=()=>{jobs.delete(job);group.delete(job);if(!group.size)rootJobs.delete(root);};job.then(done,done);return job;}
  let invalidate=()=>{},store,stopWatch;
  ctx.effect(()=>async()=>{lifetime.abort();for(const c of controllers.keys())c.abort();if(typeof stopWatch==='function')stopWatch();await Promise.allSettled([...jobs]);await store?.drain();await store?.close();});
  store=await openProjectStore(ctx,{z,initialMode:config.initialMode,invalidate:()=>invalidate()});
  const projection=await ctx.sessionProjections.register({key:'local-skill-loop-observations',stateVersion:4,stateSchema:z.custom(v=>v&&v.version===1&&Array.isArray(v.events)),init:initProjection,apply:foldAll});
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
    async function reserve(stage){return store.reserve(root,{runId,stage,manual,dailyReviews:config.dailyReviews,maxAuxCallsPerDay:config.maxAuxCallsPerDay??12,cooldownMs:config.cooldownMs,signal,guard});}
    try{
      let held=null;
      const proposer=createAceLiteProposer({stream:o=>ctx.llm.stream(o),provider,model,sessionId:agent.id,config,project:p,reserve,onStage:s=>stages.push(s),onReflection:r=>{judgments=r.judgments;reflection=r;},onState:(status,code)=>{held={status,code};}});
      const {turn,lastSeq,signal:sourceSignal,confirmed,confirmationSeqs,evidence}=batch;
      const proposed=await proposer.propose({batch:{turn,lastSeq,signal:sourceSignal,confirmed,confirmationSeqs,evidence},feedback,hint},{budget,signal});
      signal.throwIfAborted();if(!guard())throw Error('review-cancelled');let outcome;
      await store.mutate(root,current=>{outcome=ace.stage(current,proposed.candidate??{lessons:[],proposal:null},{runId,sessionId:agent.id,turn:batch.turn,evidence:batch.evidence,confirmed:batch.confirmed,confirmationSeqs:batch.confirmationSeqs,outcome:feedback?.outcome??'unverified',episodeEndSeq:batch.lastSeq,now:nowISO()},{requirePaired,deferAuto:requirePaired});return outcome.project;},{signal,guard});
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
      await store.finish(root,status,code,{runId,stages,judgments,evaluations,budget:budget.snapshot(),creatorPolicy:CREATOR_POLICY_VERSION});return committed;
    }catch(error){
      if(committed){ctx.logger.warn('ACE project committed; telemetry unavailable: %s',compact(error));return {...committed,telemetry:'unavailable',telemetryCode:compact(error)};}
      if(error.telemetry&&!stages.includes(error.telemetry))stages.push(error.telemetry);
      const code=signal.aborted?'review-aborted':compact(error),status=error.reviewStatus??(code.startsWith('held-')?code:'failed');if(!lifetime.signal.aborted)await store.finish(root,status,code,{runId,stages,judgments}).catch(()=>{});
      ctx.logger.warn('ACE-lite review did not publish: %s',code);return {status,code};
    }finally{controllers.delete(controller);inFlight.delete(root);}
  }
  function launch(agent,options){const root=rootOf(agent),job=trackJob(root,runReview(agent,options));job.catch(e=>ctx.logger.warn('ACE review failed: %s',compact(e)));return job;}
  function status(root){const p=projectOf(root),c=store.control(root);return {...ace.summary(p),engine:'ace-lite',version:'0.2.4',creator:{policy:CREATOR_POLICY_VERSION,requirePairedEvaluation:requirePaired,autoEvaluate:config.autoEvaluate!==false,maxRefinements:config.maxRefinements??1,matchingCaseSets:trustedCaseSets.filter(s=>s.appliesTo?.root===root).map(s=>({id:s.id,names:s.appliesTo.names}))},budget:{dailyLimit:config.dailyReviews,attempts:c.attempts,maxAuxCallsPerDay:config.maxAuxCallsPerDay??12,auxCalls:c.auxCalls},lastReview:{status:c.status,code:c.code,at:c.updatedAt,telemetry:c.telemetry?.at(-1)??null},storageRestored:restoredRoots.has(root)};}
  ctx.skills.registerProvider(control=>{invalidate=control.invalidate;const visible=cwd=>{const root=canonicalRoot(cwd);return root?projectOf(root).skills.filter(s=>s.status==='active'):[];};return {
    name:PROVIDER,
    async list(options){if(!enabled(config))return [];const root=canonicalRoot(options.cwd);if(!root)return [];return visible(options.cwd).map(s=>({name:s.name,description:s.description,whenToUse:s.trigger,invocation:{modelInvocable:true,userInvocable:true},source:'custom',provider:PROVIDER,resourceBase:{kind:'opaque',description:'Project-scoped versioned skill; history: /skill-loop show '+s.name},rank:25,locator:{project:hash(root),name:s.name,revision:s.revision}}));},
    async get(candidate,options){options.signal?.throwIfAborted();if(!enabled(config))return undefined;const root=canonicalRoot(options.cwd);if(!root||candidate.locator?.project!==hash(root))return undefined;const skill=visible(options.cwd).find(s=>s.name===candidate.name&&s.revision===candidate.locator.revision);if(!skill)return undefined;return {...candidate,content:ace.renderSkill(skill),metadata:{revision:skill.revision,scope:'project',quality:'evidence-linked; not universal benchmark validation'}};},
  };});
  ctx.skills.register({name:'skill-loop-guide',description:'Inspect automatic ACE-lite learning, review, soft auto, entry deltas and rollback.',content:GUIDE,source:'runtime',provider:PROVIDER,resourceBase:{kind:'opaque',description:'Native commands and skill_loop tool; no supporting files.'}});
  ctx.systemPrompt.section({name:'local-skill-loop-guidance',order:870,text:({scope})=>enabled(config)&&(!scope?.session||rootAgent(scope))?AGENT_GUIDANCE:''});
  ctx.systemPrompt.context({name:'local-skill-loop-status',order:870,text:({scope})=>{if(!enabled(config)||!rootAgent(scope))return '';const root=rootOf(scope);if(!root)return '';const p=projectOf(root),pending=p.proposals.filter(x=>x.status==='pending').slice(-3);return `Skill loop: ${p.paused?'paused':p.mode}. ${pending.length?'Pending (not active instructions): '+pending.map(x=>x.id+' '+x.name+(x.confirmed?' [evidence confirmed]':' [unconfirmed]')).join('; ')+'. Inspect with skill_loop read; human /skill-loop approve <id>.':''}`;}});
  ctx.tools.register({name:TOOL,description:'Inspect project learning status or a skill/proposal; request reflection after a correction. Cannot confirm, approve or change mode.',parameters:{type:'object',properties:{action:{type:'string',enum:['status','read','reflect']},id:{type:'string',description:'Skill name or proposal id for read.'},note:{type:'string',description:'Brief intervention; never verification.'}},required:['action'],additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>textResult(v)},async execute(args,exec){
    if(!rootAgent(exec.agent))throw Error('Root session required');const root=rootOf(exec.agent);if(!root)throw Error('Workspace unavailable');if(args.action==='status')return status(root);const p=projectOf(root);
    if(args.action==='read')return readItem(p,args.id);
    if(args.action==='reflect'){if(!enabled(config)||p.paused||restoredRoots.has(root))return {status:'disabled'};const note=String(args.note||'').trim();if(!note||note.length>1200||hasSecret(note))throw Error('Supply a short non-sensitive intervention note');if(hints.size>=100)throw Error('Reflection queue full');hints.set(exec.agent.id,{note,turn:ctx.agents.turnBoundaryOf(exec.agent.session).lastTurn});return {status:'queued-for-turn-end',confirmation:'not granted'};}
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
        if(!caseSetId)return {publication:'held-no-trusted-cases',receipt:null,policy:CREATOR_POLICY_VERSION};
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
      if(options.telemetry!==false)await store.finish(root,value.publication,receipt.metrics?.comparison?.verdict??'',{runId:receipt.runId,evaluation:receipt,budget:value.budget,policy:CREATOR_POLICY_VERSION});
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
  ctx.commands.register({name:COMMAND,description:'ACE-lite skill review, source confirmation, publication, entry protection, verification, migration restore.',input:{hint:'status | show ID | confirm ID | approve ID | mode auto | pin NAME ENTRY | verify ID CASESET | storage-backups'},async handler(invocation){try{
    const {agent,signal}=invocation;signal.throwIfAborted();if(!rootAgent(agent))throw Error('Root session required');const root=rootOf(agent);if(!root)throw Error('Workspace unavailable');const [action='help',id,arg]=String(invocation.rawInput||'').trim().split(/\s+/).filter(Boolean);const p=projectOf(root);let value;
    const mutate=fn=>{if(restoredRoots.has(root))throw Error('storage-restored-stop-v02-before-downgrade');return store.mutate(root,fn,{signal,guard:()=>!lifetime.signal.aborted&&!restoredRoots.has(root)&&rootOf(agent)===root});};
    if(action==='help')return {kind:'success',text:GUIDE};
    if(action==='status')value=status(root);
    else if(action==='pending')value=p.proposals.filter(x=>x.status==='pending').map(x=>({id:x.id,name:x.name,reason:x.reason,confirmed:x.confirmed,evidenceStatus:x.evidenceStatus,evaluationStatus:x.evaluationStatus,baseRevision:x.baseRevision}));
    else if(action==='show')value=readItem(p,id);
    else if(action==='confirm')value=ace.summary(await mutate(c=>ace.confirm(c,id,{commandId:invocation.commandId,sessionId:agent.id},nowISO())));
    else if(action==='approve')value=ace.summary(await mutate(c=>ace.approve(c,id,nowISO())));
    else if(action==='reject')value=ace.summary(await mutate(c=>ace.reject(c,id,nowISO())));
    else if(action==='mode'){if(!['review','auto'].includes(id))throw Error('Mode must be review or auto');value=ace.summary(await mutate(c=>({...c,mode:id})));}
    else if(action==='pause'||action==='resume'){value=ace.summary(await mutate(c=>({...c,paused:action==='pause'})));if(action==='pause')for(const [c,owner]of controllers)if(owner.root===root)c.abort();}
    else if(action==='rollback'){if(!/^\d+$/.test(arg||''))throw Error('Supply retained revision');value=ace.summary(await mutate(c=>ace.rollback(c,id,Number(arg),nowISO())));}
    else if(action==='archive'||action==='restore')value=ace.summary(await mutate(c=>ace[action](c,id,nowISO())));
    else if(action==='pin'||action==='unpin')value=ace.summary(await mutate(c=>ace.pin(c,id,arg,action==='pin',nowISO())));
    else if(action==='analyze')value=await launch(agent,{force:true,manual:true,externalSignal:signal});
    else if(action==='curate')value={changed:false,note:'Use a new evidence-backed delta; no automatic semantic merge/prune.'};
    else if(action==='benchmark')value=await benchmark(agent,root,id===undefined?42:Number(id),arg===undefined?96:Number(arg),signal);
    else if(action==='verifiers')value=trustedCaseSets.map(s=>({id:s.id,adaptationCases:s.cases.filter(c=>c.split==='adaptation').length,holdoutCases:s.cases.filter(c=>c.split==='holdout').length,appliesTo:s.appliesTo??null,automaticMatch:s.appliesTo?.root===root,environment:'trusted registered paired cases only under strict policy; memory-only declarative, not JS execution'}));
    else if(action==='storage-backups')value=store.backups(root);
    else if(action==='storage-restore'){if(!store.backups(root).some(s=>s.id===id&&s.kind==='project'&&s.format===1))throw Error('invalid-v1-backup');restoredRoots.add(root);for(const[c,owner]of controllers)if(owner.root===root)c.abort();await Promise.allSettled([...rootJobs.get(root)??[]]);value=await store.restore(root,id,{signal,guard:()=>!lifetime.signal.aborted&&rootOf(agent)===root});}
    else if(action==='verify'){
      const candidate=p.proposals.find(x=>x.id===id&&x.status==='pending');if(!candidate)throw Error('Pending proposal not found');
      value=await verify(agent,root,candidate,arg,signal);
    }else throw Error('Unknown command; /skill-loop for help');
    return {kind:'success',text:JSON.stringify(value,null,2)};
  }catch(error){return {kind:'error',text:redact(String(error.message||'Command failed')).slice(0,400)};}}});
  ctx.on('session/event',(session,event)=>{if(!enabled(config))return;const agent=ctx.agents.get(session.id);if(!rootAgent(agent))return;const cut=cutOf(agent,event.seq);if(!cut.root)return;if(event.type==='user/message'&&event.data?.source?.kind==='user')for(const[c,owner]of controllers)if(owner.agentId===agent.id)c.abort();if(event.type==='turn/end'){const hint=hints.get(agent.id);hints.delete(agent.id);if(event.data?.reason?.kind==='completed')void launch(agent,{force:!!hint,hint:hint?.note||''});}});
  ctx.on('agent/disposed',({agent})=>{for(const[c,owner]of controllers)if(owner.agentId===agent.id)c.abort();cuts.delete(agent.id);hints.delete(agent.id);});
  stopWatch=typeof config.enabled?.watch==='function'?config.enabled.watch(v=>{if(!v)for(const c of controllers.keys())c.abort();}):null;
  return {runReview:launch,launch,status,domain:store.domain,projection,store,drain:()=>Promise.allSettled([...jobs])};
}
