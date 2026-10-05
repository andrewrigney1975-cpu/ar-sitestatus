// Background worker. While a sidebar is open, the sidebar runs the checks (down to every 5 s).
// While none is open, an alarm runs them here instead (browsers allow alarms every 30 s at
// most). Either way, this worker keeps the toolbar badge and notifications up to date.
import { probeBatch } from './ext/probe.js';
import { classify, updateAlerts, STATES } from './js/classify.js';

const api = globalThis.browser ?? globalThis.chrome;
const KEYS = { sites: 'sitestatus.sites.v1', settings: 'sitestatus.settings.v1', history: 'sitestatus.history.v1', alerts: 'sitestatus.alerts.v1' };
const DEFAULTS = { intervalSec: 60, slowMs: 2000, notify: true };
const HISTORY_LEN = 90;
const MIN_PERIOD_MIN = 0.5;
const COLORS = { down: '#d6334a', warn: '#e8662a' };

const read = async key => {
  const raw = (await api.storage.local.get(key))[key];
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
};
const settings = async () => ({ ...DEFAULTS, ...(await read(KEYS.settings)) });

// ------------------------------------------------------------------ toolbar button
async function setup() {
  // Chrome / Edge: the toolbar button opens the side panel
  api.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  await scheduleAlarm();
  await refreshBadge();
}
api.runtime.onInstalled.addListener(setup);
api.runtime.onStartup.addListener(setup);
// Firefox: no side panel API; the toolbar button toggles the sidebar instead
if (!api.sidePanel && api.sidebarAction) api.action.onClicked.addListener(() => api.sidebarAction.toggle());

// ------------------------------------------------------------------ open sidebars & leader
const ports = [];
function announce() {
  ports.forEach((port, i) => { try { port.postMessage({ type: 'role', leader: i === 0 }); } catch { /* gone */ } });
}
api.runtime.onConnect.addListener(port => {
  if (port.name !== 'panel') return;
  ports.push(port);
  port.onDisconnect.addListener(() => {
    ports.splice(ports.indexOf(port), 1);
    announce();
  });
  announce();
});
api.runtime.onMessage.addListener(msg => { if (msg?.type === 'ping') return Promise.resolve('pong'); });

// ------------------------------------------------------------------ background checks
async function scheduleAlarm() {
  const { intervalSec } = await settings();
  const period = Math.max(MIN_PERIOD_MIN, intervalSec / 60);
  const existing = await api.alarms.get('tick');
  if (existing?.periodInMinutes === period) return;
  await api.alarms.create('tick', { periodInMinutes: period, delayInMinutes: period });
}

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'tick' && !ports.length) tick();
});

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sites = (await read(KEYS.sites)) ?? [];
    if (!sites.length) return;
    const { intervalSec } = await settings();
    const timeoutMs = Math.min(10_000, Math.max(3000, intervalSec * 800));
    const results = await probeBatch(sites.map(s => s.url), { timeoutMs });
    // Re-read: the list may have changed while checks were in flight
    const history = (await read(KEYS.history)) ?? {};
    const current = new Set(((await read(KEYS.sites)) ?? []).map(s => `${s.id} ${s.url}`));
    const entries = sites.map((site, i) => [site.id, results[i]]).filter((_, i) => current.has(`${sites[i].id} ${sites[i].url}`));
    for (const [id, result] of entries) {
      const list = history[id] ??= [];
      list.push(result);
      if (list.length > HISTORY_LEN) list.splice(0, list.length - HISTORY_LEN);
    }
    const alerts = (await read(KEYS.alerts)) ?? {};
    const update = { [KEYS.history]: JSON.stringify(history) };
    if (updateAlerts(alerts, entries).length) update[KEYS.alerts] = JSON.stringify(alerts);
    await api.storage.local.set(update);
  } finally {
    ticking = false;
  }
}
globalThis.siteStatusTick = tick;     // lets automated tests trigger a background run

// ------------------------------------------------------------------ badge & notifications
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[KEYS.settings]) scheduleAlarm();
  if (changes[KEYS.history] || changes[KEYS.sites] || changes[KEYS.settings]) refreshBadge();
});

async function refreshBadge() {
  const sites = (await read(KEYS.sites)) ?? [];
  const history = (await read(KEYS.history)) ?? {};
  const s = await settings();
  const states = sites.map(site => ({ site, state: classify(history[site.id]?.at(-1), s.slowMs) }));
  const count = st => states.filter(x => x.state === st).length;
  const down = count('down');
  const warn = count('warn');

  await api.action.setBadgeText({ text: down ? String(down) : warn ? String(warn) : '' });
  if (down || warn) await api.action.setBadgeBackgroundColor({ color: down ? COLORS.down : COLORS.warn });
  await api.action.setTitle({
    title: !sites.length ? 'Site Status'
      : down ? `Site Status: ${down} site${down === 1 ? '' : 's'} down`
      : warn ? `Site Status: ${warn} site${warn === 1 ? '' : 's'} returning errors`
      : 'Site Status: all sites operational',
  });

  // Notify on transitions into and out of "down"
  const { lastStates = {} } = await api.storage.session.get('lastStates');
  const next = {};
  for (const { site, state } of states) {
    next[site.id] = state;
    const prev = lastStates[site.id];
    if (!s.notify || !prev || prev === state || state === 'none') continue;
    if (state === 'down') notify(site, `${site.name} is down`, history[site.id]?.at(-1));
    else if (prev === 'down' && (state === 'up' || state === 'slow')) notify(site, `${site.name} has recovered`, history[site.id]?.at(-1));
  }
  await api.storage.session.set({ lastStates: next });
}

function notify(site, title, result) {
  const detail = result?.error ?? (result?.status ? `HTTP ${result.status}` : STATES.down.label);
  api.notifications.create(`site-${site.id}-${Date.now()}`, {
    type: 'basic',
    iconUrl: api.runtime.getURL('icons/icon-128.png'),
    title,
    message: `${new URL(site.url).host}: ${detail}`,
  });
}
