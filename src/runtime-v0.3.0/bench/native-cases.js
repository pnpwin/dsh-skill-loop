import {validateCaseSet} from '../optimizer.js';

/** Tiny controlled workflow fixtures. Not a JavaScript coding benchmark. */
export function createNativeFixtureSet(){
  const base=(id,family,split,task,operation,args,expected,extra={})=>({id,family,split,input:{task,initialFiles:{'solution.json':JSON.stringify({operation}),...(extra.files??{})},allowedPaths:['solution.json']},expected:{module:'solution.json',requiredChecks:[{args,expected,...(extra.preserveArgs?{preserveArgs:true}:{})}],forbiddenPaths:extra.forbidden??[]}});
  return validateCaseSet({id:'native-declarative-workflow-v1',cases:[
    base('order-adapt','correction-and-check','adaptation','Fix the fixture: remove duplicates while retaining first-occurrence order; verify the repair.','unique-sort',[[3,1,3,2]],[3,1,2]),
    base('order-holdout','correction-and-check','holdout','Remove duplicates while retaining first-occurrence order.','unique-sort',[[9,2,9,1]],[9,2,1]),
    base('constraints-adapt','project-constraints','adaptation','Fix inclusive clamping: zero is a valid value. Preserve config.json exactly; write only solution.json.','clamp-falsy',[0,-3,4],0,{files:{'config.json':'{"sourceDirectory":"src","protected":true}'},forbidden:['config.json']}),
    base('constraints-holdout','project-constraints','holdout','Clamp to inclusive bounds, preserving zero and the read-only project config.','clamp-falsy',[0,-10,2],0,{files:{'config.json':'{"sourceDirectory":"src","protected":true}'},forbidden:['config.json']}),
    base('stale-adapt','stale-instruction','adaptation','Return ascending numeric order without mutating input. The current verification API is ace_fixture_verify, not the obsolete ace_fixture_check.','sort-mutating',[[11,2,3]],[2,3,11],{preserveArgs:true}),
    base('stale-holdout','stale-instruction','holdout','Sort numerically without changing the caller array. Use only the current tool schemas, not obsolete saved API names.','sort-mutating',[[100,-2,9,0]],[-2,0,9,100],{preserveArgs:true}),
  ]});
}
