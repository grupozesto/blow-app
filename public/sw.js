// Blow — Service Worker v4
// Cache offline + push notifications

const CACHE = 'blow-v4';
const PRECACHE = [
  '/icon/icon-192.png',
  '/icon/icon-512.png',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  // Solo pre-cachear iconos — NO cachear index.html ni JS para evitar versiones viejas
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // API requests: network only, con fallback offline
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Sin conexión. Revisá tu internet.' }), {
          status: 503, headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // index.html y assets de la app: SIEMPRE red primero, cache como fallback
  // Esto evita que versiones viejas queden atrapadas en cache
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          // Solo cachear iconos y fuentes, NO el HTML ni JS principal
          if (res.ok && (url.pathname.startsWith('/icons/') || url.origin.includes('fonts'))) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          // Sin red: intentar desde cache
          return caches.match(e.request).then(cached => {
            if (cached) return cached;
            // Para HTML, devolver una página de error amigable
            if (e.request.headers.get('accept')?.includes('text/html')) {
              return new Response(
                '<html><body style="font-family:sans-serif;text-align:center;padding:40px;"><h2>Sin conexión</h2><p>Revisá tu internet y recargá la página.</p><button onclick="location.reload()">Reintentar</button></body></html>',
                { headers: { 'Content-Type': 'text/html' } }
              );
            }
          });
        })
    );
    return;
  }

  // Fuentes externas: cache first
  if (url.origin.includes('fonts.googleapis') || url.origin.includes('fonts.gstatic')) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return res;
        }).catch(() => cached);
      })
    );
  }
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Blow', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Blow', {
    body: data.body || '', icon: '/icon/icon-192.png', badge: '/icon/icon-72.png',
    tag: data.tag || 'blow-notif', data: { url: data.url || '/' },
    vibrate: [200, 100, 200], requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const targetUrl = e.notification.data?.url || '/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) {
          c.focus(); return c.navigate(targetUrl);
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
