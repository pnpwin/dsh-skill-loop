import test from 'node:test';
import assert from 'node:assert/strict';
import { initialProjection, foldProjection, selectBatch } from '../src/projection.js';
import { newProject, stage } from '../src/core.js';

const e = (seq, type, data) => ({ seq, type, data });
const user = (seq, content, extra = {}) => e(seq, 'user/message', { role: 'user', source: { kind: 'user' }, content, ...extra });
const start = (seq, turn = 1) => e(seq, 'turn/start', { turn });
const end = (seq, turn = 1) => e(seq, 'turn/end', { turn, reason: 'completed' });
const assistant = (seq, content, turn = 1) => e(seq, 'assistant/message', { turn, step: 1, message: { content, source: { kind: 'assistant' } } });
const call = (seq, command, name = 'functions.bash', turn = 1, callId = 'c1') => e(seq, 'tool/call', {
  turn, step: 1, callId, name, arguments: JSON.stringify(name.endsWith('terminal_send') ? { text: command } : { command }),
});
const result = (seq, content, extra = {}, turn = 1, toolCallId = 'c1') => e(seq, 'tool/result', {
  turn, step: 1, message: { content, isError: false, toolCallId }, ...extra,
});
const fold = (events, state = initialProjection({ id: 'session-1' })) => events.reduce(foldProjection, state);
const commandBatch = (command, output, extra = {}, name = 'functions.bash') => selectBatch(fold([
  start(0), call(1, command, name), result(2, output, extra), end(3),
]));

for (const text of ['It works!', 'Thanks, that works.', 'All tests passed.', 'Отлично, всё работает!', 'Теперь работает', 'Тесты прошли.', 'Да, получилось!']) {
  test(`explicit short human success: ${text}`, () => {
    const batch = selectBatch(fold([user(0, text), start(1), end(2)]));
    assert.equal(batch.confirmed, true);
    assert.equal(batch.signal, 'success');
    assert.equal(batch.turn, 1);
    assert.equal(batch.lastSeq, 2);
    assert.deepEqual(Object.keys(batch).sort(), ['confirmationSeqs', 'confirmed', 'evidence', 'lastSeq', 'signal', 'text', 'turn']);
    assert.deepEqual(batch.confirmationSeqs, [0]);
  });
}

for (const text of ['"It works"', 'He said: "It works"', 'It works?', 'Does it work?', 'It does not work', 'Not fixed', 'Tests did not pass', 'Не работает', 'Тесты не прошли', '«Теперь работает»', 'Всё работает?', 'Нет, всё не работает', 'It works, but there is still an error.', 'Great!', 'Спасибо!']) {
  test(`not human confirmation: ${text}`, () => {
    const batch = selectBatch(fold([user(0, text), start(1), end(2)]));
    assert.notEqual(batch?.confirmed, true);
  });
}

test('corrections, antipatterns, intervention can stage without confirmation', () => {
  for (const [text, signal] of [['Неверно, исправь обработчик.', 'correction'], ['Please fix the wrong function', 'correction'], ['Не повторяй этот обход.', 'antipattern'], ['Never do that again.', 'antipattern'], ['Стоп, подожди.', 'intervention']]) {
    const batch = selectBatch(fold([user(0, text), start(1), end(2)]));
    assert.equal(batch.signal, signal);
    assert.equal(batch.confirmed, false);
  }
});

test('reasoning, system, developer, synthetic user and plugin outputs never trigger', () => {
  const state = fold([
    user(0, 'It works', { source: { kind: 'plugin' } }),
    user(1, 'Теперь работает', { synthetic: true }),
    user(2, '<system-reminder>It works</system-reminder>'),
    start(3),
    e(4, 'system/message', { content: 'It works' }),
    e(5, 'developer/message', { content: 'It works' }),
    e(6, 'assistant/reasoning', { turn: 1, content: 'It works' }),
    assistant(7, [{ type: 'reasoning', text: 'It works' }, { type: 'text', text: 'Visible answer' }]),
    e(8, 'tool/call', { turn: 1, callId: 'plugin', name: 'skill_loop_analyze', arguments: '{}' }),
    result(9, '[exit code: 0] It works', {}, 1, 'plugin'),
    end(10),
  ]);
  assert.equal(selectBatch(state), null);
  const all = JSON.stringify(state);
  assert.ok(!all.includes('reasoning'));
  assert.ok(!all.includes('skill_loop_analyze'));
  assert.ok(state.events.some(entry => entry.text === 'Visible answer'));
  assert.ok(!state.events.some(entry => entry.type === 'tool/result'));
});

for (const [command, name] of [['node --test tests/core.test.mjs', 'bash'], ['pnpm test', 'functions.bash'], ['npm run test:unit', 'functions.bash'], ['pnpm run typecheck', 'functions.terminal_send'], ['pnpm exec tsc --noEmit', 'terminal_send'], ['npx vitest run', 'bash']]) {
  test(`recognized verification with explicit zero: ${command}`, () => {
    const batch = commandBatch(command, 'Tests passed\n# fail 0\n[exit code: 0]', {}, name);
    assert.equal(batch.confirmed, true);
    assert.equal(batch.evidence[0].verified, true);
  });
}

test('explicit numeric exit metadata verifies; isError false alone does not', () => {
  assert.equal(commandBatch('node --test', 'All tests passed'), null);
  assert.equal(commandBatch('node --test', 'All tests passed', { meta: { code: 0 } }), null);
  assert.equal(commandBatch('node --test', 'All tests passed', { meta: { exitCode: 0 } }).confirmed, true);
  assert.equal(commandBatch('pnpm typecheck', '', { meta: { exit_code: 0 } }).confirmed, true);
});

for (const [output, extra] of [
  ['[exit code: 1]', {}],
  ['Tests failed\n[exit code: 0]', {}],
  ['Error: assertions were skipped\n[exit code: 0]', {}],
  ['[exit code: 0]', { error: { message: 'Failed' } }],
  ['[exit code: 0]', { message: { toolCallId: 'c1', content: '[exit code: 0]', isError: true } }],
  ['[exit code: 0]', { meta: { exitCode: 2 } }],
  ['[exit code: 0]\nProcess exited with code 1', {}],
]) {
  test(`failure cannot confirm: ${output} ${JSON.stringify(extra)}`, () => {
    assert.equal(commandBatch('node --test', output, extra), null);
  });
}

for (const command of ['echo tests passed', 'cat test.js', 'npm run build', 'node script.js', 'echo node --test', 'node --test; echo done', 'npm test && echo passed', 'node --test | true', 'npm test --help', 'npx vitest run --passWithNoTests']) {
  test(`generic/build/masked command cannot confirm: ${command}`, () => {
    assert.equal(commandBatch(command, '[exit code: 0]'), null);
  });
}

test('later correction or failed result invalidates an earlier success', () => {
  const base = [start(0), call(1, 'node --test'), result(2, '[exit code: 0]')];
  const corrected = selectBatch(fold([...base, user(3, 'Tests did not pass'), end(4)]));
  assert.equal(corrected.confirmed, false);
  assert.equal(corrected.signal, 'correction');
  const failed = selectBatch(fold([...base, call(3, 'node --test'), result(4, '[exit code: 1]'), end(5)]));
  assert.equal(failed.confirmed, false);
});

test('latest completed work window alone triggers; prior context does not retrigger', () => {
  let state = fold([start(0), assistant(1, 'Fixed the reducer'), call(2, 'node --test'), result(3, '[exit code: 0]'), end(4)]);
  assert.equal(selectBatch(state).confirmed, true);
  state = fold([user(5, 'Read the next file'), start(6, 2)], state);
  assert.equal(selectBatch(state), null);
  state = fold([assistant(7, 'Read it', 2), end(8, 2)], state);
  assert.equal(selectBatch(state), null);
  const forced = selectBatch(state, { force: true });
  assert.equal(forced.signal, 'intervention');
  assert.equal(forced.confirmed, false);
  assert.equal(forced.lastSeq, 8);
  assert.ok(forced.evidence.some(entry => entry.seq === 3 && entry.verified));
});

test('human success in next turn retains bounded previous work context', () => {
  const state = fold([start(0), assistant(1, 'Implemented stable sorting'), end(2), user(3, 'Теперь работает'), start(4, 2), end(5, 2)]);
  const batch = selectBatch(state);
  assert.equal(batch.confirmed, true);
  assert.ok(batch.evidence.some(entry => entry.seq === 1 && entry.text === 'Implemented stable sorting'));
  assert.equal(batch.turn, 2);
});

test('force does not fabricate evidence or confirmation', () => {
  assert.equal(selectBatch(initialProjection({}), { force: true }), null);
  assert.equal(selectBatch(fold([start(0), end(1)]), { force: true }), null);
  const state = fold([user(0, 'Inspect this function'), start(1), assistant(2, 'Read the function'), end(3)]);
  assert.equal(selectBatch(state), null);
  assert.equal(selectBatch(state, { force: true }).confirmed, false);
});

test('fork inherited cutoff excludes source refs, commands and confirmation', () => {
  const state = fold([
    user(0, 'It works'), start(1), call(2, 'node --test'), assistant(3, 'Inherited fix'), end(4),
    start(5, 2), result(6, '[exit code: 0]', {}, 2), assistant(7, 'Current answer', 2), end(8, 2),
  ], initialProjection({ sessionId: 'fork' }, 5));
  assert.equal(selectBatch(state), null);
  const forced = selectBatch(state, { force: true });
  assert.ok(forced.evidence.every(entry => entry.seq >= 5));
  assert.equal(forced.confirmed, false);
  assert.equal(state.sessionId, 'fork');
});

test('malformed arbitrary JSON events are ignored without throwing', () => {
  let state = initialProjection(null);
  const junk = [null, false, 5, 'bad', [], {}, { seq: -5 }, { seq: NaN }];
  for (const value of junk) assert.doesNotThrow(() => { state = foldProjection(state, value); });
  const badData = [null, false, 5, 'bad', [], {}, { message: null }, { message: { content: [null, 3, 'text', {}] } }, { arguments: '{bad' }];
  let seq = 0;
  for (const type of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/start', 'turn/end', 'garbage']) {
    for (const data of badData) assert.doesNotThrow(() => { state = foldProjection(state, e(seq++, type, data)); });
  }
  assert.doesNotThrow(() => selectBatch(state));
});

test('own properties only; prototype call ids cannot inject inherited commands', () => {
  let state = fold([start(0), result(1, '[exit code: 0]', {}, 1, 'toString'), end(2)]);
  assert.equal(selectBatch(state), null);
  state = fold([start(0), call(1, 'node --test', 'bash', 1, '__proto__'), result(2, '[exit code: 0]', {}, 1, '__proto__'), end(3)]);
  assert.equal(selectBatch(state).confirmed, true);
  assert.equal({}.recognized, undefined);
  assert.equal(foldProjection(initialProjection({}), Object.create({ seq: 0, type: 'user/message', data: { source: { kind: 'user' }, content: 'It works' } })).events.length, 0);
});

test('projection is immutable JSON with bounded sanitized evidence and commands', () => {
  const old = initialProjection({ id: 'bounded' });
  const snapshot = JSON.stringify(old);
  let state = fold([start(0)], old);
  for (let seq = 1; seq <= 90; seq++) state = foldProjection(state, assistant(seq, `api_key=supersecret${seq} ${'x'.repeat(3000)}`));
  for (let seq = 91; seq <= 120; seq++) state = foldProjection(state, call(seq, 'node --test', 'bash', 1, `c${seq}`));
  assert.equal(JSON.stringify(old), snapshot);
  assert.equal(state.events.length, 60);
  assert.equal(Object.keys(state.commands).length, 20);
  assert.ok(state.events.every(entry => entry.text.length <= 1000));
  assert.ok(!JSON.stringify(state).includes('supersecret'));
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
});

test('selection budget bounds text and evidence together; no arbitrary earlier refs', () => {
  let state = fold([start(0)]);
  for (let seq = 1; seq <= 30; seq++) state = foldProjection(state, assistant(seq, 'context '.repeat(200)));
  state = fold([user(31, 'Теперь работает'), end(32)], state);
  for (const maxInputChars of [0, 1, 30, 150, 1000, 16000, 30000]) {
    const batch = selectBatch(state, { maxInputChars });
    if (!batch) continue;
    assert.ok(batch.text.length <= Math.min(maxInputChars, 16000));
    assert.ok(batch.evidence.reduce((sum, entry) => sum + entry.text.length, 0) <= Math.min(maxInputChars, 16000));
    assert.ok(batch.evidence.some(entry => entry.seq === 31));
    assert.ok(batch.evidence.every(entry => state.events.some(source => source.seq === entry.seq)));
  }
});

test('plugin-source results, malformed roles, interrupted terminal writes are not evidence', () => {
  const state = fold([
    user(0, 'It works', { role: 'assistant' }), start(1), call(2, 'node --test'),
    result(3, '[exit code: 0]', { source: { kind: 'plugin' } }),
    e(4, 'tool/call', { turn: 1, callId: 'partial', name: 'terminal_send', arguments: JSON.stringify({ text: 'node --test', submit: false }) }),
    result(5, '[exit code: 0]', {}, 1, 'partial'), end(6),
  ]);
  assert.equal(selectBatch(state), null);
  assert.equal(state.events.length, 0);
});

test('tiny evidence budgets cannot truncate human confirmation and retain confirmed=true', () => {
  const batch = selectBatch(fold([user(0, 'Теперь работает'), start(1), end(2)]), { maxInputChars: 21 });
  assert.equal(batch.confirmed, false);
});

test('selected evidence is directly accepted by core staging context', () => {
  const batch = selectBatch(fold([user(0, 'Теперь работает'), start(1), end(2)]));
  assert.ok(batch.evidence.every(entry => Number.isInteger(entry.turn)));
  const output = stage(newProject('/test'), {
    lessons: [{ kind: 'success', trigger: 'Sorting work', lesson: 'Use stable ordering.', evidenceSeqs: [0] }],
    proposal: null,
  }, { runId: 'projection-integration', sessionId: 'session-1', turn: batch.turn,
    evidence: batch.evidence, confirmed: batch.confirmed, now: '2026-11-07T00:00:00Z' });
  assert.equal(output.status, 'lessons-only');
});

test('duplicate/out-of-order events and mismatched turns do not establish success', () => {
  let state = fold([start(0), call(1, 'node --test')]);
  state = foldProjection(state, result(1, '[exit code: 0]'));
  state = foldProjection(state, result(2, '[exit code: 0]', {}, 2));
  state = foldProjection(state, end(3, 2));
  assert.equal(selectBatch(state), null);
  state = foldProjection(state, end(4));
  assert.equal(selectBatch(state), null);
});
