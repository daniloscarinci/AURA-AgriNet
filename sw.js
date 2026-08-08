/* AURA-AgriNet service worker.

   The app is entirely client-side, so "offline" simply means the shell must be
   cached completely -- there is no data layer to reconcile. Every asset is
   precached on install and served cache-first.

   Bump CACHE_VERSION on every deploy. An installed copy keeps serving the old
   cache until a new version activates, so forgetting this ships nothing. */
const CACHE_VERSION = 'aura-v3';

const PRECACHE = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // addAll is atomic: one bad URL fails the whole install, which is what we
    // want -- a half-cached shell that breaks offline is worse than no install.
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never cache cross-origin

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);

    // Navigations: serve the cached shell so a deep link works offline too.
    if (req.mode === 'navigate') {
      const cached = await cache.match('./index.html');
      if (cached) {
        // Refresh in the background so the next launch is current.
        event.waitUntil(
          fetch(req).then(res => res.ok && cache.put('./index.html', res.clone())).catch(() => {})
        );
        return cached;
      }
    }

    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;

    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      // Genuinely offline and not in cache.
      return new Response('Offline — asset not cached.', {
        status: 503,
        statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  })());
});

// Lets the page trigger an immediate update instead of waiting for a restart.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
