import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import * as legacy from './core.js';
import * as ace from './ace-core.js';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : stableJSON(value)).digest('hex');
export function stableJSON(value) {
  if (Array.isArray(value)) return '['+value.map(stableJSON).join(',')+']';
  if (value !== null && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+stableJSON(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
const keyOf = root => digest(root).slice(0,32);
const dateOf = now => now.slice(0,10);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const TELEMETRY_ROWS = 100, TELEMETRY_CHARS = 1000000, TELEMETRY_BYTES = 1000000;
function telemetrySize(value) {
  const serialized = JSON.stringify(value);
  return {chars:serialized.length,bytes:Buffer.byteLength(serialized,'utf8')};
}
function validTelemetry(value) {
  if(!Array.isArray(value)||value.length>TELEMETRY_ROWS)return false;
  try {const size=telemetrySize(value);return size.chars<=TELEMETRY_CHARS&&size.bytes<=TELEMETRY_BYTES;}
  catch {return false;}
}
function boundedTelemetry(previous,latest) {
  // A single oversized result becomes a factual omission diagnostic BEFORE old
  // rows are evicted; never substitute zero provider usage for omitted telemetry.
  if(latest!==undefined){
    const size=telemetrySize(latest);
    if(size.chars+2>TELEMETRY_CHARS||size.bytes+2>TELEMETRY_BYTES)latest={
      diagnostic:'telemetry-row-omitted-size-limit',status:String(latest.status??'').slice(0,120),
      code:String(latest.code??'').slice(0,120),at:String(latest.at??'').slice(0,80),
      originalChars:size.chars,originalBytes:size.bytes,
    };
  }
  const rows=(latest===undefined?[...previous]:[...previous,latest]).slice(-TELEMETRY_ROWS);
  const sizes=rows.map(telemetrySize);
  let chars=2+Math.max(0,rows.length-1)+sizes.reduce((sum,s)=>sum+s.chars,0);
  let bytes=2+Math.max(0,rows.length-1)+sizes.reduce((sum,s)=>sum+s.bytes,0);
  let start=0;
  while(start<rows.length&&(chars>TELEMETRY_CHARS||bytes>TELEMETRY_BYTES)){
    const comma=rows.length-start>1?1:0;
    chars-=sizes[start].chars+comma;bytes-=sizes[start].bytes+comma;start+=1;
  }
  return rows.slice(start);
}
export function validControl(v) {
  if (!record(v) || typeof v.root!=='string' || typeof v.date!=='string' || !/^\d{4}-\d\d-\d\d$/.test(v.date)) return false;
  if (!Number.isSafeInteger(v.attempts)||v.attempts<0 || !Array.isArray(v.recent)||v.recent.length>100||!v.recent.every(x=>typeof x==='string'))return false;
  if(typeof v.status!=='string'||typeof v.code!=='string'||!Number.isFinite(v.cooldownUntil)||typeof v.updatedAt!=='string')return false;
  if(v.schemaVersion!==undefined&&v.schemaVersion!==2)return false;
  if(Object.keys(v).some(k=>!['schemaVersion','root','date','attempts','auxCalls','recent','status','code','cooldownUntil','updatedAt','telemetry'].includes(k)))return false;
  return v.schemaVersion!==2 || (Number.isSafeInteger(v.auxCalls)&&v.auxCalls>=0 && (v.telemetry===undefined || validTelemetry(v.telemetry)));
}
function controlOf(raw,root,now) {
  const same = raw?.date===dateOf(now);
  return {schemaVersion:2,root,date:dateOf(now),attempts:same?raw.attempts:0,auxCalls:same?(raw.auxCalls??raw.attempts):0,recent:raw?.recent??[],status:raw?.status??'idle',code:raw?.code??'',cooldownUntil:same?raw.cooldownUntil:0,updatedAt:raw?.updatedAt??now,telemetry:raw?.telemetry??[]};
}
function validSnapshot(v) {
  if(!record(v)||v.schemaVersion!==1||typeof v.root!=='string'||!['project','control'].includes(v.kind)||typeof v.at!=='string')return false;
  if(v.kind==='project' && !(legacy.validateProject(v.payload)||ace.validateProject(v.payload)))return false;
  if(v.kind==='control' && !validControl(v.payload))return false;
  return v.payload.root===v.root && v.checksum===digest({root:v.root,kind:v.kind,payload:v.payload});
}

/** Same-process root serialization and durability-first native KV; no cross-table transaction assumption. */
export async function openProjectStore(ctx,{z,now=()=>new Date().toISOString(),invalidate=()=>{},initialMode='review'}) {
  const main=await ctx.storageDomain.open({name:'local_skill_loop',version:1,layout:'per-record',tables:{
    projects:{valueSchema:z.custom(v=>legacy.validateProject(v)||ace.validateProject(v),'Invalid skillgrowth project')},
    controls:{valueSchema:z.custom(validControl,'Invalid skillgrowth control')},
  }});
  let backup;
  try { backup=await ctx.storageDomain.open({name:'local_skill_loop_backups',version:1,layout:'per-record',tables:{snapshots:{valueSchema:z.custom(validSnapshot,'Invalid migration snapshot')}}}); }
  catch(error){await main.close();throw error;}
  const projects=main.table('projects'),controls=main.table('controls'),snapshots=backup.table('snapshots');
  const locks=new Map();let closed=false;
  async function serial(root,fn){if(closed)throw Error('store-closed');const k=keyOf(root),prev=locks.get(k)??Promise.resolve();const job=prev.catch(()=>{}).then(fn);locks.set(k,job);try{return await job;}finally{if(locks.get(k)===job)locks.delete(k);}}
  async function saveBackup(root,kind,payload){
    const checksum=digest({root,kind,payload}),id=digest(root+'\0'+kind+'\0'+checksum).slice(0,32);
    const old=snapshots.get(id);if(old){if(!validSnapshot(old)||old.checksum!==checksum)throw Error('backup-conflict');return id;}
    await snapshots.put(id,{schemaVersion:1,root,kind,checksum,payload:structuredClone(payload),at:now()});return id;
  }
  const fresh = root => ({...ace.newProject(root),mode:initialMode==='auto'?'auto':'review'});
  async function backupBeforeControlWrite(root,rawControl){
    // A role can fail, or finish can record a held outcome, before stage ever
    // writes a project. Keep a restorable V1 project even on this control-only
    // path: project backup FIRST, legacy control backup SECOND, canonical last.
    // saveBackup is idempotent, so also repair control-only roots already on V2.
    const rawProject=projects.get(keyOf(root));
    if(rawProject&&legacy.validateProject(rawProject))await saveBackup(root,'project',rawProject);
    else if(!rawProject)await saveBackup(root,'project',{...legacy.newProject(root),mode:fresh(root).mode});
    if(rawControl&&rawControl.schemaVersion!==2)await saveBackup(root,'control',rawControl);
  }
  const read = root => {const raw=projects.get(keyOf(root));return raw?ace.migrateProject(raw):fresh(root);};
  const check = ({signal,guard}={})=>{signal?.throwIfAborted();if(guard&&!guard())throw Error('review-cancelled');};
  return {
    domain:main,backupDomain:backup,
    read,
    control(root){return controlOf(controls.get(keyOf(root)),root,now());},
    async mutate(root,fn,options={}){return serial(root,async()=>{
      check(options);const raw=projects.get(keyOf(root));
      if(raw && !ace.validateProject(raw))await saveBackup(root,'project',raw);
      const current=raw?ace.migrateProject(raw):fresh(root);
      const next=await fn(current);if(!ace.validateProject(next))throw Error('invalid-project-update');
      check(options);await projects.put(keyOf(root),next);invalidate();return next;
    });},
    async reserve(root,{runId,stage,manual=false,dailyReviews=12,maxAuxCallsPerDay=12,cooldownMs=60000,signal,guard}={}){return serial(root,async()=>{
      check({signal,guard});const at=now(),raw=controls.get(keyOf(root)),c=controlOf(raw,root,at);
      if(stage==='reflector'){
        if(c.recent.includes(runId))return 'already-reviewed';
        if(c.attempts>=dailyReviews)return 'daily-budget';
        if(!manual&&Date.parse(at)<c.cooldownUntil)return 'cooldown';
      }else if(!['curator','evaluator'].includes(stage))throw Error('invalid-review-stage');
      if(c.auxCalls>=maxAuxCallsPerDay)return 'auxiliary-budget';
      await backupBeforeControlWrite(root,raw);
      check({signal,guard});
      await controls.put(keyOf(root),{...c,attempts:c.attempts+(stage==='reflector'?1:0),auxCalls:c.auxCalls+1,recent:stage==='reflector'?[...c.recent,runId].slice(-100):c.recent,status:stage,code:'',cooldownUntil:stage==='reflector'?Date.parse(at)+cooldownMs:c.cooldownUntil,updatedAt:at});
      return 'claimed';
    });},
    async finish(root,status,code='',details=null){return serial(root,async()=>{
      const raw=controls.get(keyOf(root));await backupBeforeControlWrite(root,raw);
      const at=now(),c=controlOf(raw,root,at);
      const telemetry=boundedTelemetry(c.telemetry,details?{...details,status,code,at}:undefined);
      await controls.put(keyOf(root),{...c,status,code,updatedAt:at,telemetry});
    });},
    backups(root){return [...snapshots.entries()].filter(([,s])=>s.root===root).map(([id,s])=>({id,kind:s.kind,format:s.payload.schemaVersion??1,checksum:s.checksum,at:s.at})).sort((a,b)=>a.at.localeCompare(b.at));},
    async restore(root,id,options={}){return serial(root,async()=>{
      check(options);
      const s=snapshots.get(id);if(!s||!validSnapshot(s)||s.root!==root||s.kind!=='project'||!legacy.validateProject(s.payload))throw Error('invalid-v1-backup');
      const old=projects.get(keyOf(root));if(old)await saveBackup(root,'project',old);
      const c=controls.get(keyOf(root));if(c)await saveBackup(root,'control',c);
      // Last cancellation boundary: durable backups may exist after an abort,
      // but the canonical project remains untouched until this check succeeds.
      check(options);
      await projects.put(keyOf(root),structuredClone(s.payload));
      // Once the canonical V1 write commits, finish the quota-preserving control
      // downgrade even if cancellation arrives. There is no KV transaction; a
      // later controls.put failure must throw without pretending V1 was reverted.
      if(c){const normalized=controlOf(c,root,now());const {schemaVersion,auxCalls,telemetry,...v1}=normalized;await controls.put(keyOf(root),{...v1,attempts:Math.max(normalized.attempts,auxCalls),status:'storage-restored',code:'',updatedAt:now()});}
      invalidate();return {status:'restored-v1',backupId:id,note:'V2 state archived before restore. Stop v0.2 before installing v0.1.3; new learning would migrate again.'};
    });},
    async drain(){await Promise.allSettled([...locks.values()]);},
    async close(){if(closed)return;closed=true;await Promise.allSettled([...locks.values()]);await Promise.all([main.close(),backup.close()]);},
  };
}
