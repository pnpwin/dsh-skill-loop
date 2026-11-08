import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { installRuntime, canonicalRoot } from '../src/runtime.js';
import { initialProjection, foldProjection } from '../src/projection.js';

const root = canonicalRoot(process.cwd());
const key = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const now = '2026-11-09T00:00:00.000Z';
const schema = predicate => ({ parse(v) { if (predicate && !predicate(v)) throw Error('invalid'); return v; } });
const z = { custom: schema, object: () => schema(), string: () => schema(), number: () => schema(), array: () => schema() };
const baseConfig = { enabled: true, requirePairedEvaluation: false, initialMode: 'review', maxInputChars: 16000, maxOutputTokens: 3000, timeoutMs: 5000, cooldownMs: 0, dailyReviews: 12, provider: '', model: '', skillDelivery: 'provider', learnLite: true, learnStandard: true, learnHeavy: false };

function reflectorResponse(o) {
  const data = JSON.parse(o.messages[0].content[0].text);
  const refs = [data.observations.at(-1).seq];
  return { lessons: [{ kind: 'success', trigger: 'Проверенная работа', lesson: 'Фиксируй подтверждённый результат.', evidenceSeqs: refs }], insights: [{ targetName: null, trigger: 'Проверенная работа', lesson: 'Сохранять подтверждённую последовательность.', evidenceSeqs: refs }], judgments: [] };
}
async function fixture(options = {}) {
  const data = options.data ?? { projects: new Map(), controls: new Map() };
  const definitions = { tools: new Map(), commands: new Map(), providers: [], skills: [], sections: [], contexts: [] };
  const events = new Map(), effects = []; let closed = false, calls = 0;
  const states = new Map();
  const session = { id: 'session-v030', seq: 0, header: { id: 'session-v030', cwd: root } };
  const agent = { id: session.id, session, cwd: root, model: { current: () => ({ provider: 'fake', model: 'fake-model' }) } };
  const ctx = {
    logger: { warn(...a) { (options.warnings ??= []).push(a); } },
    storageDomain: { async open(spec) { const tables = spec.name === 'local_skill_loop' ? data : (data.backups ??= { snapshots: new Map() }); return { table(n) { return { get: k => tables[n].get(k), entries: () => tables[n].entries(), async put(k, v) { spec.tables[n].valueSchema.parse(v); tables[n].set(k, structuredClone(v)); } }; }, async close() { closed = true; } }; } },
    sessionProjections: { async register(def) { return { stateOf(s) { return states.get(s.id) ?? def.init(s.header, 0); }, dispose: async () => {} }; } },
    agents: { list: () => [agent], get: id => id === agent.id ? agent : undefined, turnBoundaryOf: () => ({ lastTurn: 1 }) },
    workingDirectory: { get: () => agent.cwd },
    skills: { registerProvider(make) { const p = make({ signal: new AbortController().signal, invalidate() {} }); definitions.providers.push(p); return () => {}; }, register(s) { definitions.skills.push(s); return () => {}; } },
    systemPrompt: { section(s) { definitions.sections.push(s); return () => {}; }, context(c) { definitions.contexts.push(c); return () => {}; } },
    tools: { register(t) { definitions.tools.set(t.name, t); return () => {}; } },
    commands: { register(c) { definitions.commands.set(c.name, c); return () => {}; } },
    llm: { stream(o) { calls++; return (async function* () { yield { type: 'text-delta', text: JSON.stringify(options.curatorResponse && o.purpose === 'dsh-skillgrowth-curator' ? options.curatorResponse(o) : reflectorResponse(o)) }; yield { type: 'finish', reason: { kind: 'stop' } }; })(); } },
    on(name, fn) { const l = events.get(name) ?? []; l.push(fn); events.set(name, l); return () => {}; },
    effect(fn) { const d = fn(); effects.push(typeof d === 'function' ? d : () => {}); return d; },
  };
  const rt = await installRuntime(ctx, { ...baseConfig, ...options.config }, { z });
  function emit(type, value, notify = false) { const event = { seq: session.seq++, type, data: value }; states.set(session.id, foldProjection(states.get(session.id) ?? initialProjection(session.header, 0), event)); if (notify) for (const l of events.get('session/event') ?? []) l(session, event); return event.seq; }
  function command(rawInput, signal = new AbortController().signal) { return definitions.commands.get('dsh-skillgrowth').handler({ agent, rawInput, commandId: 'command-1', signal }); }
  return { rt, ctx, agent, session, emit, command, definitions, data, get calls() { return calls; }, async close() { for (const d of effects.reverse()) await d(); } };
}
function work(f, { human = 'Теперь работает', turn = 1, verified = true } = {}) {
  f.emit('turn/start', { turn }, true);
  f.emit('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: human }] }, true);
  f.emit('assistant/message', { turn, step: 1, message: { content: [{ type: 'text', text: 'Готово.' }] } }, true);
  f.emit('tool/call', { turn, step: 1, callId: 'call-' + turn, name: 'bash', arguments: JSON.stringify({ command: 'node --test tests/core.test.mjs' }) }, true);
  f.emit('tool/result', { turn, step: 1, ...(verified ? { meta: { exitCode: 0 } } : {}), message: { toolCallId: 'call-' + turn, isError: false, content: [{ type: 'text', text: verified ? '# tests 2\n# pass 2\n# fail 0' : 'прочитал файл' }] } }, true);
  f.emit('turn/end', { turn, reason: { kind: 'completed' } }, true);
}

test('lite-only mode runs Reflector, skips Curator: one call, lessons without proposal', async () => {
  const f = await fixture({ config: { learnStandard: false } });
  work(f); await f.rt.drain();
  assert.equal(f.calls, 1);
  const p = f.data.projects.get(key(root));
  assert.equal(p.proposals.length, 0);
  assert.ok(p.lessons.some(l => l.lesson.includes('Фиксируй подтверждённый результат')));
  const status = JSON.parse((await f.command('status')).text);
  assert.equal(status.modes.lite, true); assert.equal(status.modes.standard, false);
  await f.close();
});
test('default lite+standard escalates on insights and stages a proposal', async () => {
  const f = await fixture({ curatorResponse: o => { const d = JSON.parse(o.messages[0].content[0].text); const refs = [d.workEvidence.at(-1).seq]; return { proposal: { name: 'learned-verify-fix', baseRevision: 0, baseHash: null, reason: 'Проверено.', evidenceSeqs: refs, operations: [{ op: 'create', description: 'Проверять исправления', trigger: 'После исправления', entries: [{ section: 'step', text: 'Повторить тест.' }, { section: 'step', text: 'Зафиксировать результат.' }, { section: 'check', text: 'Тест пройден.' }] }] } }; } });
  work(f); await f.rt.drain();
  assert.equal(f.calls, 2);
  const p = f.data.projects.get(key(root));
  assert.equal(p.proposals.length, 1);
  assert.equal(p.proposals[0].status, 'pending');
  await f.close();
});
test('escalation=on-confirmed keeps unconfirmed insights lite-only', async () => {
  const f = await fixture({ config: { escalation: 'on-confirmed' } });
  work(f, { human: 'Всё ещё не работает', verified: false }); await f.rt.drain();
  assert.equal(f.calls, 1);
  assert.equal(f.data.projects.get(key(root)).proposals.length, 0);
  await f.close();
});
test('repeated tool error then recovery stages an antipattern lesson and errorPattern ledger', async () => {
  const f = await fixture({ config: { learnStandard: false } });
  f.emit('turn/start', { turn: 1 }, true);
  const err = 'ENOENT: no such file or directory, open \'/x/y/file-123.txt\'';
  for (const [i, ok] of [[1, false], [2, false], [3, true]]) {
    f.emit('tool/call', { turn: 1, step: i, callId: 'c' + i, name: 'read', arguments: '{}' }, true);
    f.emit('tool/result', { turn: 1, step: i, message: { toolCallId: 'c' + i, isError: !ok, content: [{ type: 'text', text: ok ? 'file contents' : err }] } }, true);
  }
  f.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, true);
  await f.rt.drain();
  const p = f.data.projects.get(key(root));
  assert.equal(f.calls, 0); // deterministic path, no LLM
  assert.ok(p.errorPatterns.length >= 1, 'errorPatterns recorded');
  assert.ok(p.lessons.some(l => l.kind === 'antipattern' && l.lesson.includes('read')), 'antipattern lesson staged');
  await f.close();
});
test('lesson command stages a human note without LLM or publication', async () => {
  const f = await fixture({ config: { learnStandard: false } });
  const r = await f.command('lesson всегда запускай typecheck перед сборкой');
  assert.equal(r.kind, 'success');
  assert.equal(f.calls, 0);
  const p = f.data.projects.get(key(root));
  assert.ok(p.lessons.some(l => l.lesson.includes('typecheck')));
  assert.equal(p.proposals.length, 0);
  await f.close();
});
test('lite daily quota holds further reflector calls', async () => {
  const f = await fixture({ config: { learnStandard: false, liteMaxCallsPerDay: 1 } });
  work(f, { turn: 1 }); await f.rt.drain();
  assert.equal(f.calls, 1);
  const seq = f.session.seq;
  f.emit('turn/start', { turn: 2 }, true);
  f.emit('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Теперь работает' }] }, true);
  f.emit('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'ok' }] } }, true);
  f.emit('tool/result', { turn: 2, step: 1, message: { toolCallId: 'x', isError: false, content: [{ type: 'text', text: 'fine' }] } }, true);
  f.emit('turn/end', { turn: 2, reason: { kind: 'completed' } }, true);
  await f.rt.drain();
  assert.equal(f.calls, 1);
  const c = f.data.controls.get(key(root));
  assert.equal(c.liteCalls, 1);
  await f.close();
});
