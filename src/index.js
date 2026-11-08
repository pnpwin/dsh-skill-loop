import { hostImport } from './host-imports.js';
import { installRuntime } from './runtime.js';

const schemaModule = await hostImport('@deepseek-ai/schemastery');
const Schema = schemaModule.default;
const { z } = await hostImport('zod');
const {createUserMessage} = await hostImport('@deepseek-ai/dsh-llm');
const {NativeToolExecutor} = await hostImport('@deepseek-ai/dsh-tool-executor-native');
export const name = 'dsh-skillgrowth';
export const inject = ['skills', 'tools', 'commands', 'llm', 'agents', 'agentLoop', 'workingDirectory', 'sessionProjections', 'storageDomain', 'systemPrompt'];
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  initialMode: Schema.union(['review', 'auto']).default('review'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxInputChars: Schema.number().step(1).min(4000).max(24000).default(16000),
  maxOutputTokens: Schema.number().step(1).min(1000).max(6000).default(3000),
  timeoutMs: Schema.number().step(1).min(5000).max(120000).default(45000),
  cooldownMs: Schema.number().step(1).min(0).max(3600000).default(60000),
  dailyReviews: Schema.number().step(1).min(1).max(200).default(16),
  maxAuxCallsPerDay: Schema.number().step(1).min(1).max(500).default(40),
  requirePairedEvaluation: Schema.boolean().default(true),
  autoEvaluate: Schema.boolean().default(true),
  maxRefinements: Schema.number().step(1).min(0).max(1).default(1),
  verificationMaxCalls: Schema.number().step(1).min(1).max(100).default(24),
  verificationTimeoutMs: Schema.number().step(1).min(5000).max(300000).default(120000),
  declarativeCaseSetsJson: Schema.string().default(''),
  // Learning modes (checkboxes); lite+standard on by default, heavy is explicit.
  learnLite: Schema.boolean().default(true),
  learnStandard: Schema.boolean().default(true),
  learnHeavy: Schema.boolean().default(false),
  escalation: Schema.union(['on-insights', 'on-confirmed', 'never']).default('on-insights'),
  liteSoftAuto: Schema.boolean().default(false),
  // Heavy (GEPA-lite) evolution budget.
  heavyAuto: Schema.boolean().default(false),
  heavyMaxCallsPerRun: Schema.number().step(1).min(10).max(200).default(60),
  heavyMaxRunsPerDay: Schema.number().step(1).min(1).max(5).default(1),
  heavyEpochs: Schema.number().step(1).min(1).max(3).default(2),
  heavyPopulation: Schema.number().step(1).min(2).max(4).default(3),
  heavyMaxInputChars: Schema.number().step(1).min(8000).max(48000).default(24000),
  // Skill delivery: filesystem (.agents/skills) is the default in v0.3.
  skillDelivery: Schema.union(['filesystem', 'provider', 'both']).default('filesystem'),
  // Deterministic tool-error antipattern capture.
  errorPatternEnabled: Schema.boolean().default(true),
  errorPatternMinRepeats: Schema.number().step(1).min(2).max(5).default(2),
  // Per-mode daily quotas on top of the shared maxAuxCallsPerDay rail.
  liteMaxCallsPerDay: Schema.number().step(1).min(1).max(100).default(16),
  standardMaxCallsPerDay: Schema.number().step(1).min(1).max(200).default(24),
});
export async function apply(ctx, config) {
  await installRuntime(ctx, config, { z,NativeToolExecutor,createUserMessage });
}
