// @vitest-environment node

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { build } from 'vite';

const COMPANION_UI_ROOT = resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

interface TestResponse {
  label: string;
  ok: boolean;
  clone(): TestResponse;
}

interface ServiceWorkerHarnessOptions {
  cacheKeys?: string[];
  cachedResponse?: TestResponse;
  fetchResponse?: TestResponse;
  fetchError?: Error;
  windowClients?: Array<{
    focused: boolean;
    navigate: ReturnType<typeof vi.fn>;
    url: string;
    visibilityState: string;
  }>;
}

function testResponse(label: string): TestResponse {
  return {
    label,
    ok: true,
    clone: () => testResponse(label),
  };
}

function createServiceWorkerHarness(
  source: string,
  options: ServiceWorkerHarnessOptions,
): {
  cacheStorage: {
    delete: ReturnType<typeof vi.fn>;
  };
  clients: {
    claim: ReturnType<typeof vi.fn>;
    matchAll: ReturnType<typeof vi.fn>;
  };
  dispatchActivate(): Promise<void>;
  dispatchFetch(request: {
    method: string;
    mode: string;
    url: string;
  }): Promise<TestResponse | undefined>;
  fetch: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, (event: unknown) => void>();
  const cache = {
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => options.cachedResponse),
    put: vi.fn(async () => undefined),
  };
  const cacheStorage = {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => options.cacheKeys ?? []),
    match: vi.fn(async () => options.cachedResponse),
    open: vi.fn(async () => cache),
  };
  const fetch = vi.fn(async () => {
    if (options.fetchError) throw options.fetchError;
    if (!options.fetchResponse) throw new Error('Test fetch response was not configured');
    return options.fetchResponse;
  });
  const clients = {
    claim: vi.fn(async () => undefined),
    matchAll: vi.fn(async () => options.windowClients ?? []),
  };
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    clients,
    location: {
      origin: 'https://companion.test',
    },
    skipWaiting: vi.fn(async () => undefined),
  };
  runInNewContext(source, {
    URL,
    caches: cacheStorage,
    console,
    fetch,
    Promise,
    self,
  });

  return {
    cacheStorage,
    clients,
    fetch,
    async dispatchActivate() {
      const listener = listeners.get('activate');
      if (!listener) throw new Error('Service worker did not register an activate listener');
      const lifetimePromises: Promise<unknown>[] = [];
      let dispatching = true;
      listener({
        waitUntil(value: Promise<unknown>) {
          if (!dispatching) throw new Error('waitUntil called after event dispatch');
          lifetimePromises.push(Promise.resolve(value));
        },
      });
      dispatching = false;
      await Promise.all(lifetimePromises);
    },
    async dispatchFetch(request) {
      const listener = listeners.get('fetch');
      if (!listener) throw new Error('Service worker did not register a fetch listener');
      let responsePromise: Promise<TestResponse> | undefined;
      const lifetimePromises: Promise<unknown>[] = [];
      let dispatching = true;
      try {
        listener({
          request,
          respondWith(value: Promise<TestResponse>) {
            responsePromise = Promise.resolve(value);
          },
          waitUntil(value: Promise<unknown>) {
            if (!dispatching) throw new Error('waitUntil called after event dispatch');
            lifetimePromises.push(Promise.resolve(value));
          },
        });
      } finally {
        dispatching = false;
      }
      if (!responsePromise) return undefined;
      const response = await responsePromise;
      await Promise.all(lifetimePromises);
      return response;
    },
  };
}

async function buildCompanionUi(revision: string, hubUrl?: string): Promise<{
  indexHtml: string;
  serviceWorker: string;
}> {
  const outDir = await mkdtemp(resolve(tmpdir(), 'psfn-companion-ui-build-'));
  temporaryDirectories.push(outDir);
  const previousRevision = process.env.COMPANION_UI_BUILD_REVISION;
  const previousHubUrl = process.env.VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL;
  process.env.COMPANION_UI_BUILD_REVISION = revision;
  if (hubUrl === undefined) {
    delete process.env.VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL;
  } else {
    process.env.VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL = hubUrl;
  }
  try {
    await build({
      root: COMPANION_UI_ROOT,
      configFile: resolve(COMPANION_UI_ROOT, 'vite.config.ts'),
      logLevel: 'silent',
      build: {
        emptyOutDir: true,
        outDir,
      },
    });
  } finally {
    if (previousRevision === undefined) {
      delete process.env.COMPANION_UI_BUILD_REVISION;
    } else {
      process.env.COMPANION_UI_BUILD_REVISION = previousRevision;
    }
    if (previousHubUrl === undefined) {
      delete process.env.VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL;
    } else {
      process.env.VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL = previousHubUrl;
    }
  }
  return {
    indexHtml: await readFile(resolve(outDir, 'index.html'), 'utf8'),
    serviceWorker: await readFile(resolve(outDir, 'sw.js'), 'utf8'),
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { force: true, recursive: true }),
  ));
});

describe('companion-ui production service worker', () => {
  it('versions each deployment and precaches that build\'s immutable assets', async () => {
    const buildA = await buildCompanionUi('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const buildB = await buildCompanionUi('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    expect(buildA.serviceWorker).not.toBe(buildB.serviceWorker);
    expect(buildA.serviceWorker).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(buildB.serviceWorker).toContain('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(buildB.serviceWorker).not.toContain('__PSFN_COMPANION_UI_');
    expect(buildB.serviceWorker).not.toMatch(/\/assets\/[^"']+\.map/gu);

    const assetPaths = [...buildB.indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)]
      .map((match) => match[1]);
    expect(assetPaths.length).toBeGreaterThan(0);
    for (const assetPath of assetPaths) {
      expect(buildB.serviceWorker).toContain(JSON.stringify(assetPath));
    }
  });

  it('uses a distinct cache generation when one revision produces different bundles', async () => {
    const revision = '2222222222222222222222222222222222222222';
    const buildA = await buildCompanionUi(revision, 'ws://hub-a.test:8787/');
    const buildB = await buildCompanionUi(revision, 'ws://hub-b.test:8787/');
    const cacheA = buildA.serviceWorker.match(/const CACHE_NAME = "([^"]+)";/u)?.[1];
    const cacheB = buildB.serviceWorker.match(/const CACHE_NAME = "([^"]+)";/u)?.[1];

    expect(cacheA).toBeTruthy();
    expect(cacheB).toBeTruthy();
    expect(cacheA).not.toBe(cacheB);
  });

  it('uses the network for navigations even when an older shell is cached', async () => {
    const { serviceWorker } = await buildCompanionUi(
      'cccccccccccccccccccccccccccccccccccccccc',
    );
    const cached = testResponse('cached build A shell');
    const current = testResponse('network build B shell');
    const harness = createServiceWorkerHarness(serviceWorker, {
      cachedResponse: cached,
      fetchResponse: current,
    });

    const response = await harness.dispatchFetch({
      method: 'GET',
      mode: 'navigate',
      url: 'https://companion.test/',
    });

    expect(response).toBe(current);
    expect(harness.fetch).toHaveBeenCalledOnce();
  });

  it('activates a generated update without deleting unrelated caches or navigating open clients', async () => {
    const { serviceWorker } = await buildCompanionUi(
      'dddddddddddddddddddddddddddddddddddddddd',
    );
    const currentCacheName = serviceWorker.match(/const CACHE_NAME = "([^"]+)";/u)?.[1];
    if (!currentCacheName) throw new Error('Built service worker did not contain its cache name');
    const navigate = vi.fn(async () => undefined);
    const harness = createServiceWorkerHarness(serviceWorker, {
      cacheKeys: [
        currentCacheName,
        'psfn-companion-ui-previous-build',
        'psfn-satellite-mobile-chat-app-v1',
        'unrelated-origin-cache',
      ],
      windowClients: [{
        focused: true,
        navigate,
        url: 'https://companion.test/',
        visibilityState: 'visible',
      }],
    });

    await harness.dispatchActivate();

    expect(harness.cacheStorage.delete.mock.calls.map(([cacheName]) => cacheName).sort()).toEqual([
      'psfn-companion-ui-previous-build',
      'psfn-satellite-mobile-chat-app-v1',
    ]);
    expect(harness.clients.claim).toHaveBeenCalledOnce();
    expect(harness.clients.matchAll).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('schedules a focused legacy-client recovery without awaiting navigation during activation', async () => {
    const { serviceWorker } = await buildCompanionUi(
      'dddddddddddddddddddddddddddddddddddddddd',
    );
    const currentCacheName = serviceWorker.match(/const CACHE_NAME = "([^"]+)";/u)?.[1];
    if (!currentCacheName) throw new Error('Built service worker did not contain its cache name');
    const navigate = vi.fn(() => new Promise<never>(() => {}));
    const harness = createServiceWorkerHarness(serviceWorker, {
      cacheKeys: [currentCacheName, 'psfn-satellite-mobile-chat-app-v1'],
      windowClients: [{
        focused: true,
        navigate,
        url: 'https://companion.test/',
        visibilityState: 'visible',
      }],
    });

    await harness.dispatchActivate();

    expect(harness.clients.claim).toHaveBeenCalledOnce();
    expect(harness.clients.matchAll).toHaveBeenCalledWith({
      includeUncontrolled: true,
      type: 'window',
    });
    expect(navigate).toHaveBeenCalledWith('https://companion.test/');
  });

  it('falls back to the current cached shell when a navigation is offline', async () => {
    const { serviceWorker } = await buildCompanionUi(
      'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    );
    const cached = testResponse('current cached shell');
    const harness = createServiceWorkerHarness(serviceWorker, {
      cachedResponse: cached,
      fetchError: new Error('offline'),
    });

    const response = await harness.dispatchFetch({
      method: 'GET',
      mode: 'navigate',
      url: 'https://companion.test/conversation',
    });

    expect(response).toBe(cached);
  });

  it('serves hashed immutable assets cache-first', async () => {
    const { serviceWorker } = await buildCompanionUi(
      'ffffffffffffffffffffffffffffffffffffffff',
    );
    const cached = testResponse('cached immutable asset');
    const harness = createServiceWorkerHarness(serviceWorker, {
      cachedResponse: cached,
      fetchResponse: testResponse('network immutable asset'),
    });

    const response = await harness.dispatchFetch({
      method: 'GET',
      mode: 'same-origin',
      url: 'https://companion.test/assets/index-AbCdEf12.js',
    });

    expect(response).toBe(cached);
    expect(harness.fetch).not.toHaveBeenCalled();
  });

  it('leaves unversioned non-shell resources to the browser network', async () => {
    const { serviceWorker } = await buildCompanionUi(
      '1111111111111111111111111111111111111111',
    );
    const harness = createServiceWorkerHarness(serviceWorker, {
      cachedResponse: testResponse('stale unversioned response'),
      fetchResponse: testResponse('current unversioned response'),
    });

    const response = await harness.dispatchFetch({
      method: 'GET',
      mode: 'same-origin',
      url: 'https://companion.test/runtime-config.json',
    });

    expect(response).toBeUndefined();
    expect(harness.fetch).not.toHaveBeenCalled();
  });
});
