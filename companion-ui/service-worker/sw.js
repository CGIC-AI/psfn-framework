const CACHE_NAME = __PSFN_COMPANION_UI_CACHE_NAME__;
const APP_SHELL = __PSFN_COMPANION_UI_PRECACHE_URLS__;
const CACHE_PREFIX = 'psfn-companion-ui-';
const LEGACY_CACHE_NAMES = new Set(['psfn-satellite-mobile-chat-app-v1']);
const CACHE_FIRST_PATHS = new Set(
  APP_SHELL.filter((path) => path !== '/' && path !== '/index.html'),
);
const HASHED_ASSET_PATH = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u;

async function storeResponse(cache, request, response) {
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.error('Failed to update companion-ui offline cache', error);
  }
}

async function fetchNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(request)
      ?? await cache.match('/index.html')
      ?? await cache.match('/');
    if (cached) return cached;
    throw error;
  }
  if (response.ok) await storeResponse(cache, request, response);
  return response;
}

async function fetchCachedResource(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await storeResponse(cache, request, response);
  return response;
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleCacheNames = keys.filter((key) => (
        key !== CACHE_NAME
        && (key.startsWith(CACHE_PREFIX) || LEGACY_CACHE_NAMES.has(key))
      ));
      await Promise.all(staleCacheNames.map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) {
    return;
  }
  if (
    url.origin === self.location.origin
    && (request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html')
  ) {
    event.respondWith(fetchNavigation(request));
    return;
  }
  if (
    url.origin === self.location.origin
    && (CACHE_FIRST_PATHS.has(url.pathname) || HASHED_ASSET_PATH.test(url.pathname))
  ) {
    event.respondWith(fetchCachedResource(request));
  }
});
