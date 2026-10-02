// Site Status API + static host. Zero dependencies.
//   GET  /api/health
//   GET  /api/probe?url=...
//   POST /api/probe/batch   { "urls": [...], "timeoutMs"?: number }
// Everything else is served from WEB_ROOT (the PWA).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probe, probeBatch, VERSION } from '../shared/probe.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const env = process.env;
const config = {
  port: Number(env.PORT ?? 8080),
  host: env.HOST ?? '0.0.0.0',
  webRoot: resolve(env.WEB_ROOT ?? join(here, '..', 'web')),
  allowPrivate: /^(1|true|yes)$/i.test(env.ALLOW_PRIVATE ?? 'false'),
  allowedPorts: parsePorts(env.ALLOWED_PORTS ?? '*'),
  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
  maxBatch: Number(env.MAX_BATCH ?? 50),
  ratePerMin: Number(env.RATE_LIMIT_PER_MIN ?? 1200),  // probed URLs per client IP per minute
  maxTimeoutMs: 10_000,
};

function parsePorts(spec) {
  if (spec.trim() === '*') return null;
  const ports = new Set();
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    for (let p = a; p <= (b || a); p++) ports.add(p);
  }
  return ports;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

// --- rate limiting: fixed one-minute window per client IP --------------------------------------
const buckets = new Map();
function takeTokens(ip, n) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > 60_000) buckets.set(ip, b = { start: now, used: 0 });
  if (b.used + n > config.ratePerMin) return false;
  b.used += n;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, b] of buckets) if (b.start < cutoff) buckets.delete(ip);
}, 60_000).unref();

// --- CORS: same-origin always allowed; others only if listed. Cross-origin callers that aren't
// allowed are rejected outright, so an arbitrary web page can't drive this API (which may be
// allowed to reach the private network) from a visitor's browser.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return { ok: true };
  const self = `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
  if (origin === self) return { ok: true };
  if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) return { ok: true, origin };
  return { ok: false };
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(typeof body === 'object' && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

async function readJson(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function probeOptions(timeoutMs) {
  return {
    allowPrivate: config.allowPrivate,
    allowedPorts: config.allowedPorts,
    timeoutMs: Math.min(config.maxTimeoutMs, Math.max(1000, Number(timeoutMs) || config.maxTimeoutMs)),
    transport: 'server',
  };
}

async function handleApi(req, res, url) {
  const cors = originAllowed(req);
  if (!cors.ok) return send(res, 403, { error: 'Origin not allowed' });
  const corsHeaders = cors.origin ? {
    'Access-Control-Allow-Origin': cors.origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin',
  } : {};
  const noStore = { 'Cache-Control': 'no-store', ...corsHeaders };
  const ip = req.socket.remoteAddress ?? 'unknown';

  if (req.method === 'OPTIONS') return send(res, 204, '', corsHeaders);

  if (url.pathname === '/api/health' && req.method === 'GET') {
    return send(res, 200, { status: 'ok', version: VERSION, allowPrivate: config.allowPrivate }, noStore);
  }

  if (url.pathname === '/api/probe' && req.method === 'GET') {
    const target = url.searchParams.get('url');
    if (!target) return send(res, 400, { error: 'Missing url parameter' }, noStore);
    if (!takeTokens(ip, 1)) return send(res, 429, { error: 'Rate limit exceeded' }, { ...noStore, 'Retry-After': '60' });
    return send(res, 200, await probe(target, probeOptions(url.searchParams.get('timeoutMs'))), noStore);
  }

  if (url.pathname === '/api/probe/batch' && req.method === 'POST') {
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'Content-Type must be application/json' }, noStore);
    }
    const body = await readJson(req);
    const urls = body.urls;
    if (!Array.isArray(urls) || urls.some(u => typeof u !== 'string')) {
      return send(res, 400, { error: 'Body must be { "urls": string[] }' }, noStore);
    }
    if (urls.length > config.maxBatch) return send(res, 400, { error: `At most ${config.maxBatch} URLs per batch` }, noStore);
    if (!takeTokens(ip, urls.length)) return send(res, 429, { error: 'Rate limit exceeded' }, { ...noStore, 'Retry-After': '60' });
    return send(res, 200, { results: await probeBatch(urls, probeOptions(body.timeoutMs)) }, noStore);
  }

  return send(res, 404, { error: 'Not found' }, noStore);
}

async function handleStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(config.webRoot, rel));
  if (!file.startsWith(config.webRoot + sep)) return send(res, 403, 'Forbidden');
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const ext = extname(file).toLowerCase();
    const immutable = /\/(fonts|icons)\//.test(rel);
    const body = req.method === 'HEAD' ? '' : await readFile(file);
    send(res, 200, body, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': immutable ? 'public, max-age=604800' : 'no-cache',
      ...(req.method === 'HEAD' ? { 'Content-Length': info.size } : {}),
    });
  } catch {
    send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await handleStatic(req, res, url);
  } catch (err) {
    if (!res.headersSent) send(res, err.status ?? 500, { error: err.status ? err.message : 'Internal error' });
    if (!err.status) console.error(err);
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Site Status ${VERSION} listening on http://${config.host}:${config.port}`);
  console.log(`  web root: ${config.webRoot}`);
  console.log(`  private targets: ${config.allowPrivate ? 'ALLOWED' : 'blocked'}; CORS origins: ${config.corsOrigins.join(', ') || '(same-origin only)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
