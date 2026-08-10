/* AURA-AgriNet service worker.

   The app is entirely client-side, so "offline" simply means the shell must be
   cached completely -- there is no data layer to reconcile. Every asset is
   precached on install and served cache-first.

   Bump CACHE_VERSION on every deploy. An installed copy keeps serving the old
   cache until a new version activates, so forgetting this ships nothing. */
const CACHE_VERSION = 'aura-v8';

const PRECACHE = [
  './',
  './index.html',
  './app.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon-180.png',
  // Locale catalogues. Precached rather than fetched on demand because a farmer
  // who set the app to Português and then lost signal must not get English back.
  './i18n/es.json', './i18n/fr.json', './i18n/pt.json'
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
    await Promise.all(keys.filter(k => !k.startsWith(CACHE_VERSION)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Cross-origin hosts this app is allowed to cache. Everything here is keyless
   and CORS-open, so responses arrive as real (type 'cors') responses that can be
   read and replayed rather than opaque ones that cannot.

   Kept in two buckets because they want opposite strategies:
     DATA  — observations. Network-first: a grower acting on soil moisture needs
             today's number, and the cache is the fallback, not the default.
     TILES — NASA imagery. Cache-first: a granule is immutable once published,
             so re-fetching the same tile is pure waste.                       */
const DATA_HOSTS  = ['api.open-meteo.com', 'flood-api.open-meteo.com', 'geocoding-api.open-meteo.com'];
const TILE_HOSTS  = ['gibs.earthdata.nasa.gov'];
const DATA_CACHE  = CACHE_VERSION + '-data';
const TILE_CACHE  = CACHE_VERSION + '-tiles';
const TILE_LIMIT  = 260;                 // roughly a dozen catchments of imagery

/** Keep a runtime cache from growing without bound. */
async function trim(cacheName, limit) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;
  await Promise.all(keys.slice(0, keys.length - limit).map(k => cache.delete(k)));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* ---- observations: network-first, fall back to the last good response ---- */
  if (DATA_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await cache.match(req);
        if (hit) return hit;
        // The page handles this: it falls back to its own localStorage cache and
        // then to simulation, and says which one it is using.
        return new Response(JSON.stringify({ error: 'offline', host: url.hostname }), {
          status: 503, statusText: 'Offline',
          headers: { 'Content-Type': 'application/json' }
        });
      }
    })());
    return;
  }

  /* ---- NASA imagery: cache-first, since a published granule never changes --- */
  if (TILE_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) {
          cache.put(req, res.clone());
          event.waitUntil(trim(TILE_CACHE, TILE_LIMIT));
        }
        return res;
      } catch (err) {
        return new Response('', { status: 504, statusText: 'Tile unavailable offline' });
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return;   // anything else: untouched

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
