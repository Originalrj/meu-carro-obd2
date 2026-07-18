// SELF-DESTRUCT: remove service worker to prevent interference
self.addEventListener('install', () => {
    self.registration.unregister();
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))));
});
self.addEventListener('activate', e => {
    e.waitUntil(self.clients.claim().then(() => self.clients.matchAll()).then(clients => {
        clients.forEach(c => c.navigate(c.url));
    }));
});
