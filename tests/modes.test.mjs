import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModes, shouldEscalate, heldForReserve } from '../src/modes.js';

test('mode checkboxes: defaults lite+standard, heavy off', () => {
  assert.deepEqual(resolveModes({}), { lite: true, standard: true, heavy: false, any: true });
  assert.deepEqual(resolveModes({ learnLite: false, learnStandard: false }), { lite: false, standard: false, heavy: false, any: false });
  assert.deepEqual(resolveModes({ learnLite: false, learnStandard: true, learnHeavy: true }), { lite: false, standard: true, heavy: true, any: true });
  assert.equal(resolveModes({ learnLite: false, learnStandard: false }).any, false);
});
test('escalation policy gates the lite->standard curator pass', () => {
  assert.equal(shouldEscalate({ escalation: 'on-insights', insights: 2, confirmed: false }), true);
  assert.equal(shouldEscalate({ escalation: 'on-insights', insights: 0, confirmed: true }), false);
  assert.equal(shouldEscalate({ escalation: 'on-confirmed', insights: 3, confirmed: false }), false);
  assert.equal(shouldEscalate({ escalation: 'on-confirmed', insights: 3, confirmed: true }), true);
  assert.equal(shouldEscalate({ escalation: 'never', insights: 3, confirmed: true }), false);
});
test('reserve rejection codes map to held statuses', () => {
  assert.equal(heldForReserve('lite-budget'), 'held-lite-budget');
  assert.equal(heldForReserve('standard-budget'), 'held-standard-budget');
  assert.equal(heldForReserve('heavy-budget'), 'held-heavy-budget');
  assert.equal(heldForReserve('cooldown'), 'cooldown');
});
