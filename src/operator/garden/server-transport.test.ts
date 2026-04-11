import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdminServerTransport } from './server-transport.js';

interface ResponseCapture {
  status: number;
  headers: Record<string, string>;
  body: string;
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
        capture.body = body;
      } else if (body) {
        capture.body = body.toString('utf8');
      } else {
        capture.body = '';
      }
      resolveCapture(capture);
      return response;
    }),
  } as unknown as ServerResponse;

  return { response, done };
}

function createHarness(): {
  buildDir: string;
  transport: AdminServerTransport;
} {
  const root = mkdtempSync(join(tmpdir(), 'admin-transport-test-'));
  const buildDir = join(root, 'build');
  mkdirSync(join(buildDir, '_app', 'immutable', 'entry'), { recursive: true });
  writeFileSync(join(buildDir, 'index.html'), '<!doctype html><html><body>spa-shell</body></html>', 'utf8');
  writeFileSync(join(buildDir, '_app', 'immutable', 'entry', 'start.test.js'), 'console.log("asset");', 'utf8');

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
  for (const root of rootsToDelete) {
    rmSync(root, { recursive: true, force: true });
  }
  rootsToDelete = [];
});

describe('AdminServerTransport Garden assets', () => {
  it('serves built immutable asset files directly', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset('/_app/immutable/entry/start.test.js', response);

    await expect(done).resolves.toMatchObject({
      status: 200,
      body: 'console.log("asset");',
      headers: expect.objectContaining({
        'Content-Type': 'text/javascript',
      }),
    });
  });

  it('does not fall back to index.html for missing immutable assets', async () => {
    const harness = createHarness();
    rootsToDelete.push(harness.buildDir);
    const { response, done } = createResponseCapture();

    harness.transport.serveGardenBuildAsset('/_app/immutable/entry/missing.js', response);

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

    harness.transport.serveGardenPage('/memory', response);

    await expect(done).resolves.toMatchObject({
      status: 200,
      body: '<!doctype html><html><body>spa-shell</body></html>',
      headers: expect.objectContaining({
        'Content-Type': 'text/html',
      }),
    });
  });
});
