import dns from 'node:dns';
import { createServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { getCACertificates, setDefaultCACertificates, type TLSSocket } from 'node:tls';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateCaMaterial, issueCertificate, loadCa } from '../../app/cert-manager/pki.js';
import type { DnsResolver } from '../../boundary/gateway/url-policy.js';
import { fetchRemoteResource } from './safe-remote-fetch.js';

// Local test-server policy: the strict production default (no override) blocks
// loopback, so tests that need a live local server opt in explicitly.
const localServerPolicy = { allowHttp: true, allowInternalNetwork: true };

async function listen(
  handler: Parameters<typeof createServer>[1],
  host = '127.0.0.1',
  port = 0,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind test http server');
  }
  return { server, url: `http://${host.includes(':') ? `[${host}]` : host}:${address.port}` };
}

describe('fetchRemoteResource (Sprint-10 6ny2, shared across channel adapters)', () => {
  const servers: Server[] = [];
  const trustedCas = getCACertificates();

  afterEach(async () => {
    vi.restoreAllMocks();
    setDefaultCACertificates(trustedCas);
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    servers.length = 0;
  });

  // ── SSRF policy: strict default lane ──

  it.each([
    { address: '127.0.0.2', family: 4 },
    { address: '::1', family: 6 },
  ])('connects to the validated address after the system DNS answer flips to $address', async flipped => {
    const approved = await listen((req, res) => {
      expect(req.headers.host).toBe(`media.rebind.test:${new URL(approved.url).port}`);
      res.end('approved media');
    });
    servers.push(approved.server);
    const forbidden = await listen((_req, res) => {
      res.end('rebound private service');
    }, flipped.address, Number(new URL(approved.url).port));
    servers.push(forbidden.server);

    // Only DNS is controlled: both endpoints accept real TCP/HTTP connections.
    // Authorization sees .1; any second system lookup selects the other service.
    const systemLookup = dns.lookup;
    vi.spyOn(dns, 'lookup').mockImplementation(((hostname, options, callback) => {
      if (hostname !== 'media.rebind.test') return systemLookup(hostname, options, callback);
      if (typeof options === 'object' && options.all) {
        callback(null, [flipped]);
      } else {
        callback(null, flipped.address, flipped.family);
      }
    }) as typeof dns.lookup);

    const result = await fetchRemoteResource(`http://media.rebind.test:${new URL(approved.url).port}/image`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: '127.0.0.1', family: 4 }),
    });
    expect(result.bytes.toString()).toBe('approved media');
  });

  it('denies internal IPv4 targets with the default policy', async () => {
    await expect(fetchRemoteResource('https://10.0.0.5/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchRemoteResource('https://192.168.1.10/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchRemoteResource('https://127.0.0.1/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchRemoteResource('https://169.254.169.254/latest/meta-data/', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies IPv6 loopback, unspecified, and IMDS targets', async () => {
    await expect(fetchRemoteResource('https://[::1]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchRemoteResource('https://[::]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
    await expect(fetchRemoteResource('https://[fd00:ec2::254]/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies plain HTTP with the default policy', async () => {
    await expect(fetchRemoteResource('http://example.com/cat.png', { maxBytes: 1024 }))
      .rejects.toThrow(/blocked/);
  });

  it('denies hostnames that resolve to private addresses', async () => {
    const dnsResolver: DnsResolver = async () => ({ address: '10.0.0.5', family: 4 });
    await expect(fetchRemoteResource('https://rebind.evil.test/cat.png', {
      maxBytes: 1024,
      dnsResolver,
    })).rejects.toThrow(/blocked/);
  });

  it('denies a DNS address whose declared family disagrees with the literal', async () => {
    const { server, url } = await listen((_req, res) => res.end('must not connect'));
    servers.push(server);
    await expect(fetchRemoteResource(`http://family.rebind.test:${new URL(url).port}/image`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: '127.0.0.1', family: 6 }),
    })).rejects.toThrow(/blocked/);
  });

  it.each([
    [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: 'fd00:ec2::254', family: 6 }],
    [{ address: '93.184.216.34', family: 4 }, { address: 'not-an-ip', family: 4 }],
    [],
  ])('denies a mixed, invalid, or empty DNS snapshot: %j', async (...answers) => {
    await expect(fetchRemoteResource('https://mixed.rebind.test/image', {
      maxBytes: 1024,
      dnsResolver: async () => answers,
    })).rejects.toThrow(/blocked/);
  });

  it('pins the first approved address in a complete allowed DNS snapshot', async () => {
    const { server, url } = await listen((_req, res) => res.end('approved snapshot'));
    servers.push(server);
    const result = await fetchRemoteResource(`http://snapshot.rebind.test:${new URL(url).port}/image`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => [
        { address: '127.0.0.1', family: 4 },
        { address: '127.0.0.2', family: 4 },
      ],
    });
    expect(result.bytes.toString()).toBe('approved snapshot');
  });

  it('denies DNS failures without connecting', async () => {
    await expect(fetchRemoteResource('https://unresolved.rebind.test/image', {
      maxBytes: 1024,
      dnsResolver: async () => { throw new Error('controlled DNS failure'); },
    })).rejects.toThrow(/blocked: DNS resolution failed/);
  });

  it('preserves Host, TLS SNI, and hostname certificate validation for a pinned socket', async () => {
    const ca = await generateCaMaterial({ commonName: 'Media Fetch Test CA', validityDays: 2 });
    const certificate = await issueCertificate({
      kind: 'server', identityId: 'media-server', sans: ['media.tls.test'],
      validityDays: 1, ca: await loadCa(ca.certPem, ca.keyPem),
    });
    setDefaultCACertificates([...trustedCas, ca.certPem]);
    const requests: Array<{ host: string | undefined; servername: string | false | undefined }> = [];
    const server = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
      requests.push({ host: req.headers.host, servername: (req.socket as TLSSocket).servername });
      res.end('verified TLS');
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing TLS port');
    const options = {
      maxBytes: 1024,
      urlPolicy: { allowInternalNetwork: true },
      dnsResolver: async () => ({ address: '127.0.0.1', family: 4 }),
    };
    const result = await fetchRemoteResource(`https://media.tls.test:${address.port}/image`, options);
    expect(result.bytes.toString()).toBe('verified TLS');
    expect(requests).toEqual([{ host: `media.tls.test:${address.port}`, servername: 'media.tls.test' }]);
    await expect(fetchRemoteResource(`https://wrong.tls.test:${address.port}/image`, options))
      .rejects.toMatchObject({ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } });
    setDefaultCACertificates(trustedCas);
    await expect(fetchRemoteResource(`https://media.tls.test:${address.port}/image`, options))
      .rejects.toMatchObject({ cause: { code: expect.stringMatching(/SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE/) } });
    expect(requests).toHaveLength(1);
  });

  it('rejects a non-positive byte cap', async () => {
    await expect(fetchRemoteResource('https://example.com/cat.png', { maxBytes: 0 }))
      .rejects.toThrow(/positive maxBytes/);
  });

  // ── Streaming byte cap ──

  it('accepts an in-cap decoded gzip body when its wire representation exceeds maxBytes', async () => {
    const sockets = new Set<Socket>();
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      res.end(gzipSync('approved'));
    });
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const response = await fetchRemoteResource(`${url}/compressed`, {
      maxBytes: 8, urlPolicy: localServerPolicy,
    });
    expect(response.bytes.toString()).toBe('approved');
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it.each([
    { name: 'one byte over the decoded cap', body: Buffer.from('approved!') },
    { name: 'a highly compressed expansion', body: Buffer.alloc(1024 * 1024, 0x61) },
  ])('rejects gzip containing $name and closes its socket', async ({ body }) => {
    const sockets = new Set<Socket>();
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      // Keep the HTTP stream open: decoded overflow must abort before EOF.
      res.write(gzipSync(body));
    });
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const error = await fetchRemoteResource(`${url}/compressed-overflow`, {
      maxBytes: 8, timeoutMs: 1000, urlPolicy: localServerPolicy,
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: 'Remote fetch body too large: exceeded 8 bytes' });
    // Encoded input fits its own bound; this denial is from the decoded stream.
    expect((error as Error).cause).toBeUndefined();
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

  it('bounds gzip wire input that produces no decoded bytes and closes its socket', async () => {
    const sockets = new Set<Socket>();
    const { server, url } = await listen((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      // Valid concatenated empty members defeat a decoded-byte-only safeguard.
      res.write(Buffer.concat(Array.from({ length: 4096 }, () => gzipSync(Buffer.alloc(0)))));
    });
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await expect(fetchRemoteResource(`${url}/encoded-input-overflow`, {
      maxBytes: 8, timeoutMs: 1000, urlPolicy: localServerPolicy,
    })).rejects.toMatchObject({
      message: 'Remote fetch body too large: exceeded 8 bytes',
      cause: { cause: { code: 'UND_ERR_RES_EXCEEDED_MAX_SIZE' } },
    });
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  });

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

    await expect(fetchRemoteResource(`${url}/huge.png`, {
      maxBytes: 4096,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/too large/);
  });

  // ── Timeout ──

  it('enforces the hard timeout even while DNS is still pending', async () => {
    const outcome = fetchRemoteResource('https://stall.rebind.test/image', {
      maxBytes: 1024,
      timeoutMs: 20,
      dnsResolver: async () => new Promise(() => {}),
    }).then(() => 'unexpected success', (error: Error) => error.message);
    const result = await Promise.race([
      outcome,
      new Promise<string>(resolve => setTimeout(() => resolve('DNS escaped timeout'), 100)),
    ]);
    expect(result).toBe('Remote fetch timed out after 20ms');
  });

  it('times out when the server never responds', async () => {
    const { server, url } = await listen(() => {
      // Never respond: the request must be aborted by the timeout.
    });
    servers.push(server);

    await expect(fetchRemoteResource(`${url}/stall.png`, {
      maxBytes: 1024,
      timeoutMs: 100,
      urlPolicy: localServerPolicy,
    })).rejects.toThrow(/timed out after 100ms/);
  });

  // ── Redirect re-validation ──

  it('revalidates and repins even same-origin redirects instead of reusing a stale socket', async () => {
    const first = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/target' }).end();
      } else {
        res.end('stale destination');
      }
    });
    servers.push(first.server);
    const second = await listen((_req, res) => res.end('fresh approved destination'),
      '127.0.0.2', Number(new URL(first.url).port));
    servers.push(second.server);
    let checks = 0;
    const result = await fetchRemoteResource(`http://redirect.rebind.test:${new URL(first.url).port}/start`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: ++checks === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }),
    });
    expect(result.bytes.toString()).toBe('fresh approved destination');
  });

  it('rechecks a redirect hostname and denies a new private/metadata DNS answer', async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://metadata.rebind.test/latest/meta-data/' }).end();
    });
    servers.push(server);
    await expect(fetchRemoteResource(`${url}/start`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: '169.254.169.254', family: 4 }),
    })).rejects.toThrow(/blocked/);
  });

  it('forwards no credentials or sensitive headers across origins, including a bounce back', async () => {
    const seen: Array<{ path: string | undefined; headers: Record<string, string | string[] | undefined> }> = [];
    const { server, url } = await listen((req, res) => {
      seen.push({ path: req.url, headers: req.headers });
      if (req.url === '/start') {
        res.writeHead(302, {
          'set-cookie': 'secret=must-not-replay',
          location: `http://other.origin.test:${new URL(url).port}/middle`,
        }).end();
      } else if (req.url === '/middle') {
        res.writeHead(302, { location: `${url}/final` }).end();
      } else {
        res.end('redirected media');
      }
    });
    servers.push(server);
    const result = await fetchRemoteResource(`${url}/start`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: '127.0.0.1', family: 4 }),
    });
    expect(result.bytes.toString()).toBe('redirected media');
    expect(seen.map(entry => entry.path)).toEqual(['/start', '/middle', '/final']);
    for (const { headers } of seen) {
      expect(headers.authorization).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
      expect(headers['proxy-authorization']).toBeUndefined();
      expect(headers.referer).toBeUndefined();
    }
  });

  it('rejects embedded redirect credentials before contacting the target', async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(302, { location: 'http://user:secret@credential.origin.test/image' }).end();
    });
    servers.push(server);
    await expect(fetchRemoteResource(`${url}/start`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
      dnsResolver: async () => ({ address: '127.0.0.1', family: 4 }),
    })).rejects.toThrow(/credentials/);
  });

  it('re-validates redirect targets and denies redirects into blocked ranges', async () => {
    const { server, url } = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/latest/meta-data/');
      res.end('redirecting');
    });
    servers.push(server);

    await expect(fetchRemoteResource(`${url}/start.png`, {
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

    await expect(fetchRemoteResource(`${url}/0`, {
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

    const result = await fetchRemoteResource(`${url}/ok.png`, {
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

    const result = await fetchRemoteResource(`${url}/missing.png`, {
      maxBytes: 1024,
      urlPolicy: localServerPolicy,
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.bytes.byteLength).toBe(0);
  });

  it('preserves error status when the discarded error body exceeds maxBytes', async () => {
    const { server, url } = await listen((_req, res) => {
      res.writeHead(404).end(Buffer.alloc(64 * 1024));
    });
    servers.push(server);
    await expect(fetchRemoteResource(`${url}/missing`, {
      maxBytes: 1, urlPolicy: localServerPolicy,
    })).resolves.toMatchObject({ ok: false, status: 404, bytes: Buffer.alloc(0) });
  });

  it.each(['success', 'status', 'cap', 'headers-timeout', 'body-timeout', 'redirect-limit',
    'invalid-redirect', 'blocked-redirect', 'disconnect'])(
    'closes all real sockets after %s', async terminal => {
      const sockets = new Set<Socket>();
      const { server, url } = await listen((_req, res) => {
        if (terminal === 'success') res.end('ok');
        if (terminal === 'status') res.writeHead(503).flushHeaders();
        if (terminal === 'cap') res.write(Buffer.alloc(1025));
        if (terminal === 'body-timeout') res.write('pending');
        if (terminal === 'redirect-limit') res.writeHead(302, { location: '/again' }).end();
        if (terminal === 'invalid-redirect') res.writeHead(302, { location: 'http://[' }).end();
        if (terminal === 'blocked-redirect') res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
        if (terminal === 'disconnect') res.destroy();
      });
      servers.push(server);
      server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      const operation = fetchRemoteResource(`${url}/image`, {
        maxBytes: 1024,
        timeoutMs: terminal.endsWith('timeout') ? 100 : 1000,
        urlPolicy: localServerPolicy,
      });
      if (terminal === 'success') await expect(operation).resolves.toMatchObject({ ok: true });
      else if (terminal === 'status') await expect(operation).resolves.toMatchObject({ ok: false, status: 503 });
      else await expect(operation).rejects.toThrow();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    },
  );
});
