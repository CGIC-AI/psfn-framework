import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { FleetGardenUiAssets } from './fleet-garden-ui-assets.js';

class CapturedResponse extends Writable {
  status = 0;
  headers: Record<string, string> = {};
  chunks: Buffer[] = [];

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function request(headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

async function completed(response: CapturedResponse): Promise<void> {
  if (response.writableFinished) return;
  await new Promise<void>(resolve => response.once('finish', resolve));
}

describe('fleet Garden bundle assets', () => {
  it('serves a no-store Garden shell with fleet-scoped immutable assets', async () => {
    const build = await mkdtemp(join(tmpdir(), 'fleet-garden-ui-'));
    mkdirSync(join(build, '_app', 'immutable'), { recursive: true });
    writeFileSync(
      join(build, 'index.html'),
      '<script src="/_app/immutable/start.js"></script><script>globalThis.startGarden()</script>',
    );
    writeFileSync(join(build, '_app', 'immutable', 'start.js'), 'export{}');
    const assets = new FleetGardenUiAssets(build);

    const page = new CapturedResponse();
    assets.servePage(request(), page as unknown as ServerResponse);
    await completed(page);
    expect(page.status).toBe(200);
    expect(page.headers['Cache-Control']).toBe('no-store');
    expect(page.headers['Content-Security-Policy']).toMatch(
      /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/u,
    );
    expect(Buffer.concat(page.chunks).toString('utf8'))
      .toContain('/fleet/_app/immutable/start.js');
    expect(Buffer.concat(page.chunks).toString('utf8'))
      .not.toContain('./fleet/_app/');

    const asset = new CapturedResponse();
    assets.serveAsset(
      '/fleet/_app/immutable/start.js',
      request(),
      asset as unknown as ServerResponse,
    );
    await completed(asset);
    expect(asset.status).toBe(200);
    expect(asset.headers['Cache-Control']).toContain('immutable');
    expect(Buffer.concat(asset.chunks).toString('utf8')).toBe('export{}');
    await readFile(join(build, 'index.html'));
  });

  it('rejects paths outside the immutable bundle root', async () => {
    const build = await mkdtemp(join(tmpdir(), 'fleet-garden-ui-'));
    writeFileSync(join(build, 'index.html'), '<!doctype html>');
    const assets = new FleetGardenUiAssets(build);
    const response = new CapturedResponse();
    assets.serveAsset(
      '/fleet/_app/../index.html',
      request(),
      response as unknown as ServerResponse,
    );
    await completed(response);
    expect(response.status).toBe(404);
  });
});
