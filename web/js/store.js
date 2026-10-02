// All persistent state lives in localStorage behind this module. If storage is unavailable
// (private mode, quota, disabled) everything keeps working in memory for the session.

const KEYS = {
  sites: 'sitestatus.sites.v1',
  settings: 'sitestatus.settings.v1',
  history: 'sitestatus.history.v1',
};

export const INTERVALS = [5, 10, 15, 30, 60, 120, 300, 600, 900];
export const HISTORY_LEN = 90;
export const DEFAULT_SETTINGS = { intervalSec: 60, theme: 'system', apiBase: '', slowMs: 2000 };
export const EXAMPLE_SITES = [
  { name: 'Google', url: 'https://www.google.com' },
  { name: 'GitHub', url: 'https://github.com' },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org' },
  { name: 'Cloudflare', url: 'https://www.cloudflare.com' },
];

const memory = {};
let storageOk = true;

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? (memory[key] ?? fallback) : JSON.parse(raw);
  } catch {
    storageOk = false;
    return memory[key] ?? fallback;
  }
}

function write(key, value) {
  memory[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { storageOk = false; }
}

const uid = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** Validates and normalises a URL; throws a user-facing message on failure. */
export function normalizeUrl(input) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('Enter a URL.');
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = 'https://' + text;
  let url;
  try { url = new URL(text); } catch { throw new Error('That doesn\'t look like a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// URLs can be monitored.');
  if (!url.hostname) throw new Error('The URL needs a host name.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials aren\'t supported.');
  url.hash = '';
  return url.href;
}

/** Key used to de-duplicate: case-insensitive host, no trailing slash. */
const urlKey = href => {
  const u = new URL(href);
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}${u.search}`;
};

function cleanName(name, url) {
  const n = String(name ?? '').trim().slice(0, 80);
  return n || new URL(url).hostname.replace(/^www\./, '');
}

class Store extends EventTarget {
  #sites = read(KEYS.sites, []);
  #settings = { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) };
  #history = read(KEYS.history, {});

  constructor() {
    super();
    // Keep multiple tabs/windows in sync
    addEventListener('storage', e => {
      if (e.key === KEYS.sites) { this.#sites = read(KEYS.sites, []); this.#emit('sites'); }
      if (e.key === KEYS.settings) { this.#settings = { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) }; this.#emit('settings'); }
    });
    if (!INTERVALS.includes(this.#settings.intervalSec)) this.#settings.intervalSec = DEFAULT_SETTINGS.intervalSec;
  }

  get storageOk() { return storageOk; }

  #emit(what, detail = {}) { this.dispatchEvent(new CustomEvent('change', { detail: { what, ...detail } })); }
  #saveSites() { write(KEYS.sites, this.#sites); this.#emit('sites'); }

  // ----- sites -----
  getSites() { return this.#sites.slice(); }
  getSite(id) { return this.#sites.find(s => s.id === id); }

  findDuplicate(url, exceptId) {
    const key = urlKey(url);
    return this.#sites.find(s => s.id !== exceptId && urlKey(s.url) === key);
  }

  addSite({ name, url }) {
    const href = normalizeUrl(url);
    const dup = this.findDuplicate(href);
    if (dup) throw new Error(`"${dup.name}" already monitors that URL.`);
    const site = { id: uid(), name: cleanName(name, href), url: href, createdAt: new Date().toISOString() };
    this.#sites.push(site);
    this.#saveSites();
    return site;
  }

  updateSite(id, { name, url }) {
    const site = this.getSite(id);
    if (!site) return;
    const href = normalizeUrl(url);
    const dup = this.findDuplicate(href, id);
    if (dup) throw new Error(`"${dup.name}" already monitors that URL.`);
    const urlChanged = href !== site.url;
    Object.assign(site, { name: cleanName(name, href), url: href });
    if (urlChanged) this.clearHistory(id);
    this.#saveSites();
  }

  /** Removes a site and returns an undo function. */
  removeSite(id) {
    const index = this.#sites.findIndex(s => s.id === id);
    if (index < 0) return () => {};
    const [site] = this.#sites.splice(index, 1);
    const history = this.#history[id];
    delete this.#history[id];
    write(KEYS.history, this.#history);
    this.#saveSites();
    return () => {
      this.#sites.splice(Math.min(index, this.#sites.length), 0, site);
      if (history) { this.#history[id] = history; write(KEYS.history, this.#history); }
      this.#saveSites();
    };
  }

  moveSite(id, delta) {
    const i = this.#sites.findIndex(s => s.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.#sites.length) return;
    [this.#sites[i], this.#sites[j]] = [this.#sites[j], this.#sites[i]];
    this.#saveSites();
  }

  /** mode: 'merge' (skip duplicates) or 'replace'. Returns { added, skipped }. */
  importSites(list, mode) {
    if (mode === 'replace') {
      this.#sites = [];
      this.#history = {};
      write(KEYS.history, this.#history);
    }
    let added = 0, skipped = 0;
    for (const { name, url } of list) {
      if (this.findDuplicate(url)) { skipped++; continue; }
      this.#sites.push({ id: uid(), name: cleanName(name, url), url, createdAt: new Date().toISOString() });
      added++;
    }
    this.#saveSites();
    return { added, skipped };
  }

  exportSites() {
    return {
      app: 'site-status',
      version: 1,
      exportedAt: new Date().toISOString(),
      sites: this.#sites.map(({ name, url }) => ({ name, url })),
    };
  }

  // ----- settings -----
  getSettings() { return { ...this.#settings }; }
  setSettings(patch) {
    this.#settings = { ...this.#settings, ...patch };
    write(KEYS.settings, this.#settings);
    this.#emit('settings', { keys: Object.keys(patch) });
  }

  // ----- history (ring buffer per site) -----
  getHistory(id) { return this.#history[id] ?? []; }

  /** results: Array<[siteId, result]>; written once per tick. */
  appendResults(results) {
    for (const [id, result] of results) {
      if (!this.getSite(id)) continue;
      const list = this.#history[id] ??= [];
      list.push(result);
      if (list.length > HISTORY_LEN) list.splice(0, list.length - HISTORY_LEN);
    }
    write(KEYS.history, this.#history);
    this.#emit('history', { ids: results.map(([id]) => id) });
  }

  clearHistory(id) {
    if (id) delete this.#history[id];
    else this.#history = {};
    write(KEYS.history, this.#history);
    this.#emit('history', { ids: id ? [id] : this.#sites.map(s => s.id) });
  }
}

/**
 * Parses an import file. Accepts { sites: [...] } (our export format) or a bare array of
 * { name, url }. Returns cleaned entries; throws a user-facing message if nothing is usable.
 */
export function parseImport(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The file isn\'t valid JSON.'); }
  const list = Array.isArray(data) ? data : data?.sites;
  if (!Array.isArray(list)) throw new Error('Expected a list of sites ({ "sites": [ { "name", "url" } ] }).');
  const sites = [];
  let invalid = 0;
  for (const item of list) {
    try {
      const url = normalizeUrl(typeof item === 'string' ? item : item?.url);
      sites.push({ name: typeof item?.name === 'string' ? item.name : '', url });
    } catch { invalid++; }
  }
  if (!sites.length) throw new Error('No valid http(s) sites were found in the file.');
  return { sites, invalid };
}

export const store = new Store();
