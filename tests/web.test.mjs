// Front-end logic that doesn't need a DOM: classification, uptime, timeouts, URL handling, import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, uptime, worstState } from '../web/js/classify.js';
import { timeoutFor } from '../web/js/scheduler.js';

// store.js expects browser globals; provide minimal stand-ins before importing it
const mem = new Map();
globalThis.addEventListener ??= () => {};
globalThis.localStorage ??= {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
};
const { store, normalizeUrl, parseImport } = await import('../web/js/store.js');

const r = (status, total = 100, extra = {}) => ({ status, timings: { total }, ...extra });

test('classify', () => {
  assert.equal(classify(r(200), 2000), 'up');
  assert.equal(classify(r(301), 2000), 'up');
  assert.equal(classify(r(200, 2500), 2000), 'slow');
  assert.equal(classify(r(404), 2000), 'warn');
  assert.equal(classify(r(503), 2000), 'down');
  assert.equal(classify(r(null, 10000, { error: 'Timed out' }), 2000), 'down');
  assert.equal(classify(r(null, 50, { opaque: true }), 2000), 'opaque');
  assert.equal(classify(r(null, null, { blocked: true }), 2000), 'blocked');
  assert.equal(classify(undefined, 2000), 'none');
});

test('uptime ignores browser-only checks', () => {
  assert.equal(uptime([r(200), r(200, 3000), r(503), r(404)], 2000), 0.5);
  assert.equal(uptime([r(null, 1, { opaque: true })], 2000), null);
  assert.equal(uptime([], 2000), null);
});

test('worstState', () => {
  assert.equal(worstState(['up', 'slow', 'up']), 'slow');
  assert.equal(worstState(['up', 'down', 'warn']), 'down');
  assert.equal(worstState(['none']), null);
});

test('timeout scales with interval within 3–10 s', () => {
  assert.equal(timeoutFor(5), 4000);
  assert.equal(timeoutFor(60), 10_000);
  assert.equal(timeoutFor(1), 3000);
});

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com/');
  assert.equal(normalizeUrl(' http://Example.com/a#frag '), 'http://example.com/a');
  assert.throws(() => normalizeUrl('ftp://x.com'), /http/);
  assert.throws(() => normalizeUrl('https://user:pw@x.com'), /credentials/);
  assert.throws(() => normalizeUrl(''), /Enter a URL/);
});

test('parseImport accepts export format and bare arrays', () => {
  const { sites, invalid } = parseImport(JSON.stringify({ app: 'site-status', version: 1, sites: [
    { name: 'A', url: 'https://a.example' }, { name: 'Bad', url: 'javascript:alert(1)' }, 'b.example',
  ] }));
  assert.equal(sites.length, 2);
  assert.equal(invalid, 1);
  assert.equal(sites[1].url, 'https://b.example/');
  assert.equal(parseImport('[{"url":"https://c.example"}]').sites.length, 1);
  assert.throws(() => parseImport('{nope'), /valid JSON/);
  assert.throws(() => parseImport('{"sites":[]}'), /No valid/);
});

test('store: add, dedupe, merge/replace import, history ring buffer, undo', () => {
  const a = store.addSite({ name: '', url: 'https://www.example.com' });
  assert.equal(a.name, 'example.com');
  assert.throws(() => store.addSite({ name: 'x', url: 'https://WWW.example.com/' }), /already monitors/);

  const merged = store.importSites([{ name: 'dup', url: 'https://www.example.com/' }, { name: 'new', url: 'https://new.example/' }], 'merge');
  assert.deepEqual(merged, { added: 1, skipped: 1 });

  const result = { url: a.url, status: 200, timings: { total: 1 } };
  store.appendResults(Array.from({ length: 100 }, () => [a.id, result]));
  assert.equal(store.getHistory(a.id).length, 90);

  const undo = store.removeSite(a.id);
  assert.equal(store.getSite(a.id), undefined);
  undo();
  assert.equal(store.getHistory(a.id).length, 90);

  store.importSites([{ name: 'only', url: 'https://only.example/' }], 'replace');
  assert.deepEqual(store.getSites().map(s => s.name), ['only']);
  assert.deepEqual(store.exportSites().sites, [{ name: 'only', url: 'https://only.example/' }]);
});
