import{randomUUID}from'node:crypto';
import{immutableSnapshot,stableHash,validateCaseSet,assertHostCallBudget}from'./optimizer.js';
const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function abortable(call,signal){if(!signal)return call();signal.throwIfAborted();return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});Promise.resolve().then(call).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));});}
const sum=(xs,key)=>xs.length&&xs.every(x=>Number.isSafeInteger(x[key])&&x[key]>=0)?xs.reduce((n,x)=>n+x[key],0):null;
export function validatePairedCaseSet(value){
  if(!obj(value)||Object.keys(value).some(k=>!['id','cases','appliesTo'].includes(k)))throw Error('invalid-paired-case-set');
  const base=validateCaseSet({id:value.id,cases:value.cases});
  if(base.cases.length>8||!base.cases.some(c=>c.split==='adaptation')||!base.cases.some(c=>c.split==='holdout'))throw Error('paired-cases-require-train-holdout');
  if(value.appliesTo!==undefined){const a=value.appliesTo;if(!obj(a)||Object.keys(a).some(k=>!['root','names'].includes(k))||typeof a.root!=='string'||!a.root.startsWith('/')||a.root.includes('\0')||!Array.isArray(a.names)||!a.names.length||a.names.length>32||a.names.some(n=>typeof n!=='string'||!/^learned-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)))throw Error('invalid-paired-applicability');}
  return immutableSnapshot({...base,...(value.appliesTo?{appliesTo:value.appliesTo}:{})},250000);
}
function usageOf(result){
  const calls=result?.metrics?.modelCalls,source=result?.metrics?.tokenUsage,p=result?.usage?.provider;
  if(source)return source;
  const complete=Number.isSafeInteger(calls)&&calls>0&&p?.reportedCalls===calls;
  return {inputTokens:complete?p.inputTokens:null,outputTokens:complete?p.outputTokens:null,totalTokens:null,cacheReadTokens:complete?(p.cacheReadTokens??null):null,reasoningTokens:null};
}
function phaseSummary(pairs){return {pairs:pairs.length,complete:pairs.every(p=>p.complete),gains:pairs.filter(p=>p.complete&&!p.baselinePassed&&p.candidatePassed).length,regressions:pairs.filter(p=>p.complete&&p.baselinePassed&&!p.candidatePassed).length,candidateFailed:pairs.filter(p=>p.complete&&!p.candidatePassed).length,baselineFailed:pairs.filter(p=>p.complete&&!p.baselinePassed).length};}
function verdict(train,holdout){if(!train.complete||holdout&&!holdout.complete)return'inconclusive';if(train.regressions||holdout?.regressions)return'regression';if(train.candidateFailed||holdout?.candidateFailed)return'candidate-failed';if(!train.gains)return'no-gain';if(!holdout)return'train-gain';return holdout.gains?'observed-gain':'no-holdout-gain';}
/** Host-only capabilities: registered frozen suites, exact baselines, identity receipts.
 * Nothing here is exposed as an arbitrary model-callable verifier registration API. */
export function createPairedEvaluatorRegistry({runCase,hashCandidate,hashBaseline,model,now=()=>new Date().toISOString(),makeRunId=randomUUID}){
  if(typeof runCase!=='function'||typeof hashCandidate!=='function'||typeof hashBaseline!=='function'||!obj(model)||typeof model.provider!=='string'||typeof model.model!=='string')throw Error('paired-host-bindings-required');
  const frozenModel=immutableSnapshot(model),sets=new Map(),issued=new WeakSet(),trained=new WeakSet(),trainingBudgets=new WeakMap();
  function binding(candidate,baseline,caseSetId,scope){
    const set=sets.get(caseSetId);if(!set)throw Error('unregistered-paired-case-set');if(typeof scope!=='string'||!scope.startsWith('/')||scope.includes('\0'))throw Error('invalid-paired-scope');
    const c=immutableSnapshot(candidate),b=baseline==null?null:immutableSnapshot(baseline),candidateHash=hashCandidate(c),baselineHash=hashBaseline(b);
    if(!hash(candidateHash)||!(baselineHash===null||hash(baselineHash))||c.candidateHash!==candidateHash||c.baseRevision!==(b?.revision??0)||c.delta?.baseHash!==baselineHash)throw Error('paired-baseline-mismatch');
    return {candidate:c,baseline:b,candidateHash,baselineHash,caseSetId,caseSetHash:set.hash,scope,set};
  }
  async function runPhase(bind,phase,{budget,signal}){
    const pairs=[],attempts=[];
    for(const testCase of bind.set.value.cases.filter(c=>c.split===phase)){
      signal?.throwIfAborted();
      const rows=await Promise.all(['baseline','candidate'].map(async arm=>{
        const before=performance.now(),start=budget.snapshot().used;
        if(budget.snapshot().remaining===0||budget.snapshot().used>=budget.snapshot().limit)return {arm,passed:false,eligible:false,calls:0,elapsedMs:0,usage:usageOf(null),reason:'not-run-budget',caseId:testCase.id};
        try{const result=await abortable(()=>runCase({candidate:arm==='baseline'?bind.baseline:bind.candidate,case:testCase,scope:bind.scope,arm,phase,budget,signal}),signal);signal?.throwIfAborted();
          const calls=result?.metrics?.modelCalls,terminal=result?.feedback?.terminalReason;
          const eligible=typeof result?.passed==='boolean'&&Number.isSafeInteger(calls)&&calls>0&&(terminal==='completed'||result?.metrics?.stepLimited===true)&&budget.snapshot().denied===0;
          return {arm,passed:eligible&&result.passed,eligible,calls:Number.isSafeInteger(calls)?calls:budget.snapshot().used-start,elapsedMs:performance.now()-before,usage:usageOf(result),caseId:testCase.id,feedback:phase==='adaptation'?{task:testCase.input?.task??'',outcome:result.feedback?.outcome??null,terminalReason:terminal??'unknown',candidateLoaded:result.metrics?.loaded??false}:undefined};
        }catch(error){signal?.throwIfAborted();return {arm,passed:false,eligible:false,calls:null,elapsedMs:performance.now()-before,usage:usageOf(null),caseId:testCase.id,reason:error?.message==='logical-call-budget-exhausted'?'budget-exhausted':'case-error'};}
      }));
      const a=rows[0],b=rows[1];pairs.push({caseId:testCase.id,complete:a.eligible&&b.eligible,baselinePassed:a.passed,candidatePassed:b.passed});attempts.push(...rows);
    }
    return {pairs,attempts,summary:phaseSummary(pairs)};
  }
  const registry={
    registerCaseSet(value){const s=validatePairedCaseSet(value);if(sets.has(s.id)||sets.size>=32)throw Error('paired-case-set-duplicate');sets.set(s.id,{value:s,hash:stableHash(s)});return registry.describeCaseSet(s.id);},
    describeCaseSet(id){const s=sets.get(id);return s?{id,caseSetHash:s.hash,adaptationCases:s.value.cases.filter(c=>c.split==='adaptation').length,holdoutCases:s.value.cases.filter(c=>c.split==='holdout').length,appliesTo:s.value.appliesTo??null}:null;},
    select(scope,name){const matches=[...sets.values()].filter(s=>s.value.appliesTo?.root===scope&&s.value.appliesTo.names.includes(name));return matches.length===1?matches[0].value.id:null;},
    async train(candidate,caseSetId,{baseline=null,scope,budget,signal}={}){
      assertHostCallBudget(budget);
      const bind=binding(candidate,baseline,caseSetId,scope),before=budget.snapshot().used,deniedBefore=budget.snapshot().denied,result=await runPhase(bind,'adaptation',{budget,signal});
      const report=immutableSnapshot({...Object.fromEntries(Object.entries(bind).filter(([k])=>!['candidate','baseline','set'].includes(k))),model:frozenModel,adaptation:result.summary,adaptationPairs:result.pairs,adaptationAttempts:result.attempts,logicalCalls:budget.snapshot().used-before,denied:budget.snapshot().denied-deniedBefore,verdict:verdict(result.summary,null)},250000);trained.add(report);trainingBudgets.set(report,budget);return report;
    },
    feedback(report){if(!trained.has(report))throw Error('foreign-training-report');return immutableSnapshot({protocol:'paired-skill-v1',candidateHash:report.candidateHash,baselineHash:report.baselineHash,caseSetHash:report.caseSetHash,scope:report.scope,phase:'adaptation',verdict:report.verdict,summary:report.adaptation,attempts:report.adaptationAttempts.map(a=>({caseId:a.caseId,arm:a.arm,passed:a.passed,eligible:a.eligible,...(a.feedback?{feedback:a.feedback}:{})}))},50000);},
    async finalize(candidate,caseSetId,{baseline=null,scope,budget,signal,training}={}){
      assertHostCallBudget(budget);
      const bind=binding(candidate,baseline,caseSetId,scope);
      if(!trained.has(training)||trainingBudgets.get(training)!==budget||training.candidateHash!==bind.candidateHash||training.baselineHash!==bind.baselineHash||training.caseSetHash!==bind.caseSetHash||training.scope!==scope)throw Error('foreign-or-stale-training-report');
      signal?.throwIfAborted();const before=budget.snapshot().used;
      const held=training.verdict!=='train-gain',holdout=held?null:await runPhase(bind,'holdout',{budget,signal});signal?.throwIfAborted();
      const comparison={verdict:verdict(training.adaptation,holdout?.summary??null),complete:training.adaptation.complete&&!!holdout?.summary.complete,adaptation:training.adaptation,holdout:holdout?.summary??{pairs:0,complete:false,gains:0,regressions:0,candidateFailed:0,baselineFailed:0}};
      const attempts=[...training.adaptationAttempts,...(holdout?.attempts??[])],usage=Object.fromEntries(['inputTokens','outputTokens','totalTokens','cacheReadTokens','reasoningTokens'].map(k=>[k,sum(attempts.map(a=>a.usage),k)]));
      const receipt=immutableSnapshot({candidateHash:bind.candidateHash,caseSetId,caseSetHash:bind.caseSetHash,scope,passed:comparison.verdict==='observed-gain'&&comparison.complete,runId:makeRunId(),at:now(),metrics:{protocol:'paired-skill-v1',baselineHash:bind.baselineHash,model:frozenModel,comparison,logicalCalls:training.logicalCalls+budget.snapshot().used-before,usage,pairs:[...training.adaptationPairs,...(holdout?.pairs??[])]}},10000);
      issued.add(receipt);return {receipt,report:{training,holdout:holdout?{summary:holdout.summary,pairs:holdout.pairs,attempts:holdout.attempts.map(a=>({...a,feedback:undefined}))}:null}};
    },
    async evaluate(candidate,caseSetId,options){const training=await registry.train(candidate,caseSetId,options);return registry.finalize(candidate,caseSetId,{...options,training});},
    owns(receipt,binding={}){if(!issued.has(receipt))return false;const s=sets.get(receipt.caseSetId);return !!s&&s.hash===receipt.caseSetHash&&Object.entries(binding).every(([k,v])=>['candidateHash','scope','caseSetHash','caseSetId'].includes(k)&&receipt[k]===v);},
  };return Object.freeze(registry);
}
