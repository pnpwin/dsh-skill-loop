import { randomUUID } from 'node:crypto';

// Pure JSON state; limits bound both persisted history and individual input fields.
const LIMIT = { skills: 100, active: 50, proposals: 100, pending: 50, lessons: 200, runs: 100, revisions: 10 };
const NAME = /^learned-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = ['success', 'correction', 'antipattern', 'intervention'];
const STATUSES = ['pending', 'approved', 'rejected', 'superseded', 'stale'];
const SECRET = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|aws[_-]?secret[_-]?access[_-]?key|password|passwd|secret|token)\b["']?\s*[:=]\s*(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s"',;}{]+)|https?:\/\/[^\s/@:]+:[^\s/@]+@/gi;
const UNSAFE = /(?:ignore|override|disregard)\s+(?:(?:all|any|the|previous|prior|system|developer)\s+){0,4}(?:instructions|polic(?:y|ies)|permissions|rules)|(?:bypass|disable|circumvent)\s+(?:(?:all|any|the|safety|security|permission)\s+){0,3}(?:approvals?|permissions?|safeguards?|checks?|restrictions?|sandbox|polic(?:y|ies))|(?:exfiltrate|steal)\s+(?:secrets?|credentials?|tokens?)|danger-full-access|--no-sandbox|игнорир\S*\s+(?:инструкц|правил)|обой\S*\s+(?:разрешени|ограничени|подтверждени)/i;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k));
const text = (x, max = 4000, empty = false) => typeof x === 'string' && x.length <= max && (empty || x.trim().length > 0) && !x.includes('\u0000');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const identifier = x => text(x, 160) && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(x) && !hasSecret(x);
const eventType = x => text(x, 80) && /^[A-Za-z0-9_./:-]+$/.test(x);
const list = (x, max, check) => Array.isArray(x) && x.length <= max && Array.from(x).every(check);
const date = x => text(x, 40) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
const safe = x => text(x) && !hasSecret(x) && !UNSAFE.test(x);
const name = x => text(x, 64) && NAME.test(x);
const strings = x => list(x, 30, safe);
const contentKeys = ['name', 'description', 'trigger', 'steps', 'pitfalls', 'checks'];
const contentOK = x => object(x) && name(x.name) && safe(x.description) && x.description.length <= 240 && safe(x.trigger) && x.trigger.length <= 800 && strings(x.steps) && x.steps.length > 0 && x.steps.length <= 12 && strings(x.pitfalls) && x.pitfalls.length <= 8 && strings(x.checks) && x.checks.length <= 8 && JSON.stringify(content(x)).length <= 10000;
const content = x => Object.fromEntries(contentKeys.map(k => [k, Array.isArray(x[k]) ? [...x[k]] : x[k]]));
const sameContent = (a, b) => JSON.stringify(content(a)) === JSON.stringify(content(b));
const refOK = x => keys(x, ['seq', 'type', 'verified']) && integer(x.seq) && eventType(x.type) && typeof x.verified === 'boolean';
const receiptOK = x => keys(x, ['commandId', 'sessionId', 'at']) && identifier(x.commandId) && identifier(x.sessionId) && date(x.at);
const provenanceOK = x => keys(x, ['runId', 'sessionId', 'turn', 'at', 'confirmed', 'evidence', 'action', 'sourceRevision', 'humanConfirmation', 'reason']) && identifier(x.runId) && identifier(x.sessionId) && integer(x.turn) && date(x.at) && typeof x.confirmed === 'boolean' && (x.reason === undefined || safe(x.reason)) && list(x.evidence, 100, refOK) && x.evidence.length > 0 && (x.action === undefined || ['publish', 'rollback'].includes(x.action)) && (x.sourceRevision === undefined || integer(x.sourceRevision)) && (x.humanConfirmation === undefined || (x.confirmed && receiptOK(x.humanConfirmation)));
const snapshotOK = x => keys(x, [...contentKeys, 'revision', 'provenance']) && contentOK(x) && integer(x.revision) && x.revision > 0 && provenanceOK(x.provenance) && x.provenance.confirmed;
const skillOK = x => keys(x, [...contentKeys, 'revision', 'status', 'provenance', 'revisions']) && snapshotOK({ ...content(x), revision: x.revision, provenance: x.provenance }) && ['active', 'archived'].includes(x.status) && list(x.revisions, LIMIT.revisions, snapshotOK) && x.revisions.length > 0 && x.revisions.every((r, i) => r.name === x.name && r.revision <= x.revision && (!i || r.revision > x.revisions[i - 1].revision)) && x.revisions.at(-1).revision === x.revision && sameContent(x, x.revisions.at(-1)) && JSON.stringify(x.provenance) === JSON.stringify(x.revisions.at(-1).provenance);
const proposalOK = x => keys(x, [...contentKeys, 'id', 'status', 'baseRevision', 'confirmed', 'provenance', 'reason', 'createdAt', 'updatedAt']) && contentOK(x) && identifier(x.id) && STATUSES.includes(x.status) && integer(x.baseRevision) && typeof x.confirmed === 'boolean' && provenanceOK(x.provenance) && x.confirmed === x.provenance.confirmed && safe(x.reason) && date(x.createdAt) && (x.updatedAt === undefined || date(x.updatedAt));
const lessonOK = x => keys(x, ['id', 'kind', 'trigger', 'lesson', 'evidenceSeqs', 'provenance']) && identifier(x.id) && KINDS.includes(x.kind) && safe(x.trigger) && safe(x.lesson) && list(x.evidenceSeqs, 100, integer) && x.evidenceSeqs.length > 0 && provenanceOK(x.provenance) && x.evidenceSeqs.every(seq => x.provenance.evidence.some(ref => ref.seq === seq));
const runOK = x => keys(x, ['runId', 'sessionId', 'turn', 'at', 'status', 'proposalId']) && identifier(x.runId) && identifier(x.sessionId) && integer(x.turn) && date(x.at) && eventType(x.status) && (x.proposalId === null || identifier(x.proposalId));
const unique = (xs, key) => new Set(xs.map(x => x[key])).size === xs.length;

export function hasSecret(value) {
  if (typeof value !== 'string') return false;
  SECRET.lastIndex = 0;
  return SECRET.test(value);
}

export function redact(value) {
  if (typeof value !== 'string') return '';
  SECRET.lastIndex = 0;
  return value.replace(SECRET, '[REDACTED]');
}

export function newProject(root) {
  if (!text(root, 4096) || hasSecret(root)) throw new TypeError('Invalid project root');
  return { root, mode: 'review', paused: false, skills: [], proposals: [], runs: [], lessons: [] };
}

export function validateProject(value) {
  try {
    return keys(value, ['root', 'mode', 'paused', 'skills', 'proposals', 'runs', 'lessons']) && text(value.root, 4096) && !hasSecret(value.root) && ['review', 'auto'].includes(value.mode) && typeof value.paused === 'boolean' &&
      list(value.skills, LIMIT.skills, skillOK) && unique(value.skills, 'name') && value.skills.filter(x => x.status === 'active').length <= LIMIT.active &&
      list(value.proposals, LIMIT.proposals, proposalOK) && unique(value.proposals, 'id') && value.proposals.filter(x => x.status === 'pending').length <= LIMIT.pending &&
      unique(value.proposals.filter(x => x.status === 'pending'), 'name') && list(value.lessons, LIMIT.lessons, lessonOK) && unique(value.lessons, 'id') &&
      list(value.runs, LIMIT.runs, runOK) && unique(value.runs, 'runId');
  } catch { return false; }
}

function requireProject(project) {
  if (!validateProject(project)) throw new TypeError('Invalid project');
}
function requireDate(now) {
  if (!date(now)) throw new TypeError('Invalid timestamp');
}
function contextOK(c) {
  return keys(c, ['runId', 'sessionId', 'turn', 'evidence', 'confirmed', 'now']) && identifier(c.runId) && identifier(c.sessionId) && integer(c.turn) && typeof c.confirmed === 'boolean' && date(c.now) &&
    list(c.evidence, 1000, e => keys(e, ['seq', 'type', 'text', 'verified', 'turn']) && integer(e.seq) && eventType(e.type) && text(e.text, 20000, true) && (e.verified === undefined || typeof e.verified === 'boolean') && (e.turn === undefined || integer(e.turn))) && unique(c.evidence, 'seq');
}
function seqsOK(seqs, c) {
  return list(seqs, 100, integer) && seqs.length > 0 && new Set(seqs).size === seqs.length && seqs.every(seq => c.evidence.some(e => e.seq === seq));
}
function provenance(c, seqs) {
  return { runId: c.runId, sessionId: c.sessionId, turn: c.turn, at: c.now, confirmed: c.confirmed,
    evidence: seqs.map(seq => { const e = c.evidence.find(item => item.seq === seq); return { seq, type: e.type, verified: e.verified === true }; }) };
}
function draftOK(d, c) {
  return keys(d, ['lessons', 'proposal']) && list(d.lessons, 50, l => keys(l, ['kind', 'trigger', 'lesson', 'evidenceSeqs']) && KINDS.includes(l.kind) && safe(l.trigger) && safe(l.lesson) && seqsOK(l.evidenceSeqs, c)) &&
    (d.proposal === null || (keys(d.proposal, [...contentKeys, 'reason', 'evidenceSeqs', 'baseRevision']) && contentOK(d.proposal) && safe(d.proposal.reason) && integer(d.proposal.baseRevision) && seqsOK(d.proposal.evidenceSeqs, c)));
}
const result = (project, status, id = null) => ({ project, status, proposalId: id, id });
function trimProposals(proposals) {
  const pending = proposals.filter(p => p.status === 'pending');
  const history = proposals.filter(p => p.status !== 'pending').slice(-(LIMIT.proposals - pending.length));
  return [...history, ...pending];
}
function record(project, c, status, id = null) {
  const run = { runId: c.runId, sessionId: c.sessionId, turn: c.turn, at: c.now, status, proposalId: id };
  return result({ ...project, proposals: trimProposals(project.proposals), runs: [...project.runs, run].slice(-LIMIT.runs) }, status, id);
}

export function stage(project, draft, context) {
  if (!validateProject(project)) return result(project, 'invalid-project');
  try {
    if (!contextOK(context)) return result(project, 'invalid-context');
    if (project.runs.some(r => r.runId === context.runId)) return result(project, 'noop-replay');
    if (project.paused) return result(project, 'paused');
    if (!draftOK(draft, context)) return result(project, 'invalid-or-unsafe-draft');
    const lessons = draft.lessons.map(l => ({ id: randomUUID(), kind: l.kind, trigger: l.trigger, lesson: l.lesson, evidenceSeqs: [...l.evidenceSeqs], provenance: provenance(context, l.evidenceSeqs) }));
    let next = { ...project, lessons: [...project.lessons, ...lessons].slice(-LIMIT.lessons) };
    const d = draft.proposal;
    if (!d) return record(next, context, lessons.length ? 'lessons-only' : 'noop-empty');
    const current = project.skills.find(s => s.name === d.name);
    if ((current?.revision ?? 0) !== d.baseRevision) return record(next, context, 'stale-base');
    if (current?.status === 'archived') return record(next, context, 'held-archived');
    if (current && sameContent(current, d)) return record(next, context, 'noop-content');
    const existing = project.proposals.find(p => p.status === 'pending' && p.name === d.name);
    if (existing && existing.baseRevision === d.baseRevision && sameContent(existing, d) && existing.confirmed === context.confirmed) {
      if (next.mode === 'auto' && context.confirmed) {
        if (!current && (next.skills.length >= LIMIT.skills || next.skills.filter(s => s.status === 'active').length >= LIMIT.active)) return record(next, context, 'held-capacity', existing.id);
        return record(publish(next, existing, context.now), context, 'published', existing.id);
      }
      return record(next, context, 'noop-pending', existing.id);
    }
    if (!existing && project.proposals.filter(p => p.status === 'pending').length >= LIMIT.pending) return record(next, context, 'held-capacity');
    const p = { ...content(d), id: randomUUID(), reason: d.reason, baseRevision: d.baseRevision, confirmed: context.confirmed, provenance: { ...provenance(context, d.evidenceSeqs), reason: d.reason }, status: 'pending', createdAt: context.now };
    next = { ...next, proposals: [...next.proposals.map(old => old.status === 'pending' && old.name === p.name ? { ...old, status: 'superseded', updatedAt: context.now } : old), p] };
    if (next.mode === 'auto' && p.confirmed) {
      if (!current && (next.skills.length >= LIMIT.skills || next.skills.filter(s => s.status === 'active').length >= LIMIT.active)) return record(next, context, 'held-capacity', p.id);
      next = publish(next, p, context.now);
      return record(next, context, 'published', p.id);
    }
    return record(next, context, p.confirmed ? 'pending-review' : 'held-unconfirmed', p.id);
  } catch { return result(project, 'invalid-or-unsafe-draft'); }
}

function publish(project, proposal, now) {
  const current = project.skills.find(s => s.name === proposal.name);
  if (!proposal.confirmed) throw new Error('Unconfirmed proposal cannot publish');
  if ((current?.revision ?? 0) !== proposal.baseRevision) throw new Error('Stale proposal base revision');
  if (current?.status === 'archived') throw new Error('Archived skill cannot publish');
  if (current?.revision === Number.MAX_SAFE_INTEGER) throw new Error('Revision counter exhausted');
  if (!current && (project.skills.length >= LIMIT.skills || project.skills.filter(s => s.status === 'active').length >= LIMIT.active)) throw new Error('Skill capacity reached');
  const snapshot = { ...content(proposal), revision: (current?.revision ?? 0) + 1, provenance: { ...structuredClone(proposal.provenance), at: now, action: 'publish' } };
  const skill = { ...snapshot, status: 'active', revisions: [...(current?.revisions ?? []), structuredClone(snapshot)].slice(-LIMIT.revisions) };
  return { ...project, skills: [...project.skills.filter(s => s.name !== skill.name), skill], proposals: project.proposals.map(p => p.id === proposal.id ? { ...p, status: 'approved', updatedAt: now } : p.status === 'pending' && p.name === skill.name ? { ...p, status: 'stale', updatedAt: now } : p) };
}
function pending(project, id, now) {
  requireProject(project); requireDate(now);
  if (!text(id, 160)) throw new TypeError('Invalid proposal id');
  const proposal = project.proposals.find(p => p.id === id && p.status === 'pending');
  if (!proposal) throw new Error('Pending proposal not found');
  return proposal;
}
// Caller must expose this only as an explicit native human success-confirmation command,
// never an LLM tool or an implicit side effect of approve. A receipt is a source reference.
export function confirm(project, id, receipt, now) {
  const proposal = pending(project, id, now);
  if (!keys(receipt, ['commandId', 'sessionId']) || !identifier(receipt.commandId) || !identifier(receipt.sessionId)) throw new TypeError('Invalid human confirmation receipt');
  if ((project.skills.find(s => s.name === proposal.name)?.revision ?? 0) !== proposal.baseRevision) throw new Error('Stale proposal base revision');
  if (proposal.confirmed) return project;
  const humanConfirmation = { commandId: receipt.commandId, sessionId: receipt.sessionId, at: now };
  return { ...project, proposals: project.proposals.map(p => p.id === id ? { ...p, confirmed: true, updatedAt: now, provenance: { ...p.provenance, confirmed: true, humanConfirmation } } : p) };
}
export function approve(project, id, now) {
  const proposal = pending(project, id, now);
  return publish(project, proposal, now);
}
export function reject(project, id, now) {
  pending(project, id, now);
  return { ...project, proposals: project.proposals.map(p => p.id === id ? { ...p, status: 'rejected', updatedAt: now } : p) };
}
export function rollback(project, skillName, revision, now) {
  requireProject(project); requireDate(now);
  if (!name(skillName) || !integer(revision) || revision === 0) throw new TypeError('Invalid rollback target');
  const skill = project.skills.find(s => s.name === skillName);
  const old = skill?.revisions.find(r => r.revision === revision);
  if (!old) throw new Error('Retained revision not found');
  if (skill.revision === Number.MAX_SAFE_INTEGER) throw new Error('Revision counter exhausted');
  const snapshot = { ...content(old), revision: skill.revision + 1, provenance: { ...structuredClone(old.provenance), at: now, action: 'rollback', sourceRevision: revision } };
  const updated = { ...snapshot, status: skill.status, revisions: [...skill.revisions, structuredClone(snapshot)].slice(-LIMIT.revisions) };
  return { ...project, skills: project.skills.map(s => s.name === skillName ? updated : s), proposals: project.proposals.map(p => p.name === skillName && p.status === 'pending' ? { ...p, status: 'stale', updatedAt: now } : p) };
}
function setArchived(project, skillName, now, status) {
  requireProject(project); requireDate(now);
  if (!name(skillName)) throw new TypeError('Invalid skill name');
  const skill = project.skills.find(s => s.name === skillName);
  if (!skill) throw new Error('Skill not found');
  if (status === 'active' && skill.status !== 'active' && project.skills.filter(s => s.status === 'active').length >= LIMIT.active) throw new Error('Skill capacity reached');
  return { ...project, skills: project.skills.map(s => s.name === skillName ? { ...s, status } : s), proposals: project.proposals.map(p => p.name === skillName && p.status === 'pending' ? { ...p, status: 'stale', updatedAt: now } : p) };
}
export const archive = (project, skillName, now) => setArchived(project, skillName, now, 'archived');
export const restore = (project, skillName, now) => setArchived(project, skillName, now, 'active');

export function summary(project) {
  requireProject(project);
  return { root: project.root, mode: project.mode, paused: project.paused, counts: { skills: project.skills.filter(s => s.status === 'active').length, archived: project.skills.filter(s => s.status === 'archived').length, pending: project.proposals.filter(p => p.status === 'pending').length, lessons: project.lessons.length, runs: project.runs.length }, pending: project.proposals.filter(p => p.status === 'pending').map(p => ({ id: p.id, name: p.name, baseRevision: p.baseRevision, confirmed: p.confirmed })), skills: project.skills.map(s => ({ name: s.name, revision: s.revision, status: s.status })) };
}

export function renderSkill(skill) {
  if (!skillOK(skill) || skill.status !== 'active') throw new TypeError('Invalid or archived skill');
  const bullet = xs => xs.length ? xs.map(s => `- ${s}`).join('\n') : '- None recorded.';
  const p = skill.provenance;
  return `# ${skill.name}\n\n${skill.description}\n\n## Trigger\n${skill.trigger}\n\n## Steps\n${bullet(skill.steps)}\n\n## Pitfalls\n${bullet(skill.pitfalls)}\n\n## Checks\n${bullet(skill.checks)}\n\n## Version\nRevision ${skill.revision}${p.reason ? `\nReason: ${p.reason}` : ''}\n\n## Provenance\nSession: ${p.sessionId}; run: ${p.runId}; turn: ${p.turn}; recorded: ${p.at}\n${p.evidence.map(e => `- session:${p.sessionId}#event:${e.seq} (${e.type}, ${e.verified ? 'verified' : 'unverified'})`).join('\n')}${p.action === 'rollback' ? `\nRollback source revision: ${p.sourceRevision}` : ''}${p.humanConfirmation ? `\nHuman confirmation: session:${p.humanConfirmation.sessionId}#command:${p.humanConfirmation.commandId}; ${p.humanConfirmation.at}` : ''}\n`;
}
