const CACHE_NAME = 'obra-em-dia-mobile-v5';
const APP_FILES = [
  './',
  './index.html',
  './projects.html',
  './projects.js?v=project-management-20261006',
  './styles.css?v=project-management-20261006',
  './app.js?v=activities-fast-20261009',
  './supabase/config.js',
  './manifest.webmanifest',
  './entrecon-logo.svg',
  './icons/icon-192.svg',
  './icons/icon-512.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);

    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(event.request);
      if (cached) return cached;

      if (event.request.mode === 'navigate') {
        return await cache.match('./index.html') || await cache.match('./');
      }

      return Response.error();
    }
  })());
});
