import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Development/release validation only; never imported by the plugin Host.
export function checkPackage(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const rootMetadata = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'README.ru.md', 'LICENSE', 'UPSTREAM.md', '.gitignore']);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && !rootMetadata.has(entry.name)) throw new Error(`Unexpected root file: ${entry.name}; code belongs in src/`);
  }
  for (const file of ['src/index.js', 'src/host-imports.js', 'src/runtime.js', 'src/core.js', 'src/projection.js', 'src/prompts.js', 'src/ace-core.js', 'src/feedback.js', 'src/review.js', 'src/store.js', 'src/optimizer.js', 'src/bench/runner.js', 'src/bench/native-case.js', 'src/icon.svg', 'locale/en.json', 'locale/ru.json', 'LICENSE', 'UPSTREAM.md']) {
    if (!statSync(resolve(root, file)).isFile()) throw new Error(`Missing release resource: ${file}`);
  }
  if (pkg.exports?.['.'] !== './src/index.js' || pkg.exports?.['./icon'] !== './src/icon.svg') throw new Error('Entry/icon exports must resolve under src/');
  if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('Missing DSH bundle discovery');
  if (pkg.scripts?.prepare || pkg.scripts?.install || pkg.scripts?.postinstall || Object.keys(pkg.dependencies || {}).length) throw new Error('Release must not require dependency installation or build hooks');
  for (const language of ['en', 'ru']) {
    const locale = JSON.parse(readFileSync(resolve(root, `locale/${language}.json`), 'utf8'));
    if (!locale.meta?.title || !locale.meta?.description) throw new Error(`Missing ${language} display metadata`);
  }
  const code = readdirSync(resolve(root, 'src'),{recursive:true}).filter(file => file.endsWith('.js'));
  for (const file of code) {
    const full = resolve(root, 'src', file);
    const syntax = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`${relative(root, full)}: ${syntax.stderr || syntax.error || 'syntax check failed'}`);
    const source = readFileSync(full, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:from\s+|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(full), specifier);
      if (!target.startsWith(resolve(root, 'src') + sep)) throw new Error(`Runtime import leaves src/: ${specifier}`);
      if (!statSync(target).isFile()) throw new Error(`Missing module: ${specifier}`);
    }
  }
  return { name: pkg.name, version: pkg.version, modules: code.length, entry: pkg.exports['.'] };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(checkPackage(root), null, 2));
  if (process.argv.includes('--pack')) {
    mkdirSync(resolve(root, '.release'), { recursive: true });
    const npm = process.env.npm_execpath;
    const result = spawnSync(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'pack', '--pack-destination', '.release'], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
