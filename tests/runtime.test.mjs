import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { installRuntime, canonicalRoot } from '../src/runtime.js';
import { buildReviewInput, collectReview } from '../src/prompts.js';
import { initialProjection, foldProjection, selectBatch } from '../src/projection.js';
import { newProject } from '../src/core.js';

const root=canonicalRoot(process.cwd());
const key=value=>createHash('sha256').update(value).digest('hex').slice(0,32);
const schema=predicate=>({parse(value){if(predicate&&!predicate(value))throw Error('invalid');return value;},int(){return this;},nonnegative(){return this;},max(){return this;}});
const z={custom:schema,object:()=>schema(),string:()=>schema(),number:()=>schema(),array:()=>schema()};
const config={enabled:true,initialMode:'review',maxInputChars:16000,maxOutputTokens:3000,timeoutMs:5000,cooldownMs:0,dailyReviews:12,provider:'',model:''};
function proposalFor(options,{assistantOnly=false}={}){
  const data=JSON.parse(options.messages[0].content[0].text);
  const refs=assistantOnly?[data.observations.find(e=>e.type==='assistant/message').seq]:data.trustedEnvelope.confirmationSeqs.length?data.trustedEnvelope.confirmationSeqs:[data.observations.at(-1).seq];
  return {lessons:[{kind:'correction',trigger:'При диагностике тестов',lesson:'Проверять исправление повторным запуском теста.',evidenceSeqs:refs}],proposal:{name:'learned-check-regressions',description:'Проверять исправления регрессионными тестами',trigger:'После исправления воспроизводимой ошибки',steps:['Воспроизвести ошибку.','Проверить исправление тем же тестом.'],pitfalls:['Не считать отсутствие исключения доказательством успеха.'],checks:['Убедиться, что нужный тест был выполнен.'],reason:'Сохраняет проверенную последовательность.',evidenceSeqs:refs,baseRevision:0}};
}
async function fixture(options={}){
  const data=options.data??{projects:new Map(),controls:new Map()};
  const definitions={tools:new Map(),commands:new Map(),providers:[],skills:[],sections:[],contexts:[]};
  const events=new Map(),effects=[];let projectDef,closed=false,calls=0;
  const states=new Map();
  const session={id:'session-test',seq:0,header:{id:'session-test',cwd:root,...options.header}};
  const agent={id:session.id,session,cwd:root,model:{current:()=>({provider:'fake',model:'fake-model'})}};
  const warnings=[];
  const ctx={
    logger:{warn(...args){warnings.push(args);}},
    storageDomain:{async open(spec){assert.match(spec.name,/^[a-z][a-z0-9_]*$/);for(const table of Object.keys(spec.tables))assert.match(table,/^[a-z][a-z0-9_]*$/);projectDef=spec;return {table(name){return {get:k=>data[name].get(k),async put(k,v){spec.tables[name].valueSchema.parse(v);data[name].set(k,structuredClone(v));}};},async close(){closed=true;}};}},
    sessionProjections:{async register(def){return {stateOf(s){return states.get(s.id)??def.init(s.header,0);},dispose:async()=>{}};}},
    agents:{list:()=>[agent],get:id=>id===agent.id?agent:undefined,turnBoundaryOf:()=>({lastTurn:1})},
    workingDirectory:{get:()=>agent.cwd},
    skills:{registerProvider(make){const p=make({signal:new AbortController().signal,invalidate(){}});definitions.providers.push(p);return()=>{};},register(s){definitions.skills.push(s);return()=>{};}},
    systemPrompt:{section(s){definitions.sections.push(s);return()=>{};},context(c){definitions.contexts.push(c);return()=>{};}},
    tools:{register(t){definitions.tools.set(t.name,t);return()=>{};}},
    commands:{register(c){definitions.commands.set(c.name,c);return()=>{};}},
    llm:{stream(o){calls++;return options.stream?options.stream(o):(async function*(){yield {type:'text-delta',text:JSON.stringify(proposalFor(o,options))};yield {type:'finish',reason:{kind:'stop'}};})();}},
    on(name,fn){const list=events.get(name)??[];list.push(fn);events.set(name,list);return()=>{};},
    effect(fn){const disposer=fn();if(typeof disposer==='function')effects.push(disposer);return disposer;},
  };
  const rt=await installRuntime(ctx,{...config,...options.config},{z});
  function emit(type,value,notify=false){const event={seq:session.seq++,type,data:value};states.set(session.id,foldProjection(states.get(session.id)??initialProjection(session.header,0),event));if(notify)for(const listener of events.get('session/event')??[])listener(session,event);return event.seq;}
  function work({success=true,human=false,notify=false,turn=1}={}){
    emit('turn/start',{turn});emit('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:human?'Теперь работает':'Исправь обнаруженную ошибку.'}]});
    emit('assistant/message',{turn,step:1,message:{content:[{type:'text',text:'Исправлена причина ошибки; проверяю результат.'}]}});
    emit('tool/call',{turn,step:1,callId:'call-'+turn,name:'bash',arguments:JSON.stringify({command:'node --test tests/core.test.mjs'})});
    emit('tool/result',{turn,step:1,message:{toolCallId:'call-'+turn,isError:false,content:[{type:'text',text:success?'# tests 2\n# pass 2\n# fail 0\n[exit code: 0]':'# tests 2\n# fail 1\n[exit code: 1]'}]}});
    emit('turn/end',{turn,reason:{kind:'completed'}},notify);
  }
  async function command(rawInput,signal=new AbortController().signal){return definitions.commands.get('skill-loop').handler({agent,rawInput,commandId:'command-1',signal});}
  return {rt,ctx,agent,session,work,emit,definitions,data,states,command,warnings,get calls(){return calls;},get closed(){return closed;},async close(){for(const d of effects.reverse())await d();}};
}

test('automatic completed verified work creates a review proposal, not an active skill',async()=>{
  const f=await fixture();f.work({notify:true});await f.rt.drain();
  assert.equal(f.calls,1);const p=f.data.projects.get(key(root));assert.equal(p.proposals[0].status,'pending');assert.equal(p.proposals[0].confirmed,true);assert.equal(p.skills.length,0);
  assert.equal((await f.command('approve '+p.proposals[0].id)).kind,'success');
  const candidates=await f.definitions.providers[0].list({cwd:root});assert.equal(candidates.length,1);
  const skill=await f.definitions.providers[0].get(candidates[0],{cwd:root});assert.match(skill.content,/Provenance/);
  assert.equal((await f.definitions.providers[0].list({cwd:tmpdir()})).length,0);
  assert.equal(await f.definitions.providers[0].get(candidates[0],{cwd:tmpdir()}),undefined);
  await f.close();assert.equal(f.closed,true);
});
test('auto publishes only proposals citing actual final verification',async()=>{
  const f=await fixture({config:{initialMode:'auto'}});f.work();assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'published');await f.close();
  const g=await fixture({assistantOnly:true,config:{initialMode:'auto'}});g.work();assert.equal((await g.rt.launch(g.agent,{manual:true})).status,'held-unconfirmed');assert.equal(g.data.projects.get(key(root)).skills.length,0);await g.close();
});
test('unconfirmed correction needs separate human confirm then approve; tool cannot do either',async()=>{
  const f=await fixture();f.work({success:false});await f.rt.launch(f.agent,{manual:true});const p=f.data.projects.get(key(root)).proposals[0];
  assert.equal(p.confirmed,false);assert.equal((await f.command('approve '+p.id)).kind,'error');
  await assert.rejects(f.definitions.tools.get('skill_loop').execute({action:'approve',id:p.id},{agent:f.agent}),/Unknown action/);
  await assert.rejects(f.definitions.tools.get('skill_loop').execute({action:'confirm',id:p.id},{agent:f.agent}),/Unknown action/);
  assert.equal((await f.command('confirm '+p.id)).kind,'success');assert.equal(f.data.projects.get(key(root)).skills.length,0);
  assert.equal((await f.command('approve '+p.id)).kind,'success');assert.equal(f.data.projects.get(key(root)).skills[0].provenance.humanConfirmation.commandId,'command-1');
  assert.equal((await f.command('mode auto')).kind,'success');await f.close();
});
test('persisted interrupted running state does not lock a fresh process',async()=>{
  const data={projects:new Map(),controls:new Map([[key(root),{root,date:new Date().toISOString().slice(0,10),attempts:1,recent:['old-run'],status:'running',code:'',cooldownUntil:0,updatedAt:new Date().toISOString()}]])};
  const f=await fixture({data});f.work();assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'pending-review');assert.equal(f.calls,1);await f.close();
});
test('identical completed window is charged only once',async()=>{
  const f=await fixture();f.work();await f.rt.launch(f.agent,{manual:true});assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'already-reviewed');assert.equal(f.calls,1);await f.close();
});
test('daily limit applies to manual analysis too',async()=>{
  const f=await fixture({config:{dailyReviews:1}});f.work();await f.rt.launch(f.agent,{manual:true});f.work({turn:2});assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'daily-budget');assert.equal(f.calls,1);await f.close();
});
test('a manual command cannot bypass a changed working-directory evidence boundary',async()=>{
  const f=await fixture();f.work();f.agent.cwd=tmpdir();f.emit('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Новая задача'}]},true);
  assert.equal((await f.rt.launch(f.agent,{manual:true,force:true})).status,'no-new-signal');assert.equal(f.calls,0);await f.close();
});
test('manual analyze cancellation prevents publication',async()=>{
  let release;const gate=new Promise(r=>release=r);let started;const ready=new Promise(r=>started=r);
  const f=await fixture({config:{initialMode:'auto'},stream:async function*(o){started();await gate;yield {type:'text-delta',text:JSON.stringify(proposalFor(o))};yield {type:'finish',reason:{kind:'stop'}};}});
  f.work();const abort=new AbortController();const job=f.command('analyze',abort.signal);await ready;abort.abort();release();await job;assert.equal(f.data.projects.size,0);await f.close();
});
test('agent disposal and new human steering cancel in-flight reflection',async()=>{
  let release;const gate=new Promise(r=>release=r);let start;const ready=new Promise(r=>start=r);
  const f=await fixture({config:{initialMode:'auto'},stream:async function*(o){start();await gate;yield {type:'text-delta',text:JSON.stringify(proposalFor(o))};yield {type:'finish',reason:{kind:'stop'}};}});
  f.work();const job=f.rt.launch(f.agent,{manual:true});await ready;f.emit('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Нет, это не исправлено.'}]},true);release();assert.equal((await job).status,'failed');assert.equal(f.data.projects.size,0);await f.close();
});
test('human ordinary fork can learn but subagents cannot',async()=>{
  const f=await fixture({header:{parentSession:'older-human'}});f.work();assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'pending-review');await f.close();
  const g=await fixture({header:{origin:'subagent',parentSession:'parent'}});g.work();assert.equal((await g.rt.launch(g.agent,{manual:true})).status,'disabled');assert.equal(g.calls,0);await g.close();
});
test('archived skill remains inspectable and is excluded from discovery',async()=>{
  const f=await fixture({config:{initialMode:'auto'}});f.work();await f.rt.launch(f.agent,{manual:true});assert.equal((await f.command('archive learned-check-regressions')).kind,'success');assert.equal((await f.command('show learned-check-regressions')).kind,'success');assert.deepEqual(await f.definitions.providers[0].list({cwd:root}),[]);await f.close();
});
test('review parsing requires complete stop, valid JSON and bounded output',async()=>{
  const opts={signal:new AbortController().signal};
  await assert.rejects(collectReview(async function*(){yield {type:'text-delta',text:'{}'};},opts),/incomplete/);
  await assert.rejects(collectReview(async function*(){yield {type:'finish',reason:{kind:'max-tokens'}};},opts),/max-tokens/);
  await assert.rejects(collectReview(async function*(){yield {type:'text-delta',text:'```json {} ```'};yield {type:'finish',reason:{kind:'stop'}};},opts));
  await assert.rejects(collectReview(async function*(){yield {type:'text-delta',text:'x'.repeat(101)};},opts,100),/output-limit/);
});
test('review input stays bounded with a full library and preserves complete selected skills',()=>{
  const p=newProject(root);p.skills=Array.from({length:50},(_,i)=>({name:'learned-x-'+i,description:'test '+i,trigger:'specific tests',revision:1,status:'active',steps:['x'.repeat(1500)],pitfalls:['y'.repeat(1500)],checks:['z'.repeat(1500)]}));
  const batch={confirmed:true,confirmationSeqs:[1],signal:'success',turn:1,evidence:[{seq:1,type:'tool/result',text:'tests passed',verified:true}]};
  const input=buildReviewInput({batch,project:p,maxChars:12000});assert.ok(input.length<=12000);const parsed=JSON.parse(input);assert.ok(parsed.managedSkills.length<6);assert.equal(parsed.managedSkills[0].steps[0].length,1500);
});
function nativeWork(f) {
  f.emit('turn/start',{turn:1});
  f.emit('user/message',{role:'user',source:{kind:'user'},content:[{type:'text',text:'Проверь исправление тестом.'}]});
  f.emit('assistant/message',{turn:1,step:1,message:{content:[{type:'text',text:'Исправлено сопоставление native job результата.'}]}});
  const command='node --test tests/core.test.mjs';
  f.emit('tool/call',{turn:1,step:1,callId:'native-call',name:'bash',arguments:JSON.stringify({command})});
  const jobSeq=f.emit('job/settled',{jobId:'bash-native',owner:f.agent.id,kind:'bash',label:command,toolCall:{callId:'native-call',rootCallId:'native-call'},status:'completed',cause:'producer',producerReported:true,detail:'exit code: 0'});
  const resultSeq=f.emit('tool/result',{turn:1,step:1,message:{toolCallId:'native-call',isError:false,content:[{type:'text',text:'✔ validation\nℹ tests 12\nℹ pass 12\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'}]},meta:{cwd:root}});
  f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
  return {jobSeq,resultSeq};
}
test('real native job exit status confirms an otherwise status-free bash result',async()=>{
  const f=await fixture();const refs=nativeWork(f);assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'pending-review');
  const p=f.data.projects.get(key(root));assert.equal(p.proposals[0].confirmed,true);assert.equal(p.skills.length,0);
  assert.ok(p.proposals[0].provenance.evidence.some(e=>e.seq===refs.jobSeq && e.type==='job/settled' && e.verified));
  assert.ok(p.proposals[0].provenance.evidence.some(e=>e.seq===refs.resultSeq && e.type==='tool/result'));
  await f.close();
});
test('native confirmation needs both the exit record and the matched result references',async()=>{
  const f=await fixture({config:{initialMode:'auto'},stream:async function*(o){
    const draft=proposalFor(o);draft.proposal.evidenceSeqs=draft.proposal.evidenceSeqs.slice(-1);draft.lessons[0].evidenceSeqs=draft.proposal.evidenceSeqs;
    yield {type:'text-delta',text:JSON.stringify(draft)};yield {type:'finish',reason:{kind:'stop'}};
  }});nativeWork(f);assert.equal((await f.rt.launch(f.agent,{manual:true})).status,'held-unconfirmed');assert.equal(f.data.projects.get(key(root)).skills.length,0);await f.close();
});
test('zero-test summaries do not certify work',()=>{
  let s=initialProjection({id:'s'},0);const feed=(type,data)=>{s=foldProjection(s,{seq:s.lastSeq+1,type,data});};
  feed('turn/start',{turn:1});feed('tool/call',{turn:1,step:1,callId:'a',name:'bash',arguments:JSON.stringify({command:'node --test --test-name-pattern=DOES_NOT_EXIST'})});feed('tool/result',{turn:1,step:1,message:{toolCallId:'a',content:[{type:'text',text:'# tests 0\n# pass 0\n# fail 0\n[exit code: 0]'}]}});feed('turn/end',{turn:1});assert.equal(selectBatch(s,{force:true}).confirmed,false);
});
