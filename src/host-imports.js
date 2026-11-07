import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED = new Set(['@deepseek-ai/schemastery', 'zod', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tool-executor-native']);
export function resolveHostModule(specifier, options = {}) {
  if (!ALLOWED.has(specifier)) throw new Error('Unexpected Host dependency');
  const resources = options.resourcesPath ?? process.resourcesPath;
  const entry = options.entrypoint ?? process.argv[1];
  const resolve = options.resolve ?? ((name, anchor) => createRequire(anchor).resolve(name));
  const anchors = [];
  if (typeof resources === 'string' && isAbsolute(resources)) anchors.push(join(resources, 'app.asar', 'dsh', 'package.json'));
  if (typeof entry === 'string' && isAbsolute(entry)) {
    try { anchors.push(realpathSync.native(entry)); } catch { /* declared path below */ }
    anchors.push(entry);
  }
  for (const anchor of new Set(anchors)) {
    try {
      const result = resolve(specifier, anchor);
      if (typeof result === 'string' && isAbsolute(result)) return result;
    } catch { /* next host anchor, never profile/npm fallback */ }
  }
  throw new Error('Cannot resolve the running DSH Host; install this bundle through DSH.');
}
export function hostImport(specifier) {
  return import(pathToFileURL(resolveHostModule(specifier)).href);
}
