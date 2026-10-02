// Extension probe: a plain fetch() from an extension context. With host permission for the
// target it isn't subject to CORS, so the real status code is visible. chrome.webRequest (watch
// only) adds the server IP, redirect count, an approximate TTFB and precise network error codes.
// Used by both the sidebar page and the background service worker.

const api = globalThis.browser ?? globalThis.chrome;
const ORIGIN = api.runtime.getURL('').replace(/\/$/, '');

/** Match pattern covering a URL's host (match patterns ignore ports). */
export const originPattern = url => {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
};

export const hasAccess = url => api.permissions.contains({ origins: [originPattern(url)] });

// ------------------------------------------------------------------ webRequest enrichment
const records = new Map();   // requestId -> { sent, headers, redirects, ip, error, done, at }
const byUrl = new Map();     // request URL -> latest requestId
let listening = false;

function listen() {
  if (listening || !api.webRequest) return;
  listening = true;
  const filter = { urls: ['<all_urls>'] };
  const mine = d => (d.initiator ?? d.originUrl ?? d.documentUrl ?? '').startsWith(ORIGIN);
  const rec = d => records.get(d.requestId);

  api.webRequest.onBeforeRequest.addListener(d => {
    if (!mine(d) || records.has(d.requestId)) return;
    records.set(d.requestId, { redirects: 0, done: false, at: Date.now() });
    byUrl.set(d.url, d.requestId);
  }, filter);
  api.webRequest.onSendHeaders.addListener(d => { const r = rec(d); if (r) r.sent = d.timeStamp; }, filter);
  api.webRequest.onBeforeRedirect.addListener(d => { const r = rec(d); if (r) { r.redirects++; r.sent = null; } }, filter);
  api.webRequest.onHeadersReceived.addListener(d => { const r = rec(d); if (r) r.headers = d.timeStamp; }, filter);
  api.webRequest.onResponseStarted.addListener(d => { const r = rec(d); if (r && d.ip) r.ip = d.ip; }, filter);
  api.webRequest.onCompleted.addListener(d => { const r = rec(d); if (r) { r.ip ??= d.ip; r.done = true; } }, filter);
  api.webRequest.onErrorOccurred.addListener(d => { const r = rec(d); if (r) { r.error = d.error; r.done = true; } }, filter);
}

/** The webRequest record for the latest request to `url`, waiting briefly for its final event. */
async function recordFor(url) {
  const id = byUrl.get(new URL(url).href);   // webRequest reports normalised URLs
  const r = id && records.get(id);
  if (!r) return null;
  for (let i = 0; i < 10 && !r.done; i++) await new Promise(res => setTimeout(res, 15));
  // Prune old records
  const cutoff = Date.now() - 120_000;
  for (const [k, v] of records) if (v.at < cutoff) records.delete(k);
  return r;
}

const NET_ERRORS = [
  [/NAME_NOT_RESOLVED|UNKNOWN_HOST|NAME_RESOLUTION/i, 'DNS lookup failed'],
  [/CONNECTION_REFUSED/i, 'Connection refused'],
  [/CONNECTION_RESET|NET_RESET/i, 'Connection reset'],
  [/TIMED_OUT|NET_TIMEOUT/i, 'Timed out'],
  [/ADDRESS_UNREACHABLE|NETWORK_UNREACHABLE|HOST_UNREACHABLE/i, 'Host unreachable'],
  [/INTERNET_DISCONNECTED|OFFLINE/i, 'This device is offline'],
  [/CERT_DATE_INVALID|EXPIRED/i, 'TLS certificate expired'],
  [/CERT_AUTHORITY_INVALID|UNKNOWN_ISSUER|SELF_SIGNED/i, 'TLS certificate isn\'t trusted'],
  [/CERT_COMMON_NAME_INVALID|BAD_CERT_DOMAIN/i, 'TLS certificate does not match host'],
  [/CERT|SSL|SEC_ERROR/i, 'TLS error'],
  [/BLOCKED_BY_CLIENT/i, 'Blocked by another extension (e.g. an ad-blocker)'],
  [/BLOCKED_BY_ADMINISTRATOR/i, 'Blocked by browser policy'],
  [/ABORTED|NS_BINDING_ABORTED/i, 'Request aborted'],
];
const describeNetError = code => NET_ERRORS.find(([re]) => re.test(code))?.[1] ?? code;

// ------------------------------------------------------------------ probing
export async function probe(url, timeoutMs = 10_000) {
  listen();
  const checkedAt = new Date().toISOString();
  const base = { url, checkedAt, transport: 'extension', status: null, statusText: '', redirects: 0, finalUrl: url };
  const t0 = performance.now();

  if (!(await hasAccess(url))) {
    return { ...base, method: 'HEAD', blocked: true, timings: { total: null },
      error: 'Site access not granted. Open Sites and choose Grant, or allow all sites in Settings.' };
  }

  const deadline = t0 + timeoutMs;
  const request = method => fetch(url, {
    method, cache: 'no-store', credentials: 'omit', redirect: 'follow', referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(Math.max(1, deadline - performance.now())),
  });

  let method = 'HEAD';
  try {
    let res = await request(method);
    if ((res.status >= 400 && res.status < 500) || res.status === 501) {
      method = 'GET';               // many servers/CDNs reject HEAD; confirm with GET
      res = await request(method);
    }
    res.body?.cancel().catch(() => {});      // headers are all we need
    const total = Math.round(performance.now() - t0);
    const r = await recordFor(url);
    return {
      ...base,
      status: res.status,
      statusText: res.statusText,
      method,
      timings: { dns: null, connect: null, tls: null, ttfb: r?.sent && r?.headers ? Math.round(r.headers - r.sent) : null, total },
      redirects: r?.redirects ?? (res.redirected ? 1 : 0),
      finalUrl: res.url || url,
      ip: r?.ip ?? null,
      error: null,
    };
  } catch (err) {
    const total = Math.round(performance.now() - t0);
    const r = await recordFor(url);
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      ...base,
      method,
      timings: { dns: null, connect: null, tls: null, ttfb: null, total },
      error: timedOut ? 'Timed out' : r?.error ? describeNetError(r.error) : 'Network error (no response)',
      errorCode: r?.error ?? null,
    };
  }
}

export async function probeBatch(urls, { timeoutMs } = {}, concurrency = 6) {
  const results = new Array(urls.length);
  let next = 0;
  const worker = async () => { while (next < urls.length) { const i = next++; results[i] = await probe(urls[i], timeoutMs); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
