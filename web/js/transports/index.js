// Picks the best available transport (native > hosted API > browser) and handles failover:
// two consecutive API failures demote to the browser; a periodic health check promotes back.
import { electronTransport, capacitorTransport, extensionTransport } from './native.js';
import { createApiTransport } from './api.js';
import { browserTransport } from './browser.js';

const API_RECHECK_MS = 5 * 60_000;
const API_FAILURES_BEFORE_FALLBACK = 2;

export class TransportManager extends EventTarget {
  #api;
  #current = null;
  #failures = 0;
  #recheckTimer = null;

  constructor(getApiBase) {
    super();
    this.#api = createApiTransport(getApiBase);
  }

  get current() { return this.#current; }
  get isNative() { return [electronTransport, capacitorTransport, extensionTransport].includes(this.#current); }

  async init() {
    clearInterval(this.#recheckTimer);
    this.#failures = 0;
    for (const t of [electronTransport, capacitorTransport, extensionTransport]) {
      if (await t.available()) return this.#set(t);
    }
    this.#set(await this.#api.available() ? this.#api : browserTransport);
    this.#recheckTimer = setInterval(() => this.#recheck(), API_RECHECK_MS);
  }

  /** Tests an API base without switching to it. */
  testApi(base) { return createApiTransport(() => base).available(5000); }

  async #recheck() {
    if (this.#current !== browserTransport) return;
    if (await this.#api.available()) {
      this.#set(this.#api, 'API server is reachable again. Using server probes.');
    }
  }

  #set(t, message) {
    const changed = t !== this.#current;
    this.#current = t;
    if (changed) this.dispatchEvent(new CustomEvent('change', { detail: { transport: t, message } }));
  }

  async probeBatch(urls, opts) {
    const t = this.#current ?? browserTransport;
    if (t !== this.#api) return t.probeBatch(urls, opts);
    try {
      const results = await t.probeBatch(urls, opts);
      this.#failures = 0;
      return results;
    } catch {
      // Don't leave a gap in the chart: answer this tick from the browser
      if (++this.#failures >= API_FAILURES_BEFORE_FALLBACK) {
        this.#set(browserTransport, 'Can\'t reach the API server. Falling back to browser probes, which can\'t see HTTP status codes.');
      }
      return browserTransport.probeBatch(urls, opts);
    }
  }
}
