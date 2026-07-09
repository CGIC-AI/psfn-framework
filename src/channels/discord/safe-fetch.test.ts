import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { DnsResolver } from '../../boundary/gateway/url-policy.js';
import { fetchDiscordRemoteResource } from './safe-fetch.js';

// Local test-server policy: the strict production default (no override) blocks
// loopback, so tests that need a live local server opt in explicitly.
const localServerPolicy = { allowHttp: true, allowInternalNetwork: true };

async function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind test http server');
  }
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe('fetchDiscordRemoteResource (Sprint-10 6ny2)', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    servers.length = 0;
  });

  // ── SSRF policy: strict default lane ──

  it('denies internal IPv4 targets with the default policy', async () => {
    await expect(fetchDiscordRemoteResource('https://10.0.0.5/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchDiscordRemoteResource('https://192.168.1.10/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchDiscordRemoteResource('https://127.0.0.1/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchDiscordRemoteResource('https://169.254.169.254/latest/meta-data/', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies IPv6 loopback, unspecified, and IMDS targets', async () => {
    await expect(fetchDiscordRemoteResource('https://[::1]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchDiscordRemoteResource('https://[::]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchDiscordRemoteResource('https://[fd00:ec2::254]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies plain HTTP with the default policy', async () => {
    await expect(fetchDiscordRemoteResource('http://example.com/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies hostnames that resolve to private addresses', async () => {
    const dnsResolver: DnsResolver = async () => ({ address: '10.0.0.5', family: 4 });
    await expect(fetchDiscordRemoteResource('https://rebind.evil.test/cat.png', {
      maxBytes: 1024,
      dnsResolver,
    })).rejects.toThrow(/blocked/);
  });

  it('rejects a non-positive byte cap', async () => {
    await expect(fetchDiscordRemoteResource('https://example.com/cat.png', { maxBytes: 0 }))
      .rejects.toThrow(/positive maxBytes/);
  });

  // ── Streaming byte cap ──

  it('rejects a chunked length-omitted body exceeding maxBytes during streaming', async () => {
    let responseClosed = false;
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.on('close', () => {
        responseClosed = true;
      });
      // Chunked transfer: no content-length header to pre-check.
      let writes = 0;
      const writeNext = (): void => {
        if (responseClosed || writes >= 64) return;
        writes += 1;
        if (res.write(Buffer.alloc(1024, 0x61))) {
          setImmediate(writeNext);
        } else {
          res.once('drain', writeNext);
        }
      };
      writeNext();
    });
    servers.push(server);

    await expect(fetchDiscordRemoteResource(`${url}/huge.png`, {
      maxBytes: 4096,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/too large/);
  });

  // ── Timeout ──

  it('times out when the server never responds', async () => {
    const { server, url } = await listen(() => {
      // Never respond: the request must be aborted by the timeout.
    });
    servers.push(server);

    await expect(fetchDiscordRemoteResource(`${url}/stall.png`, {
      maxBytes: 1024,
      timeoutMs: 100,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/timed out after 100ms/);
  });

  // ── Redirect re-validation ──

  it('re-validates redirect targets and denies redirects into blocked ranges', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end('redirecting');
    });
    servers.push(server);

    await expect(fetchDiscordRemoteResource(`${url}/start.png`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/blocked/);
  });

  it('caps the number of redirect hops', async () => {
    const { server, url } = await listen((req, res) => {
      const hop = Number.parseInt((req.url ?? '/0').slice(1), 10) || 0;
      res.statusCode = 302;
      res.setHeader('location', `${url}/${hop + 1}`);
      res.end('redirecting');
    });
    servers.push(server);

    await expect(fetchDiscordRemoteResource(`${url}/0`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/redirect hops/);
  });

  // ── Success and error passthrough ──

  it('returns bytes and content type for an allowed in-cap response', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.end(Buffer.from([1, 2, 3]));
    });
    servers.push(server);

    const result = await fetchDiscordRemoteResource(`${url}/ok.png`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('image/png');
    expect([...result.bytes]).toEqual([1, 2, 3]);
  });

  it('returns ok:false with the status for non-2xx responses without buffering the body', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 404;
      res.end('not found');
    });
    servers.push(server);

    const result = await fetchDiscordRemoteResource(`${url}/missing.png`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.bytes.byteLength).toBe(0);
  });
});
