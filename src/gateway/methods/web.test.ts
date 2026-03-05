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
}

function createRuntimeHarness(policyConfig: PolicyConfig): RuntimeHarness {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
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
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    gated: (_method, handler) => handler,
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
  };
}

async function listenHttp(
  handler: (reqUrl: string) => { status?: number; body: string | Buffer; contentType?: string },
): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const result = handler(req.url ?? '/');
    res.statusCode = result.status ?? 200;
    res.setHeader('content-type', result.contentType ?? 'text/plain; charset=utf-8');
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
