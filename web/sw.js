// Service worker: precaches the app shell; probe/API traffic always goes to the network.
// The CACHE name and SHELL list are maintained by scripts/build-web.mjs (npm run build:web).
const CACHE = 'site-status-0.1.0';
const SHELL = [
  /* shell:start */
  './css/app.css',
  './css/fonts.css',
  './css/tokens.css',
  './favicon.ico',
  './favicon.svg',
  './fonts/google-sans-latin-1.woff2',
  './fonts/google-sans-latin-ext-0.woff2',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
  './icons/monochrome-512.png',
  './',
  './js/app.js',
  './js/chart.js',
  './js/classify.js',
  './js/dialogs.js',
  './js/format.js',
  './js/io.js',
  './js/popover.js',
  './js/scheduler.js',
  './js/store.js',
  './js/theme-boot.js',
  './js/theme.js',
  './js/toast.js',
  './js/transports/api.js',
  './js/transports/browser.js',
  './js/transports/index.js',
  './js/transports/native.js',
  './js/version.js',
  './manifest.webmanifest',
  /* shell:end */
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Only our own old caches: other apps may share this origin (e.g. localhost during development)
    for (const key of await caches.keys()) if (key.startsWith('site-status-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  // Only same-origin GETs for the shell; never the API, never the monitored sites.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    // Stale-while-revalidate: instant from cache, refreshed in the background
    return cached ?? (await network) ?? (req.mode === 'navigate' ? cache.match('./') : Response.error());
  })());
});
