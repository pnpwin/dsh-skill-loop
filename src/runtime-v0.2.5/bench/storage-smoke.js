import {randomBytes} from 'node:crypto';
import * as legacy from '../core.js';
import * as ace from '../ace-core.js';
import {openProjectStore,digest} from '../store.js';

/** Explicit native-KV integration check in FRESH TEST DOMAINS, never production names. */
export async function runStorageSmoke(ctx,{z,root}){
  const suffix=randomBytes(5).toString('hex'),names={main:'ace_smoke_main_'+suffix,backups:'ace_smoke_backups_'+suffix},checks=[];
  const mapped={storageDomain:{open(spec){return ctx.storageDomain.open({...spec,name:spec.name==='local_skill_loop'?names.main:names.backups});}}};
  const store=await openProjectStore(mapped,{z});
  const key=digest(root).slice(0,32),now=new Date().toISOString(),old=legacy.newProject(root);
  try{
    await store.domain.table('projects').put(key,old);
    await store.domain.table('controls').put(key,{root,date:now.slice(0,10),attempts:3,recent:[],status:'fixture',code:'',cooldownUntil:0,updatedAt:now});
    checks.push({name:'v1-seed-readable',passed:store.read(root).schemaVersion===2&&store.read(root).mode==='review'});
    await store.mutate(root,p=>({...p,paused:true}));
    checks.push({name:'v2-canonical-write',passed:ace.validateProject(store.domain.table('projects').get(key))});
    const backup=store.backups(root).find(s=>s.kind==='project'&&s.format===1);
    checks.push({name:'durable-v1-backup',passed:!!backup});
    const claimed=await store.reserve(root,{runId:'native-storage-fixture',stage:'reflector',manual:true,cooldownMs:0,dailyReviews:12,maxAuxCallsPerDay:12});
    checks.push({name:'conservative-legacy-budget',passed:claimed==='claimed'&&store.control(root).auxCalls===4});
    if(backup)await store.restore(root,backup.id);
    checks.push({name:'v1-restore-with-v2-archive',passed:legacy.validateProject(store.domain.table('projects').get(key))&&store.backups(root).some(s=>s.kind==='project'&&s.format===2)});
    return {passed:checks.every(c=>c.passed),checks,names,productionDomainsOpened:false,providerCalls:0,note:'Small synthetic records retained only in these dedicated native test domains; no real skill/library/mode or budget changed.'};
  }finally{await store.close();}
}
