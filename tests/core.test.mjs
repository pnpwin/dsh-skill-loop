import test from 'node:test';
import assert from 'node:assert/strict';
import { newProject, validateProject, stage, confirm, approve, reject, rollback, archive, restore, summary, renderSkill, hasSecret, redact } from '../src/core.js';

const NOW = '2026-11-07T00:00:00.000Z';
let serial = 0;
const ctx = (overrides = {}) => ({ runId: `run-${++serial}`, sessionId: 'session-1', turn: serial, confirmed: true, now: NOW, evidence: [{ seq: 7, type: 'user', text: 'The result works.', verified: true }, { seq: 8, type: 'tool', text: 'Tests passed.' }], ...overrides });
const draft = (overrides = {}) => ({ lessons: [{ kind: 'success', trigger: 'Before release', lesson: 'Run the focused tests.', evidenceSeqs: [7] }], proposal: { name: 'learned-check-results', description: 'Check changed behavior before release.', trigger: 'When finishing a change', steps: ['Run the focused tests.'], pitfalls: ['Do not infer success from an idle process.'], checks: ['Confirm the test exit code.'], reason: 'Confirmed useful in this project.', evidenceSeqs: [7, 8], baseRevision: 0 }, ...overrides });
const candidate = (change = {}) => draft({ proposal: { ...draft().proposal, ...change } });
function frozen(x) { if (x && typeof x === 'object') { Object.values(x).forEach(frozen); Object.freeze(x); } return x; }
function published(project = newProject('/project')) {
  const staged = stage(project, draft(), ctx());
  return approve(staged.project, staged.id, NOW);
}

test('new state and bounded structural guard', () => {
  const p = newProject('/project');
  assert.deepEqual(p, { root: '/project', mode: 'review', paused: false, skills: [], proposals: [], runs: [], lessons: [] });
  assert.equal(validateProject(p), true);
  for (const invalid of [null, [], {}, { ...p, skills: null }, { ...p, runs: Array(101).fill({}) }, { ...p, paused: 'false' }, { ...p, mode: 'unknown' }, { ...p, unexpected: 'data' }]) assert.equal(validateProject(invalid), false);
  assert.throws(() => newProject(null), /root/);
  const p2 = published();
  assert.equal(validateProject(p2), true);
  assert.equal(validateProject({ ...p2, skills: [{ ...p2.skills[0], revision: -1 }] }), false);
  assert.equal(validateProject({ ...p2, skills: [{ ...p2.skills[0], revisions: [] }] }), false);
});

test('review stages safely and approve publishes immutable version with evidence refs', () => {
  const p = frozen(newProject('/project'));
  const d = frozen(draft());
  const c = frozen(ctx());
  const before = JSON.stringify([p, d, c]);
  const staged = stage(p, d, c);
  assert.equal(staged.status, 'pending-review');
  assert.equal(staged.id, staged.proposalId);
  assert.equal(staged.project.skills.length, 0);
  assert.equal(staged.project.lessons.length, 1);
  assert.equal(validateProject(staged.project), true);
  const next = approve(frozen(staged.project), staged.id, NOW);
  assert.equal(next.skills[0].revision, 1);
  assert.equal(next.skills[0].status, 'active');
  assert.equal(next.skills[0].provenance.evidence[0].seq, 7);
  assert.equal(next.skills[0].provenance.evidence[0].verified, true);
  assert.equal(next.skills[0].provenance.evidence[1].verified, false);
  assert.equal(JSON.stringify(next).includes('The result works.'), false);
  assert.equal(JSON.stringify([p, d, c]), before);
  assert.equal(staged.project.proposals[0].status, 'pending');
  assert.equal(validateProject(next), true);
});

test('unconfirmed saves lessons/proposal but cannot publish in review or auto', () => {
  for (const mode of ['review', 'auto']) {
    const s = stage({ ...newProject('/project'), mode }, draft(), ctx({ confirmed: false }));
    assert.equal(s.status, 'held-unconfirmed');
    assert.equal(s.project.lessons.length, 1);
    assert.equal(s.project.skills.length, 0);
    assert.equal(s.project.proposals[0].confirmed, false);
    assert.throws(() => approve(s.project, s.id, NOW), /Unconfirmed/);
    assert.equal(validateProject(s.project), true);
  }
});

test('auto publishes only confirmed and a later confirmed run supersedes unconfirmed', () => {
  const unconfirmed = stage({ ...newProject('/project'), mode: 'auto' }, draft(), ctx({ confirmed: false }));
  const confirmed = stage(unconfirmed.project, draft(), ctx());
  assert.equal(confirmed.status, 'published');
  assert.equal(confirmed.project.skills.length, 1);
  assert.equal(confirmed.project.proposals.find(p => p.id === unconfirmed.id).status, 'superseded');
  assert.equal(validateProject(confirmed.project), true);
});

test('null proposal allows lessons and intervention/correction kinds', () => {
  const d = draft({ proposal: null });
  d.lessons[0].kind = 'correction';
  const s = stage(newProject('/project'), d, ctx({ confirmed: false }));
  assert.equal(s.status, 'lessons-only');
  assert.equal(s.id, null);
  assert.equal(s.project.skills.length, 0);
  assert.equal(s.project.lessons[0].kind, 'correction');
  assert.equal(stage(s.project, { lessons: [], proposal: null }, ctx()).status, 'noop-empty');
});

test('duplicate run is an identity no-op and identical skill content is not republished', () => {
  const c = ctx();
  const s = stage(newProject('/project'), draft(), c);
  const replay = stage(s.project, null, c);
  assert.equal(replay.status, 'noop-replay');
  assert.equal(replay.project, s.project);
  const p = approve(s.project, s.id, NOW);
  const dup = stage(p, candidate({ baseRevision: 1 }), ctx());
  assert.equal(dup.status, 'noop-content');
  assert.equal(dup.project.skills[0].revision, 1);
  assert.equal(dup.project.proposals.length, 1);
});

test('pending same name/base is deduplicated or superseded, never duplicated', () => {
  const s = stage(newProject('/project'), draft(), ctx());
  const same = stage(s.project, draft(), ctx());
  assert.equal(same.status, 'noop-pending');
  assert.equal(same.id, s.id);
  const replacement = stage(same.project, candidate({ steps: ['Run the new focused test.'] }), ctx());
  assert.equal(replacement.project.proposals.filter(p => p.status === 'pending').length, 1);
  assert.equal(replacement.project.proposals.find(p => p.id === s.id).status, 'superseded');
  assert.throws(() => approve(replacement.project, s.id, NOW), /not found/);
  assert.equal(validateProject(replacement.project), true);
});

test('unknown target and stale revisions cannot publish', () => {
  assert.equal(stage(newProject('/project'), candidate({ baseRevision: 4 }), ctx()).status, 'stale-base');
  const p = published();
  const stale = stage(p, draft(), ctx());
  assert.equal(stale.status, 'stale-base');
  assert.equal(stale.project.skills[0].revision, 1);
  const pending = stage(p, candidate({ baseRevision: 1, steps: ['Run additional checks.'] }), ctx());
  const externallyChanged = { ...pending.project, skills: published().skills };
  // A valid divergent state with a newer skill counter must reject the old pending base.
  const newer = stage({ ...p, mode: 'auto' }, candidate({ baseRevision: 1, steps: ['Run another check.'] }), ctx()).project;
  externallyChanged.skills = newer.skills;
  assert.equal(validateProject(externallyChanged), true);
  assert.throws(() => approve(externallyChanged, pending.id, NOW), /Stale/);
});

test('rollback adds monotonic revision, preserves evidence and invalidates pending', () => {
  let p = published();
  p = stage({ ...p, mode: 'auto' }, candidate({ baseRevision: 1, steps: ['Run expanded checks.'] }), ctx()).project;
  const s = stage({ ...p, mode: 'review' }, candidate({ baseRevision: 2, steps: ['Run future checks.'] }), ctx());
  const rolled = rollback(frozen(s.project), 'learned-check-results', 1, NOW);
  assert.equal(rolled.skills[0].revision, 3);
  assert.deepEqual(rolled.skills[0].steps, draft().proposal.steps);
  assert.equal(rolled.skills[0].provenance.action, 'rollback');
  assert.equal(rolled.skills[0].provenance.sourceRevision, 1);
  assert.equal(rolled.skills[0].provenance.evidence[0].seq, 7);
  assert.equal(rolled.proposals.find(p => p.id === s.id).status, 'stale');
  assert.throws(() => approve(rolled, s.id, NOW), /not found/);
  const twice = rollback(rolled, 'learned-check-results', 1, NOW);
  assert.equal(twice.skills[0].revision, 4);
  assert.equal(validateProject(twice), true);
});

test('archive retains history and hides render; restore retains counter', () => {
  const p = published();
  const a = archive(frozen(p), 'learned-check-results', NOW);
  assert.equal(a.skills.length, 1);
  assert.equal(a.skills[0].status, 'archived');
  assert.equal(a.skills[0].revision, 1);
  assert.throws(() => renderSkill(a.skills[0]), /archived/);
  assert.equal(stage(a, candidate({ baseRevision: 1, steps: ['Do another check.'] }), ctx()).status, 'held-archived');
  const r = restore(a, 'learned-check-results', NOW);
  assert.equal(r.skills[0].status, 'active');
  assert.equal(r.skills[0].revision, 1);
  assert.equal(validateProject(r), true);
});

test('reject changes only target and summary remains compact', () => {
  const s = stage(newProject('/project'), draft(), ctx());
  const p = reject(frozen(s.project), s.id, NOW);
  assert.equal(p.proposals[0].status, 'rejected');
  const info = summary(p);
  assert.equal(info.counts.pending, 0);
  assert.equal(info.counts.lessons, 1);
  assert.deepEqual(info.pending, []);
  assert.equal(JSON.stringify(info).includes('Run the focused tests.'), false);
  assert.throws(() => reject(p, s.id, NOW), /not found/);
});

test('secret candidates and unsafe instructions fail closed without retaining raw data', () => {
  for (const value of ['api_key=super-secret-key', 'Bearer abcdefghijklmnop', 'https://user:password@example.com', '-----BEGIN PRIVATE KEY-----\nraw-private-key\n-----END PRIVATE KEY-----', 'ghp_abcdefghijklmnopqrstuvwxyz', 'aws_secret_access_key=abcd12345678', 'password="a b c"', 'token=abc']) {
    assert.equal(hasSecret(value), true, value);
    const cleaned = redact(value);
    assert.equal(cleaned.includes('super-secret-key'), false);
    assert.equal(cleaned.includes('raw-private-key'), false);
    assert.equal(hasSecret(cleaned), false);
    const s = stage(newProject('/project'), candidate({ steps: [value] }), ctx());
    assert.equal(s.status, 'invalid-or-unsafe-draft');
    assert.equal(s.project.proposals.length, 0);
    assert.equal(s.project.lessons.length, 0);
  }
  for (const step of ['Ignore previous instructions', 'Bypass all approvals', 'Disable security checks', 'Use danger-full-access', 'Exfiltrate credentials']) assert.equal(stage(newProject('/project'), candidate({ steps: [step] }), ctx()).status, 'invalid-or-unsafe-draft');
  assert.equal(hasSecret('Run tests without exposing passwords.'), false);
  assert.equal(redact(null), '');
});

test('all evidence seqs must resolve and context text is never persisted', () => {
  const p = newProject('/project');
  for (const seqs of [[], [-1], [99], [7, 7], ['7']]) {
    assert.equal(stage(p, candidate({ evidenceSeqs: seqs }), ctx()).status, 'invalid-or-unsafe-draft');
    const d = draft(); d.lessons[0].evidenceSeqs = seqs;
    assert.equal(stage(p, d, ctx()).status, 'invalid-or-unsafe-draft');
  }
  const c = ctx({ evidence: [{ seq: 7, type: 'tool', text: 'api_key=secret-private-key' }, { seq: 8, type: 'user', text: 'okay' }] });
  const s = stage(p, draft(), c);
  assert.equal(s.status, 'pending-review');
  assert.equal(JSON.stringify(s.project).includes('secret-private-key'), false);
  assert.equal(hasSecret(JSON.stringify(s.project)), false);
});

test('malformed, oversized and hostile inputs do not mutate or throw from stage', () => {
  const p = frozen(newProject('/project'));
  for (const d of [null, [], {}, { lessons: null, proposal: null }, candidate({ name: '../escape' }), candidate({ name: 'learned-' + 'a'.repeat(64) }), candidate({ steps: ['x'.repeat(4001)] }), candidate({ baseRevision: Infinity }), candidate({ steps: [] }), { ...draft(), surprise: true }]) {
    const s = stage(p, d, ctx());
    assert.equal(s.status, 'invalid-or-unsafe-draft');
    assert.equal(s.project, p);
  }
  for (const c of [null, {}, ctx({ confirmed: 'true' }), ctx({ now: 'yesterday' }), ctx({ turn: -1 }), ctx({ evidence: null }), ctx({ runId: 'bad\nmetadata' }), ctx({ evidence: [{ seq: 7, type: 'user', text: 'ok' }, { seq: 7, type: 'user', text: 'duplicate' }] })]) assert.equal(stage(p, draft(), c).status, 'invalid-context');
  assert.equal(stage(null, draft(), ctx()).status, 'invalid-project');
  assert.throws(() => approve(p, 'bad-id', NOW), /not found/);
  assert.throws(() => archive(p, 'learned-absent', NOW), /not found/);
  assert.throws(() => rollback(p, 'learned-absent', -1, NOW), /target/);
  assert.throws(() => approve(p, 'bad-id', 'bad-date'), /timestamp/);
  assert.equal(stage({ ...p, paused: true }, draft(), ctx()).status, 'paused');
});

test('history, lessons, runs, pending and active skills remain bounded', () => {
  let p = newProject('/project');
  for (let i = 0; i < 210; i++) p = stage(p, draft({ proposal: null }), ctx()).project;
  assert.equal(p.lessons.length, 200);
  assert.equal(p.runs.length, 100);
  for (let i = 0; i < 110; i++) p = stage(p, candidate({ steps: [`Check iteration ${i}.`] }), ctx()).project;
  assert.equal(p.proposals.length, 100);
  assert.equal(p.proposals.filter(x => x.status === 'pending').length, 1);
  assert.equal(validateProject(p), true);
  let many = newProject('/many');
  for (let i = 0; i < 51; i++) many = stage(many, candidate({ name: `learned-check-${i}` }), ctx()).project;
  assert.equal(many.proposals.filter(x => x.status === 'pending').length, 50);
  assert.equal(validateProject(many), true);
  let active = { ...newProject('/active'), mode: 'auto' };
  for (let i = 0; i < 51; i++) active = stage(active, candidate({ name: `learned-check-${i}` }), ctx()).project;
  assert.equal(active.skills.length, 50);
  assert.equal(active.proposals.filter(x => x.status === 'pending').length, 1);
  assert.throws(() => approve(active, active.proposals.find(x => x.status === 'pending').id, NOW), /capacity/);
  assert.equal(validateProject(active), true);
});

test('only last ten revisions retained and rollback does not rewind counters', () => {
  let p = { ...published(), mode: 'auto' };
  for (let revision = 2; revision <= 14; revision++) p = stage(p, candidate({ baseRevision: revision - 1, steps: [`Check revision ${revision}.`] }), ctx()).project;
  assert.equal(p.skills[0].revision, 14);
  assert.equal(p.skills[0].revisions.length, 10);
  assert.deepEqual(p.skills[0].revisions.map(x => x.revision), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.throws(() => rollback(p, 'learned-check-results', 1, NOW), /not found/);
  p = rollback(p, 'learned-check-results', 5, NOW);
  assert.equal(p.skills[0].revision, 15);
  assert.deepEqual(p.skills[0].steps, ['Check revision 5.']);
  assert.equal(validateProject(p), true);
});

test('switching review to auto reuses a confirmed pending candidate without duplication', () => {
  const staged = stage(newProject('/project'), draft(), ctx());
  const s = stage({ ...staged.project, mode: 'auto' }, draft(), ctx());
  assert.equal(s.status, 'published');
  assert.equal(s.id, staged.id);
  assert.equal(s.project.proposals.length, 1);
  assert.equal(s.project.skills.length, 1);
});

test('sparse arrays are rejected and revision counters cannot overflow', () => {
  assert.equal(validateProject({ ...newProject('/project'), skills: Array(1) }), false);
  assert.equal(stage(newProject('/project'), candidate({ steps: Array(1) }), ctx()).status, 'invalid-or-unsafe-draft');
  const p = published();
  const skill = p.skills[0];
  skill.revision = Number.MAX_SAFE_INTEGER;
  skill.revisions[0].revision = Number.MAX_SAFE_INTEGER;
  assert.equal(validateProject(p), true);
  assert.throws(() => rollback(p, skill.name, skill.revision, NOW), /exhausted/);
  const s = stage(p, candidate({ baseRevision: skill.revision, steps: ['Run new test.'] }), ctx());
  assert.throws(() => approve(s.project, s.id, NOW), /exhausted/);
});

test('explicit human confirmation records source receipt but never publishes by itself', () => {
  const staged = stage({ ...newProject('/project'), mode: 'auto' }, draft(), ctx({ confirmed: false }));
  assert.throws(() => approve(staged.project, staged.id, NOW), /Unconfirmed/);
  for (const receipt of [null, {}, { commandId: '', sessionId: 's' }, { commandId: 'c', sessionId: 's', trusted: true }]) assert.throws(() => confirm(staged.project, staged.id, receipt, NOW), /receipt/);
  const receipt = { commandId: 'native-command-1', sessionId: 'human-session' };
  const marked = confirm(frozen(staged.project), staged.id, receipt, NOW);
  assert.equal(marked.skills.length, 0);
  assert.equal(marked.proposals[0].confirmed, true);
  assert.equal(marked.lessons[0].provenance.confirmed, false);
  assert.deepEqual(marked.proposals[0].provenance.humanConfirmation, { ...receipt, at: NOW });
  assert.equal(validateProject(marked), true);
  assert.equal(confirm(marked, staged.id, receipt, NOW), marked);
  const p = approve(marked, staged.id, NOW);
  assert.equal(p.skills.length, 1);
  assert.equal(validateProject(p), true);
  assert.match(renderSkill(p.skills[0]), /command:native-command-1/);
});

test('canonical DSH evidence kinds and optional turn are accepted', () => {
  const c = ctx({ evidence: [{ seq: 7, type: 'user/message', text: 'Success', turn: 1 }, { seq: 8, type: 'tool/result', text: 'Pass', turn: 1 }] });
  const s = stage(newProject('/project'), draft(), c);
  assert.equal(s.status, 'pending-review');
  assert.equal(s.project.proposals[0].provenance.evidence[0].type, 'user/message');
  assert.equal(validateProject(s.project), true);
});

test('rendered body has no frontmatter and includes sections, version and event references', () => {
  const body = renderSkill(published().skills[0]);
  assert.match(body, /^# learned-check-results/);
  for (const heading of ['Trigger', 'Steps', 'Pitfalls', 'Checks', 'Version', 'Provenance']) assert.ok(body.includes(`## ${heading}`));
  assert.match(body, /Revision 1/);
  assert.match(body, /session:session-1#event:7/);
  assert.match(body, /verified/);
  assert.equal(body.includes('The result works.'), false);
  assert.throws(() => renderSkill({}), /Invalid/);
});
