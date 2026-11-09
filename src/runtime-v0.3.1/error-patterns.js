// Deterministic detector of repeating tool errors with recovery (no LLM).
// Turns "same tool failed N times, then succeeded" into an antipattern lesson
// and an optional skill proposal delta. Pure functions only.

import { createHash } from 'node:crypto';
import { redact, hasSecret } from './core.js';

// Stable basis for a signature: redact, mask volatile parts, collapse space.
export function normalizeErrorText(text, { max = 400 } = {}) {
  if (typeof text !== 'string') return '';
  let out = redact(text);
  // Absolute paths first (they may contain digits and hex-looking parts).
  out = out
    .replace(/[A-Za-z]:[\\/](?:[^\s\\/]+[\\/]?)+/g, '<path>')   // C:\… or C:/…
    .replace(/(?:\/[\w.+-]+){2,}\/?/g, '<path>');               // /a/b, /a/b/c …
  // Hex substrings ≥ 8 (ids, hashes) before digit masking.
  out = out.replace(/\b(?:0x)?[0-9a-fA-F]{8,}\b/g, '#hex');
  // Any remaining digit sequences.
  out = out.replace(/\d+/g, '#');
  // Collapse whitespace.
  out = out.replace(/\s+/g, ' ').trim();
  return out.slice(0, max);
}

export function signatureOf(toolName, normalizedText) {
  return createHash('sha256')
    .update(`${toolName}\n${normalizedText}`)
    .digest('hex')
    .slice(0, 16);
}

// Pure scan of a flat event stream (ordered by seq).
// events: { seq, type: 'tool/call'|'tool/result'|'turn/end', turn, name, isError, text }
export function extractErrorPatterns(events, { minRepeats = 2 } = {}) {
  if (!Array.isArray(events) || !Number.isSafeInteger(minRepeats) || minRepeats < 1) return [];
  const resolved = [];
  // Per-turn accumulation: tool -> signature -> { count, errorSeqs, sample }
  let currentTurn = null;
  let acc = new Map();
  const reset = () => { acc = new Map(); };

  const bump = (name, text, seq) => {
    const normalized = normalizeErrorText(text);
    const signature = signatureOf(name, normalized);
    if (!acc.has(name)) acc.set(name, new Map());
    const sigs = acc.get(name);
    if (!sigs.has(signature)) sigs.set(signature, { count: 0, errorSeqs: [], sample: normalized });
    const entry = sigs.get(signature);
    entry.count += 1;
    entry.errorSeqs.push(seq);
    return entry;
  };

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.turn !== currentTurn) { currentTurn = event.turn; reset(); }
    if (event.type === 'turn/end') { reset(); continue; }
    if (event.type !== 'tool/result' || typeof event.name !== 'string') continue;
    if (event.isError === true) {
      bump(event.name, event.text, event.seq);
      continue;
    }
    // Successful result: close every signature of this tool that reached minRepeats.
    const sigs = acc.get(event.name);
    if (!sigs) continue;
    for (const [signature, entry] of [...sigs.entries()]) {
      if (entry.count < minRepeats) continue;
      resolved.push({
        signature,
        tool: event.name,
        count: entry.count,
        errorSeqs: [...entry.errorSeqs],
        recoverySeq: event.seq,
        sample: normalizeErrorText(entry.sample, { max: 300 }),
      });
      sigs.delete(signature); // one recovery closes the pattern
    }
  }
  return resolved;
}

// Build an ace.stage draft from a resolved pattern.
export function buildAntipatternDraft(pattern, { skillName, baseRevision, baseHash, reasonSuffix = '' } = {}) {
  if (!pattern || typeof pattern !== 'object') return null;
  const tool = typeof pattern.tool === 'string' ? pattern.tool : '';
  const sample = typeof pattern.sample === 'string' ? pattern.sample : '';
  const count = Number.isSafeInteger(pattern.count) ? pattern.count : 0;
  const errorSeqs = Array.isArray(pattern.errorSeqs) ? pattern.errorSeqs.filter(Number.isSafeInteger) : [];
  const recoverySeq = Number.isSafeInteger(pattern.recoverySeq) ? pattern.recoverySeq : null;
  if (!tool || count < 1 || errorSeqs.length === 0 || recoverySeq === null) return null;
  const evidenceSeqs = [...errorSeqs, recoverySeq];
  const shortSample = sample.slice(0, 160);

  const trigger = `Инструмент "${tool}" падает с повторяющейся ошибкой`.slice(0, 400);
  const lesson = `Перед повторным вызовом ${tool}: проверь условие, которое вызывает "${shortSample}"; не повторяй вызов без изменения аргументов.`.slice(0, 400);
  if ([trigger, lesson, sample, tool].some(hasSecret)) return null;

  const lessonEntry = { kind: 'antipattern', trigger, lesson, evidenceSeqs };

  let proposal = null;
  if (typeof skillName === 'string' && skillName.length > 0 && baseRevision !== 0) {
    const pitfall = `Не вызывай ${tool} повторно с теми же аргументами, пока не устранена причина ошибки "${shortSample}": сначала измени условие (путь, аргументы, состояние), затем вызывай снова.`.slice(0, 1200);
    const operations = [{ op: 'insert', section: 'pitfall', text: pitfall }];
    if (sample.trim().length > 0) {
      operations.push({
        op: 'insert', section: 'check',
        text: `Перед вызовом ${tool} проверь, что условие "${shortSample}" уже не выполняется; если выполняется — исправь его вместо повтора.`.slice(0, 1200),
      });
    }
    if (operations.some(o => hasSecret(o.text)) || hasSecret(skillName)) return null;
    proposal = {
      name: skillName,
      baseRevision,
      baseHash,
      reason: `Авто-паттерн: ${tool} ошибался ${count}× до восстановления${reasonSuffix}`.slice(0, 1200),
      evidenceSeqs,
      operations,
    };
  }

  return { lessons: [lessonEntry], proposal };
}

// Merge freshly resolved patterns into project.errorPatterns records:
// { signature, tool, count, resolvedCount, lastSeq }
export function mergeProjectPatterns(existing, fresh, { max = 50 } = {}) {
  const base = Array.isArray(existing) ? existing.filter(x => x && typeof x === 'object') : [];
  const incoming = Array.isArray(fresh) ? fresh.filter(x => x && typeof x === 'object') : [];
  const bySignature = new Map(base.map(x => [x.signature, { ...x }]));
  for (const p of incoming) {
    if (typeof p.signature !== 'string') continue;
    const old = bySignature.get(p.signature);
    if (old) {
      bySignature.set(p.signature, {
        ...old,
        count: (old.count || 0) + (p.count || 0),
        resolvedCount: (old.resolvedCount || 0) + 1,
        lastSeq: Math.max(old.lastSeq || 0, p.recoverySeq || 0),
      });
    } else {
      bySignature.set(p.signature, {
        signature: p.signature,
        tool: p.tool,
        count: p.count || 0,
        resolvedCount: 1,
        lastSeq: p.recoverySeq || 0,
      });
    }
  }
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 50;
  return [...bySignature.values()].slice(-limit);
}
