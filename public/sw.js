// VedirtSetu PWA Service Worker (Resilient Network-First with Safe Fallback)
const CACHE_VERSION = 'vedirtsetu-v2';
const STATIC_CACHE = CACHE_VERSION + '-static';
const RUNTIME_CACHE = CACHE_VERSION + '-runtime';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
];

// Core app shell pre-cache
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

// Purane version ke sabhi stale caches ko activate hote hi wipe-out karein
self.addEventListener('activate', (event) => {
  const currentCaches = [STATIC_CACHE, RUNTIME_CACHE];
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !currentCaches.includes(key))
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Client app se instant update trigger karne ke liye message listener
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Sirf standard HTTP/HTTPS GET requests ko handle karein (browser extensions bypass)
  if (req.method !== 'GET' || !req.url.startsWith('http')) {
    return;
  }

  // Live real-time ordering APIs aur Firestore ko bilkul bypass karein
  if (
    req.url.includes('/api/') ||
    req.url.includes('firestore.googleapis.com') ||
    req.url.includes('identitytoolkit.googleapis.com')
  ) {
    return;
  }

  // HTML / Page Navigation requests: fresh network version fetch karein taaki updates turant dikhein
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req, { cache: 'no-cache' })
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const clone = res.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match('/index.html');
          return cached || (await caches.match('/'));
        })
    );
    return;
  }

  // Static assets & build bundles (CSS, JS, Fonts, Images)
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// -------------------------------------------------------------
// PUSH & SYSTEM NOTIFICATION EVENT LISTENERS
// -------------------------------------------------------------

// Web Push event listener for background incoming alerts
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'VedirtSetu Order Alert', body: event.data.text() };
    }
  }

  const title = data.title || 'VedirtSetu: ऑर्डर अपडेट';
  const options = {
    body: data.body || 'आपके ऑर्डर की स्थिति में परिवर्तन हुआ है।',
    icon: data.icon || '/icon.svg',
    badge: '/icon.svg',
    tag: data.tag || `order-alert-${Date.now()}`,
    data: data.url ? { url: data.url } : { url: '/' },
    vibrate: [200, 100, 200],
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Click listener: Focus or open the PWA window when retailer taps push alert
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});