// ═══════════════════════════════════════════════
//  DeliveryApp — Service Worker
//  Maneja cache offline y notificaciones push
// ═══════════════════════════════════════════════

const CACHE_NAME = 'deliveryapp-v1';
const CACHE_VERSION = 1;

// Archivos que se guardan en cache para funcionar offline
const STATIC_CACHE = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap',
];

// ── Instalación: guardar archivos estáticos ──
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_CACHE).catch(err => {
        console.log('Cache parcial:', err);
      });
    })
  );
  self.skipWaiting();
});

// ── Activación: limpiar caches viejos ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch: estrategia Network First con fallback a cache ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Las llamadas a la API siempre van a la red (nunca cachear datos dinámicos)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() => {
        return new Response(
          JSON.stringify({ error: 'Sin conexión. Verificá tu internet.' }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      })
    );
    return;
  }

  // Para archivos estáticos: network first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Guardar copia en cache si es válida
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(() => {
        // Sin red: devolver desde cache
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // Si no hay cache, devolver la home (SPA fallback)
          return caches.match('/');
        });
      })
  );
});

// ── Notificaciones Push ──
self.addEventListener('push', (event) => {
  let data = { title: 'DeliveryApp', body: 'Tenés una notificación nueva', icon: '/icons/icon-192.png' };

  try {
    if (event.data) {
      data = { ...data, ...event.data.json() };
    }
  } catch (e) {
    if (event.data) data.body = event.data.text();
  }

  const options = {
    body: data.body,
    icon: data.icon || '/icons/icon-192.png',
    badge: '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: data.actions || [],
    tag: data.tag || 'default',
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// ── Click en notificación: abrir la app ──
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Si ya está abierta, enfocarla
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus();
          client.navigate(urlToOpen);
          return;
        }
      }
      // Si no está abierta, abrir nueva ventana
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// ── Sync en background (cuando vuelve la conexión) ──
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-orders') {
    console.log('Background sync: verificando pedidos pendientes');
  }
});
