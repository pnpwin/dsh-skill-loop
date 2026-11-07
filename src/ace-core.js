import { createHash } from 'node:crypto';
import { hasSecret, validateProject as validateLegacyProject } from './core.js';

// All state transformations are pure. Only the host may supply context/receipts;
// model output is limited to lessons and the strictly parsed delta grammar below.
const LIMIT = { skills: 100, active: 50, proposals: 100, pending: 50, lessons: 200, runs: 100, revisions: 10 };
const SECTIONS = ['step', 'pitfall', 'check'];
const CONTENT = ['name', 'description', 'trigger', 'entries'];
const PROPOSAL = [...CONTENT, 'id', 'status', 'baseRevision', 'delta', 'candidateHash', 'confirmed', 'evidenceStatus', 'evaluationStatus', 'evaluation', 'provenance', 'reason', 'pubReason', 'createdAt', 'updatedAt'];
const UNSAFE = /(?:ignore|override|disregard)\s+(?:(?:all|any|the|previous|prior|system|developer)\s+){0,4}(?:instructions|polic(?:y|ies)|permissions|rules)|(?:bypass|disable|circumvent)\s+(?:(?:all|any|the|safety|security|permission)\s+){0,3}(?:approvals?|permissions?|safeguards?|checks?|restrictions?|sandbox|polic(?:y|ies))|(?:exfiltrate|steal)\s+(?:secrets?|credentials?|tokens?)|danger-full-access|--no-sandbox|игнорир\S*\s+(?:инструкц|правил)|обой\S*\s+(?:разрешени|ограничени|подтверждени)/i;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x));
const keys = (x, allowed, required = allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(x, k));
const text = (x, max = 4000, empty = false) => typeof x === 'string' && x.length <= max && (empty || x.trim().length > 0) && !x.includes('\0');
const safe = (x, max = 4000) => text(x, max) && !hasSecret(x) && !UNSAFE.test(x);
const FRAMING = /<\s*\/?\s*(?:skill_instructions|system(?:-reminder)?|developer|tool(?:_result)?|assistant|user)(?=[\s/>]|$)|<\|[^>]*\|>/i;
const generatedSafe = (x, max = 4000) => safe(x, max) && !FRAMING.test(x);
const escapeBody = x => x.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const integer = x => Number.isSafeInteger(x) && x >= 0;
const positive = x => integer(x) && x > 0;
const identifier = x => text(x, 160) && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(x) && !hasSecret(x);
const eventType = x => text(x, 80) && /^[A-Za-z0-9_./:-]+$/.test(x);
const nameOK = x => text(x, 64) && x.trim() === x && /^learned-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(x);
const date = x => text(x, 40) && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x));
const list = (x, max, check) => Array.isArray(x) && x.length <= max && Array.from(x).every(check);
const unique = (xs, key) => new Set(xs.map(x => key ? x[key] : x)).size === xs.length;
const seqs = x => list(x, 100, integer) && x.length > 0 && unique(x);
const hashOK = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const clone = x => structuredClone(x);
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const idFor = (runId, kind, index) => `${kind}-${digest([runId, kind, index]).slice(0, 32)}`;
const result = (project, status, id = null) => ({ project, status, proposalId: id, id });
const pickContent = x => ({ name: x.name, description: x.description, trigger: x.trigger, entries: clone(x.entries) });
const semanticEntry = e => ({ id: e.id, section: e.section, text: e.text, entryVersion: e.entryVersion, protected: e.protected, status: e.status });
const semanticContent = x => ({ name: x.name, description: x.description, trigger: x.trigger, entries: x.entries.map(semanticEntry) });

export function entryHash(entry) { return digest(semanticEntry(entry)); }
export function snapshotHash(skill) {
  return skill === null ? null : digest({ ...semanticContent(skill), revision: skill.revision, status: skill.status ?? 'active' });
}
export function candidateHash(value) { return digest({ ...semanticContent(value), baseRevision: value.baseRevision }); }
export function contentView(value) {
  if (!object(value)) throw new TypeError('Invalid content');
  if (!Array.isArray(value.entries)) return { name: value.name, description: value.description, trigger: value.trigger, steps: [...value.steps], pitfalls: [...value.pitfalls], checks: [...value.checks] };
  const active = value.entries.filter(e => e.status === 'active');
  return { name: value.name, description: value.description, trigger: value.trigger,
    steps: active.filter(e => e.section === 'step').map(e => e.text),
    pitfalls: active.filter(e => e.section === 'pitfall').map(e => e.text),
    checks: active.filter(e => e.section === 'check').map(e => e.text) };
}

const refOK = x => keys(x, ['seq', 'type', 'verified']) && integer(x.seq) && eventType(x.type) && typeof x.verified === 'boolean';
const humanOK = x => keys(x, ['commandId', 'sessionId', 'at']) && identifier(x.commandId) && identifier(x.sessionId) && date(x.at);
function sourcePublicationOK(x, root) {
  const required = ['method', 'proposalId', 'candidateHash', 'scope', 'targetRevision', 'evidenceStatus', 'evaluationStatus', 'at'];
  return keys(x, [...required, 'evaluation'], required) && ['manual', 'auto-additive', 'auto-evaluated'].includes(x.method) && identifier(x.proposalId) && hashOK(x.candidateHash) &&
    text(x.scope, 4096) && !hasSecret(x.scope) && (root === undefined || x.scope === root) && positive(x.targetRevision) && x.evidenceStatus === 'verified' && date(x.at) &&
    ['not-run', 'passed', 'failed'].includes(x.evaluationStatus) &&
    (x.evaluation === undefined ? x.evaluationStatus === 'not-run' : evaluationOK(x.evaluation) && x.evaluation.candidateHash === x.candidateHash && x.evaluation.scope === x.scope && x.evaluationStatus === (x.evaluation.passed ? 'passed' : 'failed')) &&
    (x.method !== 'auto-evaluated' || x.evaluationStatus === 'passed') && (x.method !== 'auto-additive' || x.evaluationStatus !== 'failed');
}
function provenanceOK(x, root) {
  return keys(x, ['runId', 'sessionId', 'turn', 'at', 'confirmed', 'evidence', 'action', 'sourceRevision', 'humanConfirmation', 'reason', 'sourcePublication'], ['runId', 'sessionId', 'turn', 'at', 'confirmed', 'evidence']) &&
    identifier(x.runId) && identifier(x.sessionId) && integer(x.turn) && date(x.at) && typeof x.confirmed === 'boolean' && list(x.evidence, 100, refOK) && x.evidence.length > 0 &&
    (x.reason === undefined || safe(x.reason)) && (x.action === undefined || ['publish', 'rollback', 'pin'].includes(x.action)) &&
    (x.sourceRevision === undefined || integer(x.sourceRevision)) && (x.humanConfirmation === undefined || (x.confirmed && humanOK(x.humanConfirmation))) &&
    (x.sourcePublication === undefined || x.confirmed && ['publish', 'rollback', 'pin'].includes(x.action) && sourcePublicationOK(x.sourcePublication, root));
}
function entryOK(x) {
  return keys(x, ['id', 'section', 'text', 'entryVersion', 'protected', 'status', 'evidenceRefs']) && identifier(x.id) && SECTIONS.includes(x.section) && safe(x.text) && positive(x.entryVersion) &&
    typeof x.protected === 'boolean' && ['active', 'archived'].includes(x.status) && seqs(x.evidenceRefs);
}
function contentOK(x) {
  // The legacy 10k cap concerns readable content, not host IDs/history metadata.
  return nameOK(x.name) && safe(x.description, 240) && safe(x.trigger, 800) && Array.isArray(x.entries) && x.entries.length <= 128 && Array.from(x.entries).every(entryOK) && unique(x.entries, 'id') &&
    x.entries.filter(e => e.status === 'active').length <= 32 && x.entries.some(e => e.status === 'active' && e.section === 'step') && JSON.stringify(contentView(x)).length <= 10000;
}
function snapshotOK(x, root) {
  if (!keys(x, [...CONTENT, 'revision', 'provenance']) || !contentOK(x) || !positive(x.revision) || !provenanceOK(x.provenance, root) || !x.provenance.confirmed) return false;
  const source = x.provenance.sourcePublication;
  return source === undefined || (x.provenance.action === 'publish' ?
    source.targetRevision === x.revision && source.at === x.provenance.at && source.candidateHash === candidateHash({ ...x, baseRevision: source.targetRevision - 1 }) : source.targetRevision < x.revision);
}
function retainedOriginsOK(skill) {
  return skill.revisions.every(snapshot => {
    const source = snapshot.provenance.sourcePublication;
    if (!source) return true;
    const origin = skill.revisions.find(r => r.revision === source.targetRevision);
    // An evicted origin remains a labelled exact-hash source, NOT a current
    // semantic attestation. Recheck its content/record whenever it is retained.
    return !origin || origin.provenance.action === 'publish' && source.candidateHash === candidateHash({ ...origin, baseRevision: source.targetRevision - 1 }) &&
      (origin.provenance.sourcePublication === undefined || JSON.stringify(source) === JSON.stringify(origin.provenance.sourcePublication));
  });
}
function skillOK(x, root) {
  return keys(x, [...CONTENT, 'revision', 'status', 'provenance', 'revisions']) && snapshotOK({ ...pickContent(x), revision: x.revision, provenance: x.provenance }, root) && ['active', 'archived'].includes(x.status) &&
    list(x.revisions, LIMIT.revisions, r => snapshotOK(r, root)) && x.revisions.length > 0 && x.revisions.every((r, i) => r.name === x.name && r.revision <= x.revision && (!i || r.revision > x.revisions[i - 1].revision)) &&
    x.revisions.at(-1).revision === x.revision && JSON.stringify(pickContent(x)) === JSON.stringify(pickContent(x.revisions.at(-1))) && JSON.stringify(x.provenance) === JSON.stringify(x.revisions.at(-1).provenance) && retainedOriginsOK(x);
}
function operationOK(x) {
  if (!object(x)) return false;
  switch (x.op) {
    case 'create': return keys(x, ['op', 'description', 'trigger', 'entries']) && generatedSafe(x.description, 240) && generatedSafe(x.trigger, 800) && list(x.entries, 8, e => keys(e, ['section', 'text']) && SECTIONS.includes(e.section) && generatedSafe(e.text, 1200)) && x.entries.filter(e => e.section === 'step').length >= 2;
    case 'insert': return keys(x, ['op', 'section', 'text', 'afterId']) && SECTIONS.includes(x.section) && generatedSafe(x.text, 1200) && (x.afterId === null || identifier(x.afterId));
    case 'replace': return keys(x, ['op', 'entryId', 'expectedHash', 'text']) && identifier(x.entryId) && hashOK(x.expectedHash) && generatedSafe(x.text, 1200);
    case 'archive': return keys(x, ['op', 'entryId', 'expectedHash']) && identifier(x.entryId) && hashOK(x.expectedHash);
    default: return false;
  }
}
function deltaOK(x) {
  const required = ['name', 'baseRevision', 'baseHash', 'reason', 'evidenceSeqs', 'operations'];
  if (!keys(x, [...required, 'baseProposalId', 'baseProposalHash'], required)) return false;
  const refinement = Object.hasOwn(x, 'baseProposalId') || Object.hasOwn(x, 'baseProposalHash');
  if (refinement && (!identifier(x.baseProposalId) || !hashOK(x.baseProposalHash))) return false;
  return nameOK(x.name) && integer(x.baseRevision) && (x.baseHash === null || hashOK(x.baseHash)) && generatedSafe(x.reason) && seqs(x.evidenceSeqs) &&
    list(x.operations, 4, operationOK) && x.operations.length > 0 &&
    (refinement ? !x.operations.some(o => o.op === 'create') && (x.baseRevision === 0 ? x.baseHash === null : hashOK(x.baseHash)) :
      x.operations.some(o => o.op === 'create') ? x.operations.length === 1 && x.baseRevision === 0 && x.baseHash === null : x.baseRevision > 0 && hashOK(x.baseHash)) &&
    unique(x.operations.filter(o => ['replace', 'archive'].includes(o.op)), 'entryId');
}
function metricsOK(x, depth = 0) {
  if (depth > 8) return false;
  if (x === null || typeof x === 'boolean') return true;
  if (typeof x === 'number') return Number.isFinite(x);
  if (typeof x === 'string') return text(x, 1000, true) && !hasSecret(x);
  if (Array.isArray(x)) return list(x, 100, y => metricsOK(y, depth + 1));
  return object(x) && Object.keys(x).length <= 100 && Object.entries(x).every(([k, v]) => text(k, 160) && !hasSecret(k) && metricsOK(v, depth + 1));
}
function evaluationOK(x) {
  return keys(x, ['candidateHash', 'caseSetId', 'caseSetHash', 'scope', 'passed', 'runId', 'at', 'metrics']) && hashOK(x.candidateHash) && identifier(x.caseSetId) && hashOK(x.caseSetHash) && text(x.scope, 4096) && !hasSecret(x.scope) && typeof x.passed === 'boolean' && identifier(x.runId) && date(x.at) && object(x.metrics) && metricsOK(x.metrics) && JSON.stringify(x.metrics).length <= 10000;
}
function proposalOK(x, root) {
  return keys(x, PROPOSAL, PROPOSAL.filter(k => !['evaluation', 'pubReason'].includes(k))) && contentOK(x) && identifier(x.id) && ['pending', 'approved', 'rejected', 'superseded', 'stale'].includes(x.status) && integer(x.baseRevision) &&
    (x.delta === null || (deltaOK(x.delta) && x.delta.name === x.name && x.delta.baseRevision === x.baseRevision)) && hashOK(x.candidateHash) && x.candidateHash === candidateHash(x) && typeof x.confirmed === 'boolean' &&
    ['verified', 'unverified', 'contradicted'].includes(x.evidenceStatus) && x.confirmed === (x.evidenceStatus === 'verified') && ['not-run', 'passed', 'failed'].includes(x.evaluationStatus) &&
    (x.evaluation === undefined ? x.evaluationStatus === 'not-run' : evaluationOK(x.evaluation) && x.evaluation.candidateHash === x.candidateHash && x.evaluation.scope === root && x.evaluationStatus === (x.evaluation.passed ? 'passed' : 'failed')) &&
    provenanceOK(x.provenance, root) && x.provenance.sourcePublication === undefined && x.confirmed === x.provenance.confirmed && (x.delta === null || x.delta.evidenceSeqs.every(seq => x.provenance.evidence.some(e => e.seq === seq))) && safe(x.reason) &&
    (x.pubReason === undefined || ['auto-additive', 'auto-evaluated', 'manual', 'held-unconfirmed', 'held-evaluation', 'held-review', 'held-paused', 'held-migrated', 'held-capacity', 'held-archived', 'held-stale'].includes(x.pubReason)) && date(x.createdAt) && date(x.updatedAt);
}
function lessonOK(x, root) {
  return keys(x, ['id', 'kind', 'trigger', 'lesson', 'evidenceSeqs', 'provenance']) && identifier(x.id) && ['success', 'correction', 'antipattern', 'intervention'].includes(x.kind) && safe(x.trigger) && safe(x.lesson) && list(x.evidenceSeqs, 100, integer) && x.evidenceSeqs.length > 0 && provenanceOK(x.provenance, root) && x.provenance.sourcePublication === undefined && x.evidenceSeqs.every(seq => x.provenance.evidence.some(e => e.seq === seq));
}
const runOK = x => keys(x, ['runId', 'sessionId', 'turn', 'at', 'status', 'proposalId']) && identifier(x.runId) && identifier(x.sessionId) && integer(x.turn) && date(x.at) && eventType(x.status) && (x.proposalId === null || identifier(x.proposalId));

export function newProject(root) {
  if (!text(root, 4096) || hasSecret(root)) throw new TypeError('Invalid project root');
  return { schemaVersion: 2, root, mode: 'review', paused: false, skills: [], proposals: [], runs: [], lessons: [], watermarks: {} };
}
function ownershipOK(skills, proposals) {
  const owners = new Map(skills.flatMap(s => s.entries.map(e => [e.id, s.name])));
  return proposals.every(p => p.entries.every(e => !owners.has(e.id) || owners.get(e.id) === p.name));
}
function retainedPublicationsOK(project) {
  const proposals = new Map(project.proposals.map(p => [p.id, p]));
  return project.skills.every(skill => skill.revisions.every(snapshot => {
    const source = snapshot.provenance.sourcePublication;
    if (!source) return true;
    const proposal = proposals.get(source.proposalId);
    // Proposal history is optional once evicted; the bounded source record is
    // self-contained. When present, require it to describe that exact publication.
    return !proposal || proposal.status === 'approved' && proposal.name === skill.name && proposal.candidateHash === source.candidateHash &&
      proposal.baseRevision + 1 === source.targetRevision && proposal.pubReason === source.method && proposal.updatedAt === source.at &&
      proposal.evidenceStatus === source.evidenceStatus && proposal.evaluationStatus === source.evaluationStatus && JSON.stringify(proposal.evaluation) === JSON.stringify(source.evaluation);
  }));
}
export function validateProject(x) {
  try {
    return keys(x, ['schemaVersion', 'root', 'mode', 'paused', 'skills', 'proposals', 'runs', 'lessons', 'watermarks']) && x.schemaVersion === 2 && text(x.root, 4096) && !hasSecret(x.root) && ['review', 'auto'].includes(x.mode) && typeof x.paused === 'boolean' &&
      list(x.skills, LIMIT.skills, s => skillOK(s, x.root)) && unique(x.skills, 'name') && unique(x.skills.flatMap(s => s.entries), 'id') && x.skills.filter(s => s.status === 'active').length <= LIMIT.active &&
      list(x.proposals, LIMIT.proposals, p => proposalOK(p, x.root)) && unique(x.proposals, 'id') && x.proposals.filter(p => p.status === 'pending').length <= LIMIT.pending && unique(x.proposals.filter(p => p.status === 'pending'), 'name') &&
      ownershipOK(x.skills, x.proposals) && retainedPublicationsOK(x) &&
      x.proposals.filter(p => p.status === 'pending' && p.delta?.baseProposalId).every(p => x.proposals.some(parent => parent.id === p.delta.baseProposalId && parent.id !== p.id && parent.status === 'superseded' && parent.name === p.name && parent.baseRevision === p.baseRevision && parent.candidateHash === p.delta.baseProposalHash)) &&
      list(x.lessons, LIMIT.lessons, l => lessonOK(l, x.root)) && unique(x.lessons, 'id') && list(x.runs, LIMIT.runs, runOK) && unique(x.runs, 'runId') && object(x.watermarks) && Object.keys(x.watermarks).length <= 4096 && Object.entries(x.watermarks).every(([k, v]) => identifier(k) && integer(v));
  } catch { return false; }
}
function requireProject(project) { if (!validateProject(project)) throw new TypeError('Invalid project'); }
function requireDate(now) { if (!date(now)) throw new TypeError('Invalid timestamp'); }
function legacyContent(x) {
  return { name: x.name, description: x.description, trigger: x.trigger, entries: SECTIONS.flatMap((section, s) => x[['steps', 'pitfalls', 'checks'][s]].map((t, i) => ({
    id: `legacy-${digest([x.name, section, i]).slice(0, 32)}`, section, text: t, entryVersion: x.revision ?? 1, protected: false, status: 'active', evidenceRefs: [...new Set(x.provenance.evidence.map(e => e.seq))]
  }))) };
}
export function migrateProject(input) {
  if (input?.schemaVersion === 2) { requireProject(input); return clone(input); }
  if (!validateLegacyProject(input)) throw new TypeError('Invalid legacy project');
  const source = clone(input);
  const skills = source.skills.map(s => ({ ...legacyContent(s), revision: s.revision, status: s.status, provenance: s.provenance,
    revisions: s.revisions.map(r => ({ ...legacyContent(r), revision: r.revision, provenance: r.provenance })) }));
  const proposals = source.proposals.map(p => {
    const converted = { ...legacyContent(p), id: p.id, status: p.status, baseRevision: p.baseRevision, delta: null, confirmed: p.confirmed, evidenceStatus: p.confirmed ? 'verified' : 'unverified', evaluationStatus: 'not-run',
      provenance: p.provenance, reason: p.reason, pubReason: 'held-migrated', createdAt: p.createdAt, updatedAt: p.updatedAt ?? p.createdAt };
    return { ...converted, candidateHash: candidateHash(converted) };
  });
  const migrated = { ...newProject(source.root), mode: source.mode, paused: source.paused, skills, proposals, runs: source.runs, lessons: source.lessons };
  requireProject(migrated);
  return migrated;
}

function contextOK(c) {
  return keys(c, ['runId', 'sessionId', 'turn', 'evidence', 'confirmed', 'now', 'confirmationSeqs', 'episodeEndSeq', 'outcome'], ['runId', 'sessionId', 'turn', 'evidence', 'confirmed', 'now']) && identifier(c.runId) && identifier(c.sessionId) && integer(c.turn) && typeof c.confirmed === 'boolean' && date(c.now) &&
    list(c.evidence, 1000, e => keys(e, ['seq', 'type', 'text', 'verified', 'turn'], ['seq', 'type', 'text']) && integer(e.seq) && eventType(e.type) && text(e.text, 20000, true) && (e.verified === undefined || typeof e.verified === 'boolean') && (e.turn === undefined || integer(e.turn))) && unique(c.evidence, 'seq') &&
    (c.confirmationSeqs === undefined || (list(c.confirmationSeqs, 100, integer) && unique(c.confirmationSeqs) && c.confirmationSeqs.every(seq => c.evidence.some(e => e.seq === seq)))) &&
    (c.episodeEndSeq === undefined || integer(c.episodeEndSeq) && c.evidence.every(e => e.seq <= c.episodeEndSeq)) &&
    (c.outcome === undefined || ['verified', 'unverified', 'contradicted'].includes(c.outcome));
}
const cites = (xs, c) => seqs(xs) && xs.every(seq => c.evidence.some(e => e.seq === seq));
function provenance(c, xs) {
  // `confirmed` is a native host fact. The evidence.verified bit describes tool
  // results, not human-success messages; it must not veto a known human receipt.
  const confirmed = c.confirmed && (c.confirmationSeqs ?? []).every(seq => xs.includes(seq));
  return { runId: c.runId, sessionId: c.sessionId, turn: c.turn, at: c.now, confirmed,
    evidence: xs.map(seq => { const e = c.evidence.find(e => e.seq === seq); return { seq, type: e.type, verified: e.verified === true }; }) };
}
function draftOK(d, c) {
  return keys(d, ['lessons', 'proposal']) && list(d.lessons, 50, l => keys(l, ['kind', 'trigger', 'lesson', 'evidenceSeqs']) && ['success', 'correction', 'antipattern', 'intervention'].includes(l.kind) && generatedSafe(l.trigger) && generatedSafe(l.lesson) && cites(l.evidenceSeqs, c)) &&
    (d.proposal === null || deltaOK(d.proposal) && cites(d.proposal.evidenceSeqs, c));
}
class Held extends Error { constructor(status) { super(status); this.status = status; } }
function applyDelta(current, delta, runId, baseProposal = null) {
  if ((current?.revision ?? 0) !== delta.baseRevision || snapshotHash(current ?? null) !== delta.baseHash) throw new Held('stale-base');
  if (current?.status === 'archived') throw new Held('held-archived');
  if (delta.baseProposalId && (!baseProposal || baseProposal.id !== delta.baseProposalId || baseProposal.candidateHash !== delta.baseProposalHash || baseProposal.name !== delta.name || baseProposal.baseRevision !== delta.baseRevision || !['pending', 'superseded'].includes(baseProposal.status))) throw new Held('stale-pending');
  const source = delta.baseProposalId ? baseProposal : current;
  let candidate = source ? pickContent(source) : { name: delta.name };
  const original = new Map((source?.entries ?? []).map(e => [e.id, e]));
  const changed = new Set();
  const assigned = (section, t, index) => ({ id: idFor(runId, 'entry', index), section, text: t, entryVersion: 1, protected: false, status: 'active', evidenceRefs: [...delta.evidenceSeqs] });
  delta.operations.forEach((op, i) => {
    if (op.op === 'create') {
      if (current) throw new Error('Create target exists');
      candidate = { name: delta.name, description: op.description, trigger: op.trigger, entries: op.entries.map((e, j) => assigned(e.section, e.text, `${i}:${j}`)) };
      return;
    }
    if (!source) throw new Error('Missing target');
    if (op.op === 'insert') {
      const entry = assigned(op.section, op.text, i);
      if (op.afterId === null) {
        const last = candidate.entries.findLastIndex(e => e.section === op.section);
        candidate.entries.splice(last < 0 ? candidate.entries.length : last + 1, 0, entry);
      } else {
        const anchor = original.get(op.afterId);
        if (!anchor || anchor.section !== op.section || anchor.status !== 'active' || changed.has(op.afterId)) throw new Error('Invalid insertion anchor');
        const index = candidate.entries.findIndex(e => e.id === op.afterId);
        candidate.entries.splice(index + 1, 0, entry);
      }
      return;
    }
    const before = original.get(op.entryId);
    if (!before || before.status !== 'active' || before.protected || entryHash(before) !== op.expectedHash || changed.has(op.entryId)) throw new Error('Invalid or protected entry');
    if (before.entryVersion === Number.MAX_SAFE_INTEGER) throw new Error('Entry version exhausted');
    changed.add(op.entryId);
    const next = { ...before, entryVersion: before.entryVersion + 1, evidenceRefs: [...delta.evidenceSeqs], ...(op.op === 'archive' ? { status: 'archived' } : { text: op.text }) };
    candidate.entries[candidate.entries.findIndex(e => e.id === before.id)] = next;
  });
  if (candidate.entries.length > 128 || candidate.entries.filter(e => e.status === 'active').length > 32) throw new Held('held-capacity');
  if (!contentOK(candidate)) throw new Error('Invalid candidate');
  return candidate;
}
function trimProposals(proposals) {
  const pending = proposals.filter(p => p.status === 'pending');
  // A live refinement needs its immediate base preview for later exact reapply.
  // Ancestors of superseded previews need not remain once they are not live.
  const required = new Set(pending.map(p => p.delta?.baseProposalId).filter(Boolean));
  const history = proposals.filter(p => p.status !== 'pending');
  const protectedHistory = history.filter(p => required.has(p.id));
  const room = LIMIT.proposals - pending.length - protectedHistory.length;
  const selected = new Set([...protectedHistory, ...(room > 0 ? history.filter(p => !required.has(p.id)).slice(-room) : [])].map(p => p.id));
  return [...history.filter(p => selected.has(p.id)), ...pending];
}
function record(project, c, status, id = null) {
  const watermarks = c.episodeEndSeq === undefined ? project.watermarks : { ...project.watermarks, [c.sessionId]: c.episodeEndSeq };
  const next = { ...project, proposals: trimProposals(project.proposals), watermarks,
    runs: [...project.runs, { runId: c.runId, sessionId: c.sessionId, turn: c.turn, at: c.now, status, proposalId: id }].slice(-LIMIT.runs) };
  requireProject(next);
  return result(next, status, id);
}
export function stage(project, draft, c) {
  if (!validateProject(project)) return result(project, 'invalid-project');
  try {
    if (!contextOK(c)) return result(project, 'invalid-context');
    if (project.runs.some(r => r.runId === c.runId) || project.proposals.some(p => p.provenance.runId === c.runId) || project.lessons.some(l => l.provenance.runId === c.runId) ||
      project.skills.some(s => s.provenance.runId === c.runId || s.revisions.some(r => r.provenance.runId === c.runId)) ||
      c.episodeEndSeq !== undefined && Object.hasOwn(project.watermarks, c.sessionId) && c.episodeEndSeq <= project.watermarks[c.sessionId]) return result(project, 'noop-replay');
    if (project.paused) return result(project, 'paused');
    if (c.episodeEndSeq !== undefined && !Object.hasOwn(project.watermarks, c.sessionId) && Object.keys(project.watermarks).length >= 4096) return result(project, 'held-capacity');
    if (!draftOK(draft, c)) return result(project, 'invalid-or-unsafe-draft');
    const d = draft.proposal;
    const current = d && project.skills.find(s => s.name === d.name);
    // Apply/validate the whole delta before retaining even its accompanying lessons.
    const baseProposal = d?.baseProposalId ? project.proposals.find(p => p.id === d.baseProposalId && p.status === 'pending') : null;
    const candidate = d ? applyDelta(current, d, c.runId, baseProposal) : null;
    const lessons = draft.lessons.map((l, i) => ({ ...clone(l), id: idFor(c.runId, 'lesson', i), provenance: provenance(c, l.evidenceSeqs) }));
    let next = { ...project, lessons: [...project.lessons, ...lessons].slice(-LIMIT.lessons) };
    if (!d) return record(next, c, lessons.length ? 'lessons-only' : 'noop-empty');
    const prov = { ...provenance(c, d.evidenceSeqs), reason: d.reason };
    const candidateValue = { ...candidate, baseRevision: d.baseRevision };
    const evidenceStatus = prov.confirmed ? 'verified' : c.outcome === 'contradicted' ? 'contradicted' : 'unverified';
    const hash = candidateHash(candidateValue);
    if (current && JSON.stringify(semanticContent(current)) === JSON.stringify(semanticContent(candidate))) return record(next, c, 'noop-content');
    const existing = project.proposals.find(p => p.status === 'pending' && p.name === d.name);
    // Never back-publish a migrated legacy candidate, even if a later run matches it.
    if (existing?.delta && existing.candidateHash === hash && existing.confirmed === prov.confirmed && existing.evidenceStatus === evidenceStatus) {
      const attempt = next.mode === 'auto' ? autoPublish(next, existing.id, c.now) : result(next, existing.confirmed ? 'noop-pending' : 'held-unconfirmed', existing.id);
      return record(attempt.project, c, attempt.status, existing.id);
    }
    if (!existing && project.proposals.filter(p => p.status === 'pending').length >= LIMIT.pending) return record(next, c, 'held-capacity');
    const p = { ...candidateValue, id: idFor(c.runId, 'proposal', 0), delta: clone(d), candidateHash: hash, status: 'pending', confirmed: prov.confirmed, evidenceStatus,
      evaluationStatus: 'not-run', provenance: prov, reason: d.reason, pubReason: prov.confirmed ? 'held-review' : 'held-unconfirmed', createdAt: c.now, updatedAt: c.now };
    next = { ...next, proposals: [...next.proposals.map(old => old.status === 'pending' && old.name === p.name ? { ...old, status: 'superseded', updatedAt: c.now } : old), p] };
    next.proposals = trimProposals(next.proposals);
    const attempt = next.mode === 'auto' ? autoPublish(next, p.id, c.now) : result(next, p.confirmed ? 'pending-review' : 'held-unconfirmed', p.id);
    return record(attempt.project, c, attempt.status, p.id);
  } catch (error) { return result(project, error instanceof Held ? error.status : 'invalid-or-unsafe-draft'); }
}

function pending(project, id, now) {
  requireProject(project); requireDate(now);
  if (!identifier(id)) throw new TypeError('Invalid proposal id');
  const p = project.proposals.find(p => p.id === id && p.status === 'pending');
  if (!p) throw new Error('Pending proposal not found');
  return p;
}
function currentFor(project, p) {
  const current = project.skills.find(s => s.name === p.name);
  if ((current?.revision ?? 0) !== p.baseRevision || p.delta && snapshotHash(current ?? null) !== p.delta.baseHash) throw new Error('Stale proposal base revision/hash');
  if (current?.status === 'archived') throw new Error('Archived skill cannot publish');
  if (current?.entries.some(before => before.protected && !p.entries.some(after => JSON.stringify(before) === JSON.stringify(after)))) throw new Error('Protected entry cannot change');
  // A stored preview must still be exactly the delta's deterministic result.
  if (p.delta) {
    const parent = p.delta.baseProposalId ? project.proposals.find(old => old.id === p.delta.baseProposalId && old.id !== p.id) : null;
    const expected = applyDelta(current, p.delta, p.provenance.runId, parent);
    if (candidateHash({ ...expected, baseRevision: p.baseRevision }) !== p.candidateHash || JSON.stringify(pickContent(expected)) !== JSON.stringify(pickContent(p))) throw new Error('Candidate does not match delta');
  }
  return current;
}
function invalidate(proposals, skillName, now) { return proposals.map(p => p.name === skillName && p.status === 'pending' ? { ...p, status: 'stale', updatedAt: now } : p); }
function revisionOf(current, content, provenance) {
  if (current?.revision === Number.MAX_SAFE_INTEGER) throw new Error('Revision counter exhausted');
  const snapshot = { ...pickContent(content), revision: (current?.revision ?? 0) + 1, provenance: clone(provenance) };
  return { ...snapshot, status: current?.status ?? 'active', revisions: [...(current?.revisions ?? []), clone(snapshot)].slice(-LIMIT.revisions) };
}
function publish(project, p, now, pubReason) {
  if (!p.confirmed || p.evidenceStatus !== 'verified') throw new Error('Unconfirmed proposal cannot publish');
  const current = currentFor(project, p);
  if (!current && (project.skills.length >= LIMIT.skills || project.skills.filter(s => s.status === 'active').length >= LIMIT.active)) throw new Error('Skill capacity reached');
  const sourcePublication = { method: pubReason, proposalId: p.id, candidateHash: p.candidateHash, scope: project.root,
    targetRevision: (current?.revision ?? 0) + 1, evidenceStatus: p.evidenceStatus, evaluationStatus: p.evaluationStatus,
    ...(p.evaluation === undefined ? {} : { evaluation: clone(p.evaluation) }), at: now };
  const skill = revisionOf(current, p, { ...p.provenance, at: now, action: 'publish', sourcePublication });
  const next = { ...project, skills: current ? project.skills.map(s => s.name === skill.name ? skill : s) : [...project.skills, skill],
    proposals: project.proposals.map(old => old.id === p.id ? { ...old, status: 'approved', pubReason, updatedAt: now } : old.name === p.name && old.status === 'pending' ? { ...old, status: 'stale', updatedAt: now } : old) };
  requireProject(next);
  return next;
}
export function confirm(project, id, receipt, now) {
  const p = pending(project, id, now);
  if (!keys(receipt, ['commandId', 'sessionId']) || !identifier(receipt.commandId) || !identifier(receipt.sessionId)) throw new TypeError('Invalid human confirmation receipt');
  currentFor(project, p);
  if (p.confirmed) return project;
  const humanConfirmation = { ...receipt, at: now };
  return { ...project, proposals: project.proposals.map(old => old.id === id ? { ...old, confirmed: true, evidenceStatus: 'verified', pubReason: 'held-review', updatedAt: now, provenance: { ...old.provenance, confirmed: true, humanConfirmation } } : old) };
}
export function approve(project, id, now) { return publish(project, pending(project, id, now), now, 'manual'); }
export function reject(project, id, now) {
  pending(project, id, now);
  return { ...project, proposals: project.proposals.map(p => p.id === id ? { ...p, status: 'rejected', updatedAt: now } : p) };
}
export function attachEvaluation(project, id, receipt, now) {
  const p = pending(project, id, now);
  currentFor(project, p);
  if (!evaluationOK(receipt) || receipt.candidateHash !== p.candidateHash || receipt.scope !== project.root) throw new TypeError('Invalid or mismatched evaluation receipt');
  return { ...project, proposals: project.proposals.map(old => old.id === id ? { ...old, evaluation: clone(receipt), evaluationStatus: receipt.passed ? 'passed' : 'failed', updatedAt: now } : old) };
}
function additive(p, current) {
  if (!p.delta) return false;
  if (!current) {
    const active = p.entries.filter(e => e.status === 'active');
    return active.length <= 8 && active.filter(e => e.section === 'step').length >= 2 && active.every(e => e.text.length <= 1200 && !e.protected);
  }
  // Gate the complete preview against ACTIVE, never just the latest operations.
  // Otherwise an insertion onto a destructive pending preview could bypass eval.
  if (p.description !== current.description || p.trigger !== current.trigger) return false;
  const oldIds = new Set(current.entries.map(e => e.id));
  const retained = p.entries.filter(e => oldIds.has(e.id));
  if (JSON.stringify(retained.map(semanticEntry)) !== JSON.stringify(current.entries.map(semanticEntry))) return false;
  const added = p.entries.filter(e => !oldIds.has(e.id));
  if (added.length > 2 || added.some(e => e.status !== 'active' || e.protected || e.text.length > 1200)) return false;
  return SECTIONS.every(section => {
    const before = current.entries.filter(e => e.section === section).map(e => e.id);
    const after = p.entries.filter(e => e.section === section).map(e => e.id);
    return before.every((id, i) => after[i] === id);
  });
}
export function autoPublish(project, id, now) {
  const p = pending(project, id, now);
  const held = status => result({ ...project, proposals: project.proposals.map(old => old.id === id ? { ...old, pubReason: status, updatedAt: now } : old) }, status, id);
  if (project.paused) return held('held-paused');
  if (project.mode !== 'auto') return held('held-review');
  if (!p.confirmed || p.evidenceStatus !== 'verified') return held('held-unconfirmed');
  if (!p.delta) return held('held-migrated');
  let current;
  try { current = currentFor(project, p); } catch (error) {
    if (/Archived/.test(error.message)) return held('held-archived');
    if (/Stale|stale-pending/.test(error.message)) return held('held-stale');
    throw error;
  }
  const soft = additive(p, current);
  if (p.evaluationStatus === 'failed' || !soft && !(p.evaluationStatus === 'passed' && p.evaluation?.passed && p.evaluation.candidateHash === p.candidateHash && p.evaluation.scope === project.root)) return held('held-evaluation');
  if (!current && (project.skills.length >= LIMIT.skills || project.skills.filter(s => s.status === 'active').length >= LIMIT.active)) return held('held-capacity');
  return result(publish(project, p, now, soft ? 'auto-additive' : 'auto-evaluated'), 'published', id);
}
export function rollback(project, skillName, revision, now) {
  requireProject(project); requireDate(now);
  if (!nameOK(skillName) || !positive(revision)) throw new TypeError('Invalid rollback target');
  const skill = project.skills.find(s => s.name === skillName);
  const old = skill?.revisions.find(r => r.revision === revision);
  if (!old) throw new Error('Retained revision not found');
  const updated = revisionOf(skill, old, { ...old.provenance, at: now, action: 'rollback', sourceRevision: revision });
  return { ...project, skills: project.skills.map(s => s.name === skillName ? updated : s), proposals: invalidate(project.proposals, skillName, now) };
}
function setArchived(project, skillName, now, status) {
  requireProject(project); requireDate(now);
  if (!nameOK(skillName)) throw new TypeError('Invalid skill name');
  const skill = project.skills.find(s => s.name === skillName);
  if (!skill) throw new Error('Skill not found');
  if (skill.status === status) return project;
  if (status === 'active' && project.skills.filter(s => s.status === 'active').length >= LIMIT.active) throw new Error('Skill capacity reached');
  return { ...project, skills: project.skills.map(s => s.name === skillName ? { ...s, status } : s), proposals: invalidate(project.proposals, skillName, now) };
}
export const archive = (project, skillName, now) => setArchived(project, skillName, now, 'archived');
export const restore = (project, skillName, now) => setArchived(project, skillName, now, 'active');
export function pin(project, skillName, entryId, protectedBoolean, now) {
  requireProject(project); requireDate(now);
  if (!nameOK(skillName) || !identifier(entryId) || typeof protectedBoolean !== 'boolean') throw new TypeError('Invalid pin target');
  const skill = project.skills.find(s => s.name === skillName);
  const entry = skill?.entries.find(e => e.id === entryId);
  if (!entry) throw new Error('Entry not found');
  if (entry.protected === protectedBoolean) return project;
  if (entry.entryVersion === Number.MAX_SAFE_INTEGER) throw new Error('Entry version exhausted');
  const content = { ...skill, entries: skill.entries.map(e => e.id === entryId ? { ...e, protected: protectedBoolean, entryVersion: e.entryVersion + 1 } : e) };
  const updated = revisionOf(skill, content, { ...skill.provenance, at: now, action: 'pin' });
  return { ...project, skills: project.skills.map(s => s.name === skillName ? updated : s), proposals: invalidate(project.proposals, skillName, now) };
}
export function summary(project) {
  requireProject(project);
  return { root: project.root, mode: project.mode, paused: project.paused, counts: { skills: project.skills.filter(s => s.status === 'active').length, archived: project.skills.filter(s => s.status === 'archived').length, pending: project.proposals.filter(p => p.status === 'pending').length, lessons: project.lessons.length, runs: project.runs.length },
    pending: project.proposals.filter(p => p.status === 'pending').map(p => ({ id: p.id, name: p.name, baseRevision: p.baseRevision, confirmed: p.confirmed, evidenceStatus: p.evidenceStatus, evaluationStatus: p.evaluationStatus, candidateHash: p.candidateHash })),
    skills: project.skills.map(s => ({ name: s.name, revision: s.revision, status: s.status })) };
}
function renderBody(value, { prefix = '', footer, manifest }) {
  const sections = SECTIONS.map((section, i) => {
    const entries = value.entries.filter(e => e.section === section && e.status === 'active');
    return `## ${['Steps', 'Pitfalls', 'Checks'][i]}\n${entries.length ? entries.map(e => `- [${e.id}] ${escapeBody(e.text)}`).join('\n') : '- None recorded.'}`;
  }).join('\n\n');
  return `${prefix}# ${value.name}\n\n${escapeBody(value.description)}\n\n## Trigger\n${escapeBody(value.trigger)}\n\n${sections}\n\n${footer}\n<!-- ACE-MANIFEST ${JSON.stringify(manifest)} -->\n`;
}
/** Structurally safe evaluation-only instructions, not an active/confirmed skill. */
export function renderCandidate(proposal, root = proposal?.evaluation?.scope) {
  if (!proposalOK(proposal, root) || proposal.status !== 'pending') throw new TypeError('Invalid evaluation candidate');
  const manifest = { schemaVersion: 2, name: proposal.name, proposalId: proposal.id, baseRevision: proposal.baseRevision,
    candidateHash: proposal.candidateHash, evaluationOnly: true, evidenceStatus: proposal.evidenceStatus, evaluationStatus: proposal.evaluationStatus };
  return renderBody(proposal, { prefix: 'EVALUATION ONLY — pending candidate, not published or active. Evidence and quality are independent.\n\n',
    footer: `Pending proposal ${proposal.id}; base revision ${proposal.baseRevision}; evidence ${proposal.evidenceStatus}; evaluation ${proposal.evaluationStatus}. Read skill_loop read ${proposal.id} for proposal history.`, manifest });
}
export function renderSkill(skill) {
  if (!skillOK(skill) || skill.status !== 'active') throw new TypeError('Invalid or archived skill');
  const manifest = { schemaVersion: 2, name: skill.name, revision: skill.revision, snapshotHash: snapshotHash(skill) };
  // Full origin hashes/receipts stay behind read/show, not in model context.
  return renderBody(skill, { footer: `Revision ${skill.revision}. Read skill_loop read ${skill.name} for history and provenance.`, manifest });
}
