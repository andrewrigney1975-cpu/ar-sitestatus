// Hosted API transport (api/server.mjs). Full fidelity, CORS-free because the server does the fetch.

const BATCH = 50;

export function createApiTransport(getBase) {
  const endpoint = path => {
    const base = (getBase() || '').trim().replace(/\/+$/, '');
    return base ? `${base}${path}` : new URL(`.${path}`, location.href).href;
  };

  return {
    id: 'server',
    label: 'Server probe',
    limited: false,

    /** Health check. Resolves true/false, never throws. */
    async available(timeoutMs = 3000) {
      // file:// and the native shells have no same-origin server
      if (!getBase() && !/^https?:$/.test(location.protocol)) return false;
      try {
        const res = await fetch(endpoint('/api/health'), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return false;
        const body = await res.json();
        return body?.status === 'ok';
      } catch {
        return false;
      }
    },

    async probeBatch(urls, { timeoutMs }) {
      const results = [];
      for (let i = 0; i < urls.length; i += BATCH) {
        const res = await fetch(endpoint('/api/probe/batch'), {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: urls.slice(i, i + BATCH), timeoutMs }),
          signal: AbortSignal.timeout(timeoutMs + 5000),
        });
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        results.push(...(await res.json()).results);
      }
      return results;
    },
  };
}
