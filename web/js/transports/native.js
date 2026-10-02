// Native transports: no CORS restrictions, real status codes.

/** Electron: the preload bridges to shared/probe.mjs running in the main process. */
export const electronTransport = {
  id: 'electron',
  label: 'Desktop probe',
  limited: false,
  async available() { return typeof window.siteStatusNative?.probeBatch === 'function'; },
  probeBatch(urls, { timeoutMs }) { return window.siteStatusNative.probeBatch(urls, { timeoutMs }); },
};

/** Browser extension: host-permission fetch isn't subject to CORS, so status codes are visible. */
export const extensionTransport = {
  id: 'extension',
  label: 'Extension probe',
  limited: false,
  async available() { return typeof window.siteStatusHost?.probeBatch === 'function'; },
  probeBatch(urls, { timeoutMs }) { return window.siteStatusHost.probeBatch(urls, { timeoutMs }); },
};

/** Capacitor (Android): CapacitorHttp performs the request natively. */
const capHttp = () => window.Capacitor?.Plugins?.CapacitorHttp;

async function capProbe(url, timeoutMs) {
  const t0 = performance.now();
  const checkedAt = new Date().toISOString();
  const request = method => capHttp().request({
    url, method,
    headers: { 'Cache-Control': 'no-cache' },
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
    responseType: 'text',
  });
  let method = 'HEAD';
  try {
    let res = await request(method);
    if (res.status >= 400 && res.status < 500 || res.status === 501) {
      method = 'GET';
      res = await request(method);
    }
    const total = Math.round(performance.now() - t0);
    return {
      url, checkedAt, transport: 'native',
      status: res.status, statusText: '',
      method,
      timings: { dns: null, connect: null, tls: null, ttfb: null, total },
      redirects: res.url && res.url !== url ? 1 : 0,
      finalUrl: res.url || url,
      error: null,
    };
  } catch (err) {
    const total = Math.round(performance.now() - t0);
    const msg = String(err?.message ?? err);
    return {
      url, checkedAt, transport: 'native',
      status: null, statusText: '', method,
      timings: { dns: null, connect: null, tls: null, ttfb: null, total },
      redirects: 0, finalUrl: url,
      error: /timeout|timed out/i.test(msg) ? 'Timed out'
        : /UnknownHost|Unable to resolve/i.test(msg) ? 'DNS lookup failed'
        : /refused/i.test(msg) ? 'Connection refused'
        : /SSL|certificate|Trust anchor/i.test(msg) ? 'TLS certificate error'
        : msg,
    };
  }
}

export const capacitorTransport = {
  id: 'native',
  label: 'Native probe',
  limited: false,
  async available() { return !!(window.Capacitor?.isNativePlatform?.() && capHttp()); },
  async probeBatch(urls, { timeoutMs }) {
    const results = new Array(urls.length);
    let next = 0;
    const worker = async () => { while (next < urls.length) { const i = next++; results[i] = await capProbe(urls[i], timeoutMs); } };
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
    return results;
  },
};
