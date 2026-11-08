import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import * as legacy from '../core.js';
import * as ace from '../ace-core.js';
import { REFLECT_SYSTEM, buildReviewInput, collectReview } from '../prompts.js';
import { createAceLiteProposer } from '../review.js';
import { emptyUsage, addUsage, immutableSnapshot } from '../optimizer.js';
import { createNativeCaseRunner } from './native-case.js';

const MAX_SNAPSHOT = 32 * 1024 * 1024;
const integer = x => Number.isSafeInteger(x) && x >= 0;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const identifier = x => typeof x === 'string' && x.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/.test(x) && !legacy.hasSecret(x);
const words = value => new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 32);

function memoryFor(arm, value, root) {
  const valid = arm === 'legacy' ? legacy.validateProject(value) : arm === 'ace' && ace.validateProject(value);
  if (!valid || value.root !== root) throw new TypeError('Invalid isolated benchmark snapshot');
  return immutableSnapshot(value, MAX_SNAPSHOT);
}
function selectedSkill(project, testCase) {
  // Both arms use ONLY the public task and skill discovery metadata. Neither
  // expected checks, case IDs/families nor skill bodies form a selection oracle.
  const query = words(testCase?.input?.task ?? '');
  const scored = project.skills.filter(s => s.status === 'active').map(skill => ({ skill,
    score: [...words(skill.description + ' ' + skill.trigger)].filter(word => query.has(word)).length }));
  scored.sort((a, b) => b.score - a.score || (a.skill.name < b.skill.name ? -1 : a.skill.name > b.skill.name ? 1 : 0));
  return scored[0]?.score > 0 ? scored[0].skill : null;
}
function raceSignal(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function reportedUsage(value) {
  if (!object(value) || !integer(value.inputTokens) || !integer(value.outputTokens)) return null;
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens,
    cacheReadTokens: integer(value.cacheReadTokens) ? value.cacheReadTokens : null };
}
function estimatesFor(telemetry) {
  return [
    { method: 'review-input', unit: 'characters', value: telemetry.inputChars + telemetry.systemChars },
    { method: 'review-output', unit: 'characters', value: telemetry.outputChars },
  ];
}
function rawUsage(usage) {
  // createCandidateProposer returns a normalized accumulator, whereas the outer
  // benchmark wrapper expects raw usage. reportedCalls:0 is NOT a provider report.
  return { ...(usage.provider.reportedCalls ? { provider: { ...usage.provider } } : {}),
    ...(usage.estimates.length ? { estimates: usage.estimates.map(e => ({ ...e })) } : {}) };
}
function feedbackInput(request, root) {
  if (!object(request.case) || Object.hasOwn(request.case, 'expected') || request.case.split === 'holdout' || !object(request.observation) || typeof request.observation.passed !== 'boolean') throw new TypeError('Adaptation observation required');
  const source = request.observation.feedback;
  if (source != null && (!object(source) || source.phase && source.phase !== 'adaptation' || source.scope !== undefined && source.scope !== root)) throw new TypeError('Invalid adaptation feedback scope');
  const evidence = source?.evidence ?? [];
  if (!Array.isArray(evidence) || evidence.length > 1000 || !Array.from(evidence).every(e => object(e) && integer(e.seq) && typeof e.type === 'string' && /^[A-Za-z0-9_./:-]+$/.test(e.type) && e.type.length <= 80 && typeof e.text === 'string' && e.text.length <= 20000 && !e.text.includes('\0') && (e.verified === undefined || typeof e.verified === 'boolean')) || new Set(evidence.map(e => e.seq)).size !== evidence.length) throw new TypeError('Invalid native feedback evidence');
  const anchors = source?.confirmationSeqs ?? [];
  if (!Array.isArray(anchors) || anchors.length > 100 || !Array.from(anchors).every(integer) || new Set(anchors).size !== anchors.length || !anchors.every(seq => evidence.some(e => e.seq === seq))) throw new TypeError('Invalid native confirmation references');
  const usable = evidence.length > 0;
  // No invented session, turn, end event, or affirmative grade-count inference.
  if (usable && (!identifier(source.sessionId) || !integer(source.turn) || !integer(source.endSeq) || evidence.some(e => e.seq > source.endSeq))) throw new TypeError('Native episode metadata required');
  const confirmed = usable && request.observation.passed && anchors.length > 0 && anchors.every(seq => evidence.some(e => e.seq === seq && e.verified === true));
  const outcome = confirmed ? 'verified' : source?.outcome === 'contradicted' ? 'contradicted' : 'unverified';
  const batch = { turn: usable ? source.turn : 0, lastSeq: usable ? source.endSeq : 0, signal: confirmed ? 'success' : 'intervention', confirmed,
    evidence: evidence.map(({ seq, type, text, verified }) => ({ seq, type, text, verified: verified === true })), confirmationSeqs: [...anchors] };
  const episodeId = usable ? hash(`${root}\0${source.sessionId}\0${source.endSeq}`) : null;
  return { usable, batch, sourceSessionId: usable ? source.sessionId : null,
    feedback: { episodeId, scope: root, outcome, exposures: [], alreadyProcessed: false },
    hint: typeof request.case.input?.task === 'string' ? request.case.input.task.slice(0, 1200) : '' };
}

/** Concrete comparison wiring only. State is detached private JSON: no RootStore,
 * profile installation, production publication, external SDK imports or file IO.
 * "legacy" means the preserved one-role prompt/core baseline, NOT a live app run.
 */
export function createComparisonAdapters(ctx, { ownerAgent, NativeToolExecutor, createUserMessage, root, provider, model, config = {}, onDispatch = () => {} } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || root.length > 4096 || root.includes('\0') || legacy.hasSecret(root)) throw new TypeError('Private absolute benchmark root required');
  if (typeof ctx?.llm?.stream !== 'function' || !identifier(ownerAgent?.id) || typeof onDispatch !== 'function') throw new TypeError('Native benchmark host required');
  const selection = ownerAgent.model?.current?.() ?? {};
  const selectedProvider = provider || config.provider || selection.provider;
  const selectedModel = model || config.model || selection.model;
  if (typeof selectedProvider !== 'string' || !selectedProvider || typeof selectedModel !== 'string' || !selectedModel) throw new TypeError('Benchmark model unavailable');
  const settings = { ...config, maxInputChars: config.maxInputChars ?? 16000, maxOutputTokens: 3000, timeoutMs: config.timeoutMs ?? 45000 };
  if (!Number.isSafeInteger(settings.maxInputChars) || settings.maxInputChars < 4000 || settings.maxInputChars > 24000 || !Number.isSafeInteger(settings.timeoutMs) || settings.timeoutMs < 1 || settings.timeoutMs > 120000) throw new TypeError('Invalid benchmark review budget');
  const nativeCase = createNativeCaseRunner(ctx, { ownerAgent, NativeToolExecutor, createUserMessage,
    provider: selectedProvider, model: selectedModel, cwd: root, timeoutMs: settings.timeoutMs, onDispatch });
  const snapshots = immutableSnapshot({ legacy: { ...legacy.newProject(root), mode: 'auto' }, ace: { ...ace.newProject(root), mode: 'auto' } }, MAX_SNAPSHOT);

  async function runCase(request) {
    if (!object(request) || !['no-memory', 'legacy', 'ace'].includes(request.arm)) throw new TypeError('Invalid benchmark arm');
    let selected = null;
    if (request.arm === 'no-memory') {
      if (request.candidate !== null) throw new TypeError('No-memory arm cannot receive a snapshot');
    } else selected = selectedSkill(memoryFor(request.arm, request.candidate, root), request.case);
    return nativeCase({ ...request, candidate: selected, scope: root });
  }

  async function propose(request, { budget, signal: externalSignal } = {}) {
    if (!object(request) || !['legacy', 'ace'].includes(request.arm)) throw new TypeError('Learning arm required');
    if (!budget || typeof budget.reserve !== 'function' || typeof budget.snapshot !== 'function') throw new TypeError('Shared host call budget required');
    const signal = AbortSignal.any([AbortSignal.timeout(settings.timeoutMs), ...(externalSignal ? [externalSignal] : [])]);
    signal.throwIfAborted();
    const project = memoryFor(request.arm, request.snapshot, root);
    const prepared = feedbackInput(request, root), usage = emptyUsage();
    const stream = options => {
      signal.throwIfAborted();
      const role = options.purpose === 'skill-loop-curator' ? 'curator' : 'reflector';
      onDispatch({ role, arm: request.arm, sessionId: options.sessionId, budget: budget.snapshot() });
      return ctx.llm.stream(options);
    };
    let draft;
    if (request.arm === 'legacy') {
      const input = buildReviewInput({ batch: prepared.batch, project, hint: prepared.hint, maxChars: settings.maxInputChars });
      if (input.length > settings.maxInputChars) throw new Error('held-input-budget');
      let outputChars = 0, reported = null;
      async function* measured(options) {
        try {
          for await (const chunk of stream(options)) {
            if (chunk.type === 'text-delta') outputChars += chunk.text.length;
            if (chunk.type === 'usage') reported = reportedUsage(chunk.usage) ?? reported;
            yield chunk;
          }
        } finally { if (reported) addUsage(usage, { provider: reported }); }
      }
      budget.reserve('reflector');
      draft = await raceSignal(collectReview(measured, { provider: selectedProvider, model: selectedModel, sessionId: ownerAgent.id,
        system: REFLECT_SYSTEM, messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], maxTokens: 3000, signal, purpose: 'skill-loop-benchmark-legacy' }), signal);
      addUsage(usage, { estimates: estimatesFor({ inputChars: JSON.stringify([{ role: 'user', content: [{ type: 'text', text: input }] }]).length, systemChars: REFLECT_SYSTEM.length, outputChars }) });
    } else {
      const proposer = createAceLiteProposer({ stream, provider: selectedProvider, model: selectedModel, config: settings, sessionId: ownerAgent.id, project,
        onStage: stage => addUsage(usage, { estimates: estimatesFor(stage) }) });
      const output = await raceSignal(proposer.propose({ batch: prepared.batch, feedback: prepared.feedback, hint: prepared.hint }, { budget, signal }), signal);
      if (output.usage.provider.reportedCalls) addUsage(usage, { provider: output.usage.provider });
      if (output.usage.estimates.length) addUsage(usage, { estimates: output.usage.estimates });
      draft = output.candidate;
    }
    signal.throwIfAborted();
    // A weak/absent source cannot mint provenance, even if a model hallucinates IDs.
    if (!prepared.usable || draft === null || Array.isArray(draft.lessons) && draft.lessons.length === 0 && draft.proposal === null) return { candidate: null, usage: rawUsage(usage) };
    // The preserved legacy runtime guarded ALL anchor citations before its V1
    // stage call. Keep that host check; do not upgrade partial model citations.
    const citesAnchors = value => Array.isArray(value?.evidenceSeqs) && prepared.batch.confirmationSeqs.every(seq => value.evidenceSeqs.includes(seq));
    const legacyConfirmed = Array.isArray(draft.lessons) && draft.lessons.every(citesAnchors) && (draft.proposal === null || citesAnchors(draft.proposal));
    const sourceContext = { runId: prepared.feedback.episodeId, sessionId: prepared.sourceSessionId, turn: prepared.batch.turn,
      evidence: prepared.batch.evidence, confirmed: prepared.batch.confirmed && (request.arm !== 'legacy' || legacyConfirmed), now: new Date().toISOString() };
    const staged = request.arm === 'legacy' ? legacy.stage(project, draft, sourceContext)
      : ace.stage(project, draft, { ...sourceContext, confirmationSeqs: prepared.batch.confirmationSeqs, episodeEndSeq: prepared.batch.lastSeq, outcome: prepared.feedback.outcome });
    if (staged.status.startsWith('invalid-')) throw new Error('benchmark-invalid-draft');
    if (staged.project === project || ['noop-replay', 'stale-base', 'stale-pending', 'held-archived', 'paused'].includes(staged.status)) return { candidate: null, usage: rawUsage(usage) };
    return { candidate: immutableSnapshot(staged.project, MAX_SNAPSHOT), usage: rawUsage(usage) };
  }
  return Object.freeze({ snapshots, runCase, propose });
}
