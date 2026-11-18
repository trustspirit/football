// Service worker: offline app shell + cached player photos and fonts.
const VERSION = 'mdc-v4';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/players.js', 'js/formations.js', 'js/photos.js', 'js/sim.js', 'js/match.js', 'js/draft.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const RUNTIME = 'mdc-runtime-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // App shell: network first (so updates land), fall back to cache offline.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
    );
    return;
  }

  // Photos (Wikimedia) and Google Fonts: cache first, fill on demand.
  if (/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$|fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    if (url.pathname.endsWith('/api.php')) return; // photo lookups: always live (results are cached in localStorage)
    e.respondWith(
      caches.open(RUNTIME).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }))),
    );
  }
});
