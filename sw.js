// Service worker: permite instalar la app y abrirla sin internet con los ultimos datos descargados.
// Estrategia "red primero": siempre intenta traer lo mas nuevo; si no hay conexion usa la copia guardada.
const CACHE = 'nfl-predictor-v1';
const SHELL = ['./', 'index.html', 'loader.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;   // GitHub API, logos, fuentes: directo
  const key = url.origin + url.pathname;                                  // sin ?t= / ?v= para la copia offline
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(key, copy));
      }
      return res;
    }).catch(() => caches.match(key).then(r => r || caches.match('index.html')))
  );
});
