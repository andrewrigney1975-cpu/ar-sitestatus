// End-to-end test of the Chrome sidebar extension in Chrome for Testing (separate profile).
//   npm run build:extension -- --test && node tests/extension.e2e.mjs [--screenshot <file>]
// Loads dist/extension/chrome-test (host access pre-granted), opens the sidebar page, checks a mix
// of real and local sites, then closes the sidebar and verifies the background worker takes over.
import puppeteer from 'puppeteer';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const extPath = fileURLToPath(new URL('../dist/extension/chrome-test', import.meta.url));
const shotIdx = process.argv.indexOf('--screenshot');
const shot = shotIdx > 0 ? process.argv[shotIdx + 1] : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Local target server (plain http) for deterministic status codes
const server = http.createServer((req, res) => {
  const code = Number(new URL(req.url, 'http://x').pathname.slice(1)) || 200;
  res.writeHead(code); res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`,
    // Ubuntu 23.10+ CI runners block the user namespaces Chrome's sandbox needs
    ...(process.env.CI ? ['--no-sandbox'] : []),
  ],
});
let failed = false;
try {
  const swTarget = await browser.waitForTarget(t => t.type() === 'service_worker' && t.url().endsWith('/background.js'));
  const extId = new URL(swTarget.url()).host;
  const sw = await swTarget.worker();
  console.log('extension id', extId);

  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${extId}/index.html`);
  await page.waitForSelector('#transport');
  await sleep(1500);

  const sites = [
    { name: 'GitHub', url: 'https://github.com' },
    { name: 'Plain HTTP site', url: 'http://example.com' },
    { name: 'Local OK', url: `${local}/200` },
    { name: 'Local 503', url: `${local}/503` },
    { name: 'Local 404', url: `${local}/404` },
    { name: 'Bad DNS', url: 'https://nonexistent.invalid' },
    { name: 'Expired TLS', url: 'https://expired.badssl.com' },
  ];
  await page.evaluate(async list => {
    const { store } = await import('./js/store.js');
    store.importSites(list, 'replace');
  }, sites);
  await sleep(12_000);

  const state = await page.evaluate(async () => {
    const { store } = await import('./js/store.js');
    return {
      transport: document.getElementById('transport').textContent,
      banner: document.getElementById('banner-text').textContent,
      results: store.getSites().map(s => {
        const r = store.getHistory(s.id).at(-1);
        return { name: s.name, status: r?.status, error: r?.error, ip: r?.ip, ttfb: r?.timings?.ttfb, total: r?.timings?.total, transport: r?.transport };
      }),
    };
  });
  console.table(state.results);
  console.log('transport:', state.transport, '| banner:', state.banner);
  if (shot) await page.screenshot({ path: shot, fullPage: true });

  const by = name => state.results.find(r => r.name === name);
  assert.equal(state.transport, 'Extension probe');
  assert.equal(by('GitHub').status, 200);
  assert.equal(by('Plain HTTP site').status, 200, 'http:// targets must be checkable');
  assert.equal(by('Local OK').status, 200);
  assert.equal(by('Local 503').status, 503);
  assert.equal(by('Local 404').status, 404);
  assert.equal(by('Bad DNS').status, null);
  assert.equal(by('Expired TLS').status, null);
  assert.ok(state.results.every(r => r.transport === 'extension'));
  assert.deepEqual(errors, [], 'page errors');

  const badge = await sw.evaluate(() => chrome.action.getBadgeText({}));
  console.log('badge with sidebar open:', JSON.stringify(badge));
  assert.equal(badge, '3', 'badge counts down sites (503, DNS, TLS)');

  // Close the sidebar: the background worker must take over checks
  const before = await sw.evaluate(async () => {
    const h = JSON.parse((await chrome.storage.local.get('sitestatus.history.v1'))['sitestatus.history.v1']);
    return Object.values(h).reduce((n, l) => n + l.length, 0);
  });
  await page.close();
  await sleep(1000);
  await sw.evaluate(() => globalThis.siteStatusTick());
  const after = await sw.evaluate(async () => {
    const h = JSON.parse((await chrome.storage.local.get('sitestatus.history.v1'))['sitestatus.history.v1']);
    return Object.values(h).reduce((n, l) => n + l.length, 0);
  });
  console.log(`background run: history ${before} -> ${after} checks`);
  assert.equal(after - before, sites.length);
  const alarm = await sw.evaluate(() => chrome.alarms.get('tick'));
  console.log('alarm period (min):', alarm?.periodInMinutes);
  assert.equal(alarm?.periodInMinutes, 1);
  console.log('PASS');
} catch (err) {
  failed = true;
  console.error('FAIL', err);
} finally {
  await browser.close();
  server.close();
  process.exitCode = failed ? 1 : 0;
}
