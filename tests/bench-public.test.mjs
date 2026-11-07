import test from 'node:test';
import assert from 'node:assert/strict';
import * as bench from '@pnpwin/dsh-skill-loop/bench';
import * as optimizer from '@pnpwin/dsh-skill-loop/optimizer';
import {renderingFootprint} from '../src/bench/report.js';
test('public optimizer/benchmark seams import without Host SDK or provider calls',()=>{
  assert.equal(typeof bench.runComparison,'function');assert.equal(typeof bench.createComparisonAdapters,'function');assert.equal(typeof bench.createNativeCaseRunner,'function');assert.equal(typeof optimizer.createCandidateProposer,'function');assert.equal(bench.createNativeFixtureSet().cases.length,6);assert.equal(optimizer.createCallBudget(1).snapshot().used,0);
});
test('paired body measurement preserves procedure text and distinguishes bytes from tokens',()=>{const r=renderingFootprint();assert.ok(r.legacy.utf8Bytes>0);assert.ok(r.ace.utf8Bytes>0);assert.match(r.method,/No provider calls/);assert.equal(Object.hasOwn(r,'tokens'),false);});
