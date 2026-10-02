// Bridges the shared web app (web/js) to the extension: storage in chrome.storage.local (shared
// with the background worker), the extension probe, per-site host permissions, and leader
// election so only one open sidebar runs checks at a time.
import { probeBatch, originPattern } from './probe.js';

const api = globalThis.browser ?? globalThis.chrome;
const PREFIX = 'sitestatus.';
const SETTINGS_KEY = 'sitestatus.settings.v1';

export async function installHost() {
  // ---- storage: synchronous localStorage-style facade over chrome.storage.local
  const all = await api.storage.local.get(null);
  const cache = new Map(Object.entries(all).filter(([k]) => k.startsWith(PREFIX)));

  globalThis.siteStatusStorage = {
    getItem: key => (cache.has(key) ? cache.get(key) : null),
    setItem: (key, value) => {
      cache.set(key, value);
      api.storage.local.set({ [key]: value });
      // Mirror settings so theme-boot.js can apply the theme before first paint
      if (key === SETTINGS_KEY) try { localStorage.setItem(key, value); } catch { /* optional */ }
    },
  };

  // Writes from the background worker or another sidebar arrive as storage events
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (!key.startsWith(PREFIX) || cache.get(key) === newValue) continue;
      if (newValue === undefined) cache.delete(key); else cache.set(key, newValue);
      dispatchEvent(new StorageEvent('storage', { key }));
    }
  });

  // ---- leader election via a port to the background worker
  let onRole = () => {};
  let leader = null;
  const setRole = value => { if (value !== leader) { leader = value; onRole(value); } };
  function connect() {
    let port;
    try { port = api.runtime.connect({ name: 'panel' }); } catch { setRole(true); return; }
    port.onMessage.addListener(msg => { if (msg?.type === 'role') setRole(msg.leader); });
    // The worker may be stopped by the browser; reconnecting restarts it. Keep the current role
    // meanwhile so checks don't pause.
    port.onDisconnect.addListener(() => setTimeout(connect, 500));
  }
  // Pings keep the background worker alive while a sidebar is open
  setInterval(() => api.runtime.sendMessage({ type: 'ping' }).catch(() => {}), 20_000);

  globalThis.siteStatusHost = {
    probeBatch,
    notifications: true,
    minBackgroundSec: 30,
    onLeaderChange(cb) {
      onRole = cb;
      connect();
      // If the worker never answers, act alone rather than never checking
      setTimeout(() => { if (leader === null) setRole(true); }, 1500);
    },
    access: {
      async missing(urls) {
        const out = [];
        for (const url of urls) {
          if (!(await api.permissions.contains({ origins: [originPattern(url)] }))) out.push(url);
        }
        return out;
      },
      // Must be called synchronously from a user gesture (click / submit)
      request: urls => api.permissions.request({ origins: [...new Set(urls.map(originPattern))] }),
      requestAll: () => api.permissions.request({ origins: ['http://*/*', 'https://*/*'] }),
    },
  };

  api.permissions.onAdded.addListener(() => dispatchEvent(new Event('sitestatus:access')));
}
