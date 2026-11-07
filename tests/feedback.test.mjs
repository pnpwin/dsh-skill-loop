import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initialFeedback, foldFeedback, selectExposures, episodeId, feedbackForBatch } from '../src/feedback.js';

const sha = text => createHash('sha256').update(text).digest('hex');
const body = '# Reducer\n\n1. Read the current state.\n2. Preserve untouched entries.\n<!-- ACE-MANIFEST {"schemaVersion":2,"name":"learned-reducer","revision":2,"snapshotHash":"' + 'a'.repeat(64) + '"} -->';
const known = [{ name: 'learned-reducer', revision: 2, content: body }];
const xml = value => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&apos;');
const wrap = (content = body, skillName = 'learned-reducer', extra = '') => `<skill_content name="${skillName}"${extra}>\n<skill_resources>Base directory: /workspace/skills</skill_resources>\n<skill_instructions>\n${content}\n</skill_instructions>\n</skill_content>`;
const escapedWrap = (content = body) => wrap(xml(content));
const e = (seq, type, data) => ({ seq, type, data });
const start = (seq, turn = 1) => e(seq, 'turn/start', { turn });
const call = (seq, skillName = 'learned-reducer', callId = 'skill-1', toolName = 'skill', turn = 1) => e(seq, 'tool/call', {
  turn, step: 1, callId, name: toolName, arguments: JSON.stringify({ name: skillName }),
});
const result = (seq, text = wrap(), callId = 'skill-1', turn = 1, extra = {}) => e(seq, 'tool/result', {
  turn, step: 1, message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    content: [{ type: 'text', text }], isError: false }, ...extra,
});
const invoke = (seq, text = body, extra = {}) => e(seq, 'user/message', {
  role: 'user', source: { kind: 'skill-invocation', name: 'learned-reducer', form: 'instructions' }, content: text, ...extra,
});
const fold = (events, state = initialFeedback({ id: 'session-1' })) => events.reduce(foldFeedback, state);
const selected = (events, opts = {}) => selectExposures(fold(events), { knownSkills: known, ...opts });
const hostBatch = (extra = {}) => ({ turn: 1, lastSeq: 10, signal: 'success', confirmed: true,
  confirmationSeqs: [8, 9], evidence: [
    { seq: 8, type: 'job/settled', text: 'completed: exit code: 0', verified: true, turn: 1 },
    { seq: 9, type: 'tool/result', text: 'Tests passed', verified: true, turn: 1 },
  ], ...extra });
const feedback = (batch, extra = {}) => feedbackForBatch(batch, { root: '/workspace', sessionId: 'session-1', ...extra });

test('native skill wrapper matches exact caller-provided rendered snapshot', () => {
  const [record] = selected([start(0), call(1), result(2)]);
  assert.equal(record.match, 'matched');
  assert.equal(record.revision, 2);
  assert.equal(record.loaded, true);
  assert.equal(record.bodyHash, sha(body));
  assert.equal(record.sessionId, 'session-1');
  assert.deepEqual(record.sourceSeqs, [1, 2]);
  assert.equal(record.callId, 'skill-1');
  assert.equal(record.via, 'tool');
  assert.ok(!('used' in record));
  assert.ok(!('helpful' in record));
});

test('functions.skill and XML entity decoding preserve exact body identity', () => {
  const content = 'Use x < y && y > z; "quotes" and \'single\' and literal &lt; entities.';
  const [record] = selected([call(0, 'learned-reducer', 'skill-1', 'functions.skill'), result(1, wrap(content))], {
    knownSkills: [{ name: 'learned-reducer', revision: 3, content }],
  });
  assert.equal(record.match, 'matched');
  assert.equal(record.revision, 3);
  const doubleDecoded = selected([call(0), result(1, wrap('&lt;'))], {
    knownSkills: [{ name: 'learned-reducer', revision: 1, content: '<' }],
  });
  assert.equal(doubleDecoded[0].match, 'unknown');
});

test('native framing removes one paired newline, preserving intrinsic body whitespace and entities', () => {
  const content = '\nKeep literal &lt;example&gt; and raw <example>.\n';
  const [record] = selected([call(0), result(1, wrap(content))], {
    knownSkills: [{ ...known[0], content }],
  });
  assert.equal(record.match, 'matched');
  assert.equal(record.bodyEncoding, 'raw');
  assert.equal(record.bodyHash, sha(content));
  assert.equal(selected([call(0), result(1, wrap(content))], {
    knownSkills: [{ ...known[0], content: content.trim() }],
  })[0].match, 'unknown');
});

test('escaped compact renderer fallback is exact and labeled, never preferred to raw body', () => {
  const [record] = selected([call(0), result(1, escapedWrap())]);
  assert.equal(record.match, 'matched');
  assert.equal(record.bodyEncoding, 'xml-escaped');
  assert.equal(record.bodyHash, sha(body));
  const [raw] = selected([call(0), result(1, escapedWrap())], {
    knownSkills: [{ ...known[0], content: xml(body) }, ...known],
  });
  assert.equal(raw.bodyEncoding, 'raw');
  assert.equal(raw.bodyHash, sha(xml(body)));
});

test('direct human skill invocation instructions are exposure, not success or use', () => {
  for (const content of [body, wrap()]) {
    const [record] = selected([invoke(0, content)]);
    assert.equal(record.match, 'matched');
    assert.equal(record.callId, null);
    assert.equal(record.via, 'invocation');
    const output = feedback(hostBatch({ confirmed: false, confirmationSeqs: [], signal: 'intervention' }), { exposures: [record] });
    assert.equal(output.outcome, 'unverified');
  }
});

test('catalog, synthetic instructions, ordinary user mentions and assistant claims are not exposure', () => {
  const state = fold([
    e(0, 'system/message', { message: { content: wrap() } }),
    e(1, 'developer/message', { message: { content: wrap() } }),
    e(2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'I used learned-reducer and it helped.' }] } }),
    e(3, 'user/message', { role: 'user', source: { kind: 'user' }, content: wrap() }),
    invoke(4, body, { synthetic: true }),
    invoke(5, body, { source: { kind: 'skill-invocation', name: 'learned-reducer', form: 'catalog' } }),
    e(6, 'system-prompt/skills', { content: body }),
  ]);
  assert.deepEqual(selectExposures(state, { knownSkills: known }), []);
});

test('provider shadowing with same name but different body is unknown', () => {
  const [record] = selected([call(0), result(1, wrap('Foreign provider content'))]);
  assert.equal(record.name, 'learned-reducer');
  assert.equal(record.loaded, true);
  assert.equal(record.match, 'unknown');
  assert.equal(record.revision, null);
});

test('explicit wrong provider fails closed even if body is identical', () => {
  const [record] = selected([call(0), result(1, wrap(body, 'learned-reducer', ' provider="foreign"'))], {
    knownSkills: [{ ...known[0], provider: 'local-skill-loop' }],
  });
  assert.equal(record.provider, 'foreign');
  assert.equal(record.match, 'unknown');
  assert.equal(selected([call(0), result(1, wrap(body, 'learned-reducer', ' provider="local-skill-loop"'))], {
    knownSkills: [{ ...known[0], provider: 'local-skill-loop' }],
  })[0].match, 'matched');
});

for (const [label, text] of [
  ['truncated wrapper', wrap().slice(0, -20)],
  ['partial body', wrap(body.slice(0, 100))],
  ['only manifest', wrap(body.slice(body.indexOf('<!--')))],
  ['wrong name', wrap(body, 'learned-other')],
  ['no resources', `<skill_content name="learned-reducer"><skill_instructions>${xml(body)}</skill_instructions></skill_content>`],
  ['duplicate name', wrap().replace('name="learned-reducer"', 'name="learned-reducer" name="learned-reducer"')],
  ['malformed entity', wrap().replace('Read', '&broken; Read')],
  ['trailing output', wrap() + '\nextra output'],
]) {
  test(`${label} never matches an owned revision`, () => {
    const [record] = selected([call(0), result(1, text)]);
    assert.equal(record.match, 'unknown');
    assert.equal(record.revision, null);
  });
}

test('historical snapshot identity, not current name or provider lookup', () => {
  const state = fold([call(0), result(1)]);
  const changedCurrent = [{ ...known[0], revision: 3, content: body.replace('revision":2', 'revision":3') }];
  assert.equal(selectExposures(state, { knownSkills: changedCurrent })[0].match, 'unknown');
  assert.equal(selectExposures(state, { knownSkills: [...changedCurrent, ...known] })[0].revision, 2);
  assert.equal(selectExposures(state, { knownSkills: [{ ...known[0], revision: 1 }, ...known] })[0].match, 'unknown');
  assert.equal(selectExposures(state, { knownSkills: [{ ...known[0], provider: 'one' }, { ...known[0], provider: 'two' }] })[0].match, 'unknown');
});

test('caller body hash can bind historical snapshot, but contradictory hash cannot', () => {
  const state = fold([call(0), result(1)]);
  assert.equal(selectExposures(state, { knownSkills: [{ name: 'learned-reducer', revision: 2, bodyHash: sha(body) }] })[0].match, 'matched');
  assert.equal(selectExposures(state, { knownSkills: [{ ...known[0], bodyHash: 'b'.repeat(64) }] })[0].match, 'unknown');
  assert.equal(selectExposures(state, { knownSkills: [{ ...known[0], content: undefined, bodyHash: 'bad' }] })[0].match, 'unknown');
});

test('tool call must be native, paired, same-turn and not failed', () => {
  const states = [
    fold([result(0)]),
    fold([call(0, 'learned-reducer', 'skill-1', 'plugin.skill'), result(1)]),
    fold([call(0), result(1, wrap(), 'other')]),
    fold([call(0), result(1, wrap(), 'skill-1', 2)]),
    fold([call(0), result(1, wrap(), 'skill-1', 1, { error: { code: 'failed' } })]),
    fold([call(0), result(1, wrap(), 'skill-1', 1, { message: { toolCallId: 'skill-1', isError: true, content: wrap() } })]),
    fold([call(0), result(1, wrap(), 'skill-1', 1, { source: { kind: 'plugin' } })]),
    fold([call(0), result(1, wrap(), 'skill-1', 1, { message: { toolCallId: 'skill-1', source: { kind: 'tool', callId: 'different' }, content: wrap() } })]),
  ];
  for (const state of states) assert.deepEqual(selectExposures(state, { knownSkills: known }), []);
});

test('floor excludes both pre-floor call and pre-floor invocation, endSeq inclusive', () => {
  const state = fold([call(0), result(1), invoke(2), call(3, 'learned-reducer', 'new'), result(4, wrap(), 'new')]);
  assert.deepEqual(selectExposures(state, { knownSkills: known, floor: 1 }).map(record => record.seq), [2, 4]);
  assert.deepEqual(selectExposures(state, { knownSkills: known, floor: 2, endSeq: 2 }).map(record => record.seq), [2]);
  assert.deepEqual(selectExposures(state, { knownSkills: known, endSeq: 0 }), []);
});

test('fork inheritance cannot transfer loaded skill credit across cutoff', () => {
  const state = fold([call(0), result(1), invoke(2), result(3), invoke(4)], initialFeedback({ id: 'fork' }, 3));
  const exposures = selectExposures(state, { knownSkills: known });
  assert.deepEqual(exposures.map(record => record.seq), [4]);
  assert.equal(exposures[0].sessionId, 'fork');
  assert.ok(exposures.every(record => record.sourceSeqs.every(seq => seq >= 3)));
});

test('observation/call/exposure counts stay bounded; no mutation; JSON roundtrip', () => {
  const initial = initialFeedback({ id: 'bounded' });
  const before = JSON.stringify(initial);
  let state = initial;
  for (let seq = 0; seq < 80; seq++) state = foldFeedback(state, invoke(seq));
  for (let seq = 80; seq < 120; seq++) state = foldFeedback(state, call(seq, 'learned-reducer', `call-${seq}`));
  assert.equal(state.observations.length, 60);
  assert.equal(state.exposures.length, 50);
  assert.equal(Object.keys(state.pendingCalls).length, 20);
  assert.equal(JSON.stringify(initial), before);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
  assert.equal(selectExposures(state, { knownSkills: known }).length, 50);
});

test('redaction happens before truncation; raw bodies and secret-derived matches not retained', () => {
  const content = 'x'.repeat(990) + ' api_key="top secret continuing beyond limit" ' + 'y'.repeat(3000);
  const state = fold([invoke(0, content)]);
  assert.ok(state.observations[0].text.length <= 1000);
  assert.equal(state.observations[0].text, '[REDACTED]');
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes('top secret'));
  assert.equal(state.exposures[0].bodyHash, null);
  assert.equal(selectExposures(state, { knownSkills: [{ ...known[0], content }] })[0].match, 'unknown');
});

test('private reasoning is never persisted; request and usage facts retain numeric counts only', () => {
  const state = fold([
    e(0, 'assistant/reasoning', { content: 'PRIVATE-THOUGHT' }),
    e(1, 'assistant/message', { turn: 1, message: { content: [{ type: 'reasoning', text: 'PRIVATE-THOUGHT' }] }, usage: { inputTokens: 100, outputTokens: 7, totalTokens: 107, reasoningTokens: 3, extra: 'PRIVATE-THOUGHT' } }),
    e(2, 'request/context', { provider: 'openai', model: 'test-model', system: 'PRIVATE-THOUGHT' }),
    e(3, 'request/header', { header: { config: { provider: 'vendor', model: 'model', apiKey: 'PRIVATE-THOUGHT' } } }),
    e(4, 'assistant/message', { private: true, usage: { inputTokens: 999 }, message: { content: 'PRIVATE-THOUGHT' } }),
  ]);
  assert.equal(state.observations.length, 3);
  assert.equal(state.observations[0].usage.inputTokens, 100);
  assert.ok(!JSON.stringify(state).includes('PRIVATE-THOUGHT'));
  assert.equal(selectExposures(state).length, 0);
});

test('malformed arbitrary events and duplicate seqs do not throw or introduce exposure', () => {
  let state = initialFeedback(null, -1);
  for (const item of [null, false, 5, 'bad', [], {}, { seq: -1 }, { seq: NaN }]) {
    assert.doesNotThrow(() => { state = foldFeedback(state, item); });
  }
  let seq = 0;
  for (const type of ['turn/start', 'turn/end', 'tool/call', 'tool/result', 'user/message', 'assistant/message', 'request/header', 'request/context']) {
    for (const data of [null, 1, false, 'bad', [], {}, { message: null }, { message: { content: [null, 3, {}] } }, { arguments: 'bad' }]) {
      assert.doesNotThrow(() => { state = foldFeedback(state, e(seq++, type, data)); });
    }
  }
  assert.deepEqual(selectExposures(state, { knownSkills: known }), []);
  const old = state;
  assert.equal(foldFeedback(state, invoke(state.lastSeq)), old);
  assert.equal(foldFeedback(state, Object.create({ seq: seq + 1, type: 'user/message', data: invoke(0).data })), old);
});

test('prototype-looking call ids stay own JSON keys', () => {
  const state = fold([call(0, 'learned-reducer', '__proto__'), result(1, wrap(), '__proto__')]);
  assert.equal(selectExposures(state, { knownSkills: known })[0].match, 'matched');
  assert.equal({}.name, undefined);
});

test('episodeId exactly preserves legacy root-NUL-session-NUL-endseq hashing', () => {
  assert.equal(episodeId('/workspace', 's1', 42), sha('/workspace\0s1\0' + '42').slice(0, 32));
  assert.equal(episodeId('/workspace', 's1', 42).length, 32);
  assert.notEqual(episodeId('/workspace', 's1', 42), episodeId('/workspace', 's1', 43));
});

test('host confirmed native anchors alone establish verified outcome', () => {
  const output = feedback(hostBatch());
  assert.equal(output.outcome, 'verified');
  assert.deepEqual(output.confirmationSeqs, [8, 9]);
  assert.equal(output.episodeId, episodeId('/workspace', 'session-1', 10));
  assert.equal(output.scope, '/workspace');
  assert.equal(output.alreadyProcessed, false);
  const human = feedback(hostBatch({ confirmationSeqs: [7], evidence: [{ seq: 7, type: 'user/message', text: 'Теперь работает', verified: false, turn: 1 }] }));
  assert.equal(human.outcome, 'verified');
});

for (const [label, patch] of [
  ['unconfirmed host flag', { confirmed: false }],
  ['missing anchors', { confirmationSeqs: [] }],
  ['missing native settlement', { evidence: [{ seq: 9, type: 'tool/result', text: 'Passed', verified: true }] }],
  ['duplicate anchors', { confirmationSeqs: [9, 9] }],
  ['future anchors', { confirmationSeqs: [11] }],
  ['unverified tool output', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'tool/result', text: 'Tests passed [exit code: 0]', verified: false }] }],
  ['assistant self-report', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'assistant/message', text: 'I verified this', verified: true }] }],
  ['wrong turn anchor', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'tool/result', text: 'Passed', verified: true, turn: 0 }] }],
  ['reasoning masquerade', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'assistant/reasoning', text: 'Passed', verified: true }] }],
  ['secret-bearing anchor', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'tool/result', text: 'password=private', verified: true }] }],
  ['truncated anchor', { confirmationSeqs: [9], evidence: [{ seq: 9, type: 'tool/result', text: 'x'.repeat(1200), verified: true }] }],
]) {
  test(`${label} cannot become verified through feedback`, () => {
    const output = feedback(hostBatch(patch));
    assert.equal(output.outcome, 'unverified');
    assert.deepEqual(output.confirmationSeqs, []);
  });
}

test('host correction/antipattern with human evidence is contradicted, intervention unverified', () => {
  for (const signal of ['correction', 'antipattern', 'intervention']) {
    const output = feedback(hostBatch({ signal, confirmed: false, confirmationSeqs: [], evidence: [{ seq: 7, type: 'user/message', text: 'Не работает', verified: false, turn: 1 }] }));
    assert.equal(output.outcome, signal === 'intervention' ? 'unverified' : 'contradicted');
  }
  assert.equal(feedback(hostBatch({ signal: 'correction', confirmed: false, evidence: [] })).outcome, 'unverified');
});

test('watermark prevents repeat episodes and foreign/future exposures are excluded', () => {
  const exposures = selected([call(0), result(1)]);
  const output = feedback(hostBatch(), { watermark: 10, exposures: [
    ...exposures, { ...exposures[0], sessionId: 'foreign' }, { ...exposures[0], seq: 11, sourceSeqs: [11] },
  ] });
  assert.equal(output.alreadyProcessed, true);
  assert.equal(output.exposures.length, 1);
  assert.equal(output.exposures[0].match, 'matched');
  assert.equal(feedback(hostBatch(), { watermark: 9 }).alreadyProcessed, false);
});

test('malformed known snapshots cannot borrow a hash or identify an invalid provider', () => {
  const state = fold([call(0), result(1)]);
  for (const snapshot of [
    { ...known[0], content: 123, bodyHash: sha(body) },
    { ...known[0], content: 'password=secret', bodyHash: sha(body) },
    { ...known[0], provider: {} },
  ]) assert.equal(selectExposures(state, { knownSkills: [snapshot] })[0].match, 'unknown');
});

test('private/synthetic evidence and oversized exposure source arrays are dropped', () => {
  const output = feedback(hostBatch({ confirmationSeqs: [9], evidence: [{ seq: 9, type: 'tool/result', text: 'PRIVATE', verified: true, private: true }] }), {
    exposures: [{ sessionId: 'session-1', seq: 9, sourceSeqs: Array.from({ length: 100 }, (_, seq) => seq) }],
  });
  assert.equal(output.outcome, 'unverified');
  assert.deepEqual(output.evidence, []);
  assert.deepEqual(output.exposures, []);
});

test('feedback output bounded and sanitized, invalid batch returns null', () => {
  const output = feedback(hostBatch({ confirmed: false, confirmationSeqs: [], evidence: Array.from({ length: 90 }, (_, seq) => ({ seq, type: 'assistant/message', text: 'token=secretvalue ' + 'x'.repeat(2000), verified: true })) , lastSeq: 100 }));
  assert.equal(output.evidence.length, 60);
  assert.ok(output.evidence.every(entry => entry.text.length <= 1000));
  assert.ok(!JSON.stringify(output).includes('secretvalue'));
  for (const batch of [null, {}, { lastSeq: -1, turn: 1 }, { lastSeq: 1, turn: null }]) assert.equal(feedback(batch), null);
});
