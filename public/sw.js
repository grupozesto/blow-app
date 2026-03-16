// Blow — Service Worker v2
// Cache offline + push notifications

const CACHE = 'blow-v2';
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
];

self.addEventListener('install', e => {
  self.skipWaiting();
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
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && (url.origin === self.location.origin || url.origin.includes('fonts'))) {
          try { const clone = res.clone(); caches.open(CACHE).then(c => c.put(e.request, clone)); } catch(err) {}
        }
        return res;
      }).catch(() => {
        if (e.request.headers.get('accept')?.includes('text/html'))
          return caches.match('/index.html');
      });
    })
  );
});

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'Blow', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Blow', {
    body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-72.png',
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
