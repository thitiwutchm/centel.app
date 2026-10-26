// ThemeB service worker, scoped to /themeb/. Bump CACHE when shipping changes.
const CACHE = 'billplanner-themeb-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'fonts/plexthai-400-thai.woff2',
  'fonts/plexthai-400-latin.woff2',
  'fonts/plexthai-500-thai.woff2',
  'fonts/plexthai-500-latin.woff2',
  'fonts/plexthai-600-thai.woff2',
  'fonts/plexthai-600-latin.woff2',
  'fonts/intertight-600-latin.woff2',
  'fonts/jetbrainsmono-500-latin.woff2',
  '../icons/icon-192.png',
  '../icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

// Only clean up older ThemeB caches; the main app's caches belong to its own worker.
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('billplanner-themeb-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates arrive when online; fall back to cache offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
