import test from 'node:test';
import assert from 'node:assert/strict';
import { createSeededCaseSet } from '../src/bench/cases.js';
import { runComparison, ARMS } from '../src/bench/runner.js';
import { stableHash } from '../src/optimizer.js';

const snapshots = () => ({ legacy: { schemaVersion: 1, lessons: [], label: 'legacy' }, ace: { schemaVersion: 2, lessons: [], label: 'ace' } });
const smallSet = () => ({ id: 'small-v1', cases: [
  { id: 'adapt', family: 'boundary', split: 'adaptation', input: { task: 'Adapt fixture' }, expected: { marker: 'adapt-secret' } },
  { id: 'hold', family: 'boundary', split: 'holdout', input: { task: 'Holdout fixture' }, expected: { marker: 'holdout-secret' } },
] });

test('seeded fixtures are reproducible, bounded, immutable and split within coding families', () => {
  const first = createSeededCaseSet(42), again = createSeededCaseSet(42), other = createSeededCaseSet(17);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first.cases.map(c => c.id), other.cases.map(c => c.id));
  assert.equal(first.cases.length, 8);
  for (const family of new Set(first.cases.map(c => c.family))) {
    assert.deepEqual(first.cases.filter(c => c.family === family).map(c => c.split).sort(), ['adaptation', 'holdout']);
  }
  for (const c of first.cases) {
    assert.deepEqual(c.input.allowedPaths, ['solution.mjs']);
    assert.ok(c.input.initialFiles['solution.mjs']);
    assert.ok(c.expected.requiredChecks.length);
    assert.equal(Object.isFrozen(c.expected.requiredChecks), true);
  }
  assert.throws(() => createSeededCaseSet(-1));
});

test('three-arm runner uses isolated frozen snapshots, never learns on holdout or no-memory', async () => {
  const source = snapshots(), before = JSON.stringify(source), contexts = [], seen = [];
  const result = await runComparison({ caseSet: smallSet(), snapshots: source,
    runCase: async request => {
      seen.push(request);
      assert.equal(Object.isFrozen(request), true);
      if (request.arm === 'no-memory') assert.equal(request.candidate, null);
      else assert.equal(Object.isFrozen(request.candidate.lessons), true);
      return { passed: request.phase === 'holdout' ? request.candidate?.lessons.includes('adapted') === true : true, feedback: 'Adaptation observation only' };
    },
    propose: async (context, { budget }) => {
      contexts.push(context);
      assert.equal(Object.isFrozen(context), true);
      assert.equal(JSON.stringify(context).includes('holdout-secret'), false);
      assert.equal(Object.hasOwn(context.case, 'expected'), false);
      return { candidate: { ...context.snapshot, lessons: [...context.snapshot.lessons, 'adapted'] } };
    }, maxLogicalCalls: 0 });
  assert.equal(result.complete, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.logicalCalls.used, 0);
  assert.equal(seen.length, 6);
  assert.equal(contexts.length, 2);
  assert.equal(contexts.some(c => c.arm === 'no-memory'), false);
  assert.equal(contexts.some(c => c.case.id === 'hold'), false);
  assert.equal(result.arms['no-memory'].holdout.passed, 0);
  assert.equal(result.arms.ace.holdout.passed, 1);
  assert.equal(result.arms.legacy.holdout.passed, 1);
  assert.equal(result.snapshots.ace.label, 'ace');
  assert.equal(result.snapshots.legacy.label, 'legacy');
  assert.equal(JSON.stringify(source), before);
  assert.equal(Object.isFrozen(result.snapshots.ace), true);
});

test('all roles across all arms share a hard logical dispatch cap without double charging cases', async () => {
  const roleSeen = [];
  const result = await runComparison({ caseSet: createSeededCaseSet(7), snapshots: snapshots(), maxLogicalCalls: 50,
    runCase: async ({ budget }) => {
      budget.reserve('generator'); roleSeen.push('generator');
      return { passed: true, usage: { provider: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3 }, estimates: [{ method: 'utf8', unit: 'bytes', value: 50 }] } };
    },
    propose: async (context, { budget }) => {
      budget.reserve('reflector'); budget.reserve('curator');
      roleSeen.push('reflector', 'curator');
      return { candidate: context.snapshot, usage: { provider: { inputTokens: 4, outputTokens: 1 } } };
    } });
  assert.equal(result.complete, true);
  assert.equal(result.logicalCalls.used, 40); // 24 task calls + 8 x (reflector,curator).
  assert.deepEqual(result.logicalCalls.byRole, { generator: 24, reflector: 8, curator: 8, evaluator: 0 });
  assert.equal(roleSeen.length, 40);
  assert.equal(result.arms.ace.usage.provider.inputTokens, 96);
  assert.equal(result.arms.ace.usage.provider.outputTokens, 20);
  assert.equal(result.arms.ace.usage.provider.cacheReadTokens, null); // Proposer cache usage is unknown.
  assert.equal(result.arms['no-memory'].usage.provider.cacheReadTokens, 24);
  assert.deepEqual(result.arms.ace.usage.estimates, [{ method: 'utf8', unit: 'bytes', value: 400 }]);
  assert.equal(result.arms['no-memory'].proposals, 0);
});

test('native multi-call case and proposer usage counts aggregate without synthetic dispatch charges', async () => {
  const result = await runComparison({ caseSet: smallSet(), snapshots: snapshots(), maxLogicalCalls: 24,
    runCase: async ({ budget, arm }) => {
      budget.reserve('generator'); budget.reserve('generator');
      return { passed: true, usage: { provider: { reportedCalls: 2, inputTokens: 20, outputTokens: 4,
        ...(arm === 'legacy' ? {} : { cacheReadTokens: 0 }) } } };
    },
    propose: async (context, { budget }) => {
      budget.reserve('reflector'); budget.reserve('curator'); budget.reserve('curator');
      return { candidate: context.snapshot, usage: { provider: { reportedCalls: 3, inputTokens: 30, outputTokens: 6, cacheReadTokens: 0 } } };
    } });
  assert.equal(result.complete, true);
  assert.equal(result.logicalCalls.used, 18); // 6 cases x 2 + 2 proposer invocations x 3.
  assert.equal(result.arms.ace.logicalCalls, 7);
  assert.deepEqual(result.arms.ace.usage.provider, { reportedCalls: 7, inputTokens: 70, outputTokens: 14, cacheReadTokens: 0 });
  assert.deepEqual(result.arms.legacy.usage.provider, { reportedCalls: 7, inputTokens: 70, outputTokens: 14, cacheReadTokens: null });
  assert.deepEqual(result.arms['no-memory'].usage.provider, { reportedCalls: 4, inputTokens: 40, outputTokens: 8, cacheReadTokens: 0 });
});

test('exhaustion during proposer fails closed and cannot continue into holdout', async () => {
  let holdouts = 0;
  const result = await runComparison({ caseSet: smallSet(), snapshots: snapshots(), maxLogicalCalls: 2,
    runCase: async ({ budget, phase }) => { budget.reserve('generator'); if (phase === 'holdout') holdouts += 1; return { passed: true }; },
    propose: async (context, { budget }) => { budget.reserve('reflector'); budget.reserve('curator'); return { candidate: context.snapshot }; } });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.complete, false);
  assert.equal(result.logicalCalls.used, 2);
  assert.equal(holdouts, 0);
});

test('swallowed budget denial is observable and still fails the run closed', async () => {
  const result = await runComparison({ caseSet: smallSet(), snapshots: snapshots(), maxLogicalCalls: 0,
    runCase: async ({ budget }) => { try { budget.reserve('generator'); } catch {} return { passed: true }; } });
  assert.equal(result.status, 'budget-exhausted');
  assert.equal(result.complete, false);
  assert.equal(result.logicalCalls.used, 0);
});

test('case errors and malformed usage are failed cases, never semantic success or leaked error strings', async () => {
  const result = await runComparison({ caseSet: smallSet(), snapshots: snapshots(),
    runCase: async ({ arm }) => {
      if (arm === 'no-memory') throw new Error('private provider error');
      if (arm === 'legacy') return { passed: true, usage: { provider: { inputTokens: -3, outputTokens: 1 } } };
      return { passed: false };
    } });
  assert.equal(result.complete, true);
  assert.equal(result.arms['no-memory'].holdout.errors, 1);
  assert.equal(result.arms.legacy.holdout.errors, 1);
  assert.equal(result.arms.ace.holdout.failed, 1);
  assert.equal(JSON.stringify(result).includes('private provider error'), false);
});

test('proposer errors preserve original snapshot and do not manufacture a passing candidate', async () => {
  const source = snapshots();
  const result = await runComparison({ caseSet: smallSet(), snapshots: source,
    runCase: async () => ({ passed: true }), propose: async () => { throw new Error('untrusted error'); } });
  assert.deepEqual(result.snapshots, source);
  assert.equal(result.arms.ace.proposalErrors, 1);
  assert.equal(result.arms.ace.proposals, 0);
  assert.equal(result.arms.ace.initialSnapshotHash, result.arms.ace.finalSnapshotHash);
});

test('abort bounds an unresolved callback without timers/provider work in test', async () => {
  const controller = new AbortController();
  const result = await runComparison({ caseSet: smallSet(), snapshots: snapshots(), signal: controller.signal,
    runCase: async () => { controller.abort(); return await new Promise(() => {}); } });
  assert.equal(result.status, 'aborted');
  assert.equal(result.complete, false);
});

test('deterministic case/arm order and artifacts except measured wall time', async () => {
  const options = { caseSet: createSeededCaseSet(2), snapshots: snapshots(), seed: 2, runCase: async () => ({ passed: true }) };
  const a = await runComparison(options), b = await runComparison(options);
  assert.deepEqual(a.results, b.results);
  assert.equal(a.caseSetHash, stableHash(options.caseSet));
  assert.deepEqual(a.arms, b.arms);
  assert.deepEqual(ARMS, ['no-memory', 'legacy', 'ace']);
});

test('invalid adapter, limits, snapshots and unsplit data reject before dispatch', async () => {
  const base = { caseSet: smallSet(), snapshots: snapshots(), runCase: async () => ({ passed: true }) };
  for (const bad of [{ runCase: null }, { timeoutMs: 0 }, { maxLogicalCalls: -1 }, { seed: -1 },
    { snapshots: {} }, { caseSet: { id: 'only-adapt', cases: [smallSet().cases[0]] } }]) {
    await assert.rejects(runComparison({ ...base, ...bad }));
  }
});
