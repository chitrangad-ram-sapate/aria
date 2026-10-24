// Offline cache for the website build. Versioned Pyodide files and hashed assets are cache-first;
// the page and the engine bundle are network-first so a deploy is picked up when online.
const CACHE = 'aria-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const immutable = url.pathname.startsWith('/pyodide/') || url.pathname.startsWith('/assets/');
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(e.request);
    if (immutable && hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
  }));
});
