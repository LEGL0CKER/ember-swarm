// Ember Swarm service worker — offline support + installable app.
const CACHE = 'ember-swarm-v4';
const CORE = ['/', '/index.html', '/vendor/three.module.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for pages/scripts (always fresh online), cache fallback offline.
// Cache-first for the large vendored engine (immutable, fast).
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // live data: never intercept (a cached leaderboard would masquerade as "Global" offline)
  if (url.pathname.startsWith('/api/')) return;

  // cache-first for the immutable engine, models and fonts — only ever store successful responses
  if (/^\/(vendor|models|fonts)\//.test(url.pathname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    })));
    return;
  }

  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('/index.html')))
  );
});
