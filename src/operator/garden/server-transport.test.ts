import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { AdminServerTransport } from './server-transport.js';

const originalCwd = process.cwd();

interface ResponseCapture {
  status: number;
  headers: Record<string, string>;
  body: string;
  rawBody: Buffer;
}

function createResponseCapture(): {
  response: ServerResponse;
  done: Promise<ResponseCapture>;
} {
  let resolveCapture!: (value: ResponseCapture) => void;
  const capture: ResponseCapture = {
    status: 0,
    headers: {},
    body: '',
    rawBody: Buffer.alloc(0),
  };
  const done = new Promise<ResponseCapture>((resolve) => {
    resolveCapture = resolve;
  });

  const response = {
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      capture.status = status;
      capture.headers = { ...(headers ?? {}) };
      return response;
    }),
    end: vi.fn((body?: Buffer | string) => {
      if (typeof body === 'string') {
        capture.rawBody = Buffer.from(body, 'utf8');
        capture.body = body;
      } else if (body) {
        capture.rawBody = body;
        capture.body = body.toString('utf8');
      } else {
        capture.rawBody = Buffer.alloc(0);
        capture.body = '';
      }
      resolveCapture(capture);
      return response;
    }),
  } as unknown as ServerResponse;

  return { response, done };
}

function makeRequest(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

// A payload large enough to clear the on-the-fly compression size floor.
const LARGE_JS = `console.log(${JSON.stringify('x'.repeat(4096))});\n`;

function createHarness(): {
  buildDir: string;
  transport: AdminServerTransport;
} {
  const root = mkdtempSync(join(tmpdir(), 'admin-transport-test-'));
  const buildDir = join(root, 'build');
  mkdirSync(join(buildDir, '_app', 'immutable', 'entry'), { recursive: true });
  writeFileSync(join(buildDir, 'index.html'), '<!doctype html><html><body>spa-shell</body></html>', 'utf8');
  writeFileSync(join(buildDir, '_app', 'immutable', 'entry', 'start.test.js'), 'console.log("asset");', 'utf8');
  writeFileSync(join(buildDir, '_app', 'immutable', 'entry', 'big.test.js'), LARGE_JS, 'utf8');

  const transport = new AdminServerTransport({
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  });
  Reflect.set(transport, 'gardenBuildDir', buildDir);
  return { buildDir: root, transport };
}

let rootsToDelete: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of rootsToDelete) {
    rmSync(root, { recursive: true, force: true });
  }
  rootsToDelete = [];
});

describe('AdminServerTransport Garden assets', () => {
  it('enables Garden assets from the runtime working directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-transport-cwd-test-'));
    rootsToDelete.push(root);
    const buildDir = join(root, 'admin-ui', 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'index.html'), '<!doctype html><html><body>runtime-shell</body></html>', 'utf8');
    process.chdir(root);

    const transport = new AdminServerTransport({
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    });

    transport.initialize();

    expect(transport.isGardenUiEnabled()).toBe(true);

    const { response, done } = createResponseCapture();
    transport.serveGardenPage('/', makeRequest(), response);

    await expect(done).resolves.toMatchObject({
      status: 200,
      body: '<!doctype html><html><body>runtime-shell</body></html>',
      headers: expect.objectContaining({
        'Content-Type': 'text/html',
      }),
    });
  });

  it('serves built immutable asset files directly with immutable caching and an ETag', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset('/_app/immutable/entry/start.test.js', makeRequest(), response);

    const captured = await done;
    expect(captured.status).toBe(200);
    expect(captured.body).toBe('console.log("asset");');
    expect(captured.headers['Content-Type']).toBe('text/javascript');
    expect(captured.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
    expect(captured.headers.ETag).toMatch(/^W\/"[0-9a-f.]+-[0-9a-f.]+"$/);
    expect(captured.headers.Vary).toBe('Accept-Encoding');
    expect(captured.headers['Content-Encoding']).toBeUndefined();
  });

  it('keeps the daily cache policy for non-immutable assets', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    // A non-immutable, non-HTML asset should keep the daily revalidation policy.
    writeFileSync(join(harness.buildDir, 'build', 'favicon.test.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset('/favicon.test.png', makeRequest(), response);

    const captured = await done;
    expect(captured.status).toBe(200);
    expect(captured.headers['Cache-Control']).toBe('public, max-age=86400');
    expect(captured.headers.ETag).toBeDefined();
  });

  it('compresses text assets when the client sends Accept-Encoding: gzip', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset(
      '/_app/immutable/entry/big.test.js',
      makeRequest({ 'accept-encoding': 'gzip' }),
      response,
    );

    const captured = await done;
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Encoding']).toBe('gzip');
    expect(captured.headers.Vary).toBe('Accept-Encoding');
    expect(captured.headers['Content-Length']).toBe(String(captured.rawBody.length));
    // The compressed body must be smaller than the raw payload and inflate back.
    expect(captured.rawBody.length).toBeLessThan(Buffer.byteLength(LARGE_JS));
    expect(gunzipSync(captured.rawBody).toString('utf8')).toBe(LARGE_JS);
  });

  it('serves text assets uncompressed when no Accept-Encoding is offered', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset(
      '/_app/immutable/entry/big.test.js',
      makeRequest(),
      response,
    );

    const captured = await done;
    expect(captured.status).toBe(200);
    expect(captured.headers['Content-Encoding']).toBeUndefined();
    expect(captured.body).toBe(LARGE_JS);
  });

  it('returns 304 when If-None-Match matches the current ETag', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);

    const first = createResponseCapture();
    harness.transport.serveGardenBuildAsset('/_app/immutable/entry/start.test.js', makeRequest(), first.response);
    const initial = await first.done;
    const etag = initial.headers.ETag;
    expect(etag).toBeDefined();

    const second = createResponseCapture();
    harness.transport.serveGardenBuildAsset(
      '/_app/immutable/entry/start.test.js',
      makeRequest({ 'if-none-match': etag }),
      second.response,
    );
    const conditional = await second.done;

    expect(conditional.status).toBe(304);
    expect(conditional.body).toBe('');
    expect(conditional.headers.ETag).toBe(etag);
    expect(conditional.headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('does not fall back to index.html for missing immutable assets', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset('/_app/immutable/entry/missing.js', makeRequest(), response);

    await expect(done).resolves.toMatchObject({
      status: 404,
      body: 'Not found: /_app/immutable/entry/missing.js',
      headers: expect.objectContaining({
        'Content-Type': 'text/plain',
      }),
    });
  });

  it('keeps SPA fallback behavior for Garden page routes', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenPage('/memory', makeRequest(), response);

    const captured = await done;
    expect(captured.status).toBe(200);
    expect(captured.body).toBe('<!doctype html><html><body>spa-shell</body></html>');
    expect(captured.headers['Content-Type']).toBe('text/html');
    expect(captured.headers['Cache-Control']).toBe('public, max-age=0, must-revalidate');
  });
});
