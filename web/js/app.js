import { store, INTERVALS } from './store.js';
import { worstState } from './classify.js';
import { SiteList } from './chart.js';
import { Scheduler } from './scheduler.js';
import { TransportManager } from './transports/index.js';
import { applyTheme, nextTheme, themeIcon, themeLabel, onEffectiveThemeChange } from './theme.js';
import { openSites, openSettings, wireSettings, importSites, addExamples } from './dialogs.js';
import { fmtInterval, fmtTime } from './format.js';
import { toast } from './toast.js';
import { VERSION } from './version.js';

const $ = id => document.getElementById(id);
const native = window.siteStatusNative ?? null;                          // Electron preload bridge
const cap = window.Capacitor?.isNativePlatform?.() ? window.Capacitor.Plugins : null;

const list = new SiteList($('sites'), $('popover'));
const transports = new TransportManager(() => store.getSettings().apiBase);

// ------------------------------------------------------------------ checks
const scheduler = new Scheduler(async timeoutMs => {
  const sites = store.getSites();
  if (!sites.length) return;
  const results = await transports.probeBatch(sites.map(s => s.url), { timeoutMs });
  // Ignore results for sites that were removed or re-pointed while the tick was in flight
  store.appendResults(sites
    .map((s, i) => [s.id, results[i]])
    .filter(([id, r]) => r && store.getSite(id)?.url === r.url));
});

scheduler.addEventListener('tickstart', () => { $('check-now').classList.add('spinning'); renderBanner(); });
scheduler.addEventListener('tickend', () => { $('check-now').classList.remove('spinning'); renderBanner(); });

// ------------------------------------------------------------------ header controls
const intervalSelect = $('interval');
for (const sec of INTERVALS) intervalSelect.append(new Option(fmtInterval(sec), sec));
intervalSelect.value = store.getSettings().intervalSec;
intervalSelect.addEventListener('change', () => store.setSettings({ intervalSec: Number(intervalSelect.value) }));

$('check-now').addEventListener('click', () => scheduler.runNow());
$('manage').addEventListener('click', () => openSites());
$('settings').addEventListener('click', () => openSettings({ transports, version: VERSION }));
$('theme-toggle').addEventListener('click', () => store.setSettings({ theme: nextTheme(store.getSettings().theme) }));
$('empty-add').addEventListener('click', () => openSites({ focusAdd: true }));
$('empty-examples').addEventListener('click', addExamples);
$('empty-import').addEventListener('click', importSites);
wireSettings({ transports });

function renderThemeButton() {
  const t = store.getSettings().theme;
  const btn = $('theme-toggle');
  btn.querySelector('use').setAttribute('href', `#${themeIcon(t)}`);
  btn.title = btn.ariaLabel = `${themeLabel(t)} (click to change)`;
}

onEffectiveThemeChange(({ theme, dark }) => {
  native?.setTheme?.(theme);
  cap?.StatusBar?.setStyle?.({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
  cap?.StatusBar?.setBackgroundColor?.({ color: dark ? '#151d2b' : '#ffffff' }).catch(() => {});
});

// ------------------------------------------------------------------ banner & layout
function renderLayout() {
  const has = store.getSites().length > 0;
  $('sites').hidden = !has;
  $('legend').hidden = !has;
  $('empty').hidden = has;
}

const BANNER_ICON = { up: 'i-up', slow: 'i-slow', warn: 'i-warn', down: 'i-down', opaque: 'i-opaque', blocked: 'i-blocked', none: 'i-none' };

function renderBanner() {
  const states = list.currentStates();
  const count = st => states.filter(s => s === st).length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let state = worstState(states) ?? 'none';
  let text;
  if (!states.length) text = 'No sites yet';
  else if (states.every(s => s === 'none')) { state = 'none'; text = 'Checking…'; }
  else if (state === 'down') text = `${plural(count('down'), 'site')} down`;
  else if (state === 'warn') text = `${plural(count('warn'), 'site')} returning errors`;
  else if (state === 'slow') text = 'Degraded performance';
  else if (state === 'opaque' || state === 'blocked') text = 'Sites reachable (status codes hidden)';
  else text = 'All systems operational';

  const banner = $('banner');
  banner.dataset.state = state;
  banner.querySelector('use').setAttribute('href', `#${BANNER_ICON[state]}`);
  $('banner-text').textContent = text;
  if (document.title !== `${state === 'down' ? '⚠ ' : ''}Site Status`) document.title = `${state === 'down' ? '⚠ ' : ''}Site Status`;
  renderMeta();
}

function renderMeta() {
  const meta = $('banner-meta');
  if (!store.getSites().length) { meta.textContent = ''; return; }
  if (scheduler.running) { meta.textContent = 'Checking now…'; return; }
  const parts = [];
  if (scheduler.lastAt) parts.push(`Updated ${fmtTime(new Date(scheduler.lastAt))}`);
  if (scheduler.nextAt) parts.push(`next in ${Math.max(0, Math.round((scheduler.nextAt - Date.now()) / 1000))} s`);
  meta.textContent = parts.join(' · ');
}
setInterval(renderMeta, 1000);

function renderTransport(t) {
  const badge = $('transport');
  badge.textContent = t.label;
  badge.dataset.limited = String(t.limited);
  badge.dataset.kind = t.id;
  const notice = $('notice');
  notice.hidden = !t.limited;
  notice.textContent = t.limited
    ? 'Browser-only mode: the API server can\'t be reached, so checks run from this browser. CORS hides HTTP status codes, '
      + 'so a site can only show as reachable or unreachable. Start the API server (docker compose up) for full results.'
    : '';
}

// ------------------------------------------------------------------ store changes
let knownSiteCount = store.getSites().length;
store.addEventListener('change', ({ detail }) => {
  if (detail.what === 'sites') {
    list.render();
    renderLayout();
    renderBanner();
    const n = store.getSites().length;
    if (n > knownSiteCount) scheduler.runNow();     // check newly added sites straight away
    knownSiteCount = n;
  } else if (detail.what === 'history') {
    for (const id of detail.ids) list.update(id);
    renderBanner();
  } else if (detail.what === 'settings') {
    const keys = detail.keys ?? ['theme', 'intervalSec', 'apiBase', 'slowMs'];
    const s = store.getSettings();
    if (keys.includes('theme')) { applyTheme(s.theme); renderThemeButton(); }
    if (keys.includes('intervalSec')) { intervalSelect.value = s.intervalSec; scheduler.setInterval(s.intervalSec); }
    if (keys.includes('slowMs')) { list.updateAll(); renderBanner(); }
    if (keys.includes('apiBase')) transports.init();
  }
});

transports.addEventListener('change', ({ detail }) => {
  renderTransport(detail.transport);
  if (detail.message) toast(detail.message, { timeout: 7000 });
});

// ------------------------------------------------------------------ PWA install & updates
let installEvent = null;
addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  installEvent = e;
  $('install').hidden = false;
});
$('install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice;
  installEvent = null;
  $('install').hidden = true;
});
addEventListener('appinstalled', () => { $('install').hidden = true; });

function registerServiceWorker() {
  if (native || cap || !('serviceWorker' in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    const offer = worker => toast('A new version of Site Status is available.', {
      timeout: 0,
      action: { label: 'Reload', run: () => worker.postMessage('skip-waiting') },
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch(err => console.warn('Service worker registration failed', err));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloading) { reloading = true; location.reload(); }
  });
}

// ------------------------------------------------------------------ Android back button
cap?.App?.addListener?.('backButton', () => {
  const open = document.querySelector('dialog[open]');
  if (open) open.close();
  else cap.App.exitApp();
});

// ------------------------------------------------------------------ start
applyTheme(store.getSettings().theme);
renderThemeButton();
list.render();
renderLayout();
renderBanner();
if (!store.storageOk) toast('Storage is unavailable, so changes will only last for this session.', { timeout: 8000 });

await transports.init();
scheduler.start(store.getSettings().intervalSec);
registerServiceWorker();
cap?.SplashScreen?.hide?.();
if (new URLSearchParams(location.search).get('action') === 'manage') openSites();
