import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MANAGED_MARKER, isValidSkillName, resolveSkillExportDir, exportSkill, checkDrift }
  from '../src/fs-export.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fs-export-'));
const mkdirp = dir => fs.mkdirSync(dir, { recursive: true });
const scope = 'a'.repeat(64);
const content = `# Learned skill\n\nDo the thing.\n${MANAGED_MARKER}\n`;
const sidecar = { scopeHash: scope, revision: 3, candidateHash: 'b'.repeat(64) };

const skillFile = (exportDir, name) => path.join(exportDir, name, 'SKILL.md');
const sidecarFile = (exportDir, name) => path.join(exportDir, name, '.skillgrowth.json');

test('isValidSkillName accepts only learned-<kebab> up to 64 chars', () => {
  assert.equal(isValidSkillName('learned-reducer'), true);
  assert.equal(isValidSkillName('learned-a1-b2'), true);
  assert.equal(isValidSkillName(`learned-${'x'.repeat(56)}`), true); // 64 total
  assert.equal(isValidSkillName(`learned-${'x'.repeat(57)}`), false); // 65 total
  assert.equal(isValidSkillName('foo'), false);
  assert.equal(isValidSkillName('learned-Upper'), false);
  assert.equal(isValidSkillName('learned--x'), false);
  assert.equal(isValidSkillName('learned-'), false);
  assert.equal(isValidSkillName('../x'), false);
  assert.equal(isValidSkillName('learned-a/../../b'), false);
  assert.equal(isValidSkillName(null), false);
});

test('resolveSkillExportDir finds nearest git root from a nested cwd', () => {
  const root = tmp();
  const nested = path.join(root, 'repo', 'sub', 'deep');
  mkdirp(path.join(root, 'repo', '.git'));
  mkdirp(nested);
  const resolved = resolveSkillExportDir(nested);
  assert.equal(resolved.kind, 'project');
  assert.equal(resolved.root, path.join(root, 'repo'));
  assert.equal(resolved.dir, path.join(root, 'repo', '.agents', 'skills'));
});

test('resolveSkillExportDir falls back to cwd without .git', () => {
  const cwd = tmp();
  const resolved = resolveSkillExportDir(cwd);
  assert.equal(resolved.kind, 'cwd');
  assert.equal(resolved.root, cwd);
  assert.equal(resolved.dir, path.join(cwd, '.agents', 'skills'));
});

test('resolveSkillExportDir maps the home directory to kind home', () => {
  const home = tmp();
  const resolved = resolveSkillExportDir(home, { homeDir: home });
  assert.equal(resolved.kind, 'home');
  assert.equal(resolved.root, home);
  assert.equal(resolved.dir, path.join(home, '.agents', 'skills'));
});

test('resolveSkillExportDir rejects a relative cwd', () => {
  assert.throws(() => resolveSkillExportDir('relative/path'), TypeError);
});

test('exportSkill writes SKILL.md and sidecar, creating exportDir recursively', () => {
  const root = tmp();
  const exportDir = path.join(root, 'deep', 'nested', '.agents', 'skills');
  const result = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar });
  assert.equal(result.status, 'exported');
  assert.equal(result.path, skillFile(exportDir, 'learned-reducer'));
  assert.equal(fs.readFileSync(result.path, 'utf8'), content);
  const record = JSON.parse(fs.readFileSync(sidecarFile(exportDir, 'learned-reducer'), 'utf8'));
  assert.equal(record.scopeHash, scope);
  assert.equal(record.revision, 3);
  assert.equal(record.candidateHash, sidecar.candidateHash);
  assert.equal(typeof record.exportedAt, 'string');
});

test('exportSkill is idempotent for an already exported skill', () => {
  const exportDir = tmp();
  const first = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar });
  const second = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar });
  assert.equal(first.status, 'exported');
  assert.equal(second.status, 'exported');
  assert.equal(fs.readFileSync(skillFile(exportDir, 'learned-reducer'), 'utf8'), content);
});

test('exportSkill refuses to overwrite a foreign file without the marker', () => {
  const exportDir = tmp();
  const target = skillFile(exportDir, 'learned-reducer');
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, '# handwritten notes\n');
  const result = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar });
  assert.equal(result.status, 'conflict');
  assert.equal(fs.readFileSync(target, 'utf8'), '# handwritten notes\n');
});

test('exportSkill allows overwriting a marker-less file when a valid sidecar vouches', () => {
  const exportDir = tmp();
  const target = skillFile(exportDir, 'learned-reducer');
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, '# old managed copy\n');
  fs.writeFileSync(sidecarFile(exportDir, 'learned-reducer'), JSON.stringify({ scopeHash: scope }));
  const result = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar });
  assert.equal(result.status, 'exported');
  assert.equal(fs.readFileSync(target, 'utf8'), content);
});

test('exportSkill conflicts on marker file with missing or invalid sidecar', () => {
  const exportDir = tmp();
  const name = 'learned-reducer';
  const target = skillFile(exportDir, name);
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, content); // has marker, no sidecar at all
  assert.equal(exportSkill({ exportDir, name, content, sidecar }).status, 'conflict');
  fs.writeFileSync(sidecarFile(exportDir, name), '{not json');
  assert.equal(exportSkill({ exportDir, name, content, sidecar }).status, 'conflict');
  fs.writeFileSync(sidecarFile(exportDir, name), JSON.stringify({ scopeHash: 'z'.repeat(64) }));
  assert.equal(exportSkill({ exportDir, name, content, sidecar }).status, 'conflict');
});

test('exportSkill rejects invalid names and traversal attempts', () => {
  const exportDir = tmp();
  for (const name of ['../x', 'foo', 'learned-Upper', 'learned--x', 'learned-a/../../b']) {
    assert.equal(exportSkill({ exportDir, name, content, sidecar }).status, 'invalid-name', name);
  }
  assert.equal(fs.readdirSync(exportDir).length, 0);
});

test('exportSkill rejects content without the managed marker', () => {
  const exportDir = tmp();
  const result = exportSkill({ exportDir, name: 'learned-reducer', content: '# no marker\n', sidecar });
  assert.equal(result.status, 'invalid-content');
  assert.equal(fs.readdirSync(exportDir).length, 0);
});

test('exportSkill reports fs errors and leaves no partial SKILL.md or tmp file', () => {
  const exportDir = tmp();
  const broken = { ...fs, renameSync() { throw new Error('rename boom'); } };
  const result = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar, fs: broken });
  assert.equal(result.status, 'error');
  assert.match(result.message, /rename boom/);
  // Failed rename removes its tmp file, so neither the final file nor any
  // *.tmp remnant exists; only the freshly created skill directory remains.
  const entries = fs.readdirSync(path.join(exportDir, 'learned-reducer'));
  assert.deepEqual(entries, []);
  assert.equal(fs.existsSync(skillFile(exportDir, 'learned-reducer')), false);
});

test('exportSkill reports a failing mkdir as an error status', () => {
  const exportDir = tmp();
  const broken = { ...fs, mkdirSync() { throw new Error('mkdir boom'); } };
  const result = exportSkill({ exportDir, name: 'learned-reducer', content, sidecar, fs: broken });
  assert.equal(result.status, 'error');
  assert.match(result.message, /mkdir boom/);
});

test('checkDrift covers every branch', () => {
  const exportDir = tmp();
  const name = 'learned-reducer';
  const args = { exportDir, name, content, scopeHash: scope };

  assert.equal(checkDrift(args), 'missing');
  assert.equal(checkDrift({ ...args, name: 'foo' }), 'invalid-name');

  const target = skillFile(exportDir, name);
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, '# foreign\n');
  assert.equal(checkDrift(args), 'conflict'); // no marker, no sidecar

  fs.writeFileSync(target, content); // marker, still no sidecar: fail closed
  assert.equal(checkDrift(args), 'conflict');

  fs.writeFileSync(sidecarFile(exportDir, name), JSON.stringify({ scopeHash: scope }));
  assert.equal(checkDrift(args), 'exported');
  assert.equal(checkDrift({ ...args, content: '# changed\n' + MANAGED_MARKER }), 'drifted');
  assert.equal(checkDrift({ ...args, scopeHash: 'c'.repeat(64) }), 'sidecar-mismatch');

  fs.writeFileSync(sidecarFile(exportDir, name), '{broken');
  assert.equal(checkDrift(args), 'conflict'); // invalid JSON sidecar fails closed
});

test('checkDrift treats a marker-less file with a valid sidecar as owned', () => {
  const exportDir = tmp();
  const name = 'learned-reducer';
  const target = skillFile(exportDir, name);
  mkdirp(path.dirname(target));
  fs.writeFileSync(target, content);
  fs.writeFileSync(sidecarFile(exportDir, name), JSON.stringify({ scopeHash: 'd'.repeat(64) }));
  const args = { exportDir, name, content, scopeHash: 'd'.repeat(64) };
  assert.equal(checkDrift(args), 'exported');
  assert.equal(checkDrift({ ...args, scopeHash: 'e'.repeat(64) }), 'sidecar-mismatch');
});
