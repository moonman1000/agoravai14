const CACHE_NAME = 'rt-tracking-static-v1';
const STATIC_ASSETS = [
  '/',
  '/endereco.html',
  '/rastrearpedido.html',
  '/motorista.html',
  '/manifest.json'
  // adicione ícones quando disponíveis: '/icons/icon-192-maskable.png', etc.
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Estratégia:
// - /api/* -> network-first (não cacheia agressivo)
// - /socket.io -> ignorar (SW não intercepta websockets; mas ignore requests http de polling)
// - estáticos -> cache-first
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
