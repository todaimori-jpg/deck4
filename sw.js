/**
 * Offline shell for the PWA.
 *
 * Only the app shell is cached. Imported audio lives in IndexedDB, and caching
 * it here too would double the storage cost and risk serving a stale crate
 * after the user re-imports a track.
 */

const CACHE = 'deck-shell-v2-recording';
const SHELL = [
  './',
  './index.html',
  './styles/app.css',
  './src/main.js',
  './src/audio/engine.js',
  './src/audio/deck.js',
  './src/audio/deck-worklet.js',
  './src/audio/recorder.js',
  './src/analysis/analyze.js',
  './src/analysis/grid.js',
  './src/store/library.js',
  './src/ui/widgets.js',
  './src/ui/waveform.js',
  './src/ui/deckview.js',
  './src/ui/mixerview.js',
  './src/ui/browser.js',
  './src/ui/recordingview.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/sw.js')) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || caches.match('./index.html') || Response.error()),
      ),
  );
});
