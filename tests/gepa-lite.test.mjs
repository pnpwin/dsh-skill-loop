'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';

import { runGepaLite } from '../src/evolve/gepa-lite.js';
import { createCallBudget } from '../src/optimizer.js';

/**
 * Fake paired evaluator: scores a variant by its `fixes` field (number of
 * failures it repairs). `regresses`/`incomplete`/`broken` flags model the
 * failure modes; `coverage` overrides the repaired-failure count.
 */
function makeEvaluator(baseline, stats = {}) {
  return async (variant) => {
    if (variant === baseline) {
      stats.baselineEvals = (stats.baselineEvals ?? 0) + 1;
      return { adaptation: { gains: 0, regressions: 0, candidateFailed: false, complete: true, coverage: 0 } };
    }
    return {
      adaptation: {
        gains: variant.fixes ?? 0,
        regressions: variant.regresses ? 1 : 0,
        candidateFailed: variant.broken === true,
        complete: variant.incomplete !== true,
        coverage: variant.coverage ?? variant.fixes ?? 0,
      },
    };
  };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const RNG = () => 0.5;

test('single better variant → winner, candidate-found, baseline evaluated exactly once', async () => {
  const baseline = { name: 'baseline', body: 'original' };
  const stats = {};
  const evaluate = makeEvaluator(baseline, stats);
  const result = await runGepaLite({
    baseline,
    evaluate,
    budget: createCallBudget(100),
    proposeVariant: async ({ index }) => (index === 0 ? { fixes: 2 } : null),
    rng: RNG,
  });
  assert.equal(result.reason, 'candidate-found');
  assert.equal(result.winner.fixes, 2);
  assert.equal(result.winnerMetrics.adaptation.gains, 2);
  assert.equal(result.baselineMetrics.adaptation.gains, 0);
  assert.equal(stats.baselineEvals, 1, 'baseline must be evaluated exactly once');
  assert.equal(result.epochs.length, 2, 'front sizes recorded per epoch');
  assert.ok(result.evaluations.every(e => e.variant !== baseline), 'telemetry excludes baseline');
});

test('no variant better than baseline → no-gain, winner null', async () => {
  const baseline = { name: 'baseline' };
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    proposeVariant: async () => ({ fixes: 0 }),
    rng: RNG,
  });
  assert.equal(result.reason, 'no-gain');
  assert.equal(result.winner, null);
  assert.equal(result.winnerMetrics, null);
});

test('factory always returns null → no-variants', async () => {
  const baseline = { name: 'baseline' };
  let calls = 0;
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    proposeVariant: async () => { calls += 1; return null; },
    rng: RNG,
  });
  assert.equal(result.reason, 'no-variants');
  assert.equal(result.winner, null);
  assert.equal(result.evaluations.length, 0);
  assert.equal(result.epochs.length, 0);
  assert.ok(calls > 0, 'factory was still attempted');
});

test('budget with limit 1 → budget-exhausted after baseline', async () => {
  const baseline = { name: 'baseline' };
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(1),
    proposeVariant: async () => ({ fixes: 1 }),
    rng: RNG,
  });
  assert.equal(result.reason, 'budget-exhausted');
  assert.equal(result.winner, null);
  assert.equal(result.baselineMetrics.adaptation.gains, 0, 'baseline was evaluated once');
  assert.equal(result.evaluations.length, 0, 'no variant was evaluated');
});

test('epochs=2: later generations draw parents from the front; seeded rng is deterministic', async () => {
  const run = async () => {
    const baseline = { name: 'baseline' };
    const parents = [];
    const result = await runGepaLite({
      baseline,
      evaluate: makeEvaluator(baseline),
      budget: createCallBudget(100),
      epochs: 2,
      population: 3,
      rng: RNG,
      proposeVariant: async ({ parent, index }) => {
        parents.push(parent);
        return { fixes: Math.min((parent.fixes ?? 0) + 1 + index, 6) };
      },
    });
    return { result, parents };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.result.reason, 'candidate-found');
  assert.equal(a.result.winner.fixes, 6, 'second epoch improves on first-epoch front winner');
  assert.ok(
    a.parents.some(p => p && p.fixes !== undefined),
    'proposeVariant must receive front winners, not only the baseline',
  );
  assert.equal(a.result.evaluations.length, 6, '3 variants per epoch');
  assert.deepEqual(
    a.result.evaluations.map(e => e.metrics.adaptation.gains),
    b.result.evaluations.map(e => e.metrics.adaptation.gains),
    'seeded rng → identical evaluation trace',
  );
  assert.deepEqual(a.result.winner, b.result.winner, 'seeded rng → identical winner');
  assert.deepEqual(a.result.epochs, b.result.epochs, 'seeded rng → identical front sizes');
});

test('regressions>0 and complete!==true variants are excluded from the front', async () => {
  const baseline = { name: 'baseline' };
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    epochs: 1,
    population: 3,
    rng: RNG,
    proposeVariant: async ({ index }) => {
      if (index === 0) return { fixes: 5, regresses: true };
      if (index === 1) return { fixes: 4, incomplete: true };
      return { fixes: 3 };
    },
  });
  assert.equal(result.epochs[0], 1, 'only the clean variant is on the front');
  assert.equal(result.winner.fixes, 3);
  assert.equal(result.reason, 'candidate-found');
});

test('deep-frozen baseline is not mutated', async () => {
  const baseline = deepFreeze({ name: 'baseline', nested: { body: 'original' } });
  const snapshot = JSON.stringify(baseline);
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    proposeVariant: async () => ({ fixes: 1 }),
    rng: RNG,
  });
  assert.equal(result.reason, 'candidate-found');
  assert.equal(JSON.stringify(baseline), snapshot, 'baseline untouched');
  assert.notEqual(result.winner, baseline);
});

test('recombine is invoked when the front has ≥2 members and is null-safe', async () => {
  const makeRun = (recombineResult) => {
    const baseline = { name: 'baseline' };
    const recombineCalls = [];
    return runGepaLite({
      baseline,
      evaluate: makeEvaluator(baseline),
      budget: createCallBudget(100),
      epochs: 2,
      population: 2,
      rng: RNG,
      proposeVariant: async ({ index }) => (index === 0
        ? { fixes: 3, coverage: 1 }
        : { fixes: 2, coverage: 4 }),
      recombine: async (a, b) => {
        recombineCalls.push([a, b]);
        return typeof recombineResult === 'function' ? recombineResult(a, b) : recombineResult;
      },
    }).then(result => ({ result, recombineCalls }));
  };

  // Non-dominated pair (gains 3/coverage 1 vs gains 2/coverage 4) → front size 2.
  const first = await makeRun(null);
  assert.equal(first.result.epochs[0], 2, 'two non-dominated variants on the front');
  assert.ok(first.recombineCalls.length >= 1, 'recombine called once the front has ≥2 members');
  assert.equal(first.result.reason, 'candidate-found');
  assert.equal(first.result.winner.fixes, 3, 'null recombine is skipped; factory variant wins');
  assert.ok(first.result.evaluations.every(e => e.variant.fixes !== undefined));
});

test('recombine offspring participates in the final selection', async () => {
  const baseline = { name: 'baseline' };
  const result = await runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    epochs: 2,
    population: 2,
    rng: RNG,
    proposeVariant: async ({ index }) => (index === 0
      ? { fixes: 3, coverage: 1 }
      : { fixes: 2, coverage: 4 }),
    recombine: async () => ({ fixes: 9 }),
  });
  assert.equal(result.reason, 'candidate-found');
  assert.equal(result.winner.fixes, 9, 'recombined variant wins the final selection');
});

test('pre-aborted signal propagates as a throw', async () => {
  const baseline = { name: 'baseline' };
  await assert.rejects(() => runGepaLite({
    baseline,
    evaluate: makeEvaluator(baseline),
    budget: createCallBudget(100),
    proposeVariant: async () => ({ fixes: 1 }),
    signal: AbortSignal.abort(),
    rng: RNG,
  }));
});
