import { redact } from './core.js';

// JSON-only observation reducer. A completed work window is the interval after
// the previous turn/end through the latest turn/end, including its leading user
// message. selectBatch is pure; the caller deduplicates its lastSeq.
const MAX_EVENTS = 60;
const MAX_TEXT = 1000;
const MAX_COMMANDS = 20;
const own = (object, key) => object !== null && typeof object === 'object'
  && Object.hasOwn(object, key) ? object[key] : undefined;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const turnId = value => typeof value === 'string' && value.length <= 200
  ? value : Number.isSafeInteger(value) ? value : null;
const clean = text => redact(text).slice(0, MAX_TEXT);

function visibleText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.slice(0, 100).flatMap(block => own(block, 'type') === 'text'
    && typeof own(block, 'text') === 'string' ? [block.text] : []).join('\n');
}

function synthetic(data, message = data) {
  const blocked = ['plugin', 'system', 'developer', 'synthetic', 'internal'];
  return own(data, 'synthetic') === true || own(message, 'synthetic') === true
    || blocked.includes(own(own(message, 'source'), 'kind'))
    || blocked.includes(own(own(data, 'source'), 'kind'));
}

function humanSuccess(text) {
  const value = text.trim();
  if (!value || value.length > 180 || /[?？"'`“”«»‘’\n<>]/u.test(value)) return false;
  if (/(?:^|[^\p{L}])(?:no|not|never|cannot|without|не|нет|никогда|без)(?=$|[^\p{L}])/iu.test(value)) return false;
  const courtesy = '(?:thanks[,.! ]*|thank you[,.! ]*|great[,.! ]*|yes[,.! ]*|отлично[,.! ]*|спасибо[,.! ]*|да[,.! ]*)';
  const success = '(?:it works|that works|everything works|all tests (?:pass|passed)|tests passed|fixed|вс[её] работает|теперь работает|работает|получилось|тесты прошли|вс[её] исправлено)';
  return new RegExp(`^${courtesy}*${success}[.! ]*(?:${courtesy})*$`, 'iu').test(value);
}

function humanSignal(text) {
  if (humanSuccess(text)) return 'success';
  // Quoted instructions and pasted system messages are not feedback signals.
  if (/^\s*["'`“«>]|<\/?(?:system|developer|tool|assistant|system-reminder)\b/iu.test(text)) return null;
  if (/(?:^|[^\p{L}])(?:stop|cancel|wait|стоп|останови|подожди|отмени)(?=$|[^\p{L}])/iu.test(text)) return 'intervention';
  if (/\b(?:never do|avoid doing|do not repeat|don.t repeat)\b|не повторяй|больше (?:так )?не|никогда не/iu.test(text)) return 'antipattern';
  if (/\b(?:wrong|incorrect|instead|please fix|actually|correction|don.t|doesn.t work|not (?:working|work|pass|fixed))\b|(?:^|\s)no[,!]|исправ[ььте]|неверно|неправильно|вместо|не работает|не получилось|не прошли|ошибк|не так/iu.test(text)) return 'correction';
  return null;
}

function commandInfo(data) {
  const name = own(data, 'name');
  if (!['bash', 'functions.bash', 'terminal_send', 'functions.terminal_send'].includes(name)) return null;
  let args = own(data, 'arguments');
  if (typeof args !== 'string' || args.length > 32000) return null;
  try { args = JSON.parse(args); } catch { return null; }
  if (!record(args)) return null;
  const terminal = name.endsWith('terminal_send');
  if (terminal && own(args, 'submit') === false) return null;
  const command = own(args, terminal ? 'text' : 'command');
  if (typeof command !== 'string' || command.length > 4000) return null;
  // Deliberately no build-only confirmation: compiling is not evidence that a
  // behavioral fix works. Also reject shell chains/pipes/substitutions: an echo
  // or a later successful command must never mask the actual test exit status.
  const simple = command.trim();
  const safe = !/[\n\r;&|`$<>]/u.test(simple)
    && !/\s--(?:help|version|list(?:Tests)?|passWithNoTests|if-present)(?:[=\s]|$)/u.test(simple);
  const recognized = safe && (
    /^(?:node\s+--test|bun\s+test)(?:\s|$)/u.test(simple)
    || /^(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test(?::[\w-]+)?|typecheck|type-check)(?:\s|$)/u.test(simple)
    || /^(?:(?:npx|pnpm\s+exec|yarn\s+exec)\s+)?(?:vitest\s+run|jest)(?:\s|$)/u.test(simple)
    || /^(?:(?:npx|pnpm\s+exec|yarn\s+exec)\s+)?tsc\b(?=[\s\S]*\s--noEmit(?:\s|$))/u.test(simple)
  );
  return { name, command: clean(command), recognized,
    foreground: terminal || own(args, 'run_in_background') !== true,
    // Never retain raw secrets or truncated command text for label matching.
    nativeLabel: !terminal && clean(command) === command ? command : null };
}

function resultOutcome(data, message, text, native = null) {
  const error = own(message, 'isError') === true || Boolean(own(data, 'error'));
  const meta = own(data, 'meta');
  const codes = ['exitCode', 'exit_code'].map(key => own(meta, key))
    .filter(value => typeof value === 'number');
  const textCodes = [...text.matchAll(/(?:exit(?:ed)?(?:\s+with)?\s+code|exit_code|exitCode)\s*[:=]?\s*(-?\d+)/giu)]
    .map(match => Number(match[1]));
  const zeroTests = /\bno tests?(?: found)?\b|\b0 tests?\b|^\s*#?\s*(?:tests?|pass(?:ed)?)\s*[:=]?\s*0\s*$|\bTests:\s*(?:0 passed|\d+ skipped,\s*\d+ total)/imu.test(text);
  const withoutZeroFailures = text
    .replace(/\b0\s+(?:tests?\s+)?(?:failed|failures?|errors?|exceptions?|cancelled|canceled|timeouts?)\b/giu, '')
    .replace(/\b(?:fail|failed|failures?|errors?|exceptions?|cancelled|canceled|timeouts?)\s*[:=]?\s*0\b/giu, '');
  const failed = error || [...codes, ...textCodes].some(code => code !== 0)
    || native?.failed === true;
  const badOutput = zeroTests
    || /\b(?:fail(?:ed|ure|ures)?|errors?|exception|traceback|cancelled|canceled|timed out|timeout)\b|ошибк|провален/iu.test(withoutZeroFailures);
  return { failed, verified: !failed && !badOutput
    && (native !== null ? native.verified : codes.includes(0)) };
}

export function initialProjection(header, inheritedEventCount = 0) {
  const cutoff = Number.isSafeInteger(inheritedEventCount) && inheritedEventCount >= 0
    ? inheritedEventCount : 0;
  const sessionId = own(header, 'sessionId') ?? own(header, 'id');
  return {
    version: 1,
    sessionId: typeof sessionId === 'string' ? sessionId.slice(0, 200) : null,
    inheritedEventCount: cutoff,
    currentTurn: null,
    lastSeq: cutoff - 1,
    windowStartSeq: cutoff,
    completed: null,
    events: [],
    commands: {},
  };
}

export function foldProjection(state, event) {
  const seq = own(event, 'seq');
  const type = own(event, 'type');
  const data = own(event, 'data');
  if (!Number.isSafeInteger(seq) || seq < state.inheritedEventCount || seq <= state.lastSeq) return state;
  const next = { ...state, lastSeq: seq };
  if (!record(data)) return next;
  const eventTurn = turnId(own(data, 'turn'));
  if (type === 'turn/start') {
    if (eventTurn === null) return next;
    return { ...next, currentTurn: eventTurn, completed: null,
      windowStartSeq: state.completed ? state.completed.endSeq + 1 : state.windowStartSeq,
      commands: {} };
  }
  if (type === 'turn/end') {
    if (eventTurn === null || eventTurn !== state.currentTurn) return next;
    return { ...next, currentTurn: null, commands: {},
      completed: { turn: eventTurn, startSeq: state.windowStartSeq, endSeq: seq } };
  }
  let text = '';
  let verified = false;
  let invalidates = false;
  let confirmationSeqs;
  let evidenceTurn = eventTurn ?? state.currentTurn;
  if (type === 'user/message') {
    if (own(data, 'role') !== 'user' || own(own(data, 'source'), 'kind') !== 'user' || synthetic(data)) return next;
    text = visibleText(own(data, 'content'));
    if (/<\/?(?:system|developer|tool|assistant|system-reminder)\b/iu.test(text)) return next;
  } else if (type === 'assistant/message') {
    const message = own(data, 'message');
    if (!record(message) || synthetic(data, message)) return next;
    if (eventTurn !== state.currentTurn || state.currentTurn === null) return next;
    text = visibleText(own(message, 'content'));
  } else if (type === 'tool/call') {
    if (state.currentTurn === null || eventTurn !== state.currentTurn || synthetic(data)) return next;
    const callId = own(data, 'callId');
    const info = commandInfo(data);
    if (!info || typeof callId !== 'string' || callId.length > 200) return next;
    const commands = Object.fromEntries([...Object.entries(state.commands)
      .filter(([id]) => id !== callId), [callId, { ...info, seq, turn: eventTurn }]].slice(-MAX_COMMANDS));
    return { ...next, commands };
  } else if (type === 'job/settled') {
    const callId = own(own(data, 'toolCall'), 'callId');
    const call = typeof callId === 'string' ? own(state.commands, callId) : null;
    // Foreground bash only: a settlement must precede its result in this turn.
    // Jobs returned to the background (or from another owner/call) cannot attest.
    if (!call || !call.foreground || call.nativeLabel === null || call.native
      || state.currentTurn === null || call.turn !== state.currentTurn
      || (eventTurn !== null && eventTurn !== state.currentTurn)
      || typeof state.sessionId !== 'string' || !state.sessionId
      || own(data, 'owner') !== state.sessionId || own(data, 'kind') !== 'bash'
      || own(data, 'label') !== call.nativeLabel
      || own(own(data, 'toolCall'), 'rootCallId') !== callId
      || typeof own(data, 'jobId') !== 'string' || !data.jobId || data.jobId.length > 200
      || seq <= call.seq || synthetic(data)) return next;
    const detail = own(data, 'detail');
    const nativeZero = own(data, 'status') === 'completed' && own(data, 'cause') === 'producer'
      && own(data, 'producerReported') === true && typeof detail === 'string'
      && /^exit code: 0$/u.test(detail);
    const nativeFailed = ['failed', 'cancelled', 'canceled'].includes(own(data, 'status'))
      || (typeof detail === 'string' && /^exit code: -?\d+$/u.test(detail) && detail !== 'exit code: 0');
    next.commands = { ...state.commands, [callId]: { ...call, native: { seq, verified: nativeZero, failed: nativeFailed } } };
    verified = call.recognized && nativeZero;
    invalidates = nativeFailed || (call.recognized && !nativeZero);
    text = `$ ${call.command}\n${String(own(data, 'status') ?? '')}: ${typeof detail === 'string' ? detail : 'unknown outcome'}`;
  } else if (type === 'tool/result') {
    const message = own(data, 'message');
    const callId = own(message, 'toolCallId');
    const call = typeof callId === 'string' ? own(state.commands, callId) : null;
    if (!record(message) || synthetic(data, message) || !call
      || state.currentTurn === null || eventTurn !== state.currentTurn || call.turn !== eventTurn) return next;
    text = visibleText(own(message, 'content'));
    const outcome = resultOutcome(data, message, text, call.native ?? null);
    verified = call.recognized && call.foreground && outcome.verified;
    // Unrelated successful/unknown reads and git commands are neutral. A failed
    // command or an unknown follow-up verification invalidates earlier success.
    invalidates = outcome.failed || (call.recognized && !verified);
    if (verified && call.native) confirmationSeqs = [call.native.seq, seq];
    text = `$ ${call.command}\n${text}`;
    next.commands = Object.fromEntries(Object.entries(state.commands).filter(([id]) => id !== callId));
  } else {
    return next;
  }
  if (!text.trim()) return next;
  // Redact before truncating so a credential crossing the length limit cannot
  // leak its prefix. Only visible text survives; no raw event/arguments retained.
  const entry = { seq, type, text: clean(text), verified, turn: evidenceTurn, invalidates,
    ...(confirmationSeqs ? { confirmationSeqs } : {}) };
  return { ...next, events: [...state.events, entry].slice(-MAX_EVENTS) };
}

export function selectBatch(state, { maxInputChars = 16000, force = false } = {}) {
  if (!state.completed || state.currentTurn !== null) return null;
  const limit = Number.isFinite(maxInputChars)
    ? Math.max(0, Math.min(16000, Math.floor(maxInputChars))) : 16000;
  if (limit === 0) return null;
  const { turn, startSeq, endSeq } = state.completed;
  const window = state.events.filter(entry => entry.seq >= startSeq && entry.seq <= endSeq);
  const triggers = window.flatMap(entry => {
    const signal = entry.type === 'user/message' ? humanSignal(entry.text)
      : entry.type === 'tool/result' && entry.verified ? 'success' : null;
    return signal ? [{ entry, signal }] : [];
  });
  if (!window.length || (!triggers.length && force !== true)) return null;
  const lastTrigger = triggers.at(-1) ?? { entry: window.at(-1), signal: 'intervention' };
  // Confirmation is about the final feedback/outcome, not an earlier passing
  // test followed by failure or a human correction in the same work window.
  const failuresAfter = window.some(entry => entry.seq > lastTrigger.entry.seq && entry.invalidates);
  const confirmed = lastTrigger.signal === 'success' && !failuresAfter;
  // Prefer the latest trigger under small budgets, then nearby recent context.
  // Prior-turn tail supplies what the user is confirming/correcting. It is
  // context only: never participates in triggers or confirmation above.
  const priorContext = state.events.filter(entry => entry.seq >= state.inheritedEventCount
    && entry.seq < startSeq && ['assistant/message', 'tool/result'].includes(entry.type)).slice(-6);
  const requiredSeqs = lastTrigger.entry.confirmationSeqs ?? [lastTrigger.entry.seq];
  const anchors = window.filter(entry => requiredSeqs.includes(entry.seq));
  const candidates = [lastTrigger.entry, ...anchors.filter(entry => entry !== lastTrigger.entry),
    ...window.filter(entry => entry !== lastTrigger.entry && !anchors.includes(entry)).reverse(),
    ...priorContext.reverse()];
  let remaining = limit;
  const evidence = [];
  for (const entry of candidates) {
    const prefix = `[${entry.seq} ${entry.type}] `;
    if (remaining <= prefix.length + 1) continue;
    const text = entry.text.slice(0, remaining - prefix.length - 1);
    if (!text) continue;
    // The staging core accepts only this public evidence shape.
    evidence.push({ seq: entry.seq, type: entry.type, text, verified: entry.verified, turn: entry.turn ?? turn });
    remaining -= prefix.length + text.length + 1;
  }
  if (!evidence.length) return null;
  evidence.sort((a, b) => a.seq - b.seq);
  const completeTrigger = requiredSeqs.every(seq => {
    const source = window.find(entry => entry.seq === seq);
    return source && evidence.some(entry => entry.seq === seq && entry.text === source.text);
  });
  return { turn, lastSeq: endSeq, confirmed: confirmed && completeTrigger,
    confirmationSeqs: confirmed && completeTrigger ? requiredSeqs : [], signal: lastTrigger.signal, evidence,
    text: evidence.map(entry => `[${entry.seq} ${entry.type}] ${entry.text}`).join('\n') };
}
