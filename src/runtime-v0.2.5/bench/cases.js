import { validateCaseSet } from '../optimizer.js';

// Trusted synthetic coding fixtures, not downloaded prompts and not commands to
// execute. A native-ReAct adapter may materialize these only in an isolated sandbox.
// The adapter owns execution/scoring; no benchmark case may touch a production cwd.
const families = [
  { family: 'stable-dedup', task: 'Implement unique(values): preserve first-occurrence order without mutating input.',
    starter: 'export function unique(values) { return [...new Set(values)].sort(); }\n',
    adaptation: [{ args: [[3, 1, 3, 2]], expected: [3, 1, 2] }, { args: [['b', 'a', 'b']], expected: ['b', 'a'] }],
    holdout: [{ args: [[9, 2, 9, 1, 2]], expected: [9, 2, 1] }, { args: [[]], expected: [] }], exportName: 'unique' },
  { family: 'zero-boundary', task: 'Implement clamp(value, min, max): clamp to inclusive bounds. Zero is a valid value.',
    starter: 'export function clamp(value, min, max) { return Math.min(max, Math.max(min, value || min)); }\n',
    adaptation: [{ args: [0, -3, 4], expected: 0 }, { args: [-8, -3, 4], expected: -3 }],
    holdout: [{ args: [0, -10, 2], expected: 0 }, { args: [7, -2, 5], expected: 5 }], exportName: 'clamp' },
  { family: 'immutable-sort', task: 'Implement sorted(values): return ascending numeric order, never mutate the caller array.',
    starter: 'export function sorted(values) { return values.sort(); }\n',
    adaptation: [{ args: [[11, 2, 3]], expected: [2, 3, 11], preserveArgs: true }],
    holdout: [{ args: [[100, -2, 9, 0]], expected: [-2, 0, 9, 100], preserveArgs: true }], exportName: 'sorted' },
  { family: 'empty-mean', task: 'Implement mean(values): arithmetic mean; return null for an empty array.',
    starter: 'export function mean(values) { return values.reduce((a, b) => a + b, 0) / values.length; }\n',
    adaptation: [{ args: [[]], expected: null }, { args: [[2, 4]], expected: 3 }],
    holdout: [{ args: [[-3, 0, 3]], expected: 0 }, { args: [[]], expected: null }], exportName: 'mean' },
];
function shuffle(values, seed) {
  let state = seed >>> 0;
  const out = [...values];
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/** Separate adaptation and held-out fixture instances within each coding family.
 * These are tiny harness fixtures, NOT evidence of broad coding-agent quality.
 * input = {task,initialFiles,allowedPaths}; expected includes requiredChecks. Host adapter must keep
 * expected out of generator prompts and run the checks independently after work.
 */
export function createSeededCaseSet(seed = 42) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new TypeError('Invalid benchmark seed');
  const cases = families.flatMap(f => ['adaptation', 'holdout'].map(split => ({
    id: `${f.family}-${split}`, family: f.family, split,
    input: { task: f.task, initialFiles: { 'solution.mjs': f.starter }, allowedPaths: ['solution.mjs'] },
    expected: { module: 'solution.mjs', exportName: f.exportName, requiredChecks: f[split], forbiddenPaths: [] },
  })));
  return validateCaseSet({ id: `coding-fixtures-v1-seed-${seed}`, cases: shuffle(cases, seed) });
}
