import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallBudget, createCandidateProposer, createEvaluatorRegistry,
  immutableSnapshot, stableHash, validateCaseSet, emptyUsage, addUsage } from '../src/optimizer.js';

const candidate = () => ({ name: 'learned-check-result', baseRevision: 2, entries: [{ id: 'step-1', text: 'Run focused checks.' }] });
const caseSet = () => ({ id: 'trusted-v1', cases: [
  { id: 'adapt-1', family: 'coding', split: 'adaptation', input: { task: 'Fix a bounded fixture' }, expected: { hidden: 'adapt-answer' } },
  { id: 'hold-1', family: 'coding', split: 'holdout', input: { task: 'Fix another fixture' }, expected: { hidden: 'holdout-answer' } },
] });
const registry = runCase => createEvaluatorRegistry({ runCase, hashCandidate: stableHash,
  now: () => '2026-11-07T12:00:00.000Z', makeRunId: () => 'host-run-1' });

test('logical budget is shared across roles; failed dispatch consumes a slot', async () => {
  const budget = createCallBudget(3);
  assert.equal(budget.reserve('generator'), 1);
  await assert.rejects(budget.dispatch('reflector', async () => { throw new Error('provider failure'); }));
  await budget.dispatch('curator', async () => 1);
  assert.throws(() => budget.reserve('evaluator'), /budget-exhausted/);
  assert.equal(budget.snapshot().used, 3);
  assert.equal(budget.snapshot().denied, 1);
  assert.deepEqual(budget.snapshot().byRole, { generator: 1, reflector: 1, curator: 1, evaluator: 0 });
  assert.throws(() => budget.reserve('unknown'));
  for (const bad of [-1, 1.5, NaN, 1001]) assert.throws(() => createCallBudget(bad));
});

test('JSON snapshots are detached, deep frozen, bounded and hash order independent', () => {
  const original = { b: [1, { text: 'before' }], a: 2 };
  const copy = immutableSnapshot(original);
  original.b[1].text = 'after';
  assert.equal(copy.b[1].text, 'before');
  assert.throws(() => { copy.b[1].text = 'changed'; });
  assert.equal(stableHash({ a: 1, b: 2 }), stableHash({ b: 2, a: 1 }));
  for (const invalid of [{ a: undefined }, new Date(), { a: () => 1 }, { a: Infinity }]) assert.throws(() => immutableSnapshot(invalid));
  const accessor = {}; Object.defineProperty(accessor, 'a', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => immutableSnapshot(accessor), /accessor/);
  assert.throws(() => immutableSnapshot({ a: 'a'.repeat(30) }, 5), /limit/);
});

test('usage separates API counters from estimates and canonicalizes cache alias', () => {
  const total = emptyUsage();
  addUsage(total, { provider: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 4 }, estimates: [{ method: 'utf8', unit: 'bytes', value: 60 }] });
  addUsage(total, { provider: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 2 }, estimates: [{ method: 'utf8', unit: 'bytes', value: 20 }] });
  assert.deepEqual(total.provider, { reportedCalls: 2, inputTokens: 20, outputTokens: 5, cacheReadTokens: 6 });
  assert.deepEqual(total.estimates, [{ method: 'utf8', unit: 'bytes', value: 80 }]);
  assert.throws(() => addUsage(emptyUsage(), { provider: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 1, cachedInputTokens: 2 } }));
  assert.throws(() => addUsage(emptyUsage(), { provider: { inputTokens: -1, outputTokens: 0 } }));
  assert.throws(() => addUsage(emptyUsage(), { estimates: [{ value: 1, unit: 'tokens' }] }));
});

test('aggregated provider reports preserve actual chunk count and explicit cache unknowns', () => {
  const total = emptyUsage();
  assert.equal(total.provider.cacheReadTokens, null);
  addUsage(total, { provider: { reportedCalls: 3, inputTokens: 30, outputTokens: 9, cacheReadTokens: 0 } });
  assert.deepEqual(total.provider, { reportedCalls: 3, inputTokens: 30, outputTokens: 9, cacheReadTokens: 0 });
  addUsage(total, { provider: { reportedCalls: 2, inputTokens: 20, outputTokens: 6, cachedInputTokens: 4 } });
  assert.deepEqual(total.provider, { reportedCalls: 5, inputTokens: 50, outputTokens: 15, cacheReadTokens: 4 });
  addUsage(total, { provider: { inputTokens: 1, outputTokens: 0 } });
  assert.equal(total.provider.reportedCalls, 6);
  assert.equal(total.provider.cacheReadTokens, null);
  addUsage(total, { provider: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 2 } });
  assert.equal(total.provider.cacheReadTokens, null); // A later known report cannot fill earlier gaps.
  for (const field of ['cacheReadTokens', 'cachedInputTokens']) {
    const missing = emptyUsage();
    addUsage(missing, { provider: { inputTokens: 1, outputTokens: 0, [field]: null } });
    assert.equal(missing.provider.cacheReadTokens, null);
  }
  const reverse = emptyUsage();
  addUsage(reverse, { provider: { inputTokens: 1, outputTokens: 0 } });
  addUsage(reverse, { provider: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 } });
  assert.equal(reverse.provider.cacheReadTokens, null);
});

test('usage rejects invalid aggregate counts, ambiguous aliases, unknown fields and safe-integer overflow atomically', () => {
  const base = { inputTokens: 1, outputTokens: 1 };
  for (const reportedCalls of [0, -1, 1.5, null, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2']) {
    const total = emptyUsage(), before = structuredClone(total);
    assert.throws(() => addUsage(total, { provider: { ...base, reportedCalls } }));
    assert.deepEqual(total, before);
  }
  for (const extra of [{ unknown: 1 }, { cacheReadTokens: null, cachedInputTokens: 0 },
    { cacheReadTokens: 0, cachedInputTokens: null }, { cacheReadTokens: -1 }]) {
    assert.throws(() => addUsage(emptyUsage(), { provider: { ...base, ...extra } }));
  }
  for (const field of ['reportedCalls', 'inputTokens', 'outputTokens', 'cacheReadTokens']) {
    const total = emptyUsage();
    addUsage(total, { provider: { ...base, reportedCalls: 1, cacheReadTokens: 0, [field]: Number.MAX_SAFE_INTEGER } });
    const before = structuredClone(total);
    assert.throws(() => addUsage(total, { provider: { ...base, cacheReadTokens: 1 } }), /overflow/);
    assert.deepEqual(total, before);
  }
  const total = emptyUsage(), before = structuredClone(total);
  assert.throws(() => addUsage(total, { provider: base, estimates: [{ method: 'bad', unit: 'bytes', value: -1 }] }));
  assert.deepEqual(total, before);
});

test('registry mints exact binding only after registered holdout execution; pure scoring uses zero model calls', async () => {
  const seen = [];
  const r = registry(async input => { seen.push(input); return { passed: true }; });
  const original = caseSet();
  const desc = r.registerCaseSet(original);
  original.cases[1].expected.hidden = 'mutated';
  const c = candidate();
  const receipt = await r.evaluate(c, 'trusted-v1', { scope: '/project', budget: createCallBudget(0) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].case.split, 'holdout');
  assert.equal(seen[0].case.expected.hidden, 'holdout-answer');
  assert.equal(Object.isFrozen(seen[0].candidate.entries), true);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.metrics.logicalCalls, 0);
  assert.equal(receipt.metrics.usage.provider.reportedCalls, 0);
  assert.equal(r.owns(receipt, { candidateHash: stableHash(c), caseSetHash: desc.caseSetHash, scope: '/project', caseSetId: 'trusted-v1' }), true);
  assert.equal(r.owns(receipt, { scope: '/elsewhere' }), false);
  assert.equal(r.owns(receipt, { candidateHash: stableHash({ ...c, baseRevision: 3 }) }), false);
  assert.equal(r.owns(receipt, { arbitrary: true }), false);
  assert.equal(Object.isFrozen(receipt.metrics), true);
  assert.throws(() => { receipt.passed = false; });
  assert.equal(r.revoke(receipt), true);
  assert.equal(r.owns(receipt), false);
});

test('serialized, foreign and forged receipts are not host-owned capabilities', async () => {
  const first = registry(async () => ({ passed: true }));
  const second = registry(async () => ({ passed: true }));
  first.registerCaseSet(caseSet()); second.registerCaseSet(caseSet());
  const receipt = await first.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0) });
  assert.equal(first.owns({ ...receipt }), false);
  assert.equal(first.owns(JSON.parse(JSON.stringify(receipt))), false);
  assert.equal(second.owns(receipt), false);
  assert.equal(first.owns({ ...receipt, candidateHash: stableHash(candidate()), passed: true }), false);
});

test('registry rejects unregistered tests, duplicate IDs, empty/oversized sets and non-host budget', async () => {
  const r = registry(async () => ({ passed: true }));
  assert.equal(r.describeCaseSet('none'), null);
  r.registerCaseSet(caseSet());
  assert.throws(() => r.registerCaseSet(caseSet()), /duplicate/);
  for (const c of [ { id: 'empty', cases: [] }, { cases: caseSet().cases }, { id: 1, cases: caseSet().cases },
    { id: 'missing-family', cases: [{ ...caseSet().cases[1], family: undefined }] }, { ...caseSet(), shell: 'evil' },
    { id: 'duplicate', cases: [caseSet().cases[0], caseSet().cases[0]] },
    { id: 'only-adapt', cases: [caseSet().cases[0]] } ]) assert.throws(() => r.registerCaseSet(c));
  await assert.rejects(r.evaluate(candidate(), caseSet(), { scope: '/project', budget: createCallBudget(1) }), /Unregistered/);
  await assert.rejects(r.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: { reserve() {} } }), /Host call budget/);
  await assert.rejects(r.evaluate(candidate(), 'trusted-v1', { scope: 'relative', budget: createCallBudget(1) }), /scope/);
  assert.throws(() => validateCaseSet({ id: 'big', cases: Array(65).fill(caseSet().cases[0]) }));
});

test('host scoring failure/errors mint failed receipt without leaking exception text', async () => {
  for (const run of [async () => ({ passed: false }), async () => { throw new Error('secret output'); }, async () => ({ passed: 'yes' })]) {
    const r = registry(run); r.registerCaseSet(caseSet());
    const receipt = await r.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0) });
    assert.equal(receipt.passed, false);
    assert.equal(receipt.metrics.failedCases, 1);
    assert.equal(JSON.stringify(receipt).includes('secret output'), false);
  }
});

test('all-role budgets reject both thrown and swallowed exhaustion, never mint partial pass', async () => {
  for (const swallow of [true, false]) {
    const r = registry(async ({ budget }) => {
      budget.reserve('generator');
      try { budget.reserve('reflector'); } catch (error) { if (!swallow) throw error; }
      return { passed: true };
    });
    r.registerCaseSet(caseSet());
    await assert.rejects(r.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(1) }), /budget-exhausted/);
  }
});

test('abort, invalid candidate hash and host metadata cannot mint a receipt', async () => {
  const c = new AbortController();
  const r = registry(async () => { c.abort(); return { passed: true }; });
  r.registerCaseSet(caseSet());
  await assert.rejects(r.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0), signal: c.signal }));
  const invalid = createEvaluatorRegistry({ runCase: async () => ({ passed: true }), hashCandidate: () => 'model-asserted' });
  invalid.registerCaseSet(caseSet());
  await assert.rejects(invalid.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0) }), /hash/);
  const badMetadata = createEvaluatorRegistry({ runCase: async () => ({ passed: true }), hashCandidate: stableHash, now: () => 'not-a-date' });
  badMetadata.registerCaseSet(caseSet());
  await assert.rejects(badMetadata.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0) }), /metadata/);
  const dangling = new AbortController();
  const waiting = registry(async () => { dangling.abort(); return new Promise(() => {}); });
  waiting.registerCaseSet(caseSet());
  await assert.rejects(waiting.evaluate(candidate(), 'trusted-v1', { scope: '/project', budget: createCallBudget(0), signal: dangling.signal }));
});

test('thin proposer injects bounded immutable context, noop free and reserves only actual calls', async () => {
  const noop = createCandidateProposer({ propose: async () => ({ candidate: null }) });
  assert.equal((await noop.propose({ observations: [] }, { budget: createCallBudget(0) })).status, 'noop');
  const budget = createCallBudget(2);
  const p = createCandidateProposer({ propose: async (context, options) => {
    assert.equal(Object.isFrozen(context.observations), true);
    await options.budget.dispatch('reflector', async () => {});
    await options.budget.dispatch('curator', async () => {});
    return { candidate: candidate(), usage: { provider: { inputTokens: 20, outputTokens: 5 } } };
  } });
  const result = await p.propose({ observations: [] }, { budget });
  assert.equal(result.status, 'candidate');
  assert.equal(result.usage.provider.inputTokens, 20);
  assert.equal(budget.snapshot().used, 2);
  assert.throws(() => createCandidateProposer({}));
  const unsafe = createCandidateProposer({ propose: async () => ({ candidate: candidate(), confirmed: true }) });
  await assert.rejects(unsafe.propose({}, { budget: createCallBudget(0) }), /output/);
});
