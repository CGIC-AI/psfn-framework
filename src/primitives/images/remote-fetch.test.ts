import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_FETCH_TIMEOUT_MS } from '../../system/security/policy-constants.js';
import { fetchRemoteImageBinary } from './remote-fetch.js';

const REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

async function listen(
  handler: Parameters<typeof createServer>[1],
  host = '127.0.0.1',
  port = 0,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind remote image test server');
  }
  return { server, url: `http://${host}:${address.port}` };
}

describe('fetchRemoteImageBinary', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    servers.length = 0;
  });

  it.each([
    { address: '127.0.0.2', family: 4 },
    { address: '::1', family: 6 },
  ])('connects to the authorized address when system DNS flips to $address', async flipped => {
    const approved = await listen((req, response) => {
      expect(req.headers.host).toBe(`image.rebind.test:${new URL(approved.url).port}`);
      response.writeHead(200, { 'content-type': 'image/png' }).end('approved image');
    });
    servers.push(approved.server);
    const forbidden = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png' }).end('rebound service');
    }, flipped.address, Number(new URL(approved.url).port));
    servers.push(forbidden.server);

    const systemLookup = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname, options, callback) => {
      if (hostname !== 'image.rebind.test') return systemLookup(hostname, options, callback);
      if (typeof options === 'object' && options.all) callback(null, [flipped]);
      else callback(null, flipped.address, flipped.family);
    }) as typeof dns.lookup);

    const result = await fetchRemoteImageBinary(
      `http://image.rebind.test:${new URL(approved.url).port}/input.png`,
      {
        webFetchAllowHttp: true,
        webFetchAllowInternalNetwork: true,
        webFetchDnsResolver: async () => ({ address: '127.0.0.1', family: 4 }),
      },
      globalThis.fetch,
    );

    expect(Buffer.from(result.bytes).toString()).toBe('approved image');
  });

  it('keeps the absolute deadline active while a post-header body stalls', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    });

    const operation = fetchRemoteImageBinary('https://images.example.test/stall.png', {
      webFetchDnsResolver: async () => ({ address: '93.184.216.34', family: 4 }),
    }, fetchImpl as typeof fetch);
    const outcome = operation.then(() => 'unexpected success', (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(WEB_FETCH_TIMEOUT_MS + 1);

    await expect(outcome).resolves.toBe(`Remote fetch timed out after ${WEB_FETCH_TIMEOUT_MS}ms`);
  });

  it('stops pulling a nine-megabyte chunked body as soon as the eight-megabyte cap is crossed', async () => {
    const chunkBytes = 16 * 1024;
    const totalChunks = (9 * 1024 * 1024) / chunkBytes;
    let pulls = 0;
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls >= totalChunks) {
          controller.close();
          return;
        }
        pulls += 1;
        controller.enqueue(new Uint8Array(chunkBytes));
      },
    }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const config = {
      webFetchDnsResolver: async () => ({ address: '93.184.216.34', family: 4 }),
    };

    await expect(fetchRemoteImageBinary(
      'https://images.example.test/nine-megabytes.png',
      config,
      fetchImpl as typeof fetch,
    )).rejects.toThrow(`Remote fetch body too large: exceeded ${REMOTE_IMAGE_MAX_BYTES} bytes`);
    expect(pulls).toBeLessThan(totalChunks);

    fetchImpl.mockImplementationOnce(async () => new Response(Uint8Array.from([1, 2, 3]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    const recovered = await fetchRemoteImageBinary(
      'https://images.example.test/recovered.png',
      config,
      fetchImpl as typeof fetch,
    );
    expect([...recovered.bytes]).toEqual([1, 2, 3]);
  });
});
