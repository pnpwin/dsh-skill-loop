'use strict';

/**
 * GEPA-lite: reflection-driven evolutionary search over a single skill candidate.
 *
 * Isolated module: all model/registry interaction is injected through callbacks
 * (`evaluate`, `proposeVariant`, `recombine`). This module never publishes
 * anything — it returns the winning variant plus telemetry; the caller decides
 * what to do with it.
 *
 * Budget contract: `budget.reserve('evaluator')` is called immediately before
 * EVERY `evaluate` invocation. Factories reserve their own roles
 * ('curator'/'reflector') against the same budget object.
 */

const BUDGET_EXHAUSTED = 'logical-call-budget-exhausted';

function isBudgetError(error) {
  return error instanceof RangeError && error.message === BUDGET_EXHAUSTED;
}

/** Defensive normalization of the evaluator result shape. */
function adaptationOf(metrics) {
  const a = (metrics && typeof metrics === 'object' && metrics.adaptation) || {};
  return {
    gains: Number.isFinite(a.gains) ? a.gains : 0,
    regressions: Number.isFinite(a.regressions) ? a.regressions : 0,
    candidateFailed: a.candidateFailed === true,
    complete: a.complete !== false,
    coverage: Number.isFinite(a.coverage) ? a.coverage : 0,
  };
}

function deltaSize(variant) {
  try {
    const encoded = JSON.stringify(variant);
    return typeof encoded === 'string' ? encoded.length : 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * Pareto dominance over four objectives (all "higher is better"):
 *   [gains, coverage, -regressions, -deltaSize]
 */
function dominates(a, b) {
  let strictly = false;
  for (let i = 0; i < 4; i += 1) {
    if (a[i] < b[i]) return false;
    if (a[i] > b[i]) strictly = true;
  }
  return strictly;
}

function paretoFront(candidates) {
  return candidates.filter(candidate => (
    !candidates.some(other => other !== candidate && dominates(other.scores, candidate.scores))
  ));
}

/** Deterministic front order: (gains, coverage, -regressions, -deltaSize) desc. */
function byFrontOrder(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a.scores[i] !== b.scores[i]) return b.scores[i] - a.scores[i];
  }
  return 0;
}

/** Weighted random pick, weights ∝ coverage+1, using the injected rng. */
function pickWeighted(items, weightOf, rng) {
  const weights = items.map(weightOf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return items[0];
  let r = rng() * total;
  if (!(r < total)) r = 0;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * @param {object} args
 * @param {object} args.baseline          Opaque baseline candidate (required, not null).
 * @param {(variant: object) => Promise<object>} args.evaluate
 *   Returns { adaptation: { gains, regressions, candidateFailed, complete, coverage }, usage? }.
 * @param {(ctx: {parent, feedback, index, attempt}) => Promise<object|null>} args.proposeVariant
 *   `feedback` is the parent's raw evaluate result; undefined parents none — for the
 *   baseline it is the baseline metrics.
 * @param {(a, b) => Promise<object|null>} [args.recombine] Optional cross-over.
 * @param {{reserve(role), snapshot()}} args.budget Call budget (see createCallBudget).
 * @param {AbortSignal} [args.signal]
 * @param {number} [args.epochs=2]
 * @param {number} [args.population=3]
 * @param {number} [args.maxRefineAttempts=2] Extra factory calls beyond `population`.
 * @param {() => number} [args.rng] Seeded-able random source.
 * @param {() => string} [args.now] Clock for telemetry.
 *
 * @returns {Promise<{winner, winnerMetrics, baselineMetrics, evaluations, reason, epochs}>}
 */
export async function runGepaLite({
  baseline,
  evaluate,
  proposeVariant,
  recombine,
  budget,
  signal,
  epochs = 2,
  population = 3,
  maxRefineAttempts = 2,
  rng = Math.random,
  now = () => new Date().toISOString(),
}) {
  if (baseline === null || baseline === undefined) throw new TypeError('baseline candidate is required');
  if (typeof evaluate !== 'function') throw new TypeError('evaluate callback is required');
  if (typeof proposeVariant !== 'function') throw new TypeError('proposeVariant callback is required');
  if (!budget || typeof budget.reserve !== 'function' || typeof budget.snapshot !== 'function') {
    throw new TypeError('budget with reserve(role) and snapshot() is required');
  }
  if (!Number.isSafeInteger(epochs) || epochs < 1) throw new TypeError('epochs must be a positive integer');
  if (!Number.isSafeInteger(population) || population < 1) throw new TypeError('population must be a positive integer');

  const checkSignal = () => { if (signal && typeof signal.throwIfAborted === 'function') signal.throwIfAborted(); };

  const evaluations = [];      // telemetry: non-baseline evaluations only
  const candidates = [];       // every evaluated non-baseline variant entry
  const frontHistory = [];
  const metricsByVariant = new Map();

  /** Reserve + evaluate; maps budget exhaustion to { exhausted: true }. */
  async function evaluateVariant(variant, epoch, record) {
    checkSignal();
    if (budget.snapshot().remaining === 0) return { exhausted: true };
    try {
      budget.reserve('evaluator');
    } catch (error) {
      if (isBudgetError(error)) return { exhausted: true };
      throw error;
    }
    let metrics;
    try {
      metrics = await evaluate(variant);
    } catch (error) {
      if (isBudgetError(error)) return { exhausted: true };
      throw error;
    }
    const adaptation = adaptationOf(metrics);
    if (record) {
      evaluations.push({ variant, metrics, epoch });
      candidates.push({ variant, metrics, adaptation, epoch });
    }
    metricsByVariant.set(variant, metrics);
    return { entry: { variant, metrics, adaptation, epoch } };
  }

  function finish(reason) {
    let winner = null;
    let winnerMetrics = null;
    if (reason !== 'budget-exhausted' && reason !== 'no-variants') {
      const eligible = candidates.filter(c => (
        c.adaptation.complete === true
        && c.adaptation.regressions === 0
        && !c.adaptation.candidateFailed
      ));
      eligible.sort((a, b) => (
        b.adaptation.gains - a.adaptation.gains
        || b.adaptation.coverage - a.adaptation.coverage
        || a.adaptation.regressions - b.adaptation.regressions
      ));
      const best = eligible[0];
      if (best
        && best.adaptation.gains > baselineEntry.adaptation.gains
        && best.variant !== baselineEntry.variant
        && !deepEqual(best.variant, baselineEntry.variant)) {
        winner = best.variant;
        winnerMetrics = best.metrics;
        reason = 'candidate-found';
      } else {
        reason = 'no-gain';
      }
    }
    return {
      winner,
      winnerMetrics,
      baselineMetrics,
      evaluations: evaluations.slice(),
      reason,
      epochs: frontHistory.slice(),
      finishedAt: now(),
    };
  }

  checkSignal();
  const base = await evaluateVariant(baseline, -1, false);
  if (base.exhausted) {
    const baselineMetrics = null;
    return { winner: null, winnerMetrics: null, baselineMetrics, evaluations: [], reason: 'budget-exhausted', epochs: [], finishedAt: now() };
  }
  const baselineMetrics = base.entry.metrics;
  const baselineEntry = { variant: baseline, adaptation: base.entry.adaptation };

  let front = [];
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    checkSignal();
    const pool = epoch === 0 || front.length === 0 ? [baselineEntry] : front;

    // Optional recombination of two front winners (epochs after the first).
    if (epoch > 0 && front.length >= 2 && typeof recombine === 'function') {
      const weightOf = c => c.adaptation.coverage + 1;
      const parentA = pickWeighted(front, weightOf, rng);
      let parentB = pickWeighted(front, weightOf, rng);
      if (parentB === parentA && front.length > 1) {
        parentB = front[(front.indexOf(parentA) + 1) % front.length];
      }
      const child = await recombine(parentA.variant, parentB.variant);
      if (child !== null && child !== undefined) {
        const res = await evaluateVariant(child, epoch, true);
        if (res.exhausted) return finish('budget-exhausted');
      }
    }

    // Reflection-driven proposals: keep calling the factory until `population`
    // non-null variants are produced or the call limit is exhausted. The factory
    // may spend extra calls on the same index (refine attempts).
    const factoryLimit = population + maxRefineAttempts;
    let produced = 0;
    let calls = 0;
    let index = 0;
    let attempts = 0;
    while (produced < population && calls < factoryLimit) {
      checkSignal();
      const parent = (epoch === 0 && produced === 0 && attempts === 0)
        ? baselineEntry
        : pickWeighted(pool, c => c.adaptation.coverage + 1, rng);
      const feedback = parent === baselineEntry
        ? baselineMetrics
        : metricsByVariant.get(parent.variant);
      const proposed = await proposeVariant({
        parent: parent.variant,
        feedback,
        index,
        attempt: attempts,
      });
      calls += 1;
      if (proposed === null || proposed === undefined) {
        attempts += 1; // refine attempt for the same slot
        continue;
      }
      const res = await evaluateVariant(proposed, epoch, true);
      if (res.exhausted) return finish('budget-exhausted');
      produced += 1;
      index += 1;
      attempts = 0;
    }

    // Nothing ever produced and the pool is still just the baseline.
    if (produced === 0 && candidates.length === 0) return finish('no-variants');

    // Recompute the Pareto front over all valid candidates so far. Variants that
    // failed, did not complete an adaptation phase, or introduce regressions get
    // metrics but never enter the front (their feedback may still drive refine
    // attempts).
    const valid = candidates.filter(c => (
      !c.adaptation.candidateFailed
      && c.adaptation.complete === true
      && c.adaptation.regressions === 0
    ));
    for (const c of valid) {
      c.scores = [
        c.adaptation.gains,
        c.adaptation.coverage,
        -c.adaptation.regressions,
        -deltaSize(c.variant),
      ];
    }
    front = paretoFront(valid).sort(byFrontOrder);
    frontHistory.push(front.length);
  }

  return finish('pending');
}
