const CACHE = 'repcore-v85';
const ASSETS = ['./manifest.json', './icons/icon-192x192.png', './icons/icon-512x512.png', './icons/logo.png', './icons/dumbbell.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // index.html : network-first (toujours à jour), fallback cache si offline
  if (url.includes('index.html') || url.endsWith('/') || url.endsWith('/repcore/')) {
    e.respondWith(
      fetch(e.request).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put('./index.html', clone));
        return r;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Assets : cache-first
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});
