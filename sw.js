// Bump CACHE when shipping changes so installed apps pick up the new files.
const CACHE = 'billplanner-v76';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'i18n.js',
  'theme.js',
  'glass.js',
  'cloud.js',
  'money.js',
  'notes.js',
  'chat.js',
  'mac.js',
  'app.js',
  'billfiles.js',
  'gmail.js',
  'schedule.js',
  'calfeed.js',
  'push.js',
  'manifest.webmanifest',
  'icons/centel-192.png',
  'icons/centel-512.png',
  'icons/centel-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first so updates arrive when online; fall back to cache offline.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API answers are per-account and must never be served from the cache.
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
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

// iPhone / browser notifications sent by the api (push.js on the server).
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Centel', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: 'icons/centel-192.png',
    badge: 'icons/centel-192.png',
    data: { url: d.url || '/' },
  }));
});

// Tapping a notification brings the open app forward, or opens it.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.location.origin));
    if (open) { open.postMessage({ type: 'open', url }); return open.focus(); }
    return self.clients.openWindow(url);
  }));
});
