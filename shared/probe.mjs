// Probe engine: one HTTP(S) heartbeat check with a DNS / connect / TLS / TTFB breakdown.
// Zero dependencies. Shared by the hosted API (api/server.mjs) and the Electron main process.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { isPrivateAddress } from './ssrf-guard.mjs';

export const VERSION = '0.1.0';

const DEFAULTS = {
  timeoutMs: 10_000,
  maxRedirects: 5,
  allowPrivate: true,
  allowedPorts: null,      // null = any port, otherwise a Set<number>
  userAgent: `SiteStatus/${VERSION} (+heartbeat monitor)`,
};

const ERROR_TEXT = {
  ENOTFOUND: 'DNS lookup failed',
  EAI_AGAIN: 'DNS lookup timed out',
  ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset',
  EHOSTUNREACH: 'Host unreachable',
  ENETUNREACH: 'Network unreachable',
  ETIMEDOUT: 'Timed out',
  EPROTO: 'TLS protocol error',
  CERT_HAS_EXPIRED: 'TLS certificate expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'TLS certificate is self-signed',
  SELF_SIGNED_CERT_IN_CHAIN: 'TLS chain contains a self-signed certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate could not be verified',
  ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match host',
  EBLOCKED: 'Blocked: private or reserved address',
  EPORT: 'Blocked: port not allowed',
  EPROTOCOL: 'Only http and https URLs are supported',
  EINVALIDURL: 'Invalid URL',
  ETOOMANYREDIRECTS: 'Too many redirects',
};

const describe = err => ERROR_TEXT[err.code] ?? err.message ?? String(err);
const round = n => (n == null ? null : Math.round(n));
const coded = (code, message) => Object.assign(new Error(message ?? ERROR_TEXT[code] ?? code), { code });

/** DNS lookup wrapper that enforces the private-address policy on every resolved address. */
function guardedLookup(allowPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      if (!allowPrivate) {
        const all = Array.isArray(address) ? address.map(a => a.address) : [address];
        if (all.some(isPrivateAddress)) return callback(coded('EBLOCKED'));
      }
      callback(null, address, family);
    });
  };
}

/** One request/response hop. Resolves with status, headers and timings; never reads the body. */
function hop(url, method, opts) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const t = { dns: null, connect: null, tls: null, ttfb: null };

    const req = lib.request(url, {
      method,
      agent: false,                       // fresh socket per probe so connect/TLS timings are real
      lookup: guardedLookup(opts.allowPrivate),
      headers: {
        'User-Agent': opts.userAgent,
        'Accept': '*/*',
        'Cache-Control': 'no-cache',
        'Connection': 'close',
      },
    });

    const timer = setTimeout(() => req.destroy(coded('ETIMEDOUT')), opts.remainingMs());

    req.on('socket', socket => {
      socket.once('lookup', () => { t.dns = performance.now() - t0; });
      socket.once('connect', () => { t.connect = performance.now() - t0; });
      socket.once('secureConnect', () => { t.tls = performance.now() - t0; });
    });
    req.on('response', res => {
      t.ttfb = performance.now() - t0;
      clearTimeout(timer);
      res.destroy();                      // headers are all we need
      // Convert cumulative marks into per-phase durations
      const dnsEnd = t.dns ?? 0;
      const connEnd = t.connect ?? dnsEnd;
      resolve({
        status: res.statusCode,
        statusText: res.statusMessage ?? '',
        location: res.headers.location,
        timings: {
          dns: t.dns == null ? null : round(t.dns),
          connect: t.connect == null ? null : round(connEnd - dnsEnd),
          tls: t.tls == null ? null : round(t.tls - connEnd),
          ttfb: round(t.ttfb - (t.tls ?? connEnd)),
          total: round(t.ttfb),
        },
      });
    });
    req.on('error', err => { clearTimeout(timer); reject(err); });
    req.end();
  });
}

function checkTarget(url, opts) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw coded('EPROTOCOL');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (opts.allowedPorts && !opts.allowedPorts.has(port)) throw coded('EPORT');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!opts.allowPrivate && net.isIP(host) && isPrivateAddress(host)) throw coded('EBLOCKED');
  if (!opts.allowPrivate && /^localhost$/i.test(host)) throw coded('EBLOCKED');
}

/**
 * Probe a URL. HEAD first, falling back to GET when HEAD is rejected (405/501/4xx), following
 * redirects. Always resolves (never throws) with a protocol result object; classification into
 * up/slow/down is left to the client, which owns the slow threshold.
 */
export async function probe(rawUrl, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const started = performance.now();
  opts.remainingMs = () => Math.max(1, opts.timeoutMs - (performance.now() - started));
  const checkedAt = new Date().toISOString();
  const base = { url: rawUrl, checkedAt, transport: options.transport ?? 'server' };

  let url;
  try { url = new URL(rawUrl); } catch { return fail(base, coded('EINVALIDURL'), started, 'HEAD', 0, rawUrl); }

  let method = 'HEAD';
  let redirects = 0;
  try {
    for (;;) {
      checkTarget(url, opts);
      let res = await hop(url, method, opts);
      if (method === 'HEAD' && (res.status === 405 || res.status === 501 || (res.status >= 400 && res.status < 500))) {
        method = 'GET';                   // many servers/CDNs reject HEAD; confirm with GET
        res = await hop(url, method, opts);
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        if (++redirects > opts.maxRedirects) throw coded('ETOOMANYREDIRECTS');
        url = new URL(res.location, url);
        continue;
      }
      return {
        ...base,
        status: res.status,
        statusText: res.statusText,
        method,
        timings: { ...res.timings, total: round(performance.now() - started) },
        redirects,
        finalUrl: url.href,
        error: null,
      };
    }
  } catch (err) {
    return fail(base, err, started, method, redirects, url.href);
  }
}

function fail(base, err, started, method, redirects, finalUrl) {
  return {
    ...base,
    status: null,
    statusText: '',
    method,
    timings: { dns: null, connect: null, tls: null, ttfb: null, total: round(performance.now() - started) },
    redirects,
    finalUrl,
    error: describe(err),
    errorCode: err.code ?? null,
  };
}

/** Probe many URLs with bounded concurrency; results keep input order. */
export async function probeBatch(urls, options = {}, concurrency = 8) {
  const results = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const i = next++;
      results[i] = await probe(urls[i], options);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}
