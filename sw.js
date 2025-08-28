const SHELL_CACHE = 'squad-shell-v1';
const DYN_CACHE = 'squad-dyn-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => ![SHELL_CACHE, DYN_CACHE].includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Only handle GET
  if (req.method !== 'GET') return;

  const allowCDN = (
    url.hostname.endsWith('openstreetmap.org') ||
    url.hostname.endsWith('tile.openstreetmap.org') ||
    url.hostname.endsWith('unpkg.com') ||
    url.hostname.endsWith('jsdelivr.net') ||
    url.hostname.endsWith('skypack.dev')
  );

  // Same-origin shell assets: cache-first
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      try { cache.put(req, res.clone()); } catch {}
      return res;
    })());
    return;
  }

  // CDN/tiles: cache with network fallback
  if (allowCDN) {
    e.respondWith((async () => {
      const cache = await caches.open(DYN_CACHE);
      const hit = await cache.match(req);
      const fetchP = fetch(req).then(res => { try { cache.put(req, res.clone()); } catch {} return res; });
      return hit || fetchP;
    })());
  }
});
