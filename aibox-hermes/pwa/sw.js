// Service worker AI Box PWA — stratégie NETWORK-FIRST (comme chat-ui/sw.js) :
// on privilégie toujours le réseau pour ne jamais servir d'asset périmé ; le
// cache ne sert que de repli HORS-LIGNE. L'ancien cache-first « aibox-v1 » sans
// versionnement servait des assets périmés à vie.
'use strict';

const CACHE = 'aibox-pwa-v2';

self.addEventListener('install', (e) => { self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Les appels API (chat) ne sont JAMAIS mis en cache.
  if (url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((resp) => {
        if (resp && resp.ok && resp.type === 'basic') {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
