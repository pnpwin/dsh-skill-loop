import test from 'node:test';
import assert from 'node:assert/strict';
import { createComparisonAdapters } from '../src/bench/adapters.js';
import { createNativeFixtureSet } from '../src/bench/native-cases.js';
import { runComparison } from '../src/bench/runner.js';
import { createCallBudget, createCandidateProposer } from '../src/optimizer.js';
import { REFLECT_SYSTEM } from '../src/prompts.js';
import { REFLECTOR_SYSTEM, CURATOR_SYSTEM } from '../src/review.js';
import * as legacy from '../src/core.js';
import * as ace from '../src/ace-core.js';

const ROOT = '/private/benchmark-memory';
const NOW = '2026-11-07T00:00:00.000Z';
const fixtureSet = createNativeFixtureSet();
const adaptation = fixtureSet.cases.find(c => c.id === 'order-adapt');
const holdout = fixtureSet.cases.find(c => c.id === 'order-holdout');
const textOf = options => options.messages[0].content[0].text;
const inputOf = options => JSON.parse(textOf(options));
function roleDraft(options) {
  const input = inputOf(options);
  const observations = input.observations ?? input.workEvidence;
  const refs = observations.map(e => e.seq);
  if (!refs.length) return options.system === REFLECT_SYSTEM ? { lessons: [], proposal: null } : { lessons: [], insights: [], judgments: [] };
  if (options.system === REFLECT_SYSTEM) return { lessons: [], proposal: { name: 'learned-preserve-order', description: 'Preserve first occurrence order when removing duplicates.', trigger: 'When removing duplicate values from a sequence', steps: ['Read fixture constraints.', 'Preserve first occurrence order and verify the repair.'], pitfalls: ['Do not sort as a side effect of deduplication.'], checks: ['Run the current verification tool.'], reason: 'Observed repair and its native checks.', evidenceSeqs: refs, baseRevision: 0 } };
  if (options.system === REFLECTOR_SYSTEM) return { lessons: [], insights: [{ targetName: null, trigger: 'When removing duplicates', lesson: 'Preserve first occurrence order and verify the repair.', evidenceSeqs: refs }], judgments: [] };
  assert.equal(options.system, CURATOR_SYSTEM);
  return { proposal: { name: 'learned-preserve-order', baseRevision: 0, baseHash: null, reason: 'Observed repair and its native checks.', evidenceSeqs: refs, operations: [{ op: 'create', description: 'Preserve first occurrence order when removing duplicates.', trigger: 'When removing duplicate values from a sequence', entries: [{ section: 'step', text: 'Read fixture constraints.' }, { section: 'step', text: 'Preserve first occurrence order and verify the repair.' }] }] } };
}
function fakeHost({ reply = roleDraft, usage = () => ({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }), streamOverride } = {}) {
  const trace = { reviews: [], registrations: [], dispatches: [], caseSpecs: [], disposed: 0, storageTouches: 0 };
  const ownerAgent = { id: 'actual-owner-session', session: {}, model: { current: () => ({ provider: 'provider', model: 'model' }) } };
  const ctx = {
    workingDirectory: { get: () => '/production-root-never-used' },
    llm: { stream(options) {
      trace.reviews.push(options);
      if (streamOverride) return streamOverride(options);
      return (async function* () {
        const output = reply(options);
        yield { type: 'text-delta', text: typeof output === 'string' ? output : JSON.stringify(output) };
        const counters = usage(options); if (counters) yield { type: 'usage', usage: counters };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    } },
    agentLoop: { async createAgent(_ownerCtx, spec) {
      trace.caseSpecs.push(spec);
      const definitions = new Map(), skills = new Map(), hooks = new Map(), events = [];
      let seq = 0;
      const append = (type, data) => events.push({ seq: seq++, type, data });
      const scopedSkills={ register(skill) { trace.registrations.push(skill); skills.set(skill.name, skill); }, async get(name, options) { assert.equal(options.cwd, ROOT); return skills.get(name); } };
      const agentCtx = {
        get:name=>name==='skills'?scopedSkills:undefined,
        get skills(){throw Error('cannot get property skills without inject');},
        tools: { register: def => definitions.set(def.name, def), setExecutor() {}, restrict(value) { assert.deepEqual(value, { allow: [] }); }, guard() {} },
        on: (event, fn) => hooks.set(event, fn),
      };
      async function call(name, args = {}) {
        const callId = 'call-' + seq; append('tool/call', { callId, name });
        const result = await definitions.get(name).execute(args, { concludeTurn() {} });
        append('tool/result', { message: { toolCallId: callId, isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] } });
      }
      const agent = { session: { snapshotEvents: () => structuredClone(events) }, followup() {}, cancel() {}, async whenIdle() {
        const next = async function* () { yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 10, cacheReadTokens: 0 } }; yield { type: 'finish', reason: { kind: 'stop' } }; };
        for await (const _ of hooks.get('llm/stream')({ sessionId: spec.sessionId }, next)) {}
        if (definitions.has('ace_fixture_skill')) await call('ace_fixture_skill');
        await call('ace_fixture_read'); await call('ace_fixture_patch', { path: 'solution.json', operation: 'stable-unique' }); await call('ace_fixture_verify');
        append('turn/end', { turn: 7, reason: { kind: 'completed' } });
      } };
      await spec.setup(agentCtx, agent);
      return { agent, async dispose() { trace.disposed++; } };
    } },
  };
  Object.defineProperty(ctx, 'storage', { get() { trace.storageTouches++; throw Error('Production storage forbidden'); } });
  class NativeToolExecutor {}
  const options = { ownerAgent, NativeToolExecutor, createUserMessage: message => message, root: ROOT,
    config: { maxInputChars: 16000, maxOutputTokens: 6000, timeoutMs: 1000 }, onDispatch: event => trace.dispatches.push(event) };
  return { ctx, options, trace, adapters: createComparisonAdapters(ctx, options) };
}
function learningRequest(arm, snapshot, result) { return { arm, snapshot,
  case: { id: adaptation.id, family: adaptation.family, input: adaptation.input }, observation: { passed: result.passed, feedback: result.feedback } }; }
async function nativeObservation(host, budget = createCallBudget(10)) {
  return host.adapters.runCase({ arm: 'no-memory', candidate: null, case: adaptation, scope: 'benchmark-isolated', phase: 'adaptation', budget });
}

test('comparison snapshots are private independent immutable V1/V2 projects with injected SDK only', () => {
  const host = fakeHost(), { snapshots } = host.adapters;
  assert.equal(legacy.validateProject(snapshots.legacy), true);
  assert.equal(ace.validateProject(snapshots.ace), true);
  assert.equal(snapshots.legacy.mode, 'auto'); assert.equal(snapshots.ace.mode, 'auto');
  assert.equal(snapshots.legacy.root, ROOT); assert.equal(snapshots.ace.root, ROOT);
  assert.notEqual(snapshots.legacy.lessons, snapshots.ace.lessons);
  assert.equal(Object.isFrozen(snapshots.ace.skills), true);
  assert.equal(host.trace.storageTouches, 0);
  assert.throws(() => createComparisonAdapters(host.ctx, { ...host.options, root: 'relative' }), /absolute/);
  assert.throws(() => createComparisonAdapters(host.ctx, { ...host.options, root: '/private/password=secret' }), /absolute/);
  assert.throws(() => createComparisonAdapters(host.ctx, { ...host.options, NativeToolExecutor: undefined }), /sdk/);
});

test('real legacy single role and ACE two roles use native evidence and equal total output budgets', async () => {
  const host = fakeHost({ usage: options => ({ inputTokens: 100, outputTokens: 20, ...(options.system === CURATOR_SYSTEM ? {} : { cacheReadTokens: 0 }) }) });
  const budget = createCallBudget(10), observed = await nativeObservation(host, budget);
  assert.equal(observed.passed, true); assert.equal(observed.feedback.turn, 7);
  const original = JSON.stringify(host.adapters.snapshots);
  const old = await host.adapters.propose(learningRequest('legacy', host.adapters.snapshots.legacy, observed), { budget });
  const next = await host.adapters.propose(learningRequest('ace', host.adapters.snapshots.ace, observed), { budget });
  assert.equal(legacy.validateProject(old.candidate), true); assert.equal(ace.validateProject(next.candidate), true);
  assert.equal(old.candidate.skills.length, 1); assert.equal(next.candidate.skills.length, 1);
  assert.equal(old.candidate.skills[0].provenance.sessionId, observed.feedback.sessionId);
  assert.equal(next.candidate.skills[0].provenance.turn, observed.feedback.turn);
  assert.equal(next.candidate.watermarks[observed.feedback.sessionId], observed.feedback.endSeq);
  assert.deepEqual(next.candidate.skills[0].provenance.evidence.map(e => e.seq), observed.feedback.evidence.map(e => e.seq));
  assert.deepEqual(host.trace.reviews.map(o => o.system), [REFLECT_SYSTEM, REFLECTOR_SYSTEM, CURATOR_SYSTEM]);
  assert.deepEqual(host.trace.reviews.map(o => o.maxTokens), [3000, 1000, 2000]);
  for (const options of host.trace.reviews) {
    assert.equal(options.provider, 'provider'); assert.equal(options.model, 'model'); assert.equal(options.tools, undefined);
    assert.equal(textOf(options).includes('requiredChecks'), false); assert.equal(textOf(options).includes(ROOT), false);
    assert.equal(Object.hasOwn(inputOf(options), 'project'), false);
    assert.deepEqual(inputOf(options).trustedEnvelope.confirmationSeqs, observed.feedback.confirmationSeqs);
  }
  assert.equal(old.usage.provider.reportedCalls, 1); assert.equal(old.usage.provider.inputTokens, 100); assert.equal(old.usage.provider.cacheReadTokens, 0);
  assert.equal(next.usage.provider.reportedCalls, 2); assert.equal(next.usage.provider.inputTokens, 200); assert.equal(next.usage.provider.cacheReadTokens, null);
  assert.ok(next.usage.estimates.every(e => e.unit === 'characters'));
  assert.deepEqual(budget.snapshot().byRole, { generator: 1, reflector: 2, curator: 1, evaluator: 0 });
  assert.equal(host.trace.caseSpecs[0].meta.cwd, ROOT);
  assert.equal(JSON.stringify(host.adapters.snapshots), original);
  assert.equal(host.trace.storageTouches, 0);
});

function multiSkillProject() {
  let project = { ...legacy.newProject(ROOT), mode: 'auto' };
  for (const [i, name] of ['learned-zeta', 'learned-alpha'].entries()) project = legacy.stage(project,
    { lessons: [], proposal: { name, description: 'Remove duplicates retaining order.', trigger: 'When duplicate values require stable order.', steps: ['Read the allowed fixture.', 'Check the repair.'], pitfalls: [], checks: [], reason: 'Native result.', evidenceSeqs: [1], baseRevision: 0 } },
    { runId: `seed-${i}`, sessionId: 'seed-session', turn: i, now: NOW, evidence: [{ seq: 1, type: 'tool/result', text: 'Native checker result', verified: true }], confirmed: true }).project;
  project = legacy.stage(project, { lessons: [], proposal: { name: 'learned-pending', description: 'Remove duplicates order fixture preserving first occurrence.', trigger: 'Remove duplicates retaining first occurrence order.', steps: ['Read.', 'Check.'], pitfalls: [], checks: [], reason: 'Unverified.', evidenceSeqs: [1], baseRevision: 0 } },
    { runId: 'seed-pending', sessionId: 'seed-session', turn: 3, now: NOW, evidence: [{ seq: 1, type: 'tool/result', text: 'Not proof', verified: false }], confirmed: false }).project;
  return project;
}
test('both arms load exactly one active lexical match with deterministic ties and no oracle selection', async () => {
  const host = fakeHost(), old = multiSkillProject(), next = ace.migrateProject(old), before = JSON.stringify([old, next]);
  for (const [arm, candidate] of [['legacy', old], ['ace', next]]) {
    const result = await host.adapters.runCase({ arm, candidate, case: adaptation, phase: 'holdout', scope: 'benchmark-isolated', budget: createCallBudget(4) });
    assert.equal(result.passed, true); assert.equal(result.feedback.candidateLoaded, true);
  }
  assert.deepEqual(host.trace.registrations.map(s => s.name), ['learned-alpha', 'learned-alpha']);
  const unrelated = { ...adaptation, id: 'learned-alpha', family: 'duplicates', input: { ...adaptation.input, task: 'Translate poetry.' }, expected: { ...adaptation.expected, oracleSkill: 'learned-alpha' } };
  for (const [arm, candidate] of [['legacy', old], ['ace', next]]) {
    const result = await host.adapters.runCase({ arm, candidate, case: unrelated, phase: 'holdout', budget: createCallBudget(4) });
    assert.equal(result.feedback.candidateLoaded, false);
  }
  assert.equal(host.trace.registrations.length, 2);
  assert.equal(JSON.stringify([old, next]), before);
  await assert.rejects(host.adapters.runCase({ arm: 'ace', candidate: { ...next, root: '/foreign' }, case: adaptation }), /snapshot/);
  await assert.rejects(host.adapters.runCase({ arm: 'no-memory', candidate: old, case: adaptation }), /No-memory/);
});

test('missing or weak feedback never fabricates successful native provenance', async () => {
  const host = fakeHost(), real = await nativeObservation(host);
  for (const arm of ['legacy', 'ace']) {
    const absent = learningRequest(arm, host.adapters.snapshots[arm], { passed: true, feedback: null });
    const weak = await host.adapters.propose(absent, { budget: createCallBudget(3) });
    assert.equal(weak.candidate, null);
    assert.equal(inputOf(host.trace.reviews.at(-1)).trustedEnvelope.confirmation, false);
    const failedProof = structuredClone(real); failedProof.feedback.confirmationSeqs = []; failedProof.feedback.evidence.forEach(e => { e.verified = false; });
    const pending = await host.adapters.propose(learningRequest(arm, host.adapters.snapshots[arm], failedProof), { budget: createCallBudget(3) });
    assert.equal(pending.candidate.skills.length, 0);
    assert.equal(pending.candidate.proposals[0].confirmed, false);
  }
  for (const change of [{ sessionId: undefined }, { endSeq: 0 }, { turn: undefined }, { scope: '/foreign' }, { phase: 'holdout' }, { confirmationSeqs: [999] }]) {
    const observed = { ...real, feedback: { ...real.feedback, ...change } };
    await assert.rejects(host.adapters.propose(learningRequest('ace', host.adapters.snapshots.ace, observed), { budget: createCallBudget(3) }), /metadata|scope|references/);
  }
});

test('partial native-anchor citations remain unconfirmed in both faithful baseline and ACE', async () => {
  const host = fakeHost({ reply: options => {
    const output = roleDraft(options), input = inputOf(options), first = (input.observations ?? input.workEvidence)[0].seq;
    if (output.proposal) output.proposal.evidenceSeqs = [first];
    if (output.insights) output.insights.forEach(insight => { insight.evidenceSeqs = [first]; });
    return output;
  } });
  const observed = await nativeObservation(host);
  assert.notEqual(observed.feedback.evidence[0].seq, observed.feedback.confirmationSeqs[0]);
  for (const arm of ['legacy', 'ace']) {
    const output = await host.adapters.propose(learningRequest(arm, host.adapters.snapshots[arm], observed), { budget: createCallBudget(3) });
    assert.equal(output.candidate.skills.length, 0);
    assert.equal(output.candidate.proposals[0].confirmed, false);
    assert.equal(output.candidate.proposals[0].status, 'pending');
  }
});

test('updates receive the complete actual base snapshot in each preserved role pipeline', async () => {
  const old = multiSkillProject(), next = ace.migrateProject(old);
  let sawLegacy = false, sawAce = false;
  const host = fakeHost({ reply: options => {
    const input = inputOf(options), refs = (input.observations ?? input.workEvidence).map(e => e.seq);
    if (options.system === REFLECT_SYSTEM) {
      const base = input.managedSkills.find(s => s.name === 'learned-alpha');
      assert.deepEqual(base.steps, old.skills.find(s => s.name === base.name).steps);
      assert.equal(base.revision, 1); sawLegacy = true;
      return { lessons: [], proposal: { name: base.name, description: base.description, trigger: base.trigger, steps: [...base.steps, 'Retain stable order during repair.'], pitfalls: base.pitfalls, checks: base.checks, baseRevision: base.revision, reason: 'Additional checked constraint.', evidenceSeqs: refs } };
    }
    if (options.system === REFLECTOR_SYSTEM) return { lessons: [], insights: [{ targetName: 'learned-alpha', trigger: 'When repairing duplicates', lesson: 'Retain stable order.', evidenceSeqs: refs }], judgments: [] };
    const base = next.skills.find(s => s.name === 'learned-alpha');
    assert.equal(input.target.baseHash, ace.snapshotHash(base));
    assert.deepEqual(input.target.document.entries.map(({ entryHash, ...entry }) => entry), base.entries); sawAce = true;
    return { proposal: { name: base.name, baseRevision: base.revision, baseHash: input.target.baseHash, reason: 'Additional checked constraint.', evidenceSeqs: refs, operations: [{ op: 'insert', section: 'step', text: 'Retain stable order during repair.', afterId: null }] } };
  } });
  const observed = await nativeObservation(host);
  const legacyUpdate = await host.adapters.propose(learningRequest('legacy', old, observed), { budget: createCallBudget(3) });
  const aceUpdate = await host.adapters.propose(learningRequest('ace', next, observed), { budget: createCallBudget(3) });
  assert.equal(sawLegacy, true); assert.equal(sawAce, true);
  assert.equal(legacyUpdate.candidate.skills.find(s => s.name === 'learned-alpha').revision, 2);
  assert.equal(aceUpdate.candidate.skills.find(s => s.name === 'learned-alpha').revision, 2);
  assert.equal(old.skills.find(s => s.name === 'learned-alpha').revision, 1);
});

test('normalized no-usage ACE result is converted to valid raw wrapper usage, never reportedCalls zero', async () => {
  const host = fakeHost({ reply: () => ({ lessons: [], insights: [], judgments: [] }), usage: () => null });
  const observed = await nativeObservation(host), budget = createCallBudget(2);
  const output = await createCandidateProposer({ propose: host.adapters.propose }).propose(learningRequest('ace', host.adapters.snapshots.ace, observed), { budget });
  assert.equal(output.candidate, null); assert.equal(output.usage.provider.reportedCalls, 0);
  assert.equal(output.usage.provider.cacheReadTokens, null); assert.ok(output.usage.estimates.length > 0);
  assert.equal(budget.snapshot().used, 1);
});

test('hard shared reservation, aborted deadlines and malformed JSON never dispatch repairs or mutate memory', async () => {
  const host = fakeHost(), observed = await nativeObservation(host), before = JSON.stringify(host.adapters.snapshots);
  for (const arm of ['legacy', 'ace']) {
    const count = host.trace.reviews.length, budget = createCallBudget(0);
    await assert.rejects(host.adapters.propose(learningRequest(arm, host.adapters.snapshots[arm], observed), { budget }), /logical-call-budget/);
    assert.equal(host.trace.reviews.length, count); assert.equal(budget.snapshot().denied, 1);
    const signal = AbortSignal.abort(Error('already-cancelled'));
    await assert.rejects(host.adapters.propose(learningRequest(arm, host.adapters.snapshots[arm], observed), { budget: createCallBudget(3), signal }), /already-cancelled/);
  }
  const malformed = fakeHost({ reply: () => '```json\n{}\n```' });
  for (const arm of ['legacy', 'ace']) {
    const count = malformed.trace.reviews.length, budget = createCallBudget(3);
    await assert.rejects(malformed.adapters.propose(learningRequest(arm, malformed.adapters.snapshots[arm], observed), { budget }), SyntaxError);
    assert.equal(malformed.trace.reviews.length, count + 1); assert.equal(budget.snapshot().used, 1);
  }
  const stalled = fakeHost({ streamOverride: options => (async function* () {
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true }); });
  })() });
  const bounded = createComparisonAdapters(stalled.ctx, { ...stalled.options, config: { timeoutMs: 5 } });
  const budget = createCallBudget(3);
  await assert.rejects(bounded.propose(learningRequest('legacy', bounded.snapshots.legacy, observed), { budget }), { name: 'TimeoutError' });
  assert.equal(budget.snapshot().used, 1);
  assert.equal(JSON.stringify(host.adapters.snapshots), before);
});

test('adapters plug the three-arm runner with exact native/review dispatch counts and no production writes', async () => {
  const host = fakeHost();
  const result = await runComparison({ caseSet: { id: 'adapter-native-v1', cases: [adaptation, holdout] }, ...host.adapters, maxLogicalCalls: 12, timeoutMs: 3000 });
  assert.equal(result.status, 'completed'); assert.equal(result.complete, true);
  assert.equal(result.logicalCalls.used, 9);
  assert.deepEqual(result.logicalCalls.byRole, { generator: 6, reflector: 2, curator: 1, evaluator: 0 });
  assert.equal(result.arms.legacy.proposals, 1); assert.equal(result.arms.ace.proposals, 1);
  assert.equal(result.arms['no-memory'].proposals, 0);
  assert.equal(result.arms.legacy.usage.provider.reportedCalls, 3); assert.equal(result.arms.ace.usage.provider.reportedCalls, 4);
  assert.equal(host.trace.reviews.length, 3); assert.equal(host.trace.disposed, 6);
  assert.equal(host.trace.storageTouches, 0);
  const exhausted = fakeHost();
  const limited = await runComparison({ caseSet: { id: 'adapter-native-budget', cases: [adaptation, holdout] }, ...exhausted.adapters, maxLogicalCalls: 5, timeoutMs: 3000 });
  assert.equal(limited.status, 'budget-exhausted'); assert.equal(limited.complete, false);
  assert.equal(limited.results.some(r => r.phase === 'holdout'), false);
});
