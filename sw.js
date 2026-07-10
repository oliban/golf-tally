/* Offline cache for the course, but network-first so an online launch always
 * gets the latest app. Falls back to the cache (and the app shell) when there's
 * no signal. Bump CACHE only to force a hard reset of cached assets. */
const CACHE = 'golf-v8';
const ASSETS = [
  '.',
  'index.html',
  'styles.css',
  'courses.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(networkFirst(e.request));
});

// Try the network (with a short timeout so a weak signal doesn't hang the app),
// update the cache on success, and serve the cache when offline.
async function networkFirst(request) {
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    caches.open(CACHE).then((c) => c.put(request, res.clone())).catch(() => {});
    return res;
  } catch (err) {
    const cached = await caches.match(request);
    return cached || caches.match('index.html');
  }
}
