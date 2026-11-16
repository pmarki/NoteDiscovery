// Keep It Service Worker
// Minimal service worker for PWA install support

// Cache version - the server fills in the app version plus a hash of our own scripts
// Cache is invalidated whenever either changes, which forces users to download
// fresh files without needing a release.
const CACHE_NAME = 'keepit-__APP_VERSION__';

// Something shared to the app from another one (see share_target in the manifest),
// kept until the app has put it somewhere. Not versioned, so an update can't lose it.
const SHARE_CACHE = 'keepit-share';

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
  '/static/app/diff.js?v=__APP_VERSION__',
  '/static/app/notes.js?v=__APP_VERSION__',
  '/static/app/create.js?v=__APP_VERSION__',
  '/static/app/search.js?v=__APP_VERSION__',
  '/static/app/metadata.js?v=__APP_VERSION__',
  '/static/app/share.js?v=__APP_VERSION__',
  '/static/app/home.js?v=__APP_VERSION__',
  '/static/app/share-target.js?v=__APP_VERSION__',
  '/static/app/graph.js?v=__APP_VERSION__',
  '/static/app/session.js?v=__APP_VERSION__',
  '/static/app/viewer.js?v=__APP_VERSION__',
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
          .filter((name) => name !== CACHE_NAME && name !== SHARE_CACHE)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Keep a share for the page, which asks where it goes. The page may need a login
// first, so it's stored here rather than passed along in the redirect.
async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('files').filter((file) => file instanceof File && file.size > 0);
  await caches.delete(SHARE_CACHE);  // A new share replaces one never put anywhere
  const cache = await caches.open(SHARE_CACHE);
  const meta = {
    title: form.get('title') || '',
    text: form.get('text') || '',
    url: form.get('url') || '',
    files: files.map((file) => ({ name: file.name, type: file.type })),
  };
  await Promise.all(files.map((file, index) => cache.put(`/share-target/file/${index}`, new Response(file))));
  await cache.put('/share-target/meta', new Response(JSON.stringify(meta)));
  return Response.redirect('/?share=1', 303);
}

// Fetch event - cache first for /static/, everything else straight to the network
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Only handle same-origin requests
  if (url.origin !== location.origin) {
    return;
  }
  
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(event.request));
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
  
  // Everything else goes to the network as if there were no worker. Only /static/
  // is ever cached, so there was nothing to fall back on, and a failed fetch, such as
  // a login in front of the app (Cloudflare Access) redirecting, became a broken
  // response instead of the browser following the redirect to the login page.
});

