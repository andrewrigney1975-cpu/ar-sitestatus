import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probe, probeBatch } from '../shared/probe.mjs';
import { isPrivateAddress } from '../shared/ssrf-guard.mjs';

let server, base;

before(async () => {
  server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/ok') return res.end('ok');
    if (path === '/redirect') { res.writeHead(301, { Location: '/ok' }); return res.end(); }
    if (path === '/loop') { res.writeHead(302, { Location: '/loop' }); return res.end(); }
    if (path === '/no-head') { res.writeHead(req.method === 'HEAD' ? 405 : 200); return res.end(); }
    if (path === '/error') { res.writeHead(503); return res.end(); }
    if (path === '/missing') { res.writeHead(404); return res.end(); }
    if (path === '/hang') return;                       // never answers
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

test('200 with timings', async () => {
  const r = await probe(`${base}/ok`);
  assert.equal(r.status, 200);
  assert.equal(r.method, 'HEAD');
  assert.equal(r.error, null);
  assert.ok(r.timings.total >= 0 && r.timings.ttfb != null);
  assert.match(r.checkedAt, /Z$/);
});

test('follows redirects and reports the final URL', async () => {
  const r = await probe(`${base}/redirect`);
  assert.equal(r.status, 200);
  assert.equal(r.redirects, 1);
  assert.equal(r.finalUrl, `${base}/ok`);
});

test('stops redirect loops', async () => {
  const r = await probe(`${base}/loop`, { maxRedirects: 3 });
  assert.equal(r.status, null);
  assert.equal(r.error, 'Too many redirects');
});

test('retries with GET when HEAD is rejected', async () => {
  const r = await probe(`${base}/no-head`);
  assert.equal(r.status, 200);
  assert.equal(r.method, 'GET');
});

test('reports 5xx and 4xx status codes', async () => {
  assert.equal((await probe(`${base}/error`)).status, 503);
  const missing = await probe(`${base}/missing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.method, 'GET');
});

test('times out', async () => {
  const r = await probe(`${base}/hang`, { timeoutMs: 300 });
  assert.equal(r.status, null);
  assert.equal(r.error, 'Timed out');
  assert.ok(r.timings.total >= 290 && r.timings.total < 2000);
});

test('connection refused and invalid input never throw', async () => {
  const refused = await probe('http://127.0.0.1:1/');
  assert.equal(refused.error, 'Connection refused');
  assert.equal((await probe('not a url')).error, 'Invalid URL');
  assert.equal((await probe('ftp://example.com')).error, 'Only http and https URLs are supported');
});

test('blocks private targets when allowPrivate is false', async () => {
  for (const url of [`${base}/ok`, 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data']) {
    const r = await probe(url, { allowPrivate: false });
    assert.equal(r.error, 'Blocked: private or reserved address', url);
  }
});

test('enforces the port allow-list', async () => {
  const r = await probe(`${base}/ok`, { allowedPorts: new Set([80, 443]) });
  assert.equal(r.error, 'Blocked: port not allowed');
});

test('batch keeps input order', async () => {
  const urls = [`${base}/error`, `${base}/ok`, `${base}/missing`];
  const results = await probeBatch(urls, {}, 2);
  assert.deepEqual(results.map(r => r.status), [503, 200, 404]);
  assert.deepEqual(results.map(r => r.url), urls);
});

test('isPrivateAddress', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});
