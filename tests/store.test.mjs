import test from 'node:test';
import assert from 'node:assert/strict';
import * as legacy from '../src/core.js';
import * as ace from '../src/ace-core.js';
import {openProjectStore,digest,validControl} from '../src/store.js';
const root='/project',key=digest(root).slice(0,32),now=()=> '2026-11-07T10:00:00.000Z';
const z={custom:check=>({parse(v){if(!check(v))throw Error('invalid-record');return v;}})};
const v1Control=()=>({root,date:'2026-11-07',attempts:9,recent:[],status:'idle',code:'',cooldownUntil:0,updatedAt:now()});
async function fixture({project,control,fail,initialMode='review'}={}){
  const tables={local_skill_loop:{projects:new Map(project?[[key,structuredClone(project)]]:[]),controls:new Map(control?[[key,structuredClone(control)]]:[])},local_skill_loop_backups:{snapshots:new Map()}};
  const writes=[],closed=[];let failures=fail;
  const ctx={storageDomain:{async open(spec){if(failures?.({op:'open',domain:spec.name}))throw Error('open-failed');for(const[t,table]of Object.entries(spec.tables))for(const v of tables[spec.name][t].values())table.valueSchema.parse(v);return {table(name){return {get:k=>tables[spec.name][name].get(k),entries:()=>tables[spec.name][name].entries(),async put(k,v){const op={op:'put',domain:spec.name,table:name,key:k,value:v};writes.push(op);if(await failures?.(op))throw Error('write-failed');spec.tables[name].valueSchema.parse(v);tables[spec.name][name].set(k,structuredClone(v));}};},async close(){closed.push(spec.name);}};}}};
  const store=await openProjectStore(ctx,{z,now,initialMode});return {store,tables,writes,closed,setFail(fn){failures=fn;}};
}
test('legacy read is pure, migration backup is durable before canonical V2 write',async()=>{
  const old={...legacy.newProject(root),mode:'auto',paused:true};const f=await fixture({project:old});
  assert.equal(f.store.read(root).schemaVersion,3);assert.equal(f.writes.length,0);assert.equal(f.store.read(root).mode,'auto');assert.equal(f.store.read(root).paused,true);
  await f.store.mutate(root,p=>({...p,paused:false}));assert.equal(f.writes[0].domain,'local_skill_loop_backups');assert.equal(f.writes[1].table,'projects');
  assert.ok(ace.validateProject(f.tables.local_skill_loop.projects.get(key)));assert.deepEqual([...f.tables.local_skill_loop_backups.snapshots.values()][0].payload,old);await f.store.close();
});
test('backup failure prevents any canonical mutation',async()=>{
  const old=legacy.newProject(root),f=await fixture({project:old,fail:x=>x.op==='put'&&x.domain==='local_skill_loop_backups'});
  await assert.rejects(f.store.mutate(root,p=>({...p,paused:true})),/write-failed/);assert.deepEqual(f.tables.local_skill_loop.projects.get(key),old);await f.store.close();
});
test('failed canonical write preserves V1 and durable backup; retry is idempotent',async()=>{
  const old=legacy.newProject(root),f=await fixture({project:old,fail:x=>x.op==='put'&&x.table==='projects'});
  await assert.rejects(f.store.mutate(root,p=>p),/write-failed/);assert.deepEqual(f.tables.local_skill_loop.projects.get(key),old);assert.equal(f.store.backups(root).length,1);
  f.setFail(null);await f.store.mutate(root,p=>p);assert.equal(f.store.backups(root).length,1);assert.ok(ace.validateProject(f.tables.local_skill_loop.projects.get(key)));await f.store.close();
});
test('legacy attempts become charged auxiliary calls, never a new daily allowance',async()=>{
  const f=await fixture({control:v1Control()});assert.equal(f.store.control(root).auxCalls,9);
  const opts={runId:'run-a',manual:true,dailyReviews:12,maxAuxCallsPerDay:12,cooldownMs:0};
  assert.equal(await f.store.reserve(root,{...opts,stage:'reflector'}),'claimed');assert.equal(await f.store.reserve(root,{...opts,stage:'curator'}),'claimed');assert.equal(f.store.control(root).attempts,10);assert.equal(f.store.control(root).auxCalls,11);
  assert.equal(await f.store.reserve(root,{...opts,runId:'run-b',stage:'reflector'}),'claimed');assert.equal(await f.store.reserve(root,{...opts,runId:'run-b',stage:'curator'}),'auxiliary-budget');
  assert.equal(f.store.control(root).auxCalls,12);assert.ok(f.store.backups(root).some(s=>s.kind==='control'));await f.store.close();
});
test('evaluator and refinement consume the SAME persistent daily auxiliary quota',async()=>{
  const f=await fixture(),opts={runId:'cycle',manual:true,dailyReviews:50,maxAuxCallsPerDay:4,cooldownMs:0};
  assert.equal(await f.store.reserve(root,{...opts,stage:'reflector'}),'claimed');assert.equal(await f.store.reserve(root,{...opts,stage:'curator'}),'claimed');
  const claims=await Promise.all(Array.from({length:4},()=>f.store.reserve(root,{...opts,stage:'evaluator'})));assert.equal(claims.filter(x=>x==='claimed').length,2);assert.equal(claims.filter(x=>x==='auxiliary-budget').length,2);assert.equal(f.store.control(root).attempts,1);assert.equal(f.store.control(root).auxCalls,4);assert.equal(await f.store.reserve(root,{...opts,stage:'curator'}),'auxiliary-budget');await f.store.close();
});
test('same-root mutations serialize without losing concurrent fields',async()=>{
  const f=await fixture();await Promise.all([f.store.mutate(root,async p=>({...p,mode:'auto'})),f.store.mutate(root,p=>({...p,paused:true}))]);assert.equal(f.store.read(root).mode,'auto');assert.equal(f.store.read(root).paused,true);await f.store.close();
});
test('restoration archives current V2 and writes old-reader-compatible controls',async()=>{
  const old=legacy.newProject(root),f=await fixture({project:old,control:v1Control()});await f.store.mutate(root,p=>({...p,mode:'auto'}));
  const backup=f.store.backups(root).find(s=>s.kind==='project'&&s.format===1);
  await f.store.reserve(root,{runId:'r',stage:'reflector',manual:true,dailyReviews:12,maxAuxCallsPerDay:12,cooldownMs:0});
  await f.store.restore(root,backup.id);assert.ok(legacy.validateProject(f.tables.local_skill_loop.projects.get(key)));assert.equal(f.tables.local_skill_loop.controls.get(key).schemaVersion,undefined);assert.equal(f.tables.local_skill_loop.controls.get(key).attempts,10);assert.ok(f.store.backups(root).some(s=>s.format===3));await f.store.close();
});
test('guard cancellation before commit leaves canonical state untouched',async()=>{
  const f=await fixture();let allow=true;await assert.rejects(f.store.mutate(root,p=>{allow=false;return p;},{guard:()=>allow}),/review-cancelled/);assert.equal(f.tables.local_skill_loop.projects.size,0);await f.store.close();
});
test('finish before a model reservation still backs up legacy controls',async()=>{
  const f=await fixture({control:v1Control()});await f.store.finish(root,'held-input-budget','held-input-budget');
  assert.equal(f.writes[0].domain,'local_skill_loop_backups');assert.equal(f.writes[0].value.kind,'project');
  assert.equal(f.writes[1].domain,'local_skill_loop_backups');assert.equal(f.writes[1].value.kind,'control');
  assert.equal(f.writes[2].table,'controls');assert.equal(f.store.control(root).auxCalls,9);await f.store.close();
});
test('invalid mutator and malformed controls fail closed',async()=>{
  const f=await fixture();await assert.rejects(f.store.mutate(root,p=>({...p,unknown:true})),/invalid-project-update/);assert.equal(f.tables.local_skill_loop.projects.size,0);await f.store.close();assert.equal(validControl({...v1Control(),authority:'model'}),false);
});

test('telemetry schema caps exact serialized chars and UTF-8 bytes independently',()=>{
  const control=telemetry=>({...v1Control(),schemaVersion:2,auxCalls:9,telemetry});
  assert.equal(validControl(control(['x'.repeat(999996)])),true);
  assert.equal(validControl(control(['x'.repeat(999997)])),false);
  assert.equal(validControl(control(['Ж'.repeat(499998)])),true);
  assert.equal(validControl(control(['Ж'.repeat(499999)])),false);
  assert.equal(validControl(control(Array(101).fill({}))),false);
  const cyclic=[];cyclic.push(cyclic);assert.equal(validControl(control(cyclic)),false);
});

test('more than 100 large legal finish updates trim oldest by total bytes and remain writable',async()=>{
  const f=await fixture({control:v1Control()});
  const evidenceSeqs=Array.from({length:60},(_,i)=>i);
  const judgments=Array.from({length:8},(_,i)=>({entryId:`entry-${i}`,label:'helpful',reason:'Ж'.repeat(1000),evidenceSeqs}));
  for(let i=0;i<125;i++){
    await f.store.finish(root,'pending-review','',{episodeId:`episode-${i}`,judgments});
    const control=f.tables.local_skill_loop.controls.get(key),serialized=JSON.stringify(control.telemetry);
    assert.ok(validControl(control),`invalid control at update ${i}`);
    assert.ok(control.telemetry.length<=100);
    assert.ok(serialized.length<=1000000);
    assert.ok(Buffer.byteLength(serialized,'utf8')<=1000000);
    assert.equal(control.telemetry.at(-1).episodeId,`episode-${i}`);
  }
  const telemetry=f.store.control(root).telemetry;
  assert.ok(telemetry.length<100);assert.notEqual(telemetry[0].episodeId,'episode-0');
  assert.equal(telemetry.at(-1).judgments[0].reason,'Ж'.repeat(1000));
  await f.store.finish(root,'idle');assert.ok(validControl(f.tables.local_skill_loop.controls.get(key)));
  await f.store.close();
});

test('one oversized latest telemetry row becomes explicit diagnostic without fabricated usage or eviction of small prior rows',async()=>{
  const f=await fixture();
  await f.store.finish(root,'pending-review','',{episodeId:'keep-1',usage:{provider:{inputTokens:100,outputTokens:10}}});
  await f.store.finish(root,'pending-review','',{episodeId:'keep-2'});
  await f.store.finish(root,'held','oversized',{episodeId:'oversized',reason:'Ж'.repeat(600000),usage:{provider:{inputTokens:7,outputTokens:2}}});
  const rows=f.store.control(root).telemetry,last=rows.at(-1);
  assert.equal(rows.length,3);assert.equal(rows[0].episodeId,'keep-1');assert.equal(rows[1].episodeId,'keep-2');
  assert.deepEqual(rows[0].usage.provider,{inputTokens:100,outputTokens:10});
  assert.equal(last.diagnostic,'telemetry-row-omitted-size-limit');
  assert.equal(last.status,'held');assert.equal(last.code,'oversized');
  assert.ok(last.originalChars>600000);assert.ok(last.originalBytes>1000000);
  assert.equal(Object.hasOwn(last,'usage'),false);assert.equal(Object.hasOwn(last,'reason'),false);
  assert.ok(validControl(f.tables.local_skill_loop.controls.get(key)));
  await f.store.finish(root,'idle','',{episodeId:'after-oversized'});
  assert.equal(f.store.control(root).telemetry.at(-1).episodeId,'after-oversized');
  await f.store.close();
});

async function restorableFixture(){
  const f=await fixture({project:legacy.newProject(root),control:v1Control()});
  await f.store.mutate(root,p=>({...p,mode:'auto'}));
  await f.store.reserve(root,{runId:'restore-test',stage:'reflector',manual:true,dailyReviews:12,maxAuxCallsPerDay:12,cooldownMs:0});
  return {...f,backupId:f.store.backups(root).find(s=>s.kind==='project'&&s.format===1).id};
}

test('restore checks queued-start signal before backup writes or canonical downgrade',async()=>{
  const f=await restorableFixture();
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const mutation=f.store.mutate(root,async p=>{entered();await gate;return {...p,paused:true};});
  await started;
  const controller=new AbortController();
  const restore=f.store.restore(root,f.backupId,{signal:controller.signal});
  const rejected=assert.rejects(restore,/abort/i);
  controller.abort();release();await mutation;
  const canonical=structuredClone(f.tables.local_skill_loop.projects.get(key)),writesAfterMutation=f.writes.length;
  await rejected;
  assert.deepEqual(f.tables.local_skill_loop.projects.get(key),canonical);
  assert.equal(f.writes.length,writesAfterMutation);assert.ok(ace.validateProject(canonical));
  await f.store.close();
});

test('restore guard rejects at queued start and immediately before canonical write after durable backups',async()=>{
  for(const cancelAt of ['start','after-backup']){
    const f=await restorableFixture(),canonical=structuredClone(f.tables.local_skill_loop.projects.get(key));
    let allow=cancelAt!=='start';
    const before=f.writes.length;
    f.setFail(op=>{if(op.domain==='local_skill_loop_backups')allow=false;return false;});
    await assert.rejects(f.store.restore(root,f.backupId,{guard:()=>allow}),/review-cancelled/);
    assert.deepEqual(f.tables.local_skill_loop.projects.get(key),canonical);
    const writes=f.writes.slice(before);assert.equal(writes.some(op=>op.table==='projects'),false);
    assert.equal(writes.some(op=>op.domain==='local_skill_loop_backups'),cancelAt==='after-backup');
    await f.store.close();
  }
});

test('abort during durable restore backup leaves canonical V2 untouched',async()=>{
  const f=await restorableFixture(),controller=new AbortController(),canonical=structuredClone(f.tables.local_skill_loop.projects.get(key));
  const before=f.writes.length;
  f.setFail(op=>{if(op.domain==='local_skill_loop_backups')controller.abort();return false;});
  await assert.rejects(f.store.restore(root,f.backupId,{signal:controller.signal}),/abort/i);
  assert.deepEqual(f.tables.local_skill_loop.projects.get(key),canonical);
  assert.equal(f.writes.slice(before).some(op=>op.table==='projects'),false);
  assert.ok(f.store.backups(root).some(s=>s.format===3));await f.store.close();
});

test('after canonical V1 restore commits cancellation cannot skip quota-preserving controls merge',async()=>{
  const f=await restorableFixture(),controller=new AbortController();
  let allow=true;
  f.setFail(op=>{if(op.domain==='local_skill_loop'&&op.table==='projects'){controller.abort();allow=false;}return false;});
  const result=await f.store.restore(root,f.backupId,{signal:controller.signal,guard:()=>allow});
  assert.equal(result.status,'restored-v1');assert.equal(controller.signal.aborted,true);
  assert.ok(legacy.validateProject(f.tables.local_skill_loop.projects.get(key)));
  const control=f.tables.local_skill_loop.controls.get(key);
  assert.equal(control.schemaVersion,undefined);assert.equal(control.attempts,10);assert.equal(control.status,'storage-restored');
  assert.ok(f.store.backups(root).some(s=>s.kind==='project'&&s.format===3));await f.store.close();
});

test('restore controls partial failure reports error with factual V1 canonical and retained V2 backup',async()=>{
  const f=await restorableFixture(),beforeControl=structuredClone(f.tables.local_skill_loop.controls.get(key));
  f.setFail(op=>op.domain==='local_skill_loop'&&op.table==='controls');
  await assert.rejects(f.store.restore(root,f.backupId),/write-failed/);
  assert.ok(legacy.validateProject(f.tables.local_skill_loop.projects.get(key)));
  assert.deepEqual(f.tables.local_skill_loop.controls.get(key),beforeControl);
  assert.equal(beforeControl.auxCalls,10);assert.ok(f.store.backups(root).some(s=>s.kind==='project'&&s.format===3));
  assert.ok(f.store.backups(root).some(s=>s.kind==='control'&&s.format===2));await f.store.close();
});

test('quota-held finish durably backs up V1 project before controls and remains restorable without staging',async()=>{
  const project={...legacy.newProject(root),mode:'auto',paused:true},control={...v1Control(),attempts:12};
  const f=await fixture({project,control});
  assert.equal(await f.store.reserve(root,{runId:'quota-held',stage:'reflector',manual:true}),'daily-budget');
  assert.equal(f.writes.length,0);
  await f.store.finish(root,'daily-budget','daily-budget');
  assert.deepEqual(f.writes.slice(0,3).map(op=>[op.domain,op.value.kind??op.table]),[
    ['local_skill_loop_backups','project'],['local_skill_loop_backups','control'],['local_skill_loop','controls'],
  ]);
  assert.deepEqual(f.tables.local_skill_loop.projects.get(key),project);
  const backup=f.store.backups(root).find(s=>s.kind==='project'&&s.format===1);assert.ok(backup);
  assert.deepEqual(f.tables.local_skill_loop_backups.snapshots.get(backup.id).payload,project);
  await f.store.restore(root,backup.id);
  assert.deepEqual(f.tables.local_skill_loop.projects.get(key),project);
  assert.equal(f.tables.local_skill_loop.controls.get(key).schemaVersion,undefined);
  assert.equal(f.tables.local_skill_loop.controls.get(key).attempts,12);await f.store.close();
});

test('first-role reservation followed by provider failure has a restorable V1 project without a stage write',async()=>{
  const project=legacy.newProject(root),f=await fixture({project,control:v1Control()});
  assert.equal(await f.store.reserve(root,{runId:'failed-first-role',stage:'reflector',manual:true}),'claimed');
  await f.store.finish(root,'failed','provider-error'); // No provider is invoked by this test.
  assert.equal(f.writes.some(op=>op.domain==='local_skill_loop'&&op.table==='projects'),false);
  assert.deepEqual(f.tables.local_skill_loop.projects.get(key),project);
  const backup=f.store.backups(root).find(s=>s.kind==='project'&&s.format===1);assert.ok(backup);
  assert.equal(f.store.control(root).auxCalls,10);
  await f.store.restore(root,backup.id);
  const control=f.tables.local_skill_loop.controls.get(key);
  assert.equal(control.schemaVersion,undefined);assert.equal(control.attempts,10);
  assert.ok(legacy.validateProject(f.tables.local_skill_loop.projects.get(key)));await f.store.close();
});

test('control-only empty roots get explicit V1 compatibility snapshots preserving effective initial mode',async()=>{
  for(const initialMode of ['review','auto'])for(const path of ['reserve','finish'])for(const hasControl of [false,true]){
    const f=await fixture({initialMode,...(hasControl?{control:v1Control()}:{} )});
    if(path==='reserve')assert.equal(await f.store.reserve(root,{runId:'empty-root',stage:'reflector',manual:true}),'claimed');
    else await f.store.finish(root,'held-input-budget','held-input-budget');
    assert.equal(f.tables.local_skill_loop.projects.size,0);
    const backup=f.store.backups(root).find(s=>s.kind==='project'&&s.format===1);assert.ok(backup);
    const payload=f.tables.local_skill_loop_backups.snapshots.get(backup.id).payload;
    assert.deepEqual(payload,{...legacy.newProject(root),mode:initialMode});
    assert.equal(f.writes[0].value.kind,'project');
    if(hasControl)assert.equal(f.writes[1].value.kind,'control');
    const charged=f.store.control(root).auxCalls;
    await f.store.restore(root,backup.id);
    assert.deepEqual(f.tables.local_skill_loop.projects.get(key),payload);
    assert.equal(f.tables.local_skill_loop.controls.get(key).schemaVersion,undefined);
    assert.equal(f.tables.local_skill_loop.controls.get(key).attempts,charged);await f.store.close();
  }
});

test('either required compatibility backup failing prevents the first V2 control write and retry preserves ordering',async()=>{
  for(const path of ['reserve','finish'])for(const failedKind of ['project','control']){
    const project={...legacy.newProject(root),mode:'auto'},control=v1Control();
    const f=await fixture({project,control,fail:op=>op.domain==='local_skill_loop_backups'&&op.value?.kind===failedKind});
    const run=()=>path==='reserve'?f.store.reserve(root,{runId:'backup-failure',stage:'reflector',manual:true}):f.store.finish(root,'held-input-budget');
    await assert.rejects(run(),/write-failed/);
    assert.deepEqual(f.tables.local_skill_loop.projects.get(key),project);
    assert.deepEqual(f.tables.local_skill_loop.controls.get(key),control);
    assert.equal(f.writes.some(op=>op.domain==='local_skill_loop'),false);
    f.setFail(null);await run();
    assert.ok(f.store.backups(root).some(s=>s.kind==='project'&&s.format===1));
    assert.ok(f.store.backups(root).some(s=>s.kind==='control'&&s.format===1));
    assert.equal(f.writes.at(-1).table,'controls');
    assert.deepEqual(f.tables.local_skill_loop.projects.get(key),project);await f.store.close();
  }
});

test('a preexisting V2 control-only root repairs missing V1 project compatibility backup before its next write',async()=>{
  const control={...v1Control(),schemaVersion:2,attempts:10,auxCalls:12,telemetry:[]};
  for(const project of [undefined,{...legacy.newProject(root),mode:'auto'}]){
    const f=await fixture({project,control,initialMode:'auto'});
    await f.store.finish(root,'auxiliary-budget','auxiliary-budget');
    const backup=f.store.backups(root).find(s=>s.kind==='project'&&s.format===1);assert.ok(backup);
    assert.equal(f.writes[0].domain,'local_skill_loop_backups');assert.equal(f.writes[0].value.kind,'project');
    await f.store.restore(root,backup.id);
    assert.equal(f.tables.local_skill_loop.projects.get(key).mode,'auto');
    assert.equal(f.tables.local_skill_loop.controls.get(key).attempts,12);await f.store.close();
  }
});
