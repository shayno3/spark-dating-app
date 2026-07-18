// firebase-messaging-sw.js  -- must live at the root of the site
// Handles FCM push notifications when the app is in the background or closed.

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
