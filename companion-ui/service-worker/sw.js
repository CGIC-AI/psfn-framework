const CACHE_NAME = __PSFN_COMPANION_UI_CACHE_NAME__;
const APP_SCOPE = __PSFN_COMPANION_UI_APP_SCOPE__;
const APP_SHELL = __PSFN_COMPANION_UI_PRECACHE_URLS__;
const CACHE_PREFIX = 'psfn-companion-ui-';
const LEGACY_CACHE_NAMES = new Set(['psfn-satellite-mobile-chat-app-v1']);
const CACHE_FIRST_PATHS = new Set(
  APP_SHELL.filter((path) => path !== APP_SCOPE && path !== `${APP_SCOPE}index.html`),
);
const SHELL_PATHS = new Set([APP_SCOPE, `${APP_SCOPE}index.html`]);

function isCacheableStaticResponse(request, response) {
  const cacheControl = response.headers.get('cache-control')?.toLowerCase() ?? '';
  const vary = response.headers.get('vary')?.toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean) ?? [];
  return response.ok
    && !response.redirected
    && response.url === request.url
    && !cacheControl.split(',').some((value) => (
      ['no-store', 'private'].includes(value.trim().split('=', 1)[0])
    ))
    && !vary.includes('*')
    && !vary.includes('cookie')
    && !response.headers.has('set-cookie');
}

async function precacheAppShell() {
  const entries = await Promise.all(APP_SHELL.map(async (path) => {
    const request = new Request(new URL(path, self.location.origin), {
      cache: 'reload',
      credentials: 'omit',
    });
    const response = await fetch(request);
    if (!isCacheableStaticResponse(request, response)) {
      throw new Error(`Refusing to precache non-public companion-ui asset: ${path}`);
    }
    return { request, response };
  }));
  const cache = await caches.open(CACHE_NAME);
  await Promise.all(entries.map(({ request, response }) => (
    cache.put(request, response)
  )));
}

async function fetchNavigation(request) {
  const cache = await caches.open(CACHE_NAME);
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(`${APP_SCOPE}index.html`)
      ?? await cache.match(APP_SCOPE);
    if (cached) return cached;
    throw error;
  }
  return response;
}

async function fetchCachedResource(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  return fetch(request);
}

function hasSensitiveRequestMetadata(request) {
  return request.cache === 'no-store'
    || request.mode === 'websocket'
    || (request.mode !== 'navigate' && request.credentials === 'include')
    || request.headers.has('authorization')
    || request.headers.has('cookie')
    || request.headers.has('upgrade')
    || request.headers.has('sec-websocket-key');
}

function isSafeScopedRequest(request, url) {
  return request.method === 'GET'
    && url.origin === self.location.origin
    && url.search === ''
    && !hasSensitiveRequestMetadata(request);
}

function isSafeRecoveryClient(client) {
  try {
    const url = new URL(client.url);
    return url.origin === self.location.origin
      && url.search === ''
      && SHELL_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

async function scheduleLegacyClientRecovery() {
  const windows = await self.clients.matchAll({
    includeUncontrolled: true,
    type: 'window',
  });
  const scopedWindows = windows.filter(isSafeRecoveryClient);
  const foreground = scopedWindows.filter((client) => (
    client.focused && client.visibilityState === 'visible'
  ));
  const targets = foreground.length > 0
    ? foreground
    : (scopedWindows.length === 1 ? scopedWindows : []);
  for (const client of targets) {
    // Do not await navigation inside activation: the navigation is handled by
    // this worker, so awaiting it would keep activation open behind itself.
    void client.navigate(client.url).catch((error) => {
      console.error('Failed to recover a legacy companion-ui client', error);
    });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheAppShell());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const hasLegacyCache = keys.some((key) => LEGACY_CACHE_NAMES.has(key));
      const hasPriorGeneratedCache = keys.some((key) => (
        key !== CACHE_NAME && key.startsWith(CACHE_PREFIX)
      ));
      // Cache names are origin-global, so a legacy cache cannot identify which
      // client created it. A prior generated cache means the origin is mixed or
      // already generated; fail closed instead of force-navigating that client.
      const migratingLegacyClient = hasLegacyCache && !hasPriorGeneratedCache;
      const staleCacheNames = keys.filter((key) => (
        key !== CACHE_NAME
        && (key.startsWith(CACHE_PREFIX) || LEGACY_CACHE_NAMES.has(key))
      ));
      await Promise.all(staleCacheNames.map((key) => caches.delete(key)));
      await self.clients.claim();
      if (migratingLegacyClient) await scheduleLegacyClientRecovery();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (!isSafeScopedRequest(request, url)) return;
  if (request.mode === 'navigate' && SHELL_PATHS.has(url.pathname)) {
    event.respondWith(fetchNavigation(request));
    return;
  }
  if (CACHE_FIRST_PATHS.has(url.pathname)) {
    event.respondWith(fetchCachedResource(request));
  }
});
