import { performance } from 'node:perf_hooks';
import { createCallBudget, createCandidateProposer, immutableSnapshot, stableHash,
  validateCaseSet, emptyUsage, addUsage } from '../optimizer.js';

export const ARMS = Object.freeze(['no-memory', 'legacy', 'ace']);
const counter = () => ({ attempted: 0, passed: 0, failed: 0, errors: 0 });
function collectCounter(counter, result) { counter.attempted += 1; counter[result.passed ? 'passed' : 'failed'] += 1; if (result.error) counter.errors += 1; }
function abortable(invoke, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(invoke).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function orderFor(seed, index) {
  const shift = ((seed % ARMS.length) + index) % ARMS.length;
  return [...ARMS.slice(shift), ...ARMS.slice(0, shift)];
}

/**
 * Offline, injection-only comparison. There is no filesystem, shell, provider or
 * production-storage adapter here. runCase must use the existing native agent loop
 * in a caller-owned isolated workspace; the callback receives no production handle.
 * Each actual model call (all roles, retries included) MUST reserve on budget before
 * dispatch. Pure fixture scoring consumes zero model calls. All arms share one cap.
 *
 * runCase({candidate,case,scope,arm,phase,budget,signal}) ->
 *   {passed:boolean,usage?:{provider?,estimates?},feedback?:JSON}
 * propose({arm,snapshot,case:{id,family,input},observation:{passed,feedback}},
 *         {budget,signal}) -> {candidate:JSON|null,usage?}
 * Only adaptation observations reach propose. Holdout expected checks never enter
 * the proposer context. No-memory never invokes propose. Returned snapshots are
 * experiment artifacts only; callers must NOT publish them as learned skills.
 */
export async function runComparison({ caseSet, snapshots, runCase, propose, seed = 42,
  maxLogicalCalls = 96, timeoutMs = 45000, signal: externalSignal } = {}) {
  if (typeof runCase !== 'function') throw new TypeError('Injected native runCase required');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('Invalid seed');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Invalid benchmark timeout');
  if (!snapshots || !Object.hasOwn(snapshots, 'legacy') || !Object.hasOwn(snapshots, 'ace')) throw new TypeError('Independent legacy/ACE snapshots required');
  const trusted = validateCaseSet(caseSet);
  const adaptation = trusted.cases.filter(c => c.split === 'adaptation');
  const holdout = trusted.cases.filter(c => c.split === 'holdout');
  if (!adaptation.length || !holdout.length) throw new TypeError('Separate adaptation/holdout cases required');
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
  const budget = createCallBudget(maxLogicalCalls);
  const proposer = propose === undefined ? null : createCandidateProposer({ propose });
  const memory = { 'no-memory': null, legacy: immutableSnapshot(snapshots.legacy), ace: immutableSnapshot(snapshots.ace) };
  const arms = Object.fromEntries(ARMS.map(arm => [arm, {
    adaptation: counter(), holdout: counter(), proposals: 0, proposalErrors: 0,
    initialSnapshotHash: stableHash(memory[arm]), finalSnapshotHash: null,
    usage: emptyUsage(), logicalCalls: 0,
  }]));
  const results = [];
  const initialCaseHash = stableHash(trusted);
  const started = performance.now();
  let status = 'completed', complete = true, caseIndex = 0;
  const scope = 'benchmark-isolated';
  const assertBudget = denied => { if (budget.snapshot().denied !== denied) throw new RangeError('logical-call-budget-exhausted'); };
  try {
    for (const phase of ['adaptation', 'holdout']) {
      for (const testCase of phase === 'adaptation' ? adaptation : holdout) {
        for (const arm of orderFor(seed, caseIndex)) {
          signal.throwIfAborted();
          const before = budget.snapshot();
          let result;
          try {
            result = await abortable(() => runCase(Object.freeze({ candidate: memory[arm], case: testCase, scope, arm, phase, budget, signal })), signal);
            signal.throwIfAborted(); assertBudget(before.denied);
            if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.passed !== 'boolean') throw new TypeError('Invalid case result');
            // Detached bounded feedback; candidate model controls never reach host.
            result = { passed: result.passed, error: false,
              feedback: result.feedback === undefined ? null : immutableSnapshot(result.feedback, 8000),
              ...(result.usage === undefined ? {} : { usage: immutableSnapshot(result.usage, 8000) }) };
            addUsage(arms[arm].usage, result.usage);
          } catch (error) {
            signal.throwIfAborted(); assertBudget(before.denied);
            if (error instanceof RangeError && error.message === 'logical-call-budget-exhausted') throw error;
            result = { passed: false, error: true, feedback: null };
          } finally { arms[arm].logicalCalls += budget.snapshot().used - before.used; }
          collectCounter(arms[arm][phase], result);
          results.push({ arm, phase, caseId: testCase.id, family: testCase.family, passed: result.passed, error: result.error });
          if (phase === 'adaptation' && arm !== 'no-memory' && proposer && !result.error) {
            const beforeProposal = budget.snapshot();
            try {
              const proposal = await abortable(() => proposer.propose({ arm, snapshot: memory[arm],
                case: { id: testCase.id, family: testCase.family, input: testCase.input },
                observation: { passed: result.passed, feedback: result.feedback } }, { budget, signal }), signal);
              signal.throwIfAborted(); assertBudget(beforeProposal.denied);
              // Returned aggregated usage is already labelled; merge its provider
              // total only if an actual provider response was reported.
              if (proposal.usage.provider.reportedCalls) {
                const p = proposal.usage.provider;
                addUsage(arms[arm].usage, { provider: { reportedCalls: p.reportedCalls, inputTokens: p.inputTokens, outputTokens: p.outputTokens, cacheReadTokens: p.cacheReadTokens } });
              }
              addUsage(arms[arm].usage, { estimates: proposal.usage.estimates });
              if (proposal.candidate !== null) { memory[arm] = proposal.candidate; arms[arm].proposals += 1; }
            } catch (error) {
              signal.throwIfAborted(); assertBudget(beforeProposal.denied);
              if (error instanceof RangeError && error.message === 'logical-call-budget-exhausted') throw error;
              arms[arm].proposalErrors += 1;
            } finally { arms[arm].logicalCalls += budget.snapshot().used - beforeProposal.used; }
          }
        }
        caseIndex += 1;
      }
    }
  } catch (error) {
    complete = false;
    status = signal.aborted ? 'aborted' : error instanceof RangeError && error.message === 'logical-call-budget-exhausted' ? 'budget-exhausted' : 'failed';
  }
  for (const arm of ARMS) arms[arm].finalSnapshotHash = stableHash(memory[arm]);
  return immutableSnapshot({ schemaVersion: 1, status, complete, caseSetId: trusted.id,
    caseSetHash: initialCaseHash, seed, scope, elapsedMs: Math.max(0, performance.now() - started),
    logicalCalls: budget.snapshot(), arms, results,
    snapshots: { legacy: memory.legacy, ace: memory.ace },
    limitations: ['Synthetic fixtures are not a production-quality benchmark.',
      'Provider usage is only available where the injected adapter reports it; estimates are separate.',
      'Opaque native adapters must reserve every model dispatch on the shared budget.',
      'No production state is read or written by this runner.'],
  }, 1000000);
}
