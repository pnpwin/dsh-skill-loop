import * as ace from '../ace-core.js';
import {createCallBudget,createEvaluatorRegistry} from '../optimizer.js';
import {createAceLiteProposer,buildCuratorInput,collectRole,CURATOR_SYSTEM,assertCuratorTarget} from '../review.js';
import {createNativeCaseRunner} from './native-case.js';
import {createNativeFixtureSet} from './native-cases.js';
import {episodeId} from '../feedback.js';

/** Explicit, isolated component smoke. Never opens the production storage domain. */
export async function runLiveSmoke(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,root,maxLogicalCalls=18,signal:externalSignal,onDispatch=()=>{},onProgress=()=>{},runnerFactory=createNativeCaseRunner}={}){
  const signal=AbortSignal.any([AbortSignal.timeout(300000),...(externalSignal?[externalSignal]:[])]),budget=createCallBudget(maxLogicalCalls),set=createNativeFixtureSet();
  const selection=ownerAgent.model.current(),cases=[],stages=[],errors=[];let project=ace.newProject(root),proposalId=null,receipt=null;
  const progress=()=>onProgress({phase:'running',logicalCalls:budget.snapshot(),cases:cases.map(c=>({passed:c.passed,feedback:c.feedback,metrics:c.metrics,usage:c.usage??null})),stages,errors,proposalId});
  const runCase=runnerFactory(ctx,{ownerAgent,NativeToolExecutor,createUserMessage,provider:selection.provider,model:selection.model,cwd:root,onDispatch:()=>onDispatch(budget.snapshot())});
  const adaptation=set.cases.find(c=>c.id==='order-adapt');
  try{
    const baseline=await runCase({candidate:null,case:adaptation,scope:root,budget,signal,arm:'no-memory',phase:'adaptation'});cases.push(baseline);progress();
    const work=await runCase({candidate:null,case:adaptation,scope:root,budget,signal,arm:'ace',phase:'adaptation'});cases.push(work);progress();
    const feedback=work.feedback;
    const batch={turn:feedback.turn,lastSeq:feedback.endSeq,signal:work.passed?'success':'correction',confirmed:work.passed,confirmationSeqs:work.passed?feedback.confirmationSeqs:[],evidence:feedback.evidence};
    if(!batch.evidence.length)throw Error('smoke-no-durable-evidence');
    const proposer=createAceLiteProposer({stream:options=>{onDispatch(budget.snapshot());return ctx.llm.stream(options);},provider:selection.provider,model:selection.model,sessionId:feedback.sessionId,project,config:{maxInputChars:16000,maxOutputTokens:3000,timeoutMs:45000},onStage:s=>{stages.push(s);progress();}});
    const cycleSignal=AbortSignal.any([signal,AbortSignal.timeout(45000)]);
    const proposed=await proposer.propose({batch,feedback:null,hint:'This is an explicitly authorized TEST-only learning fixture. Extract a narrowly scoped learned-* procedure for read/patch/independent-check sequencing and preserving fixture constraints; do not claim general code-generation quality.'},{budget,signal:cycleSignal});
    const staged=ace.stage(project,proposed.candidate??{lessons:[],proposal:null},{runId:episodeId(root,feedback.sessionId,batch.lastSeq),sessionId:feedback.sessionId,turn:batch.turn,episodeEndSeq:batch.lastSeq,evidence:batch.evidence,confirmed:batch.confirmed,confirmationSeqs:batch.confirmationSeqs,outcome:batch.confirmed?'verified':'unverified',now:new Date().toISOString()});
    project=staged.project;proposalId=staged.proposalId;progress();
    if(proposalId){
      const candidate=project.proposals.find(p=>p.id===proposalId);
      // Fixed holdout set chosen before seeing the model proposal; expected checks stay Host-only.
      const heldout={id:'native-smoke-heldout-v1',cases:set.cases.filter(c=>['constraints-holdout','stale-holdout'].includes(c.id))};
      const evaluatedRunner=async input=>{const result=await runCase(input);cases.push(result);progress();return result;};
      const evaluator=createEvaluatorRegistry({runCase:evaluatedRunner,hashCandidate:ace.candidateHash});evaluator.registerCaseSet(heldout);
      receipt=await evaluator.evaluate(candidate,heldout.id,{scope:root,budget,signal,timeoutMs:180000});
      if(!evaluator.owns(receipt,{candidateHash:candidate.candidateHash,scope:root}))throw Error('smoke-receipt-not-owned');
      project=ace.attachEvaluation(project,proposalId,receipt,new Date().toISOString());
    }
  }catch(error){errors.push({code:/^[a-z][a-z0-9-]{0,70}$/.test(String(error.message))?error.message:'smoke-failed',aborted:signal.aborted});}
  const result={status:errors.length?'incomplete':proposalId&&receipt?.passed?'passed':'no-evaluated-candidate',environment:'Controlled memory-only declarative workflow fixtures; generated JavaScript is NEVER executed. This is integration evidence, not quality-gain measurement.',scope:root,provider:selection.provider,model:selection.model,logicalCalls:budget.snapshot(),cases,stages,errors,proposalId,receipt,project,productionWrites:0,productionPublications:0};
  onProgress(result);return result;
}
