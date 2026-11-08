import test from 'node:test';
import assert from 'node:assert/strict';
import * as ace from '../src/ace-core.js';
import { applyOutcome, recordErrorRecovery } from '../src/impact.js';

const ROOT = '/project';
const HASH = 'a'.repeat(64);
function projectWithSkill() {
  const p = ace.newProject(ROOT);
  const draft = { lessons: [], proposal: { name: 'learned-fix-tests', baseRevision: 0, baseHash: null, reason: 'test', evidenceSeqs: [1], operations: [{ op: 'create', description: 'Fix tests', trigger: 'When tests break', entries: [{ section: 'step', text: 'Run the suite' }, { section: 'step', text: 'Fix the cause' }, { section: 'check', text: 'Zero failures' }] }] } };
  const staged = ace.stage(p, draft, { runId: 'run-1', sessionId: 's1', turn: 1, evidence: [{ seq: 1, type: 'user/message', text: 'work', verified: true, turn: 1 }], confirmed: true, now: '2026-11-09T00:00:00.000Z' }, {});
  assert.equal(staged.status, 'pending-review');
  return ace.approve(staged.project, staged.proposalId, '2026-11-09T00:01:00.000Z');
}
test('verified outcome with exact-revision exposure bumps helpful counters', () => {
  const p = projectWithSkill();
  const skill = p.skills[0];
  const next = applyOutcome(p, { exposures: [{ name: skill.name, revision: skill.revision, match: 'matched' }], outcome: 'verified', endSeq: 42 });
  const impact = next.skills[0].impact;
  assert.equal(impact.loaded, 1);
  assert.equal(impact.episodes, 1);
  assert.equal(impact.outcomesVerifiedAfterLoad, 1);
  assert.equal(impact.outcomesContradictedAfterLoad, 0);
  assert.equal(impact.lastOutcomeSeq, 42);
});
test('unmatched or unknown exposures and unverified outcomes change nothing', () => {
  const p = projectWithSkill();
  const skill = p.skills[0];
  assert.equal(applyOutcome(p, { exposures: [{ name: skill.name, revision: skill.revision, match: 'unknown' }], outcome: 'verified', endSeq: 1 }), p);
  const next = applyOutcome(p, { exposures: [{ name: skill.name, revision: skill.revision, match: 'matched' }], outcome: 'unverified', endSeq: 9 });
  assert.equal(next.skills[0].impact.outcomesVerifiedAfterLoad, 0);
  assert.equal(next.skills[0].impact.loaded, 1);
  assert.equal(applyOutcome(p, { exposures: [], outcome: 'verified', endSeq: 1 }), p);
});
test('contradicted outcome counts against the exact loaded revision only', () => {
  const p = projectWithSkill();
  const skill = p.skills[0];
  const next = applyOutcome(p, { exposures: [{ name: skill.name, revision: skill.revision + 1, match: 'matched' }], outcome: 'contradicted', endSeq: 5 });
  assert.equal(next, p); // wrong revision: no credit, no blame
  const blamed = applyOutcome(p, { exposures: [{ name: skill.name, revision: skill.revision, match: 'matched' }], outcome: 'contradicted', endSeq: 5 });
  assert.equal(blamed.skills[0].impact.outcomesContradictedAfterLoad, 1);
});
test('recordErrorRecovery bumps only the named skill and validates', () => {
  const p = projectWithSkill();
  const next = recordErrorRecovery(p, 'learned-fix-tests');
  assert.equal(next.skills[0].impact.errorRecoveries, 1);
  assert.equal(recordErrorRecovery(p, 'learned-missing'), p);
  assert.ok(ace.validateProject(next));
});
test('impact survives publish-carried revisions', () => {
  let p = projectWithSkill();
  p = applyOutcome(p, { exposures: [{ name: p.skills[0].name, revision: p.skills[0].revision, match: 'matched' }], outcome: 'verified', endSeq: 7 });
  assert.equal(p.skills[0].impact.loaded, 1);
});
