// firebase-messaging-sw.js  -- must live at the root of the site
// Handles FCM push notifications AND app shell caching for fast loads.

// ─── Cache config ────────────────────────────────────────────────────────────
// Bump CACHE_VERSION after a significant deploy to force clients to refresh.
const CACHE_VERSION = 'v6-20260902';
const CACHE_NAME    = 'spark-shell-' + CACHE_VERSION;

const SHELL_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
];

// ─── Install: pre-cache the app shell ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting(); // activate immediately, don't wait for old SW to die
});

// ─── Activate: delete stale caches ───────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('spark-shell-') && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim(); // take control of all open tabs immediately
});

// ─── Fetch: smart caching strategy ───────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept GET requests
  if (request.method !== 'GET') return;

  // Cache-first for versioned Firebase/Google CDN scripts — they never change
  // at a given version URL, so serving from cache is always safe and fast.
  const isCdnScript = (
    (url.hostname === 'www.gstatic.com'      && url.pathname.includes('/firebasejs/')) ||
    (url.hostname === 'fonts.googleapis.com') ||
    (url.hostname === 'fonts.gstatic.com')
  );
  if (isCdnScript) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return response;
      })
    );
    return;
  }

  // Only intercept same-origin requests below this point
  if (url.origin !== self.location.origin) return;

  // Navigation (main HTML doc): stale-while-revalidate
  // → serve cached instantly, update cache in background so next load is fresh
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match('/');
        const networkFetch = fetch(request).then((response) => {
          if (response && response.ok) cache.put('/', response.clone());
          return response;
        }).catch(() => null);
        // Return cache immediately if available; otherwise wait for network
        return cached ? (networkFetch.catch(() => {}), cached) : networkFetch;
      })
    );
    return;
  }

  // Static shell assets: cache-first, fall back to network
  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()));
          }
          return response;
        });
      })
    );
    return;
  }
});

// ─── Firebase Cloud Messaging ─────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyDse1xgw4UOvPEfzHeiSqLllwP6zaGQOKA',
  authDomain:        'spark-dating-c74f4.firebaseapp.com',
  projectId:         'spark-dating-c74f4',
  storageBucket:     'spark-dating-c74f4.firebasestorage.app',
  messagingSenderId: '983075921138',
  appId:             '1:983075921138:web:dd6c8b1edaa72ef70c446b',
});

const messaging = firebase.messaging();

// Called when a push arrives and the app is NOT in the foreground.
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  const data            = payload.data || {};

  self.registration.showNotification(title || 'Spark', {
    body:  body  || '',
    icon:  '/icon-192.png',
    badge: '/badge-72.png',
    data:  data,
    tag:   data.tag || 'spark-push',
  });
});

// Navigate (or focus) the app when the user taps a notification.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = (event.notification.data && event.notification.data.url)
                    || self.registration.scope;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
