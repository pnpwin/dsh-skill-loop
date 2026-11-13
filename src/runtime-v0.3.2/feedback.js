import { createHash } from 'node:crypto';
import { redact } from './core.js';

// Pure, additive feedback state, independent of legacy projection.js.
// knownSkills: [{name, revision, content?:string, bodyHash?:sha256hex,
//                provider?:string}]. `renderedContent` aliases `content`.
// content is the exact renderSkill BODY, not an XML tool wrapper. bodyHash can
// stand in for a caller-retained historical body; conflicting hashes fail closed.
// Exposure: {key,sessionId,seq,sourceSeqs,callId,name,revision,provider,via,
//            loaded,match,bodyHash}. loaded != used/helpful; match is only body
// identity against caller snapshots, never a lookup in the current provider.
const own = (value, key) => value !== null && typeof value === 'object'
  && Object.hasOwn(value, key) ? value[key] : undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = text => createHash('sha256').update(text).digest('hex');
const clean = (value, limit = 1000) => typeof value === 'string' ? redact(value).slice(0, limit) : '';
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !value.includes('\0') && redact(value) === value ? value : null;
const name = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value) ? value : null;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null;
const finiteTurn = value => integer(value) ? value : null;

function hidden(data, message = data) {
  const forbidden = ['plugin', 'synthetic', 'system', 'system-prompt', 'developer', 'internal', 'private'];
  return [data, message].some(value => own(value, 'synthetic') === true
    || own(value, 'private') === true || own(value, 'visibility') === 'private'
    || forbidden.includes(own(own(value, 'source'), 'kind')));
}

function visible(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.slice(0, 100).flatMap(block => own(block, 'type') === 'text'
    && typeof own(block, 'text') === 'string' ? [block.text] : []).join('\n');
}

function unescapeXML(text) {
  let valid = true;
  const decoded = text.replace(/&([^;\s]+);/gu, (all, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(named, entity)) return named[entity];
    const code = /^#\d+$/u.test(entity) ? Number(entity.slice(1))
      : /^#x[\da-f]+$/iu.test(entity) ? Number.parseInt(entity.slice(2), 16) : NaN;
    if (Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
    valid = false;
    return all;
  });
  // A bare ampersand is not XML-escaped native output.
  if (/&(?![^;\s]+;)/u.test(text)) valid = false;
  return valid ? decoded : null;
}

function loadedBody(text, expectedName, allowPlain) {
  if (typeof text !== 'string' || text.length > 100000) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('<skill_content')) {
    if (!allowPlain || /<\/?skill_(?:content|resources|instructions)\b/u.test(trimmed)) return null;
    return { name: expectedName, provider: null, body: text };
  }
  const outer = /^<skill_content\s+([^>]+)>([\s\S]*)<\/skill_content>$/u.exec(trimmed);
  if (!outer) return null;
  const attributes = [...outer[1].matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)];
  if (outer[1].replace(/([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu, '').trim()) return null;
  const attrs = Object.fromEntries(attributes.map(match => [match[1], unescapeXML(match[2] ?? match[3])]));
  if (attributes.length !== Object.keys(attrs).length || Object.keys(attrs).some(key => !['name', 'provider'].includes(key))) return null;
  const loadedName = name(attrs.name);
  if (!loadedName || loadedName !== expectedName || (attrs.provider !== undefined && !id(attrs.provider))) return null;
  const inner = /^\s*<skill_resources>[\s\S]*?<\/skill_resources>\s*<skill_instructions>([\s\S]*)<\/skill_instructions>\s*$/u.exec(outer[2]);
  if (!inner) return null;
  // Native dsh-skill joins wrapper lines with '\n' and inserts the body
  // VERBATIM. Remove exactly one paired framing newline, never trim the body or
  // decode its literal entities. A legacy escaped alternative is matched only
  // against an exact caller body and is explicitly labeled in selection.
  const framed = inner[1];
  const body = framed.startsWith('\n') && framed.endsWith('\n') ? framed.slice(1, -1) : framed;
  return { name: loadedName, provider: attrs.provider ?? null, body,
    escapedBody: body.includes('&lt;!-- ACE-MANIFEST ') ? unescapeXML(body) : null };
}

function observation(state, entry) {
  return { ...state, observations: [...state.observations, entry].slice(-60) };
}

function exposure(state, { seq, sourceSeqs, callId, skillName, via, text }) {
  const loaded = loadedBody(text, skillName, via === 'invocation');
  const body = loaded?.body;
  // No raw body is persisted. Only a sanitized preview plus a complete-body
  // fingerprint survives, and secret-bearing bodies cannot earn identity credit.
  const secretBody = typeof body === 'string' && redact(body) !== body
    || typeof loaded?.escapedBody === 'string' && redact(loaded.escapedBody) !== loaded.escapedBody;
  const fingerprint = value => !secretBody && typeof value === 'string' && value.length > 0 ? hash(value) : null;
  const bodyHash = fingerprint(body);
  const escapedBodyHash = loaded?.escapedBody !== body ? fingerprint(loaded?.escapedBody) : null;
  const record = { key: hash(`${state.sessionId ?? ''}\0${seq}\0${callId ?? ''}`).slice(0, 32),
    sessionId: state.sessionId, seq, sourceSeqs, callId, name: skillName,
    provider: loaded?.provider ?? null, via, loaded: loaded !== null, bodyHash, escapedBodyHash };
  const next = observation(state, { seq, type: via === 'tool' ? 'tool/result' : 'user/message',
    turn: state.currentTurn, text: secretBody ? '[REDACTED]' : clean(body ?? '') });
  return { ...next, exposures: [...state.exposures, record].slice(-50) };
}

export function initialFeedback(header, inheritedEventCount = 0) {
  const cutoff = integer(inheritedEventCount) ? inheritedEventCount : 0;
  return { version: 1, sessionId: id(own(header, 'id') ?? own(header, 'sessionId')),
    inheritedEventCount: cutoff, currentTurn: null, lastSeq: cutoff - 1,
    observations: [], pendingCalls: {}, exposures: [] };
}

export function foldFeedback(state, event) {
  const seq = own(event, 'seq');
  if (!integer(seq) || seq < state.inheritedEventCount || seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: seq };
  const type = own(event, 'type');
  const data = own(event, 'data');
  if (!object(data) || hidden(data)) return next;
  if (type === 'turn/start') return { ...next, currentTurn: finiteTurn(own(data, 'turn')), pendingCalls: {} };
  if (type === 'turn/end') return { ...next, currentTurn: null, pendingCalls: {} };
  if (type === 'tool/call') {
    if (!['skill', 'functions.skill'].includes(own(data, 'name'))) return next;
    const callId = id(own(data, 'callId'));
    let args = own(data, 'arguments');
    if (!callId || typeof args !== 'string' || args.length > 4000) return next;
    try { args = JSON.parse(args); } catch { return next; }
    const skillName = name(own(args, 'name'));
    if (!skillName) return next;
    const entry = { seq, name: skillName, turn: finiteTurn(own(data, 'turn')) };
    return { ...next, pendingCalls: Object.fromEntries([...Object.entries(state.pendingCalls)
      .filter(([key]) => key !== callId), [callId, entry]].slice(-20)) };
  }
  if (type === 'tool/result') {
    const message = own(data, 'message');
    const callId = id(own(message, 'toolCallId'));
    const call = callId ? own(state.pendingCalls, callId) : null;
    if (!call) return next;
    next.pendingCalls = Object.fromEntries(Object.entries(state.pendingCalls).filter(([key]) => key !== callId));
    const source = own(message, 'source');
    if (hidden(data, message) || own(message, 'isError') === true || own(data, 'error')
      || call.turn !== finiteTurn(own(data, 'turn'))
      || (own(source, 'kind') !== undefined && own(source, 'kind') !== 'tool')
      || (own(source, 'callId') !== undefined && own(source, 'callId') !== callId)) return next;
    return exposure(next, { seq, sourceSeqs: [call.seq, seq], callId, skillName: call.name,
      via: 'tool', text: visible(own(message, 'content')) });
  }
  if (type === 'user/message') {
    const source = own(data, 'source');
    if (own(data, 'role') !== 'user' || own(source, 'kind') !== 'skill-invocation'
      || own(source, 'form') !== 'instructions') return next;
    const skillName = name(own(source, 'name'));
    if (!skillName) return next;
    return exposure(next, { seq, sourceSeqs: [seq], callId: null, skillName,
      via: 'invocation', text: visible(own(data, 'content')) });
  }
  if (type === 'assistant/message') {
    const message = own(data, 'message');
    if (hidden(data, message)) return next;
    const usage = own(data, 'usage');
    const selected = Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']
      .filter(key => integer(own(usage, key))).map(key => [key, usage[key]]));
    return Object.keys(selected).length ? observation(next, { seq, type, turn: finiteTurn(own(data, 'turn')), usage: selected }) : next;
  }
  if (type === 'request/context' || type === 'request/header') {
    const config = type === 'request/context' ? data : own(own(data, 'header'), 'config');
    const provider = clean(own(config, 'provider'), 100);
    const model = clean(own(config, 'model'), 100);
    return provider || model ? observation(next, { seq, type, turn: state.currentTurn, provider, model }) : next;
  }
  return next;
}

function snapshotMatch(record, knownSkills) {
  if (!record.loaded || !record.bodyHash) return null;
  for (const [bodyHash, encoding] of [[record.bodyHash, 'raw'], [record.escapedBodyHash, 'xml-escaped']]) {
    if (!bodyHash) continue;
    const matches = knownSkills.slice(0, 200).filter(snapshot => {
      if (own(snapshot, 'name') !== record.name || !integer(own(snapshot, 'revision')) || snapshot.revision === 0) return false;
      const content = own(snapshot, 'content') ?? own(snapshot, 'renderedContent');
      const suppliedHash = own(snapshot, 'bodyHash');
      if (content !== undefined && (typeof content !== 'string' || content.length > 100000 || redact(content) !== content)) return false;
      if (own(snapshot, 'provider') !== undefined && !id(snapshot.provider)) return false;
      const calculated = typeof content === 'string' ? hash(content) : null;
      if (suppliedHash !== undefined && (!digest(suppliedHash) || (calculated && suppliedHash !== calculated))) return false;
      if ((calculated ?? digest(suppliedHash)) !== bodyHash) return false;
      const provider = own(snapshot, 'provider');
      return record.provider === null || (typeof provider === 'string' && record.provider === provider);
    });
    if (!matches.length) continue;
    const revisions = new Set(matches.map(snapshot => snapshot.revision));
    const providers = new Set(matches.map(snapshot => own(snapshot, 'provider') ?? null));
    return revisions.size === 1 && providers.size === 1 ? { snapshot: matches[0], bodyHash, encoding } : null;
  }
  return null;
}

export function selectExposures(state, { floor = 0, endSeq = state.lastSeq, knownSkills = [] } = {}) {
  const cutoff = Math.max(state.inheritedEventCount, integer(floor) ? floor : 0);
  const end = integer(endSeq) ? endSeq : state.lastSeq;
  return state.exposures.filter(record => record.seq <= end && record.sessionId === state.sessionId
    && record.sourceSeqs.every(seq => seq >= cutoff && seq <= end)).slice(-50).map(record => {
    const match = snapshotMatch(record, Array.isArray(knownSkills) ? knownSkills : []);
    const { escapedBodyHash, ...publicRecord } = record;
    return { ...publicRecord, sourceSeqs: [...record.sourceSeqs], revision: match?.snapshot.revision ?? null,
      bodyHash: match?.bodyHash ?? record.bodyHash, bodyEncoding: match?.encoding ?? null,
      match: match ? 'matched' : 'unknown' };
  });
}

export function episodeId(root, sessionId, endSeq) {
  return hash(`${root}\0${sessionId}\0${endSeq}`).slice(0, 32);
}

export function feedbackForBatch(batch, { root, sessionId, exposures = [], watermark = -1 } = {}) {
  const endSeq = own(batch, 'lastSeq');
  const turn = own(batch, 'turn');
  if (!integer(endSeq) || !integer(turn) || typeof root !== 'string' || !id(sessionId)) return null;
  const rawEvidence = Array.isArray(own(batch, 'evidence')) ? batch.evidence : [];
  const allowed = ['user/message', 'assistant/message', 'tool/result', 'job/settled'];
  const evidence = rawEvidence.filter(entry => integer(own(entry, 'seq')) && entry.seq <= endSeq && !hidden(entry)
    && allowed.includes(own(entry, 'type')) && typeof own(entry, 'text') === 'string')
    .slice(-60).map(entry => ({ seq: entry.seq, type: entry.type, text: clean(entry.text),
      verified: own(entry, 'verified') === true, ...(integer(own(entry, 'turn')) ? { turn: entry.turn } : {}) }));
  const anchors = Array.isArray(own(batch, 'confirmationSeqs')) ? batch.confirmationSeqs : [];
  const unique = new Set(anchors);
  const validAnchors = anchors.length > 0 && anchors.length <= 60 && unique.size === anchors.length
    && anchors.every(seq => integer(seq) && evidence.some(entry => entry.seq === seq && entry.text
      && (entry.turn === undefined || entry.turn === turn)
      && (entry.type === 'user/message' || (['tool/result', 'job/settled'].includes(entry.type) && entry.verified))
      && rawEvidence.some(raw => own(raw, 'seq') === seq && own(raw, 'text') === entry.text)))
    && new Set(evidence.map(entry => entry.seq)).size === evidence.length;
  const verified = own(batch, 'confirmed') === true && validAnchors;
  const contradicted = own(batch, 'confirmed') === false
    && ['correction', 'antipattern'].includes(own(batch, 'signal'))
    && evidence.some(entry => entry.type === 'user/message' && (entry.turn === undefined || entry.turn === turn));
  // Only explicit fields from a host-created batch establish outcome; neither
  // exposure, token usage, model judgments, nor text that merely says "passed" do.
  const selectedExposures = (Array.isArray(exposures) ? exposures : []).filter(record => object(record)
    && own(record, 'sessionId') === sessionId && integer(own(record, 'seq')) && record.seq <= endSeq
    && Array.isArray(own(record, 'sourceSeqs')) && record.sourceSeqs.length > 0 && record.sourceSeqs.length <= 2
    && new Set(record.sourceSeqs).size === record.sourceSeqs.length
    && record.sourceSeqs.every(seq => integer(seq) && seq <= endSeq)).slice(-50).map(record => ({
    key: clean(own(record, 'key'), 200), sessionId, seq: record.seq, sourceSeqs: [...record.sourceSeqs],
    callId: id(own(record, 'callId')), name: name(own(record, 'name')), provider: id(own(record, 'provider')),
    revision: integer(own(record, 'revision')) && record.revision > 0 ? record.revision : null,
    via: own(record, 'via') === 'invocation' ? 'invocation' : 'tool', loaded: own(record, 'loaded') === true,
    match: own(record, 'match') === 'matched' && own(record, 'loaded') === true
      && name(own(record, 'name')) && integer(own(record, 'revision')) && record.revision > 0
      && digest(own(record, 'bodyHash')) ? 'matched' : 'unknown', bodyHash: digest(own(record, 'bodyHash')),
    bodyEncoding: ['raw', 'xml-escaped'].includes(own(record, 'bodyEncoding')) ? record.bodyEncoding : null,
  }));
  return { episodeId: episodeId(root, sessionId, endSeq), scope: clean(root, 4096), sessionId, turn, endSeq,
    outcome: verified ? 'verified' : contradicted ? 'contradicted' : 'unverified', evidence,
    confirmationSeqs: verified ? [...anchors] : [], exposures: selectedExposures,
    alreadyProcessed: Number.isSafeInteger(watermark) && endSeq <= watermark };
}
