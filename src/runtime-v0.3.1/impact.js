import * as ace from './ace-core.js';

// Long-term usefulness telemetry: correlation of exact-revision skill exposures
// with episode outcomes. Counters only — loaded != used != helpful stays a
// documented limitation; impact is never publication/pruning authority.
function bump(skill, mutate) {
  const impact = skill.impact ?? ace.freshImpact();
  return { ...skill, impact: mutate({ ...impact }) };
}

// exposures: feedback exposure records with match==='matched' and exact revision.
export function applyOutcome(project, { exposures = [], outcome = 'unverified', endSeq = 0 } = {}) {
  if (!ace.validateProject(project)) throw new TypeError('Invalid project');
  if (!['verified', 'contradicted', 'unverified'].includes(outcome)) throw new TypeError('Invalid outcome');
  if (!Number.isSafeInteger(endSeq) || endSeq < 0) throw new TypeError('Invalid endSeq');
  const matched = exposures.filter(e => e && e.match === 'matched' && Number.isSafeInteger(e.revision));
  if (!matched.length) return project;
  let changed = false;
  const skills = project.skills.map(skill => {
    const hits = matched.filter(e => e.name === skill.name && e.revision === skill.revision);
    if (!hits.length) return skill;
    changed = true;
    return bump(skill, impact => ({
      ...impact,
      loaded: impact.loaded + hits.length,
      episodes: impact.episodes + 1,
      lastOutcomeSeq: endSeq,
      ...(outcome === 'verified' ? { outcomesVerifiedAfterLoad: impact.outcomesVerifiedAfterLoad + 1 } : {}),
      ...(outcome === 'contradicted' ? { outcomesContradictedAfterLoad: impact.outcomesContradictedAfterLoad + 1 } : {}),
    }));
  });
  if (!changed) return project;
  const next = { ...project, skills };
  if (!ace.validateProject(next)) throw new TypeError('Invalid impact update');
  return next;
}

// A resolved tool-error pattern recovered while the skill was loaded: the skill
// plausibly contributed to the recovery (hypothesis, counted as errorRecoveries).
export function recordErrorRecovery(project, skillName) {
  if (!ace.validateProject(project)) throw new TypeError('Invalid project');
  const skill = project.skills.find(s => s.name === skillName);
  if (!skill) return project;
  const next = { ...project, skills: project.skills.map(s => s.name === skillName ? bump(s, impact => ({ ...impact, errorRecoveries: impact.errorRecoveries + 1 })) : s) };
  if (!ace.validateProject(next)) throw new TypeError('Invalid impact update');
  return next;
}
