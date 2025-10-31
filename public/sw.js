const CACHE_NAME = 'motorista-cache-v1';
const urlsToCache = [
    '/',
    '/motorista.html',
    '/styles.css',
    '/socket.io/socket.io.js',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/leaflet.css',
    'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/leaflet.js'
];

// Instalação do Service Worker
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                return cache.addAll(urlsToCache);
            })
    );
});

// Resposta de requisições de rede
self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                return response || fetch(event.request);
            })
    );
});

// Atualização do Service Worker
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(keyList => {
            return Promise.all(
                keyList.map(key => {
                    if (!cacheWhitelist.includes(key)) {
                        return caches.delete(key);
                    }
                })
            );
        })
    );
});
