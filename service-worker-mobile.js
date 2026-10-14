const CACHE_NAME = 'obra-em-dia-mobile-v10';
const APP_FILES = [
  './',
  './index.html',
  './projects.html',
  './projects.js?v=session-20261014',
  './styles.css?v=admin-push-20261014',
  './app.js?v=session-20261014',
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

self.addEventListener('push', event => {
  let message = {};
  try { message = event.data?.json() || {}; } catch { /* Ignore malformed payloads. */ }
  const url = new URL(message.url || './', self.registration.scope);
  const target = url.origin === self.location.origin && url.href.startsWith(self.registration.scope)
    ? url.href : self.registration.scope;
  event.waitUntil(self.registration.showNotification(message.title || 'Obra em Dia', {
    body: message.body || 'Uma obra recebeu uma atualização.',
    icon: './icons/icon-192.svg',
    badge: './icons/icon-192.svg',
    tag: message.tag || 'obra-em-dia-update',
    data: { url: target }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find(client => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(url);
      return existing.focus();
    }
    return self.clients.openWindow(url);
  })());
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
