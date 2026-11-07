import { hostImport } from './host-imports.js';
import { installRuntime } from './runtime.js';

const schemaModule = await hostImport('@deepseek-ai/schemastery');
const Schema = schemaModule.default;
const { z } = await hostImport('zod');
export const name = 'local-skill-loop';
export const inject = ['skills', 'tools', 'commands', 'llm', 'agents', 'workingDirectory', 'sessionProjections', 'storageDomain', 'systemPrompt'];
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  initialMode: Schema.union(['review', 'auto']).default('review'),
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  maxInputChars: Schema.number().step(1).min(4000).max(24000).default(16000),
  maxOutputTokens: Schema.number().step(1).min(1000).max(6000).default(3000),
  timeoutMs: Schema.number().step(1).min(5000).max(120000).default(45000),
  cooldownMs: Schema.number().step(1).min(0).max(3600000).default(60000),
  dailyReviews: Schema.number().step(1).min(1).max(100).default(12),
});
export async function apply(ctx, config) {
  await installRuntime(ctx, config, { z });
}
