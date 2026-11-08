import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkPackage } from '../src/check-package.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

test('root contains metadata only, all implementation modules live in src', () => {
  assert.equal(checkPackage(root).entry, './src/runtime-v'+pkg.version+'/index.js');
  assert.equal(readdirSync(root).filter(name => /\.(?:[cm]?js|ts|tsx|jsx|py|sh)$/.test(name)).length, 0);
  for (const directory of ['src', 'tests', 'locale']) assert.ok(readdirSync(root, { withFileTypes: true }).some(e => e.name === directory && e.isDirectory()));
});

test('public GitHub package keeps native runtime identities for migration', () => {
  assert.equal(pkg.name, '@pnpwin/dsh-skillgrowth');
  assert.equal(pkg.repository.url, 'git+https://github.com/pnpwin/dsh-skillgrowth.git');
  assert.equal(pkg.exports['./icon'], './src/icon.svg');
  const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id: dsh-skillgrowth/);
  assert.match(patch, /name: '@pnpwin\/dsh-skillgrowth'/);
  assert.match(readFileSync(resolve(root, 'src/store.js'), 'utf8'), /name:\s*'local_skill_loop',\s*version:\s*1/);
  assert.match(readFileSync(resolve(root, 'src/store.js'), 'utf8'), /name:\s*'local_skill_loop_backups',\s*version:\s*1/);
});

test('npm distribution includes entry, modules and metadata but excludes private/local artifacts', () => {
  const npm = process.env.npm_execpath;
  const result = spawnSync(npm ? process.execPath : 'npm', [...(npm ? [npm] : []), 'pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, npm_config_cache: resolve(root, '.release/npm-cache') },
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const files = new Set(JSON.parse(result.stdout)[0].files.map(file => file.path));
  for (const file of ['src/index.js', 'src/host-imports.js', 'src/runtime.js', 'src/core.js', 'src/projection.js', 'src/prompts.js', 'src/icon.svg', 'locale/en.json', 'locale/ru.json', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'UPSTREAM.md']) assert.ok(files.has(file), file);
  assert.ok(!files.has('host.js'));
  assert.ok(!files.has('src/CONTRACT.md'));
  for (const file of files) {
    assert.ok(!file.startsWith('.release/') && !file.startsWith('.git/') && !file.startsWith('tests/'), file);
    if (/\.[cm]?js$/.test(file)) assert.ok(file.startsWith('src/'), file);
  }
});
