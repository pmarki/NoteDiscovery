// NoteDiscovery Service Worker
// Minimal service worker for PWA install support

// Cache version - the server fills in the app version plus a hash of our own scripts
// Cache is invalidated whenever either changes, which forces users to download
// fresh files without needing a release.
const CACHE_NAME = 'notediscovery-__APP_VERSION__';

// Assets to cache for faster repeat visits. Our scripts carry the same ?v= as their
// script tags in index.html, so this precaches the URL the page actually requests.
const PRECACHE_ASSETS = [
  '/static/logo.svg',
  '/static/favicon.svg',
  '/static/app/shared.js?v=__APP_VERSION__',
  '/static/app/core.js?v=__APP_VERSION__',
  '/static/app/settings.js?v=__APP_VERSION__',
  '/static/app/tree.js?v=__APP_VERSION__',
  '/static/app/tags.js?v=__APP_VERSION__',
  '/static/app/media.js?v=__APP_VERSION__',
  '/static/app/drawing.js?v=__APP_VERSION__',
  '/static/app/editor.js?v=__APP_VERSION__',
  '/static/app/notes.js?v=__APP_VERSION__',
  '/static/app/create.js?v=__APP_VERSION__',
  '/static/app/search.js?v=__APP_VERSION__',
  '/static/app/metadata.js?v=__APP_VERSION__',
  '/static/app/share.js?v=__APP_VERSION__',
  '/static/app/home.js?v=__APP_VERSION__',
  '/static/app/graph.js?v=__APP_VERSION__',
  '/static/app.js?v=__APP_VERSION__',
  '/static/app.css?v=__APP_VERSION__',
  '/static/note-editor.bundle.js?v=__APP_VERSION__'
];

// Install event - cache essential assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch event - network first, fallback to cache for assets
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only handle same-origin requests
  if (url.origin !== location.origin) {
    return;
  }
  
  // For API calls, always go to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  
  // For static assets, try cache first then network
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(event.request)
        .then((cached) => cached || fetch(event.request))
    );
    return;
  }
  
  // For everything else, network first
  event.respondWith(
    fetch(event.request)
      .catch(() => caches.match(event.request))
  );
});

