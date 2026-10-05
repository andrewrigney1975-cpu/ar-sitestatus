// Turns a raw probe result into a display state. Pure, so it's unit-testable under Node.

export const STATES = {
  up:      { label: 'Operational', icon: 'i-up', rank: 0 },
  opaque:  { label: 'Reachable, status hidden', icon: 'i-opaque', rank: 1 },
  blocked: { label: 'Can\'t be checked', icon: 'i-blocked', rank: 1 },
  slow:    { label: 'Slow response', icon: 'i-slow', rank: 2 },
  warn:    { label: 'Client error', icon: 'i-warn', rank: 3 },
  down:    { label: 'Down', icon: 'i-down', rank: 4 },
};

export function classify(result, slowMs) {
  if (!result) return 'none';
  if (result.blocked) return 'blocked';
  if (result.opaque) return 'opaque';
  const s = result.status;
  if (s == null || s >= 500 || s < 100) return 'down';
  if (s >= 400) return 'warn';
  return (result.timings?.total ?? 0) >= slowMs ? 'slow' : 'up';
}

/**
 * Uptime over the given results: (up + slow) / (everything with a known status). Browser-only
 * checks (opaque/blocked) don't count either way. Returns null when nothing is measurable.
 */
export function uptime(results, slowMs) {
  let good = 0, known = 0;
  for (const r of results) {
    const st = classify(r, slowMs);
    if (st === 'opaque' || st === 'blocked' || st === 'none') continue;
    known++;
    if (st === 'up' || st === 'slow') good++;
  }
  return known ? good / known : null;
}

/** Worst current state across sites, for the overall banner. */
export function worstState(states) {
  let worst = null;
  for (const st of states) {
    if (!STATES[st]) continue;
    if (!worst || STATES[st].rank > STATES[worst].rank) worst = st;
  }
  return worst;
}

/**
 * Raises and updates outage alerts from new results, in place. alerts: { [siteId]: alert };
 * entries: Array<[siteId, result]>. A "down" result opens an alert for a site that has none.
 * Alerts never expire: they stay (marked recovered once the site answers again) until cleared.
 * Returns the ids whose alert changed.
 */
export function updateAlerts(alerts, entries) {
  const changed = [];
  for (const [id, result] of entries) {
    if (!result) continue;
    const alert = alerts[id];
    const state = classify(result, Infinity);
    if (state === 'down') {
      if (alert) Object.assign(alert, { latest: result, downChecks: alert.downChecks + 1, recoveredAt: null });
      else alerts[id] = { startedAt: result.checkedAt, first: result, latest: result, downChecks: 1, recoveredAt: null };
      changed.push(id);
    } else if (alert && !alert.recoveredAt && state !== 'blocked') {
      alert.recoveredAt = result.checkedAt;
      changed.push(id);
    }
  }
  return changed;
}
