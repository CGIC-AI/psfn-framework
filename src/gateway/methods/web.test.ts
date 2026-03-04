import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import type { PolicyConfig } from '../policy.js';
import { registerWebMethods } from './web.js';
import { GatewayErrors } from '../protocol.js';

interface RuntimeHarness {
  invoke(params: Record<string, unknown>): Promise<any>;
  invokeBinary(params: Record<string, unknown>): Promise<any>;
}

function createRuntimeHarness(policyConfig: PolicyConfig): RuntimeHarness {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<any>>();
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
    sessionHmacKeyring: null,
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
});
