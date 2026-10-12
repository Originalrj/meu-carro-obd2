const CACHE_NAME = 'autogestaox-v6';
const ASSETS = [
    './',
    './index.html',
    './ui.js',
    './obd2.js',
    './logger.js',
    './anomaly-db.js',
    './style.css',
    './manifest.json'
];

self.addEventListener('install', (event) => {
    // cache.addAll() rejeita se QUALQUER asset falhar e, com isso, o SW novo nunca
    // ativa (ficando preso numa versão antiga). Aqui cada asset é best-effort.
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => null)))
        )
    );
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

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((cached) => {
            return cached || fetch(event.request).then((response) => {
                if (response.status === 200 && event.request.method === 'GET') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            });
        }).catch(() => {
            if (event.request.destination === 'document') {
                return caches.match('./index.html');
            }
        })
    );
});
