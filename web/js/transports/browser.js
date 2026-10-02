// Browser fallback: a no-cors fetch. CORS makes the response opaque, so we learn only whether
// the host answered at all (and roughly how fast). The HTTP status is never visible.

const NETWORK_ERROR = 'No response. The host may be down, or the request was blocked (DNS, TLS, '
  + 'a proxy, an ad-blocker or browser privacy settings).';

const isLoopback = host => /^(localhost|127(\.\d+){3}|\[::1\])$/i.test(host);

async function browserProbe(url, timeoutMs) {
  const checkedAt = new Date().toISOString();
  const base = {
    url, checkedAt, transport: 'browser', status: null, statusText: '', method: 'HEAD',
    redirects: null, finalUrl: url,
  };
  const u = new URL(url);
  // Mixed content: an https page can't fetch plain http (loopback is exempt in modern browsers)
  if (location.protocol === 'https:' && u.protocol === 'http:' && !isLoopback(u.hostname)) {
    return { ...base, blocked: true, timings: { total: null },
      error: 'This page is served over HTTPS, so the browser won\'t request an http:// URL (mixed content).' };
  }
  const t0 = performance.now();
  try {
    await fetch(url, {
      method: 'HEAD', mode: 'no-cors', cache: 'no-store', credentials: 'omit',
      redirect: 'follow', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(timeoutMs),
    });
    let total = performance.now() - t0;
    // Resource Timing gives a tighter number (cross-origin entries still expose duration)
    const entry = performance.getEntriesByName(u.href, 'resource').at(-1);
    if (entry?.duration > 0 && entry.startTime >= t0 - 1) total = entry.duration;
    return { ...base, opaque: true, timings: { total: Math.round(total) }, error: null };
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return { ...base, timings: { total: Math.round(performance.now() - t0) }, error: timedOut ? 'Timed out' : NETWORK_ERROR };
  }
}

export const browserTransport = {
  id: 'browser',
  label: 'Browser probe · limited',
  limited: true,
  async available() { return true; },
  async probeBatch(urls, { timeoutMs }) {
    performance.clearResourceTimings?.();
    const results = new Array(urls.length);
    let next = 0;
    const worker = async () => { while (next < urls.length) { const i = next++; results[i] = await browserProbe(urls[i], timeoutMs); } };
    await Promise.all(Array.from({ length: Math.min(6, urls.length) }, worker));
    return results;
  },
};
