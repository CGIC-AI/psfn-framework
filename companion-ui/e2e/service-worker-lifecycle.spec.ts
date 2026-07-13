import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { expect, test } from '@playwright/test';
import { build } from 'vite';

const COMPANION_UI_ROOT = resolve(import.meta.dirname, '..');
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
  marker: string;
  revision: string;
}

class MutableBuildServer {
  private activeDirectory: string;
  private server: Server | null = null;

  constructor(initialDirectory: string) {
    this.activeDirectory = initialDirectory;
  }

  use(directory: string): void {
    this.activeDirectory = directory;
  }

  async start(): Promise<string> {
    this.server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const requestedPath = decodeURIComponent(url.pathname);
        const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.slice(1);
        let filePath = resolve(this.activeDirectory, relativePath);
        if (!filePath.startsWith(`${resolve(this.activeDirectory)}${sep}`)) {
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
          if (requestedPath.startsWith('/assets/')) {
            response.writeHead(404).end('not found');
            return;
          }
          filePath = resolve(this.activeDirectory, 'index.html');
        }
        const extension = extname(filePath);
        const cacheControl = requestedPath === '/sw.js'
          ? 'no-cache, no-store, must-revalidate'
          : requestedPath.startsWith('/assets/')
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
    await new Promise<void>((resolveClosed, reject) => {
      server.close((error) => error ? reject(error) : resolveClosed());
    });
    this.server = null;
  }
}

async function buildFixture(
  marker: string,
  revision: string,
  options: { legacyWorker?: boolean } = {},
): Promise<BuiltFixture> {
  const directory = await mkdtemp(resolve(tmpdir(), 'psfn-companion-ui-browser-'));
  const previousRevision = process.env.COMPANION_UI_BUILD_REVISION;
  process.env.COMPANION_UI_BUILD_REVISION = revision;
  try {
    await build({
      root: COMPANION_UI_ROOT,
      configFile: resolve(COMPANION_UI_ROOT, 'vite.config.ts'),
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
  return { directory, marker, revision };
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

async function activateNextWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) throw new Error('Missing companion-ui service-worker registration');
    const previousController = navigator.serviceWorker.controller;
    const controllerChanged = new Promise<void>((resolveChanged, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('Timed out waiting for the updated service worker to activate')),
        15_000,
      );
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.clearTimeout(timeout);
        resolveChanged();
      }, { once: true });
    });
    await registration.update();
    if (navigator.serviceWorker.controller !== previousController) return;
    await controllerChanged;
  });
}

test('migrates the legacy worker without destroying active state and one reload reaches B', async ({
  context,
  page,
}) => {
  const legacy = await buildFixture('legacy-A', 'legacy-a', { legacyWorker: true });
  const current = await buildFixture('current-B', 'current-b');
  const server = new MutableBuildServer(legacy.directory);
  const url = await server.start();
  try {
    await page.goto(url);
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

    server.use(current.directory);
    await activateNextWorker(page);
    await waitForWorkerRevision(page, current.revision, 'psfn-satellite-mobile-chat-app-v1');

    await expect(page.locator('html')).toHaveAttribute('data-test-build', legacy.marker);
    await expect(session).toHaveValue('operator-session-in-progress');
    await expect(channel).toHaveValue('operator-channel-in-progress');
    await expect(credential).toHaveValue('operator-credential-in-progress');
    await expect(page.getByText('unfinished-notes.txt')).toBeVisible();

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-test-build', current.marker);

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

test('announces a generated-worker update without navigating or clearing live UI state', async ({
  page,
}) => {
  const buildA = await buildFixture('generated-A', 'generated-a');
  const buildB = await buildFixture('generated-B', 'generated-b');
  const server = new MutableBuildServer(buildA.directory);
  const url = await server.start();
  try {
    await page.goto(url);
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

    server.use(buildB.directory);
    await activateNextWorker(page);
    await waitForWorkerRevision(page, buildB.revision);

    await expect(page.locator('html')).toHaveAttribute('data-test-build', buildA.marker);
    await expect(session).toHaveValue('active-session');
    await expect(channel).toHaveValue('active-channel');
    await expect(credential).toHaveValue('active-credential');
    await expect(page.getByText('active-draft.txt')).toBeVisible();
    await expect(page.getByText('Update ready')).toBeVisible();
    await expect(page.getByText(/reload this page when your draft and live work are safe/i)).toBeVisible();
  } finally {
    await server.stop();
    await Promise.all([buildA, buildB].map((fixture) => (
      rm(fixture.directory, { force: true, recursive: true })
    )));
  }
});
