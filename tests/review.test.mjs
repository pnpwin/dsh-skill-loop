import test from 'node:test';
import assert from 'node:assert/strict';
import {collectRole,createAceLiteProposer,buildCuratorInput,parseReflection,targetOptions,summarizeJudgments} from '../src/review.js';
import {createCallBudget} from '../src/optimizer.js';
import * as ace from '../src/ace-core.js';
const config={maxInputChars:16000,maxOutputTokens:3000,timeoutMs:45000};
const batch={turn:1,lastSeq:3,confirmed:true,confirmationSeqs:[2],signal:'success',evidence:[{seq:1,type:'tool/result',text:'write acknowledged',verified:false},{seq:2,type:'tool/result',text:'Independent Host checks passed',verified:true}]};
const lesson={kind:'success',trigger:'После изменения fixture',lesson:'Проверять результат после записи.',evidenceSeqs:[1,2]};
const reflection={lessons:[lesson],insights:[{targetName:null,trigger:lesson.trigger,lesson:lesson.lesson,evidenceSeqs:[1,2]}],judgments:[]};
const delta={name:'learned-fixture-validation',baseRevision:0,baseHash:null,reason:'Разделяет запись и проверку.',evidenceSeqs:[1,2],operations:[{op:'create',description:'Проверять изменения fixture',trigger:'После изменения контролируемой fixture',entries:[{section:'step',text:'Прочитать условия и разрешённые пути.'},{section:'step',text:'Проверить результат после изменения.'}]}]};
const context={runId:'r',sessionId:'s',turn:1,now:'2026-11-07T10:00:00.000Z',confirmed:true,confirmationSeqs:[2],evidence:batch.evidence};
function streamFor(values,options=[]){return async function*(o){options.push(o);const value=values.shift();yield {type:'reasoning-delta',text:'PRIVATE-REASONING'};yield {type:'text-delta',text:JSON.stringify(value)};yield {type:'usage',usage:{inputTokens:10,outputTokens:5}};yield {type:'finish',reason:{kind:'stop'}};};}
test('ACE proposer uses two roles, shared JSON payload cap and split output',async()=>{
  const calls=[],stages=[],budget=createCallBudget(2);const p=createAceLiteProposer({stream:streamFor([reflection,{proposal:delta}],calls),provider:'p',model:'m',config,project:ace.newProject('/project'),onStage:s=>stages.push(s)});const result=await p.propose({batch,feedback:null},{budget,signal:new AbortController().signal});
  assert.deepEqual(result.candidate.proposal,delta);assert.deepEqual(calls.map(o=>o.maxTokens),[1000,2000]);assert.deepEqual(calls.map(o=>o.purpose),['skill-loop-reflector','skill-loop-curator']);assert.ok(calls.reduce((n,o)=>n+o.messages[0].content[0].text.length,0)<=16000);assert.equal(budget.snapshot().used,2);assert.equal(result.usage.provider.reportedCalls,2);assert.equal(result.usage.provider.cacheReadTokens,null);assert.ok(!JSON.stringify(result).includes('PRIVATE-REASONING'));assert.equal(stages.length,2);
});
test('no insights means no Curator call but preserves actual lessons',async()=>{
  const calls=[],budget=createCallBudget(2);const p=createAceLiteProposer({stream:streamFor([{...reflection,insights:[]}],calls),provider:'p',model:'m',config,project:ace.newProject('/project')});const result=await p.propose({batch},{budget});assert.equal(calls.length,1);assert.equal(result.candidate.proposal,null);assert.equal(result.candidate.lessons.length,1);assert.equal(budget.snapshot().used,1);
});
test('exhausted daily auxiliary allowance after reflection produces reflected-only',async()=>{
  const calls=[],states=[];const p=createAceLiteProposer({stream:streamFor([reflection],calls),provider:'p',model:'m',config,project:ace.newProject('/project'),reserve:async role=>role==='reflector'?'claimed':'auxiliary-budget',onState:(status,code)=>states.push({status,code})});const result=await p.propose({batch},{budget:createCallBudget(2)});assert.equal(calls.length,1);assert.equal(result.candidate.proposal,null);assert.equal(result.candidate.lessons.length,1);assert.deepEqual(states,[{status:'reflected-only',code:'auxiliary-budget'}]);
});
test('malformed JSON retains reported usage diagnostics and never retries',async()=>{
  const opts={messages:[{role:'user',content:[{type:'text',text:'{}'}]}],purpose:'skill-loop-curator'};
  await assert.rejects(collectRole(async function*(){yield {type:'text-delta',text:'not JSON'};yield {type:'usage',usage:{inputTokens:7,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};},opts),error=>{assert.equal(error.telemetry.usage.inputTokens,7);return true;});
});
test('unknown usage remains unknown, and output/finish bounds fail closed',async()=>{
  const opts={messages:[],purpose:'skill-loop-reflector'};
  const result=await collectRole(async function*(){yield {type:'text-delta',text:'{}'};yield {type:'finish',reason:{kind:'stop'}};},opts);assert.equal(result.telemetry.usage,null);assert.equal(result.telemetry.usageStatus,'unknown');
  await assert.rejects(collectRole(async function*(){yield {type:'text-delta',text:' '.repeat(100)};},opts,{maxChars:20}),/output-limit/);
  await assert.rejects(collectRole(async function*(){yield {type:'text-delta',text:'{}'};yield {type:'finish',reason:{kind:'max-tokens'}};},opts),/max-tokens/);
});
test('aborted caller cannot dispatch a model request',async()=>{
  const calls=[],abort=new AbortController();abort.abort();const p=createAceLiteProposer({stream:streamFor([reflection],calls),provider:'p',model:'m',config,project:ace.newProject('/project')});await assert.rejects(p.propose({batch},{budget:createCallBudget(2),signal:abort.signal}));assert.equal(calls.length,0);
});
test('current pending preview is fully supplied with exact active and pending hashes',()=>{
  let project={...ace.newProject('/project'),mode:'auto'};project=ace.stage(project,{lessons:[],proposal:delta},context).project;project={...project,mode:'review'};const skill=project.skills[0];const pending=ace.stage(project,{lessons:[],proposal:{name:skill.name,baseRevision:skill.revision,baseHash:ace.snapshotHash(skill),reason:'Дополнить контролируемую проверку.',evidenceSeqs:[2],operations:[{op:'insert',section:'check',text:'PENDING-CONTENT-MARKER',afterId:null}]}},{...context,runId:'r2'}).project;const proposal=pending.proposals.find(p=>p.status==='pending');
  const input=buildCuratorInput({reflection:{...reflection,insights:[{...reflection.insights[0],targetName:skill.name}]},batch,project:pending,maxChars:16000});assert.equal(input.target.baseProposalId,proposal.id);assert.equal(input.target.baseProposalHash,proposal.candidateHash);assert.equal(input.target.baseHash,ace.snapshotHash(skill));assert.match(input.input,/PENDING-CONTENT-MARKER/);assert.equal(input.target.document.entries.length,proposal.entries.length);
});
test('only one selected target insight reaches Curator, never another full skill body',()=>{
  const project={skills:[{name:'learned-a',description:'a',trigger:'a',revision:1,status:'active',entries:[]},{name:'learned-b',description:'b',trigger:'b',revision:1,status:'active',entries:[]}],proposals:[],lessons:[]};const ref={...reflection,insights:[{...reflection.insights[0],targetName:'learned-a'},{...reflection.insights[0],targetName:'learned-b',lesson:'OTHER-TARGET-INSIGHT'}]};const result=buildCuratorInput({reflection:ref,batch,project,maxChars:16000});assert.ok(!result.input.includes('OTHER-TARGET-INSIGHT'));assert.equal(JSON.parse(result.input).insights.length,1);
});
test('matched own loaded target outranks lexical candidates, unknown exposure does not',()=>{
  const project={skills:Array.from({length:8},(_,i)=>({name:'learned-'+i,description:'fixture check',trigger:'fixture check',status:'active'})),proposals:[]};assert.equal(targetOptions(project,batch,'',[{name:'learned-7',match:'matched'}])[0].name,'learned-7');assert.equal(targetOptions(project,batch,'',[{name:'learned-7',match:'unknown'}])[0].name,'learned-0');
});
test('soft judgments bind exact entry version/hash and never transfer to changed text',()=>{
  const entry={id:'e1',section:'step',text:'Read the fixture.',entryVersion:1,protected:false,status:'active',evidenceRefs:[2]},loaded={id:entry.id,skill:'learned-a',revision:1,entryVersion:1,entryHash:ace.entryHash(entry)};
  const judged=parseReflection({...reflection,judgments:[{entryId:'e1',label:'helpful',reason:'Only a model hypothesis.',evidenceSeqs:[2]}]},{batch,targets:[],loadedEntries:[loaded]});
  const rows=[{runId:'r',judgments:judged.judgments},{runId:'r',judgments:judged.judgments}];assert.equal(summarizeJudgments({name:'learned-a',entries:[entry]},rows).entries[0].helpful,1);
  assert.equal(summarizeJudgments({name:'learned-a',entries:[{...entry,text:'Different procedure.',entryVersion:2}]},rows).entries[0].helpful,0);
  assert.equal(summarizeJudgments({name:'learned-a',entries:[entry]},[{runId:'old',judgments:[{entryId:'e1',label:'helpful'}]}]).entries[0].helpful,0);
  assert.throws(()=>parseReflection({...reflection,judgments:[...judged.judgments,...judged.judgments]},{batch,targets:[],loadedEntries:[loaded]}),/invalid-reflection/);
});
test('model judgments cannot invent loaded entry IDs',()=>{assert.throws(()=>parseReflection({...reflection,judgments:[{entryId:'invented',label:'helpful',reason:'claim',evidenceSeqs:[2]}]},{batch,targets:[],loadedEntries:[]}),/invalid-reflection/);});
