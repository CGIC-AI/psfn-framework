import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { build, type Plugin } from 'vite';

const COMPANION_UI_ROOT = resolve(import.meta.dirname, '..');
const LEGACY_CLIENT_PATH = resolve(import.meta.dirname, 'fixtures/legacy-main.tsx');
const LEGACY_WORKER_PATH = resolve(import.meta.dirname, 'fixtures/legacy-sw.js');
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

interface BuiltFixture {
  directory: string;
  legacyWorker: boolean;
  marker: string;
  revision: string;
}

class MutableBuildServer {
  private activeFixture: BuiltFixture;
  private server: Server | null = null;

  constructor(initialFixture: BuiltFixture) {
    this.activeFixture = initialFixture;
  }

  use(fixture: BuiltFixture): void {
    this.activeFixture = fixture;
  }

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const requestedPath = decodeURIComponent(url.pathname);
        if (requestedPath === '/companion-ui') {
          response.writeHead(308, { Location: '/companion-ui/' }).end();
          return;
        }
        const outsideScopeBodies: Readonly<Record<string, string>> = {
          '/fleet': '<!doctype html><title>Fleet route</title><p>fleet route</p>',
          '/garden': '<!doctype html><title>Garden route</title><p>garden route</p>',
          '/oauth/callback': '<!doctype html><title>OAuth callback</title><p>callback route</p>',
        };
        const outsideScopeBody = outsideScopeBodies[requestedPath];
        if (outsideScopeBody) {
          response.writeHead(200, {
            'Cache-Control': 'no-store, private',
            'Content-Type': 'text/html; charset=utf-8',
            Vary: 'Cookie',
          }).end(outsideScopeBody);
          return;
        }
        const canonicalRequest = requestedPath.startsWith('/companion-ui/');
        const legacyRootRequest = this.activeFixture.legacyWorker && !canonicalRequest;
        if (!canonicalRequest && !legacyRootRequest) {
          response.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found');
          return;
        }
        const relativePath = canonicalRequest
          ? requestedPath.slice('/companion-ui/'.length) || 'index.html'
          : requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
        let filePath = resolve(this.activeFixture.directory, relativePath);
        if (!filePath.startsWith(`${resolve(this.activeFixture.directory)}${sep}`)) {
          response.writeHead(400).end('invalid path');
          return;
        }
        let requestedFileExists = false;
        try {
          requestedFileExists = (await stat(filePath)).isFile();
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if (!requestedFileExists) {
          if (relativePath.startsWith('assets/')) {
            response.writeHead(404).end('not found');
            return;
          }
          filePath = resolve(this.activeFixture.directory, 'index.html');
        }
        const extension = extname(filePath);
        const cacheControl = relativePath === 'sw.js'
          ? 'no-cache, no-store, must-revalidate'
          : relativePath.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache';
        response.writeHead(200, {
          'Cache-Control': cacheControl,
          'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream',
        });
        response.end(await readFile(filePath));
      } catch (error) {
        response.writeHead(500).end(error instanceof Error ? error.message : 'server error');
      }
    });
    const server = this.server;
    await new Promise<void>((resolveListening) => {
      server.listen(0, '127.0.0.1', resolveListening);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const closed = new Promise<void>((resolveClosed, reject) => {
      server.close((error) => error ? reject(error) : resolveClosed());
    });
    server.closeAllConnections();
    await closed;
    this.server = null;
  }
}

async function buildFixture(
  marker: string,
  revision: string,
  options: { legacyClient?: boolean; legacyWorker?: boolean } = {},
): Promise<BuiltFixture> {
  const directory = await mkdtemp(resolve(tmpdir(), 'psfn-companion-ui-browser-'));
  const previousRevision = process.env.COMPANION_UI_BUILD_REVISION;
  process.env.COMPANION_UI_BUILD_REVISION = revision;
  try {
    const legacyClientPlugin: Plugin = {
      name: 'psfn-legacy-client-entry',
      enforce: 'pre',
      resolveId(source) {
        return options.legacyClient && ['/src/main.tsx', './src/main.tsx'].includes(source)
          ? LEGACY_CLIENT_PATH
          : null;
      },
    };
    await build({
      root: COMPANION_UI_ROOT,
      configFile: resolve(COMPANION_UI_ROOT, 'vite.config.ts'),
      plugins: [legacyClientPlugin],
      define: {
        __PSFN_COMPANION_UI_SW_UPDATE_INTERVAL_MS__: JSON.stringify(100),
      },
      logLevel: 'silent',
      build: {
        emptyOutDir: true,
        outDir: directory,
      },
    });
  } finally {
    if (previousRevision === undefined) {
      delete process.env.COMPANION_UI_BUILD_REVISION;
    } else {
      process.env.COMPANION_UI_BUILD_REVISION = previousRevision;
    }
  }
  const indexPath = resolve(directory, 'index.html');
  const indexHtml = await readFile(indexPath, 'utf8');
  await writeFile(
    indexPath,
    indexHtml.replace('<html lang="en">', `<html lang="en" data-test-build="${marker}">`),
  );
  if (options.legacyWorker) {
    await writeFile(resolve(directory, 'sw.js'), await readFile(LEGACY_WORKER_PATH));
  }
  return { directory, legacyWorker: options.legacyWorker ?? false, marker, revision };
}

async function installNavigationRecorder(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      const marker = document.documentElement.dataset.testBuild ?? 'unknown';
      let history: unknown = [];
      try {
        history = JSON.parse(window.name || '[]') as unknown;
      } catch {
        history = [];
      }
      const entries = Array.isArray(history)
        ? history.filter((entry): entry is string => typeof entry === 'string')
        : [];
      window.name = JSON.stringify([...entries, marker]);
    }, { once: true });
  });
}

async function navigationHistory(
  page: import('@playwright/test').Page,
): Promise<string[]> {
  return await page.evaluate(() => {
    const value = JSON.parse(window.name || '[]') as unknown;
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  });
}

async function waitForWorkerRevision(
  page: import('@playwright/test').Page,
  revision: string,
  staleCacheName?: string,
): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ expectedRevision, staleName }) => {
    const keys = await caches.keys();
    return keys.some((key) => key.includes(expectedRevision))
      && (!staleName || !keys.includes(staleName));
  }, { expectedRevision: revision, staleName: staleCacheName })).toBe(true);
}

async function cacheSnapshot(page: import('@playwright/test').Page): Promise<{
  cacheNames: string[];
  entries: Array<{ body: string; url: string }>;
}> {
  return await page.evaluate(async () => {
    const cacheNames = await caches.keys();
    const entries = [];
    for (const cacheName of cacheNames) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({ body: response ? await response.text() : '', url: request.url });
      }
    }
    return { cacheNames, entries };
  });
}

test('legacy root control is retired when the client migrates to the subpath', async ({
  context,
  page,
}) => {
  const legacy = await buildFixture('legacy-A', 'legacy-a', {
    legacyClient: true,
    legacyWorker: true,
  });
  const current = await buildFixture('current-B', 'current-b');
  const server = new MutableBuildServer(legacy);
  const origin = await server.start();
  try {
    await installNavigationRecorder(page);
    await page.goto(origin);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await expect(page.locator('html')).toHaveAttribute('data-test-build', legacy.marker);
    await page.getByLabel('Open settings').click();
    const session = page.getByLabel('Session');
    const channel = page.getByLabel('Channel');
    const credential = page.getByLabel('Device enrollment token');
    await session.fill('operator-session-in-progress');
    await channel.fill('operator-channel-in-progress');
    await credential.fill('operator-credential-in-progress');
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'unfinished-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('unfinished attachment'),
    });

    server.use(current);
    // This is deliberately the first browser action after deploy. The current
    // client retires the legacy root registration before installing its exact
    // subpath worker.
    await page.goto(`${origin}/companion-ui/`).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('ERR_ABORTED')) throw error;
    });
    await expect(page.locator('html')).toHaveAttribute('data-test-build', current.marker);
    await waitForWorkerRevision(page, current.revision, 'psfn-satellite-mobile-chat-app-v1');
    await expect.poll(async () => page.evaluate(async () => (
      (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => scope)
    ))).toEqual([`${origin}/companion-ui/`]);

    for (const path of ['/fleet', '/garden', '/oauth/callback?code=secret-code&state=secret-state']) {
      const outsidePage = await context.newPage();
      await outsidePage.goto(`${origin}${path}`);
      expect(await outsidePage.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true);
      await outsidePage.close();
    }

    const snapshot = await cacheSnapshot(page);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-code|secret-state|operator-credential/u);
    expect(snapshot.entries.every(({ url: entryUrl }) => (
      entryUrl.startsWith(`${origin}/companion-ui/`) && !new URL(entryUrl).search
    ))).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', current.marker);
  } finally {
    await context.setOffline(false);
    await server.stop();
    await Promise.all([legacy, current].map((fixture) => (
      rm(fixture.directory, { force: true, recursive: true })
    )));
  }
});

test('generated A to B ignores a legacy cache, keeps active state, and remains available offline', async ({
  context,
  page,
}) => {
  const buildA = await buildFixture('generated-A', 'generated-a');
  const buildB = await buildFixture('generated-B', 'generated-b');
  const server = new MutableBuildServer(buildA);
  const origin = await server.start();
  try {
    await installNavigationRecorder(page);
    await page.goto(`${origin}/companion-ui/`);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildA.marker);
    await expect(page.getByText('Update ready')).toHaveCount(0);
    await page.getByLabel('Open settings').click();
    const session = page.getByLabel('Session');
    const channel = page.getByLabel('Channel');
    const credential = page.getByLabel('Device enrollment token');
    await session.fill('active-session');
    await channel.fill('active-channel');
    await credential.fill('active-credential');
    await page.locator('input[type="file"]').first().setInputFiles({
      name: 'active-draft.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('active attachment'),
    });
    await page.evaluate(async () => {
      await caches.open('psfn-satellite-mobile-chat-app-v1');
    });

    expect(await page.evaluate(async () => (
      (await navigator.serviceWorker.getRegistration('/companion-ui/'))?.scope ?? null
    ))).toBe(`${origin}/companion-ui/`);

    server.use(buildB);
    await waitForWorkerRevision(page, buildB.revision, 'psfn-satellite-mobile-chat-app-v1');

    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildA.marker);
    await expect(session).toHaveValue('active-session');
    await expect(channel).toHaveValue('active-channel');
    await expect(credential).toHaveValue('active-credential');
    await expect(page.getByText('active-draft.txt')).toBeVisible();
    await expect(page.getByText('Update ready')).toBeVisible();
    await expect(page.getByText(/reload this page when your draft and live work are safe/i)).toBeVisible();
    expect(await navigationHistory(page)).toEqual([buildA.marker]);

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildB.marker);
    expect(await navigationHistory(page)).toEqual([buildA.marker, buildB.marker]);

    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildB.marker);

    const snapshot = await cacheSnapshot(page);
    expect(JSON.stringify(snapshot)).not.toMatch(/active-session|active-channel|active-credential/u);
    expect(snapshot.entries.every(({ url: entryUrl }) => (
      entryUrl.startsWith(`${origin}/companion-ui/`) && !new URL(entryUrl).search
    ))).toBe(true);

    await context.setOffline(false);
    server.use(buildA);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/companion-ui/');
      if (!registration) throw new Error('Missing companion-ui service-worker registration');
      await registration.update();
    });
    await waitForWorkerRevision(page, buildA.revision);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildA.marker);
    await context.setOffline(true);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildA.marker);
  } finally {
    await context.setOffline(false);
    await server.stop();
    await Promise.all([buildA, buildB].map((fixture) => (
      rm(fixture.directory, { force: true, recursive: true })
    )));
  }
});
