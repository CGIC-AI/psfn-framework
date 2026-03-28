import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerWebMethods } from './web.js';
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
    notifyAll: vi.fn(),
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
