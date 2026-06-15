// Service worker AI Box — stratégie NETWORK-FIRST : on privilégie toujours le
// réseau (donc jamais d'asset périmé, cohérent avec le Cache-Control: no-store du
// serveur) ; le cache ne sert que de repli HORS-LIGNE. Permet l'installation PWA.
const CACHE = 'aibox-chat-v1';

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
  // Jamais de cache pour le dynamique : token de session, WebSocket, API, médias.
  if (url.pathname.endsWith('/session') || url.pathname.startsWith('/api/')) return;
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
