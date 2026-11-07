import * as ace from '../ace-core.js';
import {redact} from '../core.js';
import {createCallBudget,createEvaluatorRegistry} from '../optimizer.js';
import {createNativeCaseRunner} from './native-case.js';
import {createNativeFixtureSet} from './native-cases.js';

/** Resume only evaluation of an already generated, exact candidate. No reflection/curation retry. */
export async function runEvaluationSmoke(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,prior,maxLogicalCalls,signal:externalSignal,onDispatch=()=>{},onProgress=()=>{}}){
  const signal=AbortSignal.any([AbortSignal.timeout(180000),...(externalSignal?[externalSignal]:[])]),budget=createCallBudget(maxLogicalCalls),selection=ownerAgent.model.current(),cases=[],errors=[];
  let project=structuredClone(prior.project);const candidate=project.proposals.find(p=>p.id===prior.proposalId),root=project.root;let receipt=null;
  if(!candidate||candidate.candidateHash!==prior.receipt?.candidateHash||!ace.validateProject(project))throw Error('evaluation-replay-invalid');
  const run=createNativeCaseRunner(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,provider:selection.provider,model:selection.model,cwd:root,maxSteps:6,preloadCandidate:true,onDispatch:()=>onDispatch(budget.snapshot())});
  const before=await ctx.skills.get(candidate.name,{cwd:root,scope:ownerAgent,signal});
  const progress=()=>onProgress({status:'running-evaluation',logicalCalls:budget.snapshot(),candidateHash:candidate.candidateHash,cases,errors});
  try{
    const set={id:'curator-component-holdout-v1',cases:createNativeFixtureSet().cases.filter(c=>['constraints-holdout','stale-holdout'].includes(c.id))};
    const registry=createEvaluatorRegistry({hashCandidate:ace.candidateHash,runCase:async input=>{try{const result=await run(input);cases.push(result);progress();return result;}catch(error){errors.push({code:'case-execution-error',message:redact(String(error.message)).slice(0,240)});progress();throw error;}}});registry.registerCaseSet(set);
    receipt=await registry.evaluate(candidate,set.id,{scope:root,budget,signal,timeoutMs:180000});if(!registry.owns(receipt,{candidateHash:candidate.candidateHash,scope:root}))throw Error('evaluation-unowned-receipt');project=ace.attachEvaluation(project,candidate.id,receipt,new Date().toISOString());
  }catch(error){errors.push({code:/^[a-z][a-z0-9-]{0,70}$/.test(String(error.message))?error.message:'evaluation-failed',aborted:signal.aborted});}
  const after=await ctx.skills.get(candidate.name,{cwd:root,scope:ownerAgent,signal}).catch(()=>undefined);
  const registryRestored=before?.content===after?.content&&before?.provider===after?.provider;
  const result={status:receipt?.passed&&registryRestored&&!errors.length?'passed':'failed',methodology:'Evaluation-only retry after fixing a scoped SDK service-access error; same previously generated candidate hash and fixed heldout case set. Gold-insight Curator component is not automatic skill discovery or evidence of benefit.',scope:root,provider:selection.provider,model:selection.model,logicalCalls:budget.snapshot(),candidateHash:candidate.candidateHash,registryRestored,cases,errors,receipt,project,productionWrites:0,productionPublications:0};onProgress(result);return result;
}
