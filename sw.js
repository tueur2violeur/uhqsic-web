// Garde l'app utilisable hors connexion et la fait démarrer instantanément.
// Changer VERSION à chaque mise à jour du site : la nouvelle version s'installe en arrière-plan.
const VERSION = 'uhqsic-14';
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/app.js', 'js/backup.js', 'js/db.js', 'js/discover.js', 'js/gestures.js', 'js/install.js', 'js/sync.js', 'js/vendor/peerjs.min.js', 'js/importer.js', 'js/lyrics.js', 'js/motion.js', 'js/names.js', 'js/palette.js', 'js/queue.js', 'js/resume.js', 'js/settings.js', 'js/share.js', 'js/stats.js', 'js/tags.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // `reload` : les fichiers viennent du serveur, jamais d'un cache HTTP périmé.
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Le téléphone d'abord : l'app s'ouvre tout de suite, même en 4G faible ou sans réseau.
// Toute la version vient du même cache, jamais un mélange d'ancien et de nouveau.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    // Seule l'adresse de l'app sert l'app ; les autres pages (présentation) restent elles-mêmes.
    const scope = new URL('./', self.location).pathname;
    const path = new URL(request.url).pathname;
    const key = request.mode === 'navigate' && (path === scope || path === `${scope}index.html`) ? './' : request;
    const hit = await cache.match(key, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    } catch {
      return (await cache.match('index.html')) || Response.error();
    }
  })());
});
