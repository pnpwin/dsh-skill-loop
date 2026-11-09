// Learning-mode resolution. Modes are independent checkboxes; lite+standard are
// the default combination. Mode selection is orthogonal to the review/auto
// publication policy: modes decide WHO RUNS (which roles), policy decides WHAT
// PUBLISHES.
export function resolveModes(config = {}) {
  const lite = config.learnLite !== false;
  const standard = config.learnStandard !== false;
  const heavy = config.learnHeavy === true;
  return { lite, standard, heavy, any: lite || standard };
}

// When a lite (reflector-only) cycle escalates to the standard Curator pass.
export function shouldEscalate({ escalation = 'on-insights', insights = 0, confirmed = false } = {}) {
  if (escalation === 'never') return false;
  if (!insights) return false;
  if (escalation === 'on-insights') return true;
  return confirmed === true; // 'on-confirmed'
}

// Map a store reserve rejection to a held status code understood by telemetry.
export function heldForReserve(code) {
  return { 'lite-budget': 'held-lite-budget', 'standard-budget': 'held-standard-budget', 'heavy-budget': 'held-heavy-budget' }[code] ?? code;
}
