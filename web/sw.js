// Lets the page open offline and show the last check it saw.
const CACHE = 'home-alerts-v1';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first, so warnings are never served stale when there is signal.
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone();
    const key = url.pathname.endsWith('status.json') ? new Request(url.origin + url.pathname) : e.request;
    caches.open(CACHE).then(c => c.put(key, copy));
    return r;
  }).catch(() => caches.match(url.pathname.endsWith('status.json') ? url.origin + url.pathname : e.request)));
});
