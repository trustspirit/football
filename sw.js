// Service worker: offline app shell + cached player photos and fonts.
const VERSION = 'mdc-v15';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/players.js', 'js/formations.js', 'js/photos.js', 'js/sim.js', 'js/options.js', 'js/sound.js', 'js/match.js', 'js/draft.js',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];
const RUNTIME = 'mdc-runtime-v2'; // v1 held opaque photo responses that break CORS <img> loads

self.addEventListener('install', (e) => {
  // `reload` bypasses the HTTP cache so a new release never stores an older file
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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

  // App shell: network first (so updates land), but fall back to the cache after 3 s
  // on a weak connection, and when offline.
  if (url.origin === self.location.origin) {
    // `no-cache` revalidates with the server (cheap 304s) so files of one release are never
    // mixed with stale copies from the browser's HTTP cache.
    const network = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    });
    const hit = () => caches.match(req, { ignoreSearch: true });
    const offline = () => hit().then((r) => r || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    const slow = new Promise((resolve) => setTimeout(resolve, 3000)).then(hit);
    e.respondWith(
      Promise.race([network, slow])
        .then((res) => res || network) // timed out but nothing cached: keep waiting for the network
        .catch(offline),
    );
    return;
  }

  // Photos (Wikimedia) and Google Fonts: cache first, fill on demand.
  if (/(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$|fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) {
    if (url.pathname.endsWith('/api.php')) return; // photo lookups: always live (results are cached in localStorage)
    e.respondWith(
      caches.open(RUNTIME).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone()).catch(() => {}); // opaque responses are not cached (quota padding, hidden errors)
        return res;
      }))),
    );
  }
});
