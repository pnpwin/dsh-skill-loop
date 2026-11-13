// Filesystem delivery of published learned-* skills. DSH core scans
// .agents/skills itself, so this module only resolves the export directory
// and atomically writes <name>/SKILL.md plus a .skillgrowth.json sidecar.
// Ownership is fail closed: foreign files are never overwritten and our own
// marker without a valid sidecar still reports a conflict.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const MANAGED_MARKER = '<!-- managed-by: dsh-skillgrowth -->';

const SKILL_FILE = 'SKILL.md';
const SIDECAR_FILE = '.skillgrowth.json';
const NAME_RE = /^learned-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const hash = text => createHash('sha256').update(text).digest('hex');
const errorMessage = error => String(error?.message ?? error).slice(0, 200);

// null on ENOENT (nothing there yet); every other fs error propagates.
const statOrNull = (fns, target) => {
  try { return fns.statSync(target); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

const readText = (fns, target) => {
  try { return fns.readFileSync(target, 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

// Parsed sidecar object, or null when missing / not an object. Invalid JSON is
// deliberately indistinguishable from absence so both fail closed.
const readSidecar = (fns, dir) => {
  const text = readText(fns, path.join(dir, SIDECAR_FILE));
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
};

export function isValidSkillName(name) {
  return typeof name === 'string' && name.length <= 64 && NAME_RE.test(name);
}

// Nearest ancestor (cwd included) holding a .git entry wins; otherwise the
// home directory (by realpath) or cwd itself anchors the export root.
export function resolveSkillExportDir(cwd, { homeDir, fs: fns = fs } = {}) {
  if (!path.isAbsolute(cwd)) throw new TypeError(`cwd must be an absolute path: ${cwd}`);
  let dir = path.resolve(cwd);
  const filesystemRoot = path.parse(dir).root;
  for (;;) {
    if (statOrNull(fns, path.join(dir, '.git'))) {
      return { dir: path.join(dir, '.agents', 'skills'), kind: 'project', root: dir };
    }
    if (dir === filesystemRoot) break;
    dir = path.dirname(dir);
  }
  const home = homeDir ?? os.homedir();
  const real = target => {
    try { return fns.realpathSync(target); } catch { return path.resolve(target); }
  };
  return real(cwd) === real(home)
    ? { dir: path.join(home, '.agents', 'skills'), kind: 'home', root: home }
    : { dir: path.join(cwd, '.agents', 'skills'), kind: 'cwd', root: cwd };
}

// Atomic tmp-then-rename write; the tmp file is best-effort removed on failure
// so a failed export leaves no partial SKILL.md and no stray tmp file behind.
const writeAtomic = (fns, dir, finalName, text, tmpSuffix) => {
  const final = path.join(dir, finalName);
  const tmp = path.join(dir, `${finalName}.${randomBytes(6).toString('hex')}${tmpSuffix}`);
  try {
    fns.writeFileSync(tmp, text, { mode: 0o644 });
    fns.renameSync(tmp, final);
  } catch (error) {
    try { fns.unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw error;
  }
};

export function exportSkill({ exportDir, name, content, sidecar, fs: fns = fs, tmpSuffix = '.tmp' }) {
  if (!isValidSkillName(name)) return { status: 'invalid-name' };
  const base = path.resolve(exportDir);
  const targetDir = path.resolve(base, name);
  if (targetDir !== base && !targetDir.startsWith(base + path.sep)) return { status: 'invalid-name' };
  if (typeof content !== 'string' || !content.includes(MANAGED_MARKER)) return { status: 'invalid-content' };
  const expectedHash = sidecar !== null && typeof sidecar === 'object' ? sidecar.scopeHash : undefined;
  if (readText(fns, path.join(targetDir, SKILL_FILE)) !== null) {
    // Existing file: only a sidecar whose scopeHash matches the caller's
    // vouches for ownership — with or without the marker. Anything else is a
    // conflict, including our own marker with a missing/invalid sidecar.
    const ours = readSidecar(fns, targetDir);
    if (typeof ours?.scopeHash !== 'string' || ours.scopeHash !== expectedHash) {
      return { status: 'conflict' };
    }
  }
  const record = {
    scopeHash: expectedHash,
    revision: sidecar?.revision ?? null,
    candidateHash: sidecar?.candidateHash ?? null,
    exportedAt: sidecar?.exportedAt ?? new Date().toISOString(),
  };
  try {
    fns.mkdirSync(targetDir, { recursive: true, mode: 0o755 });
    writeAtomic(fns, targetDir, SKILL_FILE, content, tmpSuffix);
    writeAtomic(fns, targetDir, SIDECAR_FILE, `${JSON.stringify(record, null, 2)}\n`, tmpSuffix);
  } catch (error) {
    return { status: 'error', message: errorMessage(error) };
  }
  return { status: 'exported', path: path.join(targetDir, SKILL_FILE) };
}

// One of: 'invalid-name' | 'missing' | 'conflict' | 'drifted' | 'exported' |
// 'sidecar-mismatch'. A usable sidecar (valid JSON with a string scopeHash)
// vouches for ownership even without the marker; a marker without one fails
// closed as a conflict.
export function checkDrift({ exportDir, name, content, scopeHash, fs: fns = fs }) {
  if (!isValidSkillName(name)) return 'invalid-name';
  const targetDir = path.resolve(path.resolve(exportDir), name);
  const existing = readText(fns, path.join(targetDir, SKILL_FILE));
  if (existing === null) return 'missing';
  const sidecarHash = readSidecar(fns, targetDir)?.scopeHash;
  if (typeof sidecarHash !== 'string') return 'conflict';
  if (hash(content) !== hash(existing)) return 'drifted';
  return sidecarHash === scopeHash ? 'exported' : 'sidecar-mismatch';
}
