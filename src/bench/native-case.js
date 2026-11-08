import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {isAbsolute} from 'node:path';
import * as ace from '../ace-core.js';
import {renderSkill as renderLegacy,redact} from '../core.js';

export const FIXTURE_TOOLS=['ace_fixture_read','ace_fixture_patch','ace_fixture_verify'];
export const OPERATIONS=['stable-unique','unique-sort','clamp-zero','clamp-falsy','sort-copy','sort-mutating','mean-zero','mean-nan'];
const clone=x=>structuredClone(x);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function runOperation(op,args){
  if(op==='stable-unique')return [...new Set(args[0])];
  if(op==='unique-sort')return [...new Set(args[0])].sort();
  if(op==='clamp-zero')return Math.min(args[2],Math.max(args[1],args[0]));
  if(op==='clamp-falsy')return Math.min(args[2],Math.max(args[1],args[0]||args[1]));
  if(op==='sort-copy')return [...args[0]].sort((a,b)=>a-b);
  if(op==='sort-mutating')return args[0].sort();
  if(op==='mean-zero')return args[0].length?args[0].reduce((a,b)=>a+b,0)/args[0].length:null;
  if(op==='mean-nan')return args[0].reduce((a,b)=>a+b,0)/args[0].length;
  throw Error('unknown-fixture-operation');
}
/** Trusted, finite declarative interpreter, NOT execution of generated JS/VM code. */
export function createFixtureEnvironment(testCase){
  const {input,expected}=testCase;
  if(!object(input)||!object(input.initialFiles)||!Array.isArray(input.allowedPaths)||!object(expected)||typeof expected.module!=='string'||!Array.isArray(expected.requiredChecks)||!expected.requiredChecks.length)throw Error('unsupported-native-fixture');
  const initial=new Map(Object.entries(input.initialFiles));if([...initial.values()].some(v=>typeof v!=='string'||v.length>10000)||initial.size>8||input.allowedPaths.some(p=>typeof p!=='string'||!initial.has(p)))throw Error('unsupported-native-fixture');
  const files=new Map(initial),forbidden=new Set(expected.forbiddenPaths??[]);let version=0,lastGrade=null,forbiddenAttempts=0;
  function grade(){
    let spec;try{spec=JSON.parse(files.get(expected.module));}catch{return {passed:false,checks:expected.requiredChecks.length,failed:expected.requiredChecks.length,reason:'declarative-spec-required'};}
    if(!object(spec)||Object.keys(spec).some(k=>k!=='operation')||!OPERATIONS.includes(spec.operation))return {passed:false,checks:expected.requiredChecks.length,failed:expected.requiredChecks.length,reason:'unsupported-operation'};
    let failed=0;
    for(const c of expected.requiredChecks){try{const args=clone(c.args),before=clone(args),value=runOperation(spec.operation,args);if(!isDeepStrictEqual(value,c.expected)||(c.preserveArgs&&!isDeepStrictEqual(args,before)))failed++;}catch{failed++;}}
    const protectedUnchanged=[...forbidden].every(p=>files.get(p)===initial.get(p));
    return {passed:failed===0&&forbiddenAttempts===0&&protectedUnchanged,checks:expected.requiredChecks.length,failed,protectedUnchanged,forbiddenAttempts};
  }
  return {
    read(){return {files:Object.fromEntries(files),allowedPaths:[...input.allowedPaths],operations:[...OPERATIONS],validation:grade(),note:'Only JSON {operation: name} is interpreted. JavaScript/source strings are never executed.'};},
    patch({path,operation}){if(!input.allowedPaths.includes(path)||forbidden.has(path)){forbiddenAttempts++;lastGrade=null;throw Error('fixture-path-denied');}if(!OPERATIONS.includes(operation))throw Error('unknown-fixture-operation');files.set(path,JSON.stringify({operation}));version++;lastGrade=null;return {written:path,operation,version};},
    verify(){lastGrade={...grade(),version};return clone(lastGrade);},
    final(){return {passed:lastGrade?.passed===true&&lastGrade.version===version,grade:lastGrade??grade(),version,files:Object.fromEntries(files)};},
  };
}
export function candidateInstructions(candidate,scope){
  if(candidate===null||candidate===undefined)return null;
  if(candidate.entries&&candidate.candidateHash)return {name:candidate.name,description:candidate.description,content:ace.renderCandidate(candidate,scope)};
  if(candidate.entries&&candidate.status==='active')return {name:candidate.name,description:candidate.description,content:ace.renderSkill(candidate)};
  if(candidate.status==='active'&&Array.isArray(candidate.steps))return {name:candidate.name,description:candidate.description,content:renderLegacy(candidate)};
  throw Error('unsupported-native-candidate');
}
function textOf(content){return typeof content==='string'?content:Array.isArray(content)?content.filter(b=>b?.type==='text').map(b=>b.text).join('\n'):'';}
function eventsOf(session){return session.snapshotEvents();}

/** Uses the existing DSH ReAct driver with native executor + three memory-only tools.
 * SDK functions are injected from the running Host, not installed dependencies.
 */
export function createNativeCaseRunner(ctx,{NativeToolExecutor,createUserMessage,ownerAgent,provider,model,cwd:caseCwd,maxSteps=4,timeoutMs=45000,onCase,onDispatch=()=>{},preloadCandidate=false}={}){
  if(!ctx.agentLoop||typeof NativeToolExecutor!=='function'||typeof createUserMessage!=='function')throw Error('native-case-sdk-unavailable');
  const frozenSelection=Object.freeze({...ownerAgent?.model?.current?.()});
  return async function runCase({candidate,case:testCase,scope,budget,signal:externalSignal,arm='ace',phase='holdout'}){
    const started=Date.now();
    const signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(externalSignal?[externalSignal]:[])]),env=createFixtureEnvironment(testCase),instructions=candidateInstructions(candidate,scope);
    const id='ace-fixture-'+randomUUID(),selection=frozenSelection,selectedProvider=provider||selection.provider,selectedModel=model||selection.model;
    if(!selectedProvider||!selectedModel)throw Error('fixture-model-unavailable');
    const cwd=(typeof scope==='string'&&isAbsolute(scope)?scope:caseCwd)||ctx.workingDirectory.get(ownerAgent.session);signal.throwIfAborted();let handle,modelCalls=0,stepLimited=false,usageReports=[],loaded=false;
    let finalResult;
    const executorTools=[];
    try{
      handle=await ctx.agentLoop.createAgent(ctx,{sessionId:id,parentAgent:ownerAgent,meta:{origin:'subagent',cwd},agentOptions:{provider:selectedProvider,model:selectedModel,maxTokens:1200,...(selection.reasoningEffort?{reasoningEffort:selection.reasoningEffort}:{})},signal,
        async setup(agentCtx,agent){
          agentCtx.tools.setExecutor(new NativeToolExecutor(agentCtx,()=>1));
          // Explicit empty allow-list is supported; only this scope's own tools remain.
          agentCtx.tools.restrict({allow:[]});
          agentCtx.on('llm/stream',async function*(options,next){
            if(options.sessionId&&options.sessionId!==id){yield*next();return;}
            if(modelCalls>=maxSteps){stepLimited=true;throw Error('fixture-step-limit');}
            budget.reserve('generator');await onDispatch({role:'generator',sessionId:id,budget:budget.snapshot()});modelCalls++;let usage=null;
            try{for await(const chunk of next()){
              signal.throwIfAborted();
              if(chunk.type==='usage'&&Number.isSafeInteger(chunk.usage?.inputTokens)&&Number.isSafeInteger(chunk.usage?.outputTokens))usage=Object.fromEntries(['inputTokens','outputTokens','totalTokens','cacheReadTokens','reasoningTokens'].map(k=>[k,Number.isSafeInteger(chunk.usage[k])&&chunk.usage[k]>=0?chunk.usage[k]:null]));
              yield chunk;
            }}finally{if(usage)usageReports.push(usage);}
          });
          const register=(name,description,parameters,execute)=>{executorTools.push(name);agentCtx.tools.register({name,description,parameters,output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},isConcurrencySafe:()=>false,execute});};
          register('ace_fixture_read','Read the isolated declarative fixture and current check summary; no filesystem access.',{type:'object',properties:{},additionalProperties:false},()=>env.read());
          register('ace_fixture_patch','Set a predefined safe operation in an allowed in-memory fixture. Does not execute source code.',{type:'object',properties:{path:{type:'string'},operation:{type:'string',enum:OPERATIONS}},required:['path','operation'],additionalProperties:false},args=>env.patch(args));
          register('ace_fixture_verify','Run the trusted finite fixture checks; finish the case when all checks pass.',{type:'object',properties:{},additionalProperties:false},(_args,exec)=>{const result=env.verify();if(result.passed&&(!instructions||loaded))exec.concludeTurn();return result;});
          // A case-local capability loads only the candidate. Never exposes other local skills.
          if(instructions){
            // The loop factory's child context does not inject skills; retain a checked scoped lookup.
            const skills=agentCtx.get('skills');if(!skills)throw Error('native-case-skills-unavailable');
            skills.register({...instructions,source:'runtime',provider:'local-skill-loop-benchmark',resourceBase:{kind:'opaque',description:'Evaluation-only candidate; not a production publication.'}});
            const loadCandidate=async()=>{const skill=await skills.get(instructions.name,{cwd,scope:agent,signal});if(!skill||skill.provider!=='local-skill-loop-benchmark'||skill.content!==instructions.content)throw Error('fixture-candidate-shadowed');loaded=true;return {name:skill.name,content:skill.content,provider:skill.provider,evaluationOnly:true};};
            if(preloadCandidate)await loadCandidate();
            else register('ace_fixture_skill','Load the exact case-scoped candidate through the native skill registry (not a production publication).',{type:'object',properties:{},additionalProperties:false},loadCandidate);
          }
          agentCtx.tools.guard(exec=>executorTools.includes(exec.name)?undefined:'Fixture permits only its local memory tools.');
        },
      });
      const agent=handle.agent;
      const cancel=()=>agent.cancel({kind:'hook',reason:'fixture-cancelled'});signal.addEventListener('abort',cancel,{once:true});
      try{
        const prompt=`Controlled integration fixture, not a JavaScript benchmark. Use ONLY the available fixture tools. Read the fixture, choose a predefined operation, patch its allowed file, and run verification. Never execute source strings or call external tools. ${instructions?(preloadCandidate?'The candidate was loaded through the native case-scoped skill registry; apply applicable instructions below. The fixture boundary overrides them.\n'+instructions.content:'First load ace_fixture_skill and apply applicable candidate instructions, but the fixture safety boundary overrides them.'):''}\nTask: ${testCase.input.task}\nAllowed path names: ${JSON.stringify(testCase.input.allowedPaths)}\nNo private expected checks are supplied to you.`;
        agent.followup(createUserMessage({content:[{type:'text',text:prompt}],source:{kind:'user'}}));await agent.whenIdle();signal.throwIfAborted();
        const result=env.final();
        const events=eventsOf(agent.session),terminal=events.findLast(e=>e.type==='turn/end'),calls=new Map(events.filter(e=>e.type==='tool/call').map(e=>[e.data.callId,e.data.name]));
        const evidence=events.filter(e=>e.type==='tool/result'&&executorTools.includes(calls.get(e.data?.message?.toolCallId))).slice(-8).map(e=>{const message=e.data.message,body=textOf(message.content);return {seq:e.seq,type:e.type,text:redact(calls.get(message.toolCallId)+': '+body).slice(0,1000),verified:calls.get(message.toolCallId)==='ace_fixture_verify'&&message.isError!==true&&result.passed&&body.trim()===JSON.stringify(result.grade)};});
        const confirmationSeqs=result.passed?evidence.filter(e=>e.verified).map(e=>e.seq).slice(-1):[];
        finalResult={passed:result.passed&&terminal?.data?.reason?.kind==='completed'&&confirmationSeqs.length>0&&modelCalls>0&&!stepLimited&&(!instructions||loaded)&&budget.snapshot().denied===0,feedback:{caseId:testCase.id,family:testCase.family,phase,arm,sessionId:id,scope:cwd,turn:terminal?.data?.turn??1,endSeq:terminal?.seq??0,terminalReason:terminal?.data?.reason?.kind??'unknown',outcome:result.grade,modelCalls,candidateLoaded:loaded,candidateDelivery:instructions?(preloadCandidate?'preloaded-native-registry':'case-tool-native-registry'):'none',environment:'memory-only declarative operations; no generated JS executed',evidence,confirmationSeqs},metrics:{modelCalls,loaded,stepLimited,elapsedMs:Date.now()-started,tokenUsage:Object.fromEntries(['inputTokens','outputTokens','totalTokens','cacheReadTokens','reasoningTokens'].map(k=>[k,usageReports.length===modelCalls&&modelCalls>0&&usageReports.every(u=>u[k]!==null)?usageReports.reduce((s,u)=>s+u[k],0):null]))},...(usageReports.length?{usage:{provider:{reportedCalls:usageReports.length,inputTokens:usageReports.reduce((s,u)=>s+u.inputTokens,0),outputTokens:usageReports.reduce((s,u)=>s+u.outputTokens,0),cacheReadTokens:usageReports.every(u=>u.cacheReadTokens!==null)?usageReports.reduce((s,u)=>s+u.cacheReadTokens,0):null}}}:{})};
      }finally{signal.removeEventListener('abort',cancel);}
      onCase?.(finalResult);return finalResult;
    }finally{await handle?.dispose();}
  };
}
