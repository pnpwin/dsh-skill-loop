import * as ace from '../ace-core.js';
import {createCallBudget,createEvaluatorRegistry} from '../optimizer.js';
import {buildCuratorInput,collectRole,CURATOR_SYSTEM,assertCuratorTarget} from '../review.js';
import {createNativeCaseRunner} from './native-case.js';
import {createNativeFixtureSet} from './native-cases.js';

/** Separate Curator-only component check. A gold insight is NOT automatic reflection. */
export async function runCuratorComponentSmoke(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,root,prior,maxLogicalCalls=9,signal:externalSignal,onDispatch=()=>{},onProgress=()=>{}}){
  const signal=AbortSignal.any([AbortSignal.timeout(240000),...(externalSignal?[externalSignal]:[])]),budget=createCallBudget(maxLogicalCalls),selection=ownerAgent.model.current(),stages=[],cases=[],errors=[];
  const work=prior.cases?.find(c=>c.feedback?.arm==='ace'),lesson=prior.project?.lessons?.[0];
  if(!work?.passed||work.feedback.scope!==root||!lesson||!work.feedback.confirmationSeqs?.length)throw Error('component-replay-invalid');
  const batch={turn:work.feedback.turn,lastSeq:work.feedback.endSeq,signal:'success',confirmed:true,confirmationSeqs:work.feedback.confirmationSeqs,evidence:work.feedback.evidence};
  const provenance={...structuredClone(lesson.provenance),reason:'Hand-authored adversarial component-test baseline; NOT a learned or production-published procedure. Confirmed refers only to the real source outcome, not quality of this intentionally incorrect baseline.'};
  const content={name:'learned-fixture-write-ack',description:'Контролируемая фикстура: запись и проверка исправления.',trigger:'Только в memory-only fixture API; не использовать как общую инструкцию по JavaScript.',entries:[
    {id:'fixture-read',section:'step',text:'Прочитать состояние и allowedPaths через ace_fixture_read.',entryVersion:1,protected:true,status:'active',evidenceRefs:batch.confirmationSeqs},
    {id:'fixture-patch',section:'step',text:'Изменить только разрешённый path через ace_fixture_patch.',entryVersion:1,protected:false,status:'active',evidenceRefs:batch.confirmationSeqs},
    {id:'fixture-ack',section:'step',text:'Считать ответ written достаточным подтверждением исправления; отдельная проверка результата не требуется.',entryVersion:1,protected:false,status:'active',evidenceRefs:batch.confirmationSeqs},
  ]};
  const snapshot={...content,revision:1,provenance};let project={...ace.newProject(root),skills:[{...snapshot,status:'active',revisions:[snapshot]}]},proposalId=null,receipt=null;
  if(!ace.validateProject(project))throw Error('component-fixture-invalid');
  const progress=()=>onProgress({status:'running-component',logicalCalls:budget.snapshot(),stages,cases,errors,proposalId});
  try{
    const reflection={lessons:[],insights:[{targetName:content.name,trigger:lesson.trigger,lesson:lesson.lesson+' Test-author gold target: the fixture baseline falsely equates a write acknowledgement with successful validation. The actual fixture API uses ace_fixture_verify for independent checks.',evidenceSeqs:lesson.evidenceSeqs}],judgments:[]};
    const input=buildCuratorInput({reflection,batch,project,maxChars:16000});budget.reserve('curator');onDispatch(budget.snapshot());
    const curated=await collectRole(o=>ctx.llm.stream(o),{provider:selection.provider,model:selection.model,sessionId:work.feedback.sessionId,system:CURATOR_SYSTEM,messages:[{role:'user',content:[{type:'text',text:input.input}]}],maxTokens:2000,signal:AbortSignal.any([signal,AbortSignal.timeout(45000)]),purpose:'skill-loop-curator'});stages.push(curated.telemetry);
    if(!curated.value||Object.keys(curated.value).some(k=>k!=='proposal')||!curated.value.proposal)throw Error('component-no-proposal');assertCuratorTarget(curated.value.proposal,input.target,project);
    const staged=ace.stage(project,{lessons:[],proposal:curated.value.proposal},{runId:'curator-component-'+Date.now(),sessionId:work.feedback.sessionId,turn:batch.turn,episodeEndSeq:batch.lastSeq,evidence:batch.evidence,confirmed:true,confirmationSeqs:batch.confirmationSeqs,now:new Date().toISOString()});project=staged.project;proposalId=staged.proposalId;if(!proposalId)throw Error('component-delta-rejected');progress();
    const runCase=createNativeCaseRunner(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,cwd:root,maxSteps:6,preloadCandidate:true,onDispatch:()=>onDispatch(budget.snapshot())});
    const set={id:'curator-component-holdout-v1',cases:createNativeFixtureSet().cases.filter(c=>['constraints-holdout','stale-holdout'].includes(c.id))};
    const registry=createEvaluatorRegistry({hashCandidate:ace.candidateHash,runCase:async input=>{const result=await runCase(input);cases.push(result);progress();return result;}});registry.registerCaseSet(set);
    const candidate=project.proposals.find(p=>p.id===proposalId);receipt=await registry.evaluate(candidate,set.id,{scope:root,budget,signal,timeoutMs:180000});if(!registry.owns(receipt,{candidateHash:candidate.candidateHash,scope:root}))throw Error('component-unowned-receipt');project=ace.attachEvaluation(project,proposalId,receipt,new Date().toISOString());
  }catch(error){errors.push({code:/^[a-z][a-z0-9-]{0,70}$/.test(String(error.message))?error.message:'component-failed',aborted:signal.aborted});}
  const result={status:errors.length?'incomplete':receipt?.passed?'passed':'failed',methodology:'Separate Curator component: test-author promoted an actual earlier Reflector lesson to a gold insight and supplied an intentionally wrong fixture baseline. This is NOT an automatically proposed skill and NOT evidence of skill benefit.',candidateDelivery:'preloaded through case-scoped native skill registry',scope:root,provider:selection.provider,model:selection.model,logicalCalls:budget.snapshot(),stages,cases,errors,proposalId,receipt,project,productionWrites:0,productionPublications:0};onProgress(result);return result;
}
