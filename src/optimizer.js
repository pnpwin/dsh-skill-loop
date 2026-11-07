import { createHash, randomUUID } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const idOK = value => typeof value === 'string' && ID.test(value);
const roles = new Set(['generator', 'reflector', 'curator', 'evaluator']);
const budgets = new WeakSet();
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x)
  && [Object.prototype, null].includes(Object.getPrototypeOf(x));

function json(value, depth = 0) {
  if (depth > 24) throw new TypeError('JSON depth limit');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(x => json(x, depth + 1));
  if (!object(value)) throw new TypeError('Expected plain JSON');
  const output = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessor rejected');
    output[key] = json(descriptor.value, depth + 1);
  }
  return output;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
/** Detached, recursively frozen JSON. Never pass production handles into callbacks. */
export function immutableSnapshot(value, maxChars = 200000) {
  const normalized = json(value);
  const encoded = JSON.stringify(normalized);
  if (encoded.length > maxChars) throw new RangeError('Snapshot size limit');
  // Restore ordinary JSON objects so host adapters need no special prototype handling.
  return freeze(JSON.parse(encoded));
}
export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(json(value))).digest('hex');
}
function scopeOK(value) {
  return typeof value === 'string' && value.startsWith('/') && value.length <= 4096 && !value.includes('\0');
}
function checkSignal(signal) { signal?.throwIfAborted(); }
function abortable(invoke, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(invoke).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Logical dispatches, not provider tokens. Reservation is synchronous, monotone and
 * includes failed/aborted dispatched work. Native adapters must use this same handle
 * for EVERY additional model call; opaque callback internals cannot be inspected.
 */
export function createCallBudget(limit) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 1000) throw new TypeError('Invalid logical call limit');
  let used = 0, denied = 0;
  const byRole = Object.fromEntries([...roles].map(role => [role, 0]));
  const budget = Object.freeze({
    reserve(role) {
      if (!roles.has(role)) throw new TypeError('Unknown logical call role');
      if (used >= limit) { denied += 1; throw new RangeError('logical-call-budget-exhausted'); }
      used += 1; byRole[role] += 1;
      return used;
    },
    async dispatch(role, invoke) {
      if (typeof invoke !== 'function') throw new TypeError('Dispatch requires callback');
      budget.reserve(role);
      return await invoke();
    },
    snapshot() { return Object.freeze({ limit, used, remaining: limit - used, denied, byRole: Object.freeze({ ...byRole }) }); },
  });
  budgets.add(budget);
  return budget;
}
function requireBudget(budget) {
  if (!budgets.has(budget)) throw new TypeError('Host call budget required');
}

export function emptyUsage() {
  return { provider: { reportedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: null }, estimates: [] };
}
/**
 * Actual provider counters and labelled estimates never share one token total.
 * reportedCalls defaults to 1; adapters may supply a positive safe integer when
 * input/output/cache counters already sum multiple actual provider usage chunks.
 * Cache null/missing means UNKNOWN, not measured zero. A sum stays unknown if any
 * contributing report lacks cache data. No partial sum is mislabelled as complete.
 * Validation is atomic: malformed usage/overflow leaves the accumulator unchanged.
 */
export function addUsage(total, usage) {
  if (usage === undefined) return total;
  if (!object(usage) || Object.keys(usage).some(k => !['provider', 'estimates'].includes(k))) throw new TypeError('Invalid usage');
  const nonnegative = n => Number.isSafeInteger(n) && n >= 0;
  if (!object(total) || !object(total.provider) || !Array.isArray(total.estimates)
    || !['reportedCalls', 'inputTokens', 'outputTokens'].every(k => nonnegative(total.provider[k]))
    || (total.provider.cacheReadTokens !== null && !nonnegative(total.provider.cacheReadTokens))) throw new TypeError('Invalid usage accumulator');
  const provider = { ...total.provider };
  const estimates = total.estimates.map(e => ({ ...e }));
  if (usage.provider !== undefined) {
    const p = usage.provider;
    if (!object(p) || Object.keys(p).some(k => !['inputTokens', 'outputTokens', 'reportedCalls', 'cacheReadTokens', 'cachedInputTokens'].includes(k))
      || !['inputTokens', 'outputTokens'].every(k => nonnegative(p[k]))
      || (p.reportedCalls !== undefined && (!nonnegative(p.reportedCalls) || p.reportedCalls === 0))
      || ['cacheReadTokens', 'cachedInputTokens'].some(k => p[k] !== undefined && p[k] !== null && !nonnegative(p[k]))
      || (p.cacheReadTokens !== undefined && p.cachedInputTokens !== undefined && p.cacheReadTokens !== p.cachedInputTokens)) throw new TypeError('Invalid provider usage');
    const cache = p.cacheReadTokens !== undefined ? p.cacheReadTokens : p.cachedInputTokens !== undefined ? p.cachedInputTokens : null;
    const cacheTotal = provider.reportedCalls === 0 ? cache
      : provider.cacheReadTokens === null || cache === null ? null : provider.cacheReadTokens + cache;
    const normalized = { reportedCalls: p.reportedCalls ?? 1, inputTokens: p.inputTokens, outputTokens: p.outputTokens };
    for (const k of ['reportedCalls', 'inputTokens', 'outputTokens']) {
      const value = provider[k] + normalized[k];
      if (!nonnegative(value)) throw new RangeError('Usage counter overflow');
      provider[k] = value;
    }
    if (cacheTotal !== null && !nonnegative(cacheTotal)) throw new RangeError('Usage counter overflow');
    provider.cacheReadTokens = cacheTotal;
  }
  if (usage.estimates !== undefined) {
    if (!Array.isArray(usage.estimates) || usage.estimates.length > 16) throw new TypeError('Invalid usage estimates');
    for (const e of usage.estimates) {
      if (!object(e) || Object.keys(e).some(k => !['method', 'unit', 'value'].includes(k))
        || typeof e.method !== 'string' || !e.method || e.method.length > 100
        || !['bytes', 'characters', 'tokens'].includes(e.unit)
        || !nonnegative(e.value)) throw new TypeError('Invalid labelled estimate');
      const old = estimates.find(x => x.method === e.method && x.unit === e.unit);
      if (old) { if (!nonnegative(old.value + e.value)) throw new RangeError('Estimate overflow'); old.value += e.value; }
      else { if (estimates.length >= 64) throw new RangeError('Estimate methods limit'); estimates.push({ ...e }); }
    }
  }
  total.provider = provider;
  total.estimates = estimates;
  return total;
}

export function validateCaseSet(caseSet) {
  if (!object(caseSet) || Object.keys(caseSet).some(k => !['id', 'cases'].includes(k)) || !idOK(caseSet.id)
    || !Array.isArray(caseSet.cases) || !caseSet.cases.length || caseSet.cases.length > 64) throw new TypeError('Invalid trusted case set');
  const seen = new Set();
  for (const c of caseSet.cases) {
    if (!object(c) || Object.keys(c).some(k => !['id', 'family', 'split', 'input', 'expected'].includes(k))
      || !idOK(c.id) || !idOK(c.family) || !['adaptation', 'holdout'].includes(c.split)
      || !Object.hasOwn(c, 'input') || !Object.hasOwn(c, 'expected') || seen.has(c.id)) throw new TypeError('Invalid trusted case');
    seen.add(c.id);
  }
  return immutableSnapshot(caseSet, 250000);
}

/** Thin injection seam. This module supplies no optimizer algorithm or GEPA path. */
export function createCandidateProposer({ propose }) {
  if (typeof propose !== 'function') throw new TypeError('Injected candidate proposer required');
  return Object.freeze({
    async propose(context, { budget, signal } = {}) {
      requireBudget(budget); checkSignal(signal);
      const input = immutableSnapshot(context);
      const deniedBefore = budget.snapshot().denied;
      // A proposer invocation may be a pure noop. Its trusted implementation must
      // reserve before each actual model dispatch, including reflector/curator.
      const output = await propose(input, Object.freeze({ budget, signal }));
      checkSignal(signal);
      if (budget.snapshot().denied !== deniedBefore) throw new RangeError('logical-call-budget-exhausted');
      if (!object(output) || Object.keys(output).some(k => !['candidate', 'usage'].includes(k)) || !Object.hasOwn(output, 'candidate')) throw new TypeError('Invalid proposer output');
      const candidate = output.candidate === null ? null : immutableSnapshot(output.candidate);
      if (candidate !== null && !object(candidate)) throw new TypeError('Invalid candidate');
      const usage = emptyUsage(); addUsage(usage, output.usage);
      return freeze({ status: candidate === null ? 'noop' : 'candidate', candidate, usage });
    },
  });
}

/**
 * Host-owned evaluator capability. Keep the registry out of model tools. Registered
 * cases are trusted host definitions; evaluate accepts only their ID, not new tests
 * or model-supplied shell commands. Receipts are identity capabilities: JSON copies,
 * forged objects, foreign registries and receipts from a previous process fail owns.
 * Core can persist receipt data, but runtime must check owns before attaching it.
 */
export function createEvaluatorRegistry({ runCase, hashCandidate, now = () => new Date().toISOString(), makeRunId = randomUUID }) {
  if (typeof runCase !== 'function' || typeof hashCandidate !== 'function' || typeof now !== 'function' || typeof makeRunId !== 'function') throw new TypeError('Host evaluator callbacks required');
  const sets = new Map();
  const issued = new WeakSet();
  return Object.freeze({
    registerCaseSet(value) {
      const snapshot = validateCaseSet(value);
      if (sets.has(snapshot.id) || sets.size >= 32) throw new Error('Case set duplicate or registry capacity');
      if (!snapshot.cases.some(c => c.split === 'holdout')) throw new TypeError('Evaluator requires holdout cases');
      const set = { snapshot, hash: stableHash(snapshot) };
      sets.set(snapshot.id, set);
      return freeze({ id: snapshot.id, caseSetHash: set.hash, cases: snapshot.cases.length, holdoutCases: snapshot.cases.filter(c => c.split === 'holdout').length });
    },
    describeCaseSet(id) {
      const set = sets.get(id);
      return set ? freeze({ id, caseSetHash: set.hash, cases: set.snapshot.cases.length, holdoutCases: set.snapshot.cases.filter(c => c.split === 'holdout').length }) : null;
    },
    async evaluate(candidate, caseSetId, { scope, budget, signal: externalSignal, timeoutMs = 45000 } = {}) {
      requireBudget(budget);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Invalid evaluation timeout');
      const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
      checkSignal(signal);
      if (!scopeOK(scope)) throw new TypeError('Canonical project scope required');
      const set = sets.get(caseSetId);
      if (!set) throw new Error('Unregistered host case set');
      const snapshot = immutableSnapshot(candidate);
      const candidateHash = hashCandidate(snapshot);
      if (typeof candidateHash !== 'string' || !HASH.test(candidateHash)) throw new TypeError('Invalid host candidate hash');
      const usage = emptyUsage();
      const results = [];
      const before = budget.snapshot().used;
      const deniedBefore = budget.snapshot().denied;
      for (const testCase of set.snapshot.cases.filter(c => c.split === 'holdout')) {
        checkSignal(signal);
        // Case dispatch is NOT a provider call. The native adapter reserves before
        // each actual model call. Budget errors must abort, never mint partial pass.
        try {
          const result = await abortable(() => runCase(Object.freeze({ candidate: snapshot, case: testCase, scope, arm: 'candidate', phase: 'holdout', budget, signal })), signal);
          checkSignal(signal);
          if (budget.snapshot().denied !== deniedBefore) throw new RangeError('logical-call-budget-exhausted');
          if (!object(result) || typeof result.passed !== 'boolean') throw new TypeError('Invalid evaluator result');
          addUsage(usage, result.usage);
          results.push({ id: testCase.id, passed: result.passed, error: false });
        } catch (error) {
          checkSignal(signal);
          if (error instanceof RangeError && error.message === 'logical-call-budget-exhausted') throw error;
          // No arbitrary exception text or model output is admitted into receipts.
          results.push({ id: testCase.id, passed: false, error: true });
        }
      }
      checkSignal(signal);
      const at = now(); const runId = makeRunId();
      if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(at)
        || typeof runId !== 'string' || !ID.test(runId)) throw new TypeError('Invalid host receipt metadata');
      const receipt = freeze({ candidateHash, caseSetId, caseSetHash: set.hash, scope,
        passed: results.length > 0 && results.every(r => r.passed), runId, at,
        metrics: { cases: results.length, passedCases: results.filter(r => r.passed).length,
          failedCases: results.filter(r => !r.passed).length, errors: results.filter(r => r.error).length,
          logicalCalls: budget.snapshot().used - before, usage } });
      issued.add(receipt);
      return receipt;
    },
    owns(receipt, binding = {}) {
      if (!receipt || !issued.has(receipt)) return false;
      const set = sets.get(receipt.caseSetId);
      if (!set || receipt.caseSetHash !== set.hash) return false;
      if (!object(binding) || Object.keys(binding).some(k => !['candidateHash', 'caseSetHash', 'scope', 'caseSetId'].includes(k))) return false;
      return Object.entries(binding).every(([key, value]) => receipt[key] === value);
    },
    revoke(receipt) { return issued.delete(receipt); },
  });
}
