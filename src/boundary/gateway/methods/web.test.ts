import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerWebMethods, resetWebCircuitBreakersForTests } from './web.js';
import { GatewayErrors } from '../protocol.js';
import type { DnsResolver } from '../url-policy.js';

interface RuntimeHarness {
  invoke(params: Record<string, unknown>): Promise<any>;
  invokeBinary(params: Record<string, unknown>): Promise<any>;
  recordAuditEvent: ReturnType<typeof vi.fn>;
}

function createRuntimeHarness(policyConfig: PolicyConfig): RuntimeHarness {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
  const recordAuditEvent = vi.fn();
  const keyring = {
    activeVersion: 'v1',
    keys: { v1: 'test-web-secret' },
  };
  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<any>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    recordAuditEvent,
    audited: (_method, handler) => handler,
    approvalBoundary: {
      gate: (_options) => async (params) => _options.handler(params),
    } as any,
  };

  registerWebMethods(runtime);
  const fetchMethod = methods.get('web.fetch');
  const binaryMethod = methods.get('web.fetch_binary');
  if (!fetchMethod || !binaryMethod) {
    throw new Error('web.fetch methods were not registered');
  }
  return {
    invoke(params: Record<string, unknown>) {
      return fetchMethod(params);
    },
    invokeBinary(params: Record<string, unknown>) {
      return binaryMethod(params);
    },
    recordAuditEvent,
  };
}

async function listenHttp(
  handler: (reqUrl: string, headers: Record<string, string | string[] | undefined>) => {
    status?: number;
    body: string | Buffer;
    contentType?: string;
    headers?: Record<string, string>;
  },
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const result = handler(req.url ?? '/', req.headers);
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', result.contentType ?? 'text/plain; charset=utf-8');
    if (result.headers) {
      for (const [name, value] of Object.entries(result.headers)) {
        res.setHeader(name, value);
      }
    }
    res.end(result.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('failed to bind test http server');
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

describe('registerWebMethods', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    resetWebCircuitBreakersForTests();
    await Promise.all(servers.map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    servers.length = 0;
  });

  it('keeps strict default lane unchanged (HTTP blocked)', async () => {
    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        allowHttp: false,
      },
    });

    await expect(harness.invoke({
      url: 'http://example.com',
      lane: 'default',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
  });

  it('rejects unknown fetch lanes instead of coercing them to default', async () => {
    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        allowHttp: true,
      },
    });

    await expect(harness.invoke({
      url: 'https://example.com',
      lane: 'search_mode',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('Unsupported web lane'),
    });
  });

  it('allows discovery lane only for configured discovery URL allowlist', async () => {
    const { server, url } = await listenHttp((reqUrl) => {
      if (reqUrl !== '/v1/models') {
        return {
          status: 404,
          body: 'not found',
        };
      }
      return {
        body: Buffer.from(JSON.stringify({ data: [{ id: 'openai/gpt-4.1-mini' }] })),
        contentType: 'application/json',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        discoveryLane: {
          enabled: true,
          allowHttp: true,
          urlAllowlist: [
            `${url}/v1/models`,
            'https://openrouter.ai/api/v1/models',
          ],
        },
      },
    });

    const result = await harness.invokeBinary({
      url: `${url}/v1/models`,
      lane: 'discovery',
      maxBytes: 16 * 1024,
    });

    expect(result.mimeType).toBe('application/json');
    expect(Buffer.from(result.dataBase64, 'base64').toString('utf8')).toContain('gpt-4.1-mini');
  });

  it('denies non-allowlisted discovery lane URLs', async () => {
    const { server, url } = await listenHttp((reqUrl) => ({
      body: reqUrl,
      contentType: 'text/plain; charset=utf-8',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        discoveryLane: {
          enabled: true,
          allowHttp: true,
          urlAllowlist: [`${url}/v1/models`],
        },
      },
    });

    await expect(harness.invokeBinary({
      url: `${url}/admin`,
      lane: 'discovery',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('not allowlisted for discovery lane'),
    });
  });

  it('keeps default lane policy unchanged even when discovery lane is configured', async () => {
    const { server, url } = await listenHttp((reqUrl) => ({
      body: reqUrl,
      contentType: 'text/plain; charset=utf-8',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        discoveryLane: {
          enabled: true,
          allowHttp: true,
          urlAllowlist: [`${url}/v1/models`],
        },
      },
    });

    await expect(harness.invokeBinary({
      url: `${url}/v1/models`,
      lane: 'default',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
  });

  it('allows local crawler lane on explicit allowlist + optional HTTP', async () => {
    const { server, url } = await listenHttp(() => ({
      body: '<html><body>crawler ok</body></html>',
      contentType: 'text/html; charset=utf-8',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        allowHttp: false,
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    const result = await harness.invoke({
      url: `${url}/crawl`,
      lane: 'local_crawler',
    });

    expect(result.sanitized).toBe(true);
    expect(result.content).toContain('crawler ok');
  });

  it('returns provider error when TLS CA bundle path is invalid', async () => {
    const { server, url } = await listenHttp(() => ({
      body: 'ok',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
      webFetchTlsCaCertPaths: ['/definitely/missing/local-ca.pem'],
    });

    await expect(harness.invoke({
      url: `${url}/crawl`,
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('TLS setup failed'),
    });
  });

  it('surfaces fetch failures as diagnostics without injected conversational wording', async () => {
    const { server, url } = await listenHttp(() => ({
      status: 500,
      body: 'upstream exploded',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    let thrown: any;
    try {
      await harness.invoke({
        url: `${url}/fail`,
        lane: 'local_crawler',
      });
    } catch (error) {
      thrown = error;
    }

    if (!thrown) {
      throw new Error('Expected web.fetch to throw for HTTP 500');
    }
    expect(thrown).toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
    });
    const message = String(thrown?.message ?? '');
    expect(message).toContain('Fetch failed: 500 Internal Server Error');
    expect(message.toLowerCase()).not.toContain('please try again');
    expect(message.toLowerCase()).not.toContain('ask for resend');
  });

  it('opens a per-url web.fetch circuit after repeated provider failures', async () => {
    let requestCount = 0;
    const { server, url } = await listenHttp(() => {
      requestCount += 1;
      return {
        status: 503,
        body: 'service unavailable',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });
    const params = {
      url: `${url}/unstable`,
      lane: 'local_crawler',
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(harness.invoke(params)).rejects.toMatchObject({
        code: GatewayErrors.PROVIDER_ERROR,
        message: expect.stringContaining('Fetch failed: 503 Service Unavailable'),
      });
    }

    await expect(harness.invoke(params)).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('Circuit open for web.fetch'),
    });
    expect(requestCount).toBe(3);
  });

  it('fetches binary payloads for web.fetch_binary', async () => {
    const { server, url } = await listenHttp(() => ({
      body: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    const result = await harness.invokeBinary({
      url: `${url}/image`,
      lane: 'local_crawler',
      maxBytes: 16,
    });

    expect(result).toMatchObject({
      dataBase64: 'AQID',
      mimeType: 'image/png',
      sizeBytes: 3,
    });
  });

  it('rejects unknown binary fetch lanes instead of coercing them to default', async () => {
    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        allowHttp: true,
      },
    });

    await expect(harness.invokeBinary({
      url: 'https://example.com/image.png',
      lane: 'browse_mode',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('Unsupported web lane'),
    });
  });

  it('forwards caller headers for web.fetch_binary and ignores restricted header overrides', async () => {
    let seenHeaders: Record<string, string | string[] | undefined> | null = null;
    const { server, url } = await listenHttp((_reqUrl, headers) => {
      seenHeaders = headers;
      return {
        body: Buffer.from([9, 8, 7]),
        contentType: 'application/octet-stream',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    await harness.invokeBinary({
      url: `${url}/headers`,
      lane: 'local_crawler',
      headers: {
        Authorization: 'Bearer test-token',
        'X-Discovery': 'enabled',
        Host: 'malicious.example',
        'Content-Length': '999',
      },
    });

    expect(seenHeaders).toBeTruthy();
    expect(seenHeaders?.authorization).toBe('Bearer test-token');
    expect(seenHeaders?.['x-discovery']).toBe('enabled');
    expect(String(seenHeaders?.host ?? '')).toContain('127.0.0.1');
    expect(seenHeaders?.['content-length']).toBeUndefined();
  });

  it('enforces maxBytes for web.fetch_binary', async () => {
    const { server, url } = await listenHttp(() => ({
      body: Buffer.from([1, 2, 3]),
      contentType: 'image/png',
    }));
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    await expect(harness.invokeBinary({
      url: `${url}/image`,
      lane: 'local_crawler',
      maxBytes: 2,
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('too large'),
    });
  });

  it('follows multi-hop redirects with per-hop policy validation and records redirect audit', async () => {
    const { server, url } = await listenHttp((reqUrl) => {
      if (reqUrl === '/start') {
        return {
          status: 302,
          headers: { location: '/hop-1' },
          body: 'redirecting',
        };
      }
      if (reqUrl === '/hop-1') {
        return {
          status: 302,
          headers: { location: '/final' },
          body: 'redirecting',
        };
      }
      if (reqUrl === '/final') {
        return {
          body: '<html><body>redirect chain ok</body></html>',
          contentType: 'text/html; charset=utf-8',
        };
      }
      return {
        status: 404,
        body: 'not found',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    const result = await harness.invoke({
      url: `${url}/start`,
      lane: 'local_crawler',
    });

    expect(result.content).toContain('redirect chain ok');
    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'web.fetch.redirect_chain',
        decision: 'ALLOW',
        params: expect.objectContaining({
          rpcMethod: 'web.fetch',
          originUrl: `${url}/start`,
          finalUrl: `${url}/final`,
          redirectHopCount: 2,
        }),
      }),
    );
  });

  it('rejects redirect chain at first invalid hop and records denial audit', async () => {
    let blockedRedirect = '/blocked';
    const { server, url } = await listenHttp((reqUrl) => {
      if (reqUrl === '/start') {
        return {
          status: 302,
          headers: { location: '/hop-1' },
          body: 'redirecting',
        };
      }
      if (reqUrl === '/hop-1') {
        return {
          status: 302,
          headers: { location: blockedRedirect },
          body: 'redirecting',
        };
      }
      if (reqUrl === '/blocked') {
        return {
          body: 'should not be reachable',
        };
      }
      return {
        status: 404,
        body: 'not found',
      };
    });
    servers.push(server);

    const parsed = new URL(url);
    blockedRedirect = `http://localhost:${parsed.port}/blocked`;
    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    await expect(harness.invoke({
      url: `${url}/start`,
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('not allowlisted'),
    });

    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'web.fetch.redirect_chain',
        decision: 'DENY',
        params: expect.objectContaining({
          rpcMethod: 'web.fetch',
          finalUrl: `http://localhost:${parsed.port}/blocked`,
          redirectHopCount: 2,
        }),
      }),
    );
  });

  it('detects redirect loops and records denial audit', async () => {
    const { server, url } = await listenHttp((reqUrl) => {
      if (reqUrl === '/loop-a') {
        return {
          status: 302,
          headers: { location: '/loop-b' },
          body: 'redirecting',
        };
      }
      if (reqUrl === '/loop-b') {
        return {
          status: 302,
          headers: { location: '/loop-a' },
          body: 'redirecting',
        };
      }
      return {
        status: 404,
        body: 'not found',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    await expect(harness.invoke({
      url: `${url}/loop-a`,
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('redirect loop'),
    });

    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'web.fetch.redirect_chain',
        decision: 'DENY',
        params: expect.objectContaining({
          rpcMethod: 'web.fetch',
        }),
      }),
    );
  });

  it('enforces redirect depth limits and records denial audit', async () => {
    const { server, url } = await listenHttp((reqUrl) => {
      const match = /^\/depth-(\d+)$/.exec(reqUrl);
      if (!match) {
        return {
          status: 404,
          body: 'not found',
        };
      }
      const index = Number.parseInt(match[1], 10);
      if (index < 4) {
        return {
          status: 302,
          headers: { location: `/depth-${index + 1}` },
          body: 'redirecting',
        };
      }
      return {
        body: 'depth target',
      };
    });
    servers.push(server);

    const harness = createRuntimeHarness({
      workspacePath: process.cwd(),
      urlPolicy: {
        maxRedirectHops: 2,
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['127.0.0.1'],
        },
      },
    });

    await expect(harness.invoke({
      url: `${url}/depth-0`,
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('exceeded 2 hops'),
    });

    expect(harness.recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'web.fetch.redirect_chain',
        decision: 'DENY',
        params: expect.objectContaining({
          rpcMethod: 'web.fetch',
          redirectHopCount: 2,
        }),
      }),
    );
  });

  it('blocks metadata IP resolved by DNS even in local crawler lane', async () => {
    const dnsResolver: DnsResolver = vi.fn(async () => ({ address: '169.254.169.254', family: 4 }));
    const policyConfig = {
      workspacePath: process.cwd(),
      urlPolicy: {
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['crawler.allowed.test'],
        },
      },
      webFetchDnsResolver: dnsResolver,
    } as PolicyConfig & { webFetchDnsResolver: DnsResolver };

    const harness = createRuntimeHarness(policyConfig);
    await expect(harness.invoke({
      url: 'http://crawler.allowed.test/resource',
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('cloud metadata'),
    });
  });

  // ── Sprint-10 H2: response byte caps enforced DURING streaming ──
  // The server streams chunked bodies (no content-length header) and never
  // calls end(), so only in-flight enforcement can reject: a post-buffer
  // check would hang until the request timeout.

  async function listenStreamingHttp(
    chunk: Buffer,
    maxWrites: number,
  ): Promise<{ server: Server; url: string; stats: { writes: number; closed: boolean } }> {
    const stats = { writes: 0, closed: false };
    const server = createServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/octet-stream');
      res.on('close', () => {
        stats.closed = true;
      });
      // Respect backpressure so `stats.writes` tracks actual delivery: once
      // the client destroys the socket, no further chunks are written.
      const writeNext = (): void => {
        if (stats.closed || stats.writes >= maxWrites) return;
        stats.writes += 1;
        if (res.write(chunk)) {
          setImmediate(writeNext);
        } else {
          res.once('drain', writeNext);
        }
      };
      writeNext();
    });

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('failed to bind streaming test http server');
    }
    return { server, url: `http://127.0.0.1:${address.port}`, stats };
  }

  const localCrawlerPolicy = {
    workspacePath: process.cwd(),
    urlPolicy: {
      localCrawlerLane: {
        enabled: true,
        allowHttp: true,
        hostAllowlist: ['127.0.0.1', 'localhost'],
      },
    },
  };

  it('destroys and rejects a chunked length-omitted text response exceeding the cap', async () => {
    // Text-lane cap is 8 MiB; stream 1 MiB chunks with no content-length.
    const { server, url, stats } = await listenStreamingHttp(Buffer.alloc(1024 * 1024, 0x61), 32);
    servers.push(server);

    const harness = createRuntimeHarness(localCrawlerPolicy);

    await expect(harness.invoke({
      url: `${url}/unbounded-text`,
      lane: 'local_crawler',
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('too large'),
    });

    // The socket was destroyed mid-stream: the server observed the close and
    // stopped well before its 32 MiB write budget.
    await vi.waitFor(() => {
      expect(stats.closed).toBe(true);
    });
    expect(stats.writes).toBeLessThan(32);
  });

  it('destroys and rejects a chunked length-omitted binary response exceeding maxBytes', async () => {
    const { server, url, stats } = await listenStreamingHttp(Buffer.alloc(1024, 0x62), 64);
    servers.push(server);

    const harness = createRuntimeHarness(localCrawlerPolicy);

    await expect(harness.invokeBinary({
      url: `${url}/unbounded-binary`,
      lane: 'local_crawler',
      maxBytes: 2048,
    })).rejects.toMatchObject({
      code: GatewayErrors.PROVIDER_ERROR,
      message: expect.stringContaining('too large'),
    });

    await vi.waitFor(() => {
      expect(stats.closed).toBe(true);
    });
    expect(stats.writes).toBeLessThan(64);
  });

  // ── Sprint-10 01-M1: credentials dropped on origin-changing redirects ──

  it('drops Authorization/Cookie on a cross-port redirect but keeps benign headers', async () => {
    let targetHeaders: Record<string, string | string[] | undefined> | null = null;
    const { server: targetServer, url: targetUrl } = await listenHttp((_reqUrl, headers) => {
      targetHeaders = headers;
      return { body: Buffer.from([1]), contentType: 'application/octet-stream' };
    });
    servers.push(targetServer);

    const { server: originServer, url: originUrl } = await listenHttp(() => ({
      status: 302,
      headers: { location: `${targetUrl}/target` },
      body: 'redirecting',
    }));
    servers.push(originServer);

    const harness = createRuntimeHarness(localCrawlerPolicy);
    await harness.invokeBinary({
      url: `${originUrl}/start`,
      lane: 'local_crawler',
      headers: {
        Authorization: 'Bearer secret-token',
        Cookie: 'session=abc',
        'Proxy-Authorization': 'Basic cHJveHk=',
        'X-Keep': 'benign',
      },
    });

    expect(targetHeaders).toBeTruthy();
    expect(targetHeaders!.authorization).toBeUndefined();
    expect(targetHeaders!.cookie).toBeUndefined();
    expect(targetHeaders!['proxy-authorization']).toBeUndefined();
    expect(targetHeaders!['x-keep']).toBe('benign');
  });

  it('drops Authorization/Cookie on a cross-host redirect (same port)', async () => {
    const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = [];
    const { server, url } = await listenHttp((reqUrl, headers) => {
      seen.push({ path: reqUrl, headers });
      if (reqUrl === '/start') {
        const port = new URL(url).port;
        return {
          status: 302,
          // Same server socket, but a different hostname = different origin.
          headers: { location: `http://localhost:${port}/target` },
          body: 'redirecting',
        };
      }
      return { body: Buffer.from([1]), contentType: 'application/octet-stream' };
    });
    servers.push(server);

    // Pin `localhost` to the IPv4 test server (system resolvers may prefer ::1).
    const dnsResolver: DnsResolver = async () => ({ address: '127.0.0.1', family: 4 });
    const harness = createRuntimeHarness({
      ...localCrawlerPolicy,
      webFetchDnsResolver: dnsResolver,
    } as PolicyConfig & { webFetchDnsResolver: DnsResolver });
    await harness.invokeBinary({
      url: `${url}/start`,
      lane: 'local_crawler',
      headers: {
        Authorization: 'Bearer secret-token',
        Cookie: 'session=abc',
      },
    });

    const start = seen.find(entry => entry.path === '/start');
    const target = seen.find(entry => entry.path === '/target');
    expect(start?.headers.authorization).toBe('Bearer secret-token');
    expect(target).toBeTruthy();
    expect(target!.headers.authorization).toBeUndefined();
    expect(target!.headers.cookie).toBeUndefined();
  });

  it('keeps Authorization across same-origin redirects', async () => {
    const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined> }> = [];
    const { server, url } = await listenHttp((reqUrl, headers) => {
      seen.push({ path: reqUrl, headers });
      if (reqUrl === '/start') {
        return {
          status: 302,
          headers: { location: '/same-origin-target' },
          body: 'redirecting',
        };
      }
      return { body: Buffer.from([1]), contentType: 'application/octet-stream' };
    });
    servers.push(server);

    const harness = createRuntimeHarness(localCrawlerPolicy);
    await harness.invokeBinary({
      url: `${url}/start`,
      lane: 'local_crawler',
      headers: { Authorization: 'Bearer secret-token' },
    });

    const target = seen.find(entry => entry.path === '/same-origin-target');
    expect(target).toBeTruthy();
    expect(target!.headers.authorization).toBe('Bearer secret-token');
  });

  it('pins outbound connection to validated DNS address to avoid TOCTOU rebind', async () => {
    const { server, url } = await listenHttp(() => ({
      body: 'pinned ok',
      contentType: 'text/plain; charset=utf-8',
    }));
    servers.push(server);

    const parsed = new URL(url);
    const dnsResolver: DnsResolver = vi.fn(async (hostname: string) => {
      if (hostname !== 'crawler.allowed.test') {
        throw new Error(`unexpected hostname ${hostname}`);
      }
      return { address: '127.0.0.1', family: 4 };
    });
    const policyConfig = {
      workspacePath: process.cwd(),
      urlPolicy: {
        allowHttp: false,
        localCrawlerLane: {
          enabled: true,
          allowHttp: true,
          hostAllowlist: ['crawler.allowed.test'],
        },
      },
      webFetchDnsResolver: dnsResolver,
    } as PolicyConfig & { webFetchDnsResolver: DnsResolver };

    const harness = createRuntimeHarness(policyConfig);
    const result = await harness.invoke({
      url: `http://crawler.allowed.test:${parsed.port}/resource`,
      lane: 'local_crawler',
    });

    expect(result.content).toContain('pinned ok');
    expect(dnsResolver).toHaveBeenCalledWith('crawler.allowed.test');
  });
});
