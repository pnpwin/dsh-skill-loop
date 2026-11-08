import test from 'node:test';
import assert from 'node:assert/strict';

import { redact, hasSecret } from '../src/core.js';
import {
  normalizeErrorText,
  signatureOf,
  extractErrorPatterns,
  buildAntipatternDraft,
  mergeProjectPatterns,
} from '../src/error-patterns.js';

// ---------- normalizeErrorText ----------

test('normalizeErrorText masks digits, hex and absolute paths', () => {
  const out = normalizeErrorText('ENOENT: file /Users/alice/proj/file123.txt not found in dir C:\\work\\proj\\x exit code 255');
  assert.ok(!/\d/.test(out), `digits leaked: ${out}`);
  assert.ok(out.includes('<path>'), `unix path not masked: ${out}`);
  assert.ok(out.includes('<path>'), `windows path not masked: ${out}`);
  assert.equal(out.includes('/Users/alice'), false);
  assert.equal(out.includes('C:\\work'), false);
});

test('normalizeErrorText masks hex substrings of length >= 8', () => {
  const out = normalizeErrorText('checksum abcdef1234567890 mismatch at 0xdeadbeefcafe');
  assert.ok(out.includes('#hex'), `hex not masked: ${out}`);
  assert.ok(!/[0-9a-fA-F]{8,}/.test(out), `long hex leaked: ${out}`);
});

test('normalizeErrorText redacts secrets via core redact', () => {
  const secret = 'sk-abcdefghijklmnop';
  assert.equal(hasSecret(secret), true, 'core should catch sk-… (test premise)');
  const out = normalizeErrorText(`auth failed for token ${secret} at /var/app/x`);
  assert.equal(out.includes(secret), false);
  assert.equal(hasSecret(out), false, `secret leaked: ${out}`);
  assert.ok(out.includes('[REDACTED]'), `redaction marker missing: ${out}`);
});

test('normalizeErrorText collapses whitespace and honors max', () => {
  const out = normalizeErrorText('a\n\n  b\t\tc   d', { max: 400 });
  assert.equal(out, 'a b c d');
  const long = normalizeErrorText('x'.repeat(1000), { max: 100 });
  assert.equal(long.length, 100);
  assert.equal(normalizeErrorText(123), '');
});

// ---------- signatureOf ----------

test('signatureOf is stable and tool-sensitive', () => {
  const a = signatureOf('read', 'no such file');
  const b = signatureOf('read', 'no such file');
  const c = signatureOf('edit', 'no such file');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

// ---------- extractErrorPatterns ----------

const err = (seq, turn, name, text, isError = true) => ({ seq, type: 'tool/result', turn, name, isError, text });
const ok = (seq, turn, name) => ({ seq, type: 'tool/result', turn, name, isError: false, text: 'done' });
const end = (seq, turn) => ({ seq, type: 'turn/end', turn, completed: true });

test('extractErrorPatterns happy path: 2 errors + recovery = 1 pattern', () => {
  const events = [
    { seq: 0, type: 'tool/call', turn: 1, name: 'read' },
    err(1, 1, 'read', 'ENOENT: no such file /a/b/c'),
    err(2, 1, 'read', 'ENOENT: no such file /a/b/c'),
    ok(3, 1, 'read'),
    end(4, 1),
  ];
  const patterns = extractErrorPatterns(events);
  assert.equal(patterns.length, 1);
  const p = patterns[0];
  assert.equal(p.tool, 'read');
  assert.equal(p.count, 2);
  assert.deepEqual(p.errorSeqs, [1, 2]);
  assert.equal(p.recoverySeq, 3);
  assert.equal(typeof p.signature, 'string');
  assert.match(p.signature, /^[0-9a-f]{16}$/);
  assert.ok(p.sample.length <= 300);
  assert.ok(p.sample.includes('<path>'));
});

test('single error below minRepeats yields nothing', () => {
  const events = [err(1, 1, 'read', 'boom'), ok(2, 1, 'read'), end(3, 1)];
  assert.deepEqual(extractErrorPatterns(events), []);
  assert.deepEqual(extractErrorPatterns(events, { minRepeats: 1 }).length, 1);
});

test('errors without recovery before turn/end are dropped', () => {
  const events = [
    err(1, 1, 'read', 'boom a'),
    err(2, 1, 'read', 'boom a'),
    end(3, 1),
    err(4, 2, 'read', 'boom a'),
    err(5, 2, 'read', 'boom a'),
    ok(6, 2, 'read'),
    end(7, 2),
  ];
  const patterns = extractErrorPatterns(events);
  assert.equal(patterns.length, 1);
  assert.deepEqual(patterns[0].errorSeqs, [4, 5]);
  assert.equal(patterns[0].recoverySeq, 6);
});

test('three different signatures resolve as separate patterns', () => {
  const events = [
    err(1, 1, 'read', 'ENOENT alpha'),
    err(2, 1, 'read', 'EACCES beta'),
    err(3, 1, 'read', 'EISDIR gamma'),
    ok(4, 1, 'read'),
    end(5, 1),
  ];
  const patterns = extractErrorPatterns(events, { minRepeats: 1 });
  assert.equal(patterns.length, 3);
  assert.equal(new Set(patterns.map(p => p.signature)).size, 3);
  assert.equal(new Set(patterns.map(p => p.recoverySeq)).size, 1);
});

test('same failure in two turns yields two independent patterns', () => {
  const events = [
    err(1, 1, 'read', 'ENOENT /x/y'),
    err(2, 1, 'read', 'ENOENT /x/y'),
    ok(3, 1, 'read'),
    end(4, 1),
    err(5, 2, 'read', 'ENOENT /x/y'),
    err(6, 2, 'read', 'ENOENT /x/y'),
    ok(7, 2, 'read'),
    end(8, 2),
  ];
  const patterns = extractErrorPatterns(events);
  assert.equal(patterns.length, 2);
  assert.deepEqual(patterns.map(p => p.errorSeqs), [[1, 2], [5, 6]]);
  assert.deepEqual(patterns.map(p => p.recoverySeq), [3, 7]);
  assert.equal(patterns[0].signature, patterns[1].signature, 'same normalized error = same signature');
});

test('recovery of another tool does not close the pattern', () => {
  const events = [
    err(1, 1, 'read', 'ENOENT /x/y'),
    err(2, 1, 'read', 'ENOENT /x/y'),
    ok(3, 1, 'bash'),
    end(4, 1),
  ];
  assert.deepEqual(extractErrorPatterns(events), []);
});

test('more than minRepeats errors accumulate into one pattern', () => {
  const events = [
    err(1, 1, 'edit', 'bad args'),
    err(2, 1, 'edit', 'bad args'),
    err(3, 1, 'edit', 'bad args'),
    err(4, 1, 'edit', 'different problem'),
    ok(5, 1, 'edit'),
    end(6, 1),
  ];
  const patterns = extractErrorPatterns(events);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].count, 3);
  assert.deepEqual(patterns[0].errorSeqs, [1, 2, 3]);
});

test('normalized errors differing only in ids/paths share a signature', () => {
  const events = [
    err(1, 1, 'bash', 'exit 1: file /tmp/run7/log.txt'),
    err(2, 1, 'bash', 'exit 1: file /tmp/run42/log.txt'),
    ok(3, 1, 'bash'),
    end(4, 1),
  ];
  const patterns = extractErrorPatterns(events);
  assert.equal(patterns.length, 1, `expected masked-identity match, got ${JSON.stringify(patterns)}`);
});

test('extractErrorPatterns tolerates garbage input', () => {
  assert.deepEqual(extractErrorPatterns(null), []);
  assert.deepEqual(extractErrorPatterns([null, { type: 'mystery' }, err(1, 1, 'read', 'x')]), []);
});

// ---------- buildAntipatternDraft ----------

const pattern = {
  signature: 'abcd1234abcd1234',
  tool: 'read',
  count: 2,
  errorSeqs: [1, 2],
  recoverySeq: 3,
  sample: 'ENOENT: no such file <path>',
};

test('buildAntipatternDraft with skillName returns lesson + proposal', () => {
  const draft = buildAntipatternDraft(pattern, {
    skillName: 'learned-read-retry',
    baseRevision: 2,
    baseHash: 'a'.repeat(64),
  });
  assert.ok(draft);
  assert.equal(draft.lessons.length, 1);
  const lesson = draft.lessons[0];
  assert.equal(lesson.kind, 'antipattern');
  assert.equal(lesson.trigger, 'Инструмент "read" падает с повторяющейся ошибкой');
  assert.ok(lesson.lesson.includes('read'));
  assert.ok(lesson.lesson.includes('ENOENT'));
  assert.deepEqual(lesson.evidenceSeqs, [1, 2, 3]);
  assert.ok(lesson.trigger.length <= 400 && lesson.lesson.length <= 400);

  const proposal = draft.proposal;
  assert.ok(proposal);
  assert.equal(proposal.name, 'learned-read-retry');
  assert.equal(proposal.baseRevision, 2);
  assert.equal(proposal.baseHash, 'a'.repeat(64));
  assert.ok(proposal.reason.includes('read') && proposal.reason.includes('2'));
  assert.ok(proposal.reason.startsWith('Авто-паттерн:'));
  assert.deepEqual(proposal.evidenceSeqs, [1, 2, 3]);
  assert.ok(proposal.operations.length >= 1 && proposal.operations.length <= 2);
  assert.equal(proposal.operations[0].op, 'insert');
  assert.equal(proposal.operations[0].section, 'pitfall');
  for (const op of proposal.operations) {
    assert.ok(op.text.length <= 1200, `op text over limit: ${op.text.length}`);
    assert.equal(hasSecret(op.text), false);
  }
});

test('buildAntipatternDraft baseRevision 0 → proposal null, lesson kept', () => {
  const draft = buildAntipatternDraft(pattern, { skillName: 'learned-x', baseRevision: 0, baseHash: 'b'.repeat(64) });
  assert.ok(draft);
  assert.equal(draft.lessons.length, 1);
  assert.equal(draft.proposal, null);
});

test('buildAntipatternDraft without skillName → lesson only', () => {
  const draft = buildAntipatternDraft(pattern, {});
  assert.ok(draft);
  assert.equal(draft.lessons.length, 1);
  assert.equal(draft.proposal, null);
});

test('buildAntipatternDraft returns null on secret or empty pattern', () => {
  assert.equal(buildAntipatternDraft(null), null);
  assert.equal(buildAntipatternDraft({}), null);
  const leaky = { ...pattern, sample: 'token = sk-abcdefghijklmnop' };
  assert.equal(buildAntipatternDraft(leaky, { skillName: 'learned-x', baseRevision: 1, baseHash: 'c'.repeat(64) }), null);
});

test('buildAntipatternDraft lesson texts never exceed limits even with huge sample', () => {
  const big = { ...pattern, sample: 'z'.repeat(5000) };
  const draft = buildAntipatternDraft(big, { skillName: 'learned-x', baseRevision: 1, baseHash: 'd'.repeat(64) });
  assert.ok(draft);
  assert.ok(draft.lessons[0].lesson.length <= 400);
  for (const op of draft.proposal.operations) assert.ok(op.text.length <= 1200);
});

// ---------- mergeProjectPatterns ----------

test('mergeProjectPatterns appends new pattern', () => {
  const out = mergeProjectPatterns([], [pattern]);
  assert.equal(out.length, 1);
  assert.equal(out[0].signature, pattern.signature);
  assert.equal(out[0].tool, 'read');
  assert.equal(out[0].count, 2);
  assert.equal(out[0].resolvedCount, 1);
  assert.equal(out[0].lastSeq, 3);
});

test('mergeProjectPatterns merges matching signature', () => {
  const existing = [{ signature: 'abcd1234abcd1234', tool: 'read', count: 2, resolvedCount: 1, lastSeq: 3 }];
  const fresh = [{ ...pattern, count: 3, recoverySeq: 9, errorSeqs: [7, 8, 9] }];
  const out = mergeProjectPatterns(existing, fresh);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 5);
  assert.equal(out[0].resolvedCount, 2);
  assert.equal(out[0].lastSeq, 9);
  // inputs untouched
  assert.equal(existing[0].count, 2);
  assert.equal(existing[0].resolvedCount, 1);
});

test('mergeProjectPatterns keeps both signatures when different', () => {
  const existing = [{ signature: 'aaaa1111aaaa1111', tool: 'bash', count: 4, resolvedCount: 2, lastSeq: 10 }];
  const out = mergeProjectPatterns(existing, [pattern]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map(x => x.signature), ['aaaa1111aaaa1111', 'abcd1234abcd1234']);
});

test('mergeProjectPatterns caps at max (FIFO, keeps newest)', () => {
  const existing = Array.from({ length: 60 }, (_, i) => ({
    signature: `sig${String(i).padStart(4, '0')}`,
    tool: 't', count: 1, resolvedCount: 1, lastSeq: i,
  }));
  const out = mergeProjectPatterns(existing, [pattern], { max: 50 });
  assert.equal(out.length, 50);
  assert.deepEqual(out.at(-1).signature, pattern.signature);
  assert.deepEqual(out[0].signature, 'sig0011', 'oldest entries evicted first');
});
