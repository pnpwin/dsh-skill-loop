import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixtureEnvironment,createNativeCaseRunner,candidateInstructions} from '../src/bench/native-case.js';
import {createNativeFixtureSet} from '../src/bench/native-cases.js';
import {createCallBudget} from '../src/optimizer.js';
import * as ace from '../src/ace-core.js';
const cases=createNativeFixtureSet().cases;
const caseAt=family=>cases.find(c=>c.family===family&&c.split==='adaptation');
for(const c of cases)test('native declarative fixture reproduces initial defect: '+c.id,()=>{const env=createFixtureEnvironment(c);assert.equal(env.read().validation.passed,false);assert.equal(env.final().passed,false);});
test('finite interpreter checks repair, final verification and protected constraints',()=>{
  const env=createFixtureEnvironment(caseAt('project-constraints'));env.patch({path:'solution.json',operation:'clamp-zero'});assert.equal(env.final().passed,false);assert.equal(env.verify().passed,true);assert.equal(env.final().passed,true);
  assert.throws(()=>env.patch({path:'config.json',operation:'clamp-zero'}),/denied/);assert.equal(env.verify().passed,false);
  assert.equal(env.read().files['config.json'],'{"sourceDirectory":"src","protected":true}');
});
test('later edits invalidate an earlier passed verification',()=>{const env=createFixtureEnvironment(caseAt('correction-and-check'));env.patch({path:'solution.json',operation:'stable-unique'});assert.equal(env.verify().passed,true);env.patch({path:'solution.json',operation:'unique-sort'});assert.equal(env.final().passed,false);});
test('generated JavaScript is never evaluated',()=>{
  const c=structuredClone(caseAt('correction-and-check'));c.input.initialFiles['solution.json']='(()=>{globalThis.PWNED=true;return {operation:"stable-unique"}})()';const env=createFixtureEnvironment(c);assert.equal(env.verify().passed,false);assert.equal(globalThis.PWNED,undefined);
});
function candidate(){const p=ace.newProject('/workspace');return ace.stage(p,{lessons:[],proposal:{name:'learned-fixture-checks',baseRevision:0,baseHash:null,reason:'Сохраняет проверку исправления.',evidenceSeqs:[1],operations:[{op:'create',description:'Проверять исправление fixture',trigger:'При работе с контролируемым fixture',entries:[{section:'step',text:'Прочитать fixture и его ограничения.'},{section:'step',text:'Исправить только разрешённые данные и вызвать проверку.'}]}]}},{runId:'r',sessionId:'s',turn:1,now:'2026-11-07T10:00:00.000Z',confirmed:true,confirmationSeqs:[1],evidence:[{seq:1,type:'tool/result',text:'Host checks passed',verified:true}]}).project.proposals[0];}
function fakeHost({suppressProof=false,skipLoad=false}={}){
  const definitions=new Map(),hooks=new Map(),events=[],trace={disposed:0,modelCalls:0,restricted:null,guard:null};let spec,seq=0,ended=false;
  const append=(type,data)=>events.push({seq:seq++,type,data});
  const registeredSkills=new Map();
  const scopedSkills={register:s=>registeredSkills.set(s.name,s),get:async name=>registeredSkills.get(name)};
  const agentCtx={get:name=>name==='skills'?scopedSkills:undefined,get skills(){throw Error('cannot get property skills without inject');},tools:{register:d=>definitions.set(d.name,d),setExecutor:e=>{trace.executor=e;},restrict:f=>{trace.restricted=f;},guard:g=>{trace.guard=g;}},on:(name,fn)=>{hooks.set(name,fn);return()=>{};}};
  const owner={id:'owner',session:{header:{cwd:'/workspace'}},model:{current:()=>({provider:'p',model:'m'})}};
  async function modelStep(){trace.modelCalls++;const options=Object.freeze({sessionId:spec.sessionId,provider:'p',model:'m'});const hook=hooks.get('llm/stream');for await(const unused of hook(options,async function*(){yield {type:'usage',usage:{inputTokens:100,outputTokens:20,cacheReadTokens:0}};yield {type:'finish',reason:{kind:'stop'}};})){} }
  async function call(name,args={}){const callId='c'+seq;append('tool/call',{callId,name});assert.equal(trace.guard({name}),undefined);const value=await definitions.get(name).execute(args,{concludeTurn(){ended=true;}});if(!suppressProof)append('tool/result',{message:{toolCallId:callId,isError:false,content:[{type:'text',text:JSON.stringify(value)}]}});return value;}
  const agent={ctx:agentCtx,session:{snapshotEvents:()=>structuredClone(events)},followup(message){trace.message=message;},cancel(){},async whenIdle(){await modelStep();if(definitions.has('ace_fixture_skill')&&!skipLoad)await call('ace_fixture_skill');await call('ace_fixture_read');await modelStep();await call('ace_fixture_patch',{path:'solution.json',operation:'stable-unique'});await modelStep();await call('ace_fixture_verify');append('turn/end',{turn:1,reason:{kind:'completed'}});}};
  const ctx={workingDirectory:{get:()=>'/workspace'},agentLoop:{async createAgent(ownerCtx,s){spec=s;trace.meta=s.meta;trace.agentOptions=s.agentOptions;await s.setup(agentCtx,agent);return {agent,async dispose(){trace.disposed++;}};}}};
  class NativeToolExecutor{constructor(ctx,max){this.ctx=ctx;this.max=max();}}
  return {ctx,owner,trace,definitions,get ended(){return ended;},options:{NativeToolExecutor,createUserMessage:x=>({...x,role:'user',id:'message'}),ownerAgent:owner}};
}
test('native adapter uses existing driver, own executor, empty inherited allowlist and exact proof',async()=>{
  const f=fakeHost(),budget=createCallBudget(4);const result=await createNativeCaseRunner(f.ctx,f.options)({candidate:null,case:caseAt('correction-and-check'),scope:'/workspace',budget});
  assert.equal(result.passed,true);assert.equal(budget.snapshot().used,3);assert.equal(result.usage.provider.reportedCalls,3);assert.equal(result.usage.provider.inputTokens,300);assert.equal(result.usage.provider.cacheReadTokens,0);assert.deepEqual(f.trace.restricted,{allow:[]});assert.equal(f.trace.executor.max,1);assert.equal(f.trace.meta.origin,'subagent');assert.equal(f.trace.disposed,1);assert.equal(f.ended,true);assert.equal(typeof f.trace.guard({name:'bash'}),'string');assert.equal(result.feedback.confirmationSeqs.length,1);assert.ok(!f.trace.message.content[0].text.includes('requiredChecks'));
});
test('scoped candidate preview is loadable but never mutates project state',async()=>{
  const c=candidate(),before=JSON.stringify(c);assert.match(candidateInstructions(c,'/workspace').content,/ACE-MANIFEST/);const f=fakeHost();const result=await createNativeCaseRunner(f.ctx,f.options)({candidate:c,case:caseAt('correction-and-check'),scope:'/workspace',budget:createCallBudget(4)});assert.equal(result.passed,true);assert.equal(result.feedback.candidateLoaded,true);assert.equal(JSON.stringify(c),before);
});
test('candidate not loaded or missing durable verification proof cannot pass',async()=>{
  for(const options of [{skipLoad:true},{suppressProof:true}]){const f=fakeHost(options);const result=await createNativeCaseRunner(f.ctx,f.options)({candidate:candidate(),case:caseAt('correction-and-check'),scope:'/workspace',budget:createCallBudget(4)});assert.equal(result.passed,false);assert.equal(f.trace.disposed,1);}
});
test('exhausted shared budget stops dispatch and still disposes the agent',async()=>{
  const f=fakeHost(),budget=createCallBudget(1);await assert.rejects(createNativeCaseRunner(f.ctx,f.options)({candidate:null,case:caseAt('correction-and-check'),scope:'/workspace',budget}),/logical-call-budget/);assert.equal(budget.snapshot().used,1);assert.equal(f.trace.disposed,1);
});
