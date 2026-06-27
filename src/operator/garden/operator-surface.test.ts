import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resetRuntimeTrustPolicy } from '../../system/trust/runtime-policy.js';
import { GardenAdminTransportServer } from './transport-server.js';
import { GardenOperatorSurface } from './operator-surface.js';
import type { GardenAdminDomainServices } from './admin-contract.js';
import type {
  GardenAdminTransportClientEndpoint,
  GardenAdminTransportServerEndpoint,
  GardenAdminTransportSocketEndpoint,
} from './transport-paths.js';

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUV4P61n3XtlIkzexqJrv+jmw/zYwwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYyNzIwMTUxMVoXDTM2MDYy
NDIwMTUxMVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAzlCaIOWBPItCY+dDK50SmzNtSry94SW5LSBxUup968X9
gkHpt1nLWXjtNgwtwF+THkhxyMZiYIM2TsQHpSPuZZMDx4y+IHb3003Qb9tIf3m9
7zeBDJiVlrVs4yBfpNy4afgOM6EffQSNNtWQ9WMrKuT5EP6N/xDcfSowaHFynrju
gfRQGHVR2pbWJLvjP41l+RGGBYbD/Xv5zF1MO6d3XY+MM1cfAoCXLKEksYKDRLjO
mgNuvL6bYp1jqnrE6okbpbTWKGwoaevI08b6eQJVAvC1MwOyxjSCMp8/DjdIUY9Z
x9W7hmUJd0eJ8opBboq5mxA3vwMdIIPemMEucm3UoQIDAQABo28wbTAdBgNVHQ4E
FgQUKmsPeINxemVthC+5VR990KscVuIwHwYDVR0jBBgwFoAUKmsPeINxemVthC+5
VR990KscVuIwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARhwR/AAABgglsb2Nh
bGhvc3QwDQYJKoZIhvcNAQELBQADggEBACKfLwqWxVOZWDZJGZVqBRqj2Y/z+3AH
a2hVwQdhYf8Q2L81Pt3adUFSql4X/mNaBBVeylRhco8/PGdB1gL5rvywJZAn++uh
8Bmw7+WOINX07gpGFq2dqUBUHbJQkq0TywwyuoNJdg4IKsavONWU3nix/IIdA3E+
3Ew1XUjBBUYr/ewzy/ItALX/j2EhlfrNtiA5Iwgq6MpbvlHXO7LY9dzvVxl2bIEJ
lxL7AqS1q4m/HZ5CGobk9dT63T1miug7LE/gwMxuvBLJCWNs7xn17QA+D1DcFQCi
VWehGKtekAcSEvEpDRuUANJAet498Zs/IGa06nPhc+jxy3ifjU71kXQ=
-----END CERTIFICATE-----
`;

const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDOUJog5YE8i0Jj
50MrnRKbM21KvL3hJbktIHFS6n3rxf2CQem3WctZeO02DC3AX5MeSHHIxmJggzZO
xAelI+5lkwPHjL4gdvfTTdBv20h/eb3vN4EMmJWWtWzjIF+k3Lhp+A4zoR99BI02
1ZD1Yysq5PkQ/o3/ENx9KjBocXKeuO6B9FAYdVHaltYku+M/jWX5EYYFhsP9e/nM
XUw7p3ddj4wzVx8CgJcsoSSxgoNEuM6aA268vptinWOqesTqiRultNYobChp68jT
xvp5AlUC8LUzA7LGNIIynz8ON0hRj1nH1buGZQl3R4nyikFuirmbEDe/Ax0gg96Y
wS5ybdShAgMBAAECggEAErqZGJ4ST/9e/4K27kv2rHAhXm9+go8ncu6cWv0+gRtw
GqsGdHE1AeJLEQ+kokS1g5eVUgya/E1CWNQi0t2i0/Bh9MjUrvhzIZN8IIC04XLu
cxDZfjM7y8/xxTc4d4GHRtdl3U9QdHY9UNpXq8Rc3tVPvDiKMLrEc/hTJ1K6fP39
gKUe6lFJE7Rzp5yXf3IraAcJViLdadngymJWbJIen/on5P8CcogAejT5qMQtehS7
8tzEPIVbz8OlhzHk3WgikhfxcqkU21bxrKGiTKI4WIbR2e103YBqXbpyiBgv1lV3
jaICOdqWzKD2HvrZbg/TkHg3n5iHqIHuumdz/mrroQKBgQD8Qx63XSRG1oVS44w2
RrzaHGhF3PuTqhVyhdD1xi0V1VeMxkjLvbKe/2qI7ccRbOwMf3fDD9pOFG82To1z
Xl5pFEwNUIsU9p0an70dcTSkD4r2XOKXAD+kfTtpL/bcZG1KPd7xOhR0F51kTsx5
YC45J68VQqy4LTHNfb2+a5v8ZwKBgQDRXzHfNduC04Wp+ps7UEtunyqgUrRYSMJx
D5CMb9UCFls7BBwea0ELtAkd/A0a8JrQPCK3Uvn5jKA8ukYSlObiF44KIwtS1HL0
RkFyY/rqqjmUk9Xi9gmkEiCyiBMZfK63ZRAnw+c3xiTOx2LFCJHnXaTyL3NXtb90
D2M0kJABtwKBgQCSb/Q4xVz1sjoa7/TI3S9r/emaBLoV8joZDQ1MXwp1Di+QjNpd
S3WRTvvtGPriZrRwXN6M4Xr8sGgOwnLicfmkTiAH6qWSOcbhWbFSkhDY3Bzy/uCa
f45yUjBW030eWz4GRvxQVELjUYIQZJ3WJ7stepfsY5QYJkQu4btv+s/GKQJ/GivM
EBqrVa8bBiRNQxzGUQ2URnYQFPkDVR6c8vEHrzscLERXP3Yoq03V1emrubJZp63c
qQ22MXtijDS8jZYPRjOrjZjT0Ya818vwYlwdAThF+kyAb95RVjDt5WMdABKVxFbd
rhrOzCn4b+B8eCSaGFGcTKmhwVT2mYtS2z82wQKBgQD3W6oYbUXSisL4B9xYNACH
QN/XgtMFSj7uVLhCHagscZjK9wgG35DIW0f4azpDCwz2avn+OUjasAERL2LWtIGm
iPdmg4zsX9ZM7WfCz3pp8e05pQwAGyIDYU346C2v+AHsVAylNsObNsYvy+u0aR4Z
Zfv7C28c5whNXHsQcMX2tQ==
-----END PRIVATE KEY-----
`;

function requestPort(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestSocket(
  socketPath: string,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, method, path, headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openWebSocket(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };

    ws.once('open', () => {
      cleanup();
      resolve(ws);
    });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      response.resume();
      reject(new Error(`Unexpected websocket response: ${response.statusCode ?? 0}`));
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

function openWebSocketExpectStatus(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const cleanup = () => {
      ws.removeAllListeners('open');
      ws.removeAllListeners('error');
      ws.removeAllListeners('unexpected-response');
    };

    ws.once('open', () => {
      cleanup();
      ws.close();
      reject(new Error('Expected websocket handshake to fail'));
    });
    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

function readWebSocketMessage<T>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket message')), 2000);
    ws.once('message', (raw: WebSocket.RawData) => {
      clearTimeout(timeout);
      try {
        const text = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw).toString()
            : raw instanceof ArrayBuffer
              ? Buffer.from(raw).toString()
              : raw.toString();
        resolve(JSON.parse(text) as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

function listenSocketServer(socketPath: string, handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function listenPortServer(port: number, handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

interface Harness {
  tempDir: string;
  socketPath: string;
  port: number;
  eventBus: EventBus;
  services: GardenAdminDomainServices;
  transportServer: GardenAdminTransportServer;
  operatorSurface: GardenOperatorSurface;
  transportStopped: boolean;
}

interface OperatorOnlyHarness {
  tempDir: string;
  port: number;
  operatorSurface: GardenOperatorSurface;
}

interface CreateHarnessOptions {
  transportMode?: 'socket' | 'network-http' | 'network-https';
  timeoutMs?: number;
}

function createTestConfig(tempDir: string): SubstrateConfig {
  const characterCardPath = join(tempDir, 'character.json');
  mkdirSync(join(tempDir, 'sessions'), { recursive: true });
  writeFileSync(characterCardPath, '{}\n', 'utf-8');

  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-extract',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '123',
    companionId: 'test-companion',
    characterCardPath,
    dataDir: tempDir,
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelCatalog: {
      primary: {
        model: 'test-model-room',
        provider: 'openai',
        defaults: {
          description: 'Test Model Room',
        },
      },
    },
    modelRoleAssignments: {
      chat: 'primary',
    },
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
  };
}

function createTestServices(): GardenAdminDomainServices {
  return {
    dashboard: {
      getDashboardData: vi.fn(async () => ({
        stats: {
          sessionCount: 1,
        },
      })),
    },
    auditHistory: {
      appendGardenEntry: vi.fn(),
      getAuditHistory: vi.fn(async () => ({
        entries: [],
        filters: {
          actionType: 'all',
          decision: 'all',
          timeRange: '24h',
          source: 'all',
          limit: 100,
          offset: 0,
        },
        pagination: {
          limit: 100,
          offset: 0,
          total: 0,
          hasPrevious: false,
          hasNext: false,
        },
        sources: {
          garden: { available: true, count: 0 },
          gateway: { available: false, count: 0 },
          charge: { available: false, count: 0 },
        },
      })),
    },
    shards: {
      listShardFoldReviews: vi.fn(async () => ({ reviews: [] })),
      getShardFoldReview: vi.fn(async () => null),
      resolveShardFoldReview: vi.fn(async () => ({ ok: false, message: 'Shard fold review not found' })),
    },
    modelUsage: {
      getModelUsageData: vi.fn(async query => ({
        query: query ?? {},
        totals: {
          calls: 1,
          successfulCalls: 1,
          failedCalls: 0,
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          providerCostUsd: 0.001,
          estimatedCostUsd: 0,
          totalCostUsd: 0.001,
          averageDurationMs: 120,
          averageTtftMs: 40,
        },
        byModel: [],
        byPurpose: [],
        byTool: [],
        byCallKind: [],
        recentEvents: [],
        expensiveEvents: [],
      })),
    },
    observerEvalSidecar: {
      getHealth: vi.fn(async () => ({
        status: 'disabled',
        observedAt: 1_780_000_000_000,
        runtime: null,
        persistence: {
          available: false,
          evalOwned: false,
          authoritative: false,
        },
      })),
      getLatestObservation: vi.fn(),
      queryObservations: vi.fn(),
      queryRuns: vi.fn(),
      exportObservations: vi.fn(),
    },
    adaptiveTools: null,
    images: {} as GardenAdminDomainServices['images'],
    memory: {} as GardenAdminDomainServices['memory'],
    sessions: {} as GardenAdminDomainServices['sessions'],
    contacts: {} as GardenAdminDomainServices['contacts'],
    settings: {
      getSettingsData: vi.fn(),
      getSettingsContractData: vi.fn(),
      updateSettings: vi.fn(),
      getSubConfigJson: vi.fn((key: string) => {
        if (key !== 'providers') return null;
        return JSON.stringify({
          schemaVersion: 1,
          providers: [
            {
              id: 'litellm',
              type: 'litellm_proxy',
              enabled: true,
              apiBaseUrl: 'http://localhost:4000/v1',
              apiKeyRef: { kind: 'env', envName: 'LITELLM_API_KEY' },
            },
          ],
        });
      }),
      saveSubConfigJson: vi.fn(() => ({ ok: true, message: 'providers.json saved' })),
    } as GardenAdminDomainServices['settings'],
    identity: {} as GardenAdminDomainServices['identity'],
    prompts: {} as GardenAdminDomainServices['prompts'],
    scheduler: {
      listTasks: () => [],
    },
    skills: null,
    confirmations: null,
    values: {
      list: () => [],
    },
    modelDiscovery: null,
    chatBootstrap: {
      buildBootstrap: vi.fn(async () => ({ defaultSessionId: 'api:admin-user' })),
      updateSelection: vi.fn(async () => ({ selectedTarget: { channel: 'api', userId: 'admin-user' } })),
      buildModelRoomBootstrap: vi.fn(async () => ({ defaultRoomId: 'garden-model-room' })),
    },
  } as GardenAdminDomainServices;
}

function createSocketEndpoint(socketPath: string, timeoutMs: number): GardenAdminTransportSocketEndpoint {
  return {
    mode: 'socket',
    socketPath,
    timeoutMs,
  };
}

function createNetworkEndpoints(
  tempDir: string,
  port: number,
  scheme: 'http' | 'https',
  timeoutMs: number,
): {
  serverEndpoint: GardenAdminTransportServerEndpoint;
  clientEndpoint: GardenAdminTransportClientEndpoint;
} {
  const httpUrl = new URL(`${scheme}://127.0.0.1:${port}`);
  const wsUrl = new URL(`${scheme === 'https' ? 'wss' : 'ws'}://127.0.0.1:${port}`);
  if (scheme === 'http') {
    return {
      serverEndpoint: {
        mode: 'network',
        host: '127.0.0.1',
        port,
        scheme,
        timeoutMs,
        peerAuthMode: 'none',
      },
      clientEndpoint: {
        mode: 'network',
        httpUrl,
        wsUrl,
        timeoutMs,
        peerAuthMode: 'none',
      },
    };
  }

  const certPath = join(tempDir, 'admin-transport-cert.pem');
  const keyPath = join(tempDir, 'admin-transport-key.pem');
  writeFileSync(certPath, TEST_TLS_CERT, 'utf-8');
  writeFileSync(keyPath, TEST_TLS_KEY, 'utf-8');
  return {
    serverEndpoint: {
      mode: 'network',
      host: '127.0.0.1',
      port,
      scheme,
      timeoutMs,
      peerAuthMode: 'none',
      tls: { certPath, keyPath },
    },
    clientEndpoint: {
      mode: 'network',
      httpUrl,
      wsUrl,
      timeoutMs,
      peerAuthMode: 'none',
      tls: { caPath: certPath },
    },
  };
}

async function createOperatorOnlyHarness(
  transportEndpoint: GardenAdminTransportClientEndpoint,
): Promise<OperatorOnlyHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-test-'));
  const config = createTestConfig(tempDir);
  const port = await allocatePort();
  const operatorSurface = new GardenOperatorSurface({
    port,
    host: '127.0.0.1',
    allowInsecureWithoutToken: true,
    config,
    transportEndpoint,
  });
  await operatorSurface.init();
  await operatorSurface.start();

  return {
    tempDir,
    port,
    operatorSurface,
  };
}

async function createHarness(options: CreateHarnessOptions = {}): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-test-'));
  const config = createTestConfig(tempDir);
  const eventBus = new EventBus();
  const services = createTestServices();
  const timeoutMs = options.timeoutMs ?? 15_000;

  const socketPath = join(tempDir, 'garden-admin.sock');
  const transportMode = options.transportMode ?? 'socket';
  const transportEndpoint = transportMode === 'socket'
    ? {
        serverEndpoint: createSocketEndpoint(socketPath, timeoutMs),
        clientEndpoint: createSocketEndpoint(socketPath, timeoutMs),
      }
    : createNetworkEndpoints(
        tempDir,
        await allocatePort(),
        transportMode === 'network-https' ? 'https' : 'http',
        timeoutMs,
      );

  const transportServer = new GardenAdminTransportServer({
    endpoint: transportEndpoint.serverEndpoint,
    eventBus,
    config,
    services,
  });
  await transportServer.init();
  await transportServer.start();

  const port = await allocatePort();
  const operatorSurface = new GardenOperatorSurface({
    port,
    host: '127.0.0.1',
    allowInsecureWithoutToken: true,
    config,
    transportEndpoint: transportEndpoint.clientEndpoint,
  });
  await operatorSurface.init();
  await operatorSurface.start();

  return {
    tempDir,
    socketPath,
    port,
    eventBus,
    services,
    transportServer,
    operatorSurface,
    transportStopped: false,
  };
}

async function destroyHarness(harness: Harness): Promise<void> {
  await harness.operatorSurface.stop();
  if (!harness.transportStopped) {
    await harness.transportServer.stop();
  }
  rmSync(harness.tempDir, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}

async function destroyOperatorOnlyHarness(harness: OperatorOnlyHarness): Promise<void> {
  await harness.operatorSurface.stop();
  rmSync(harness.tempDir, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}

describe('Garden operator surface', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await destroyHarness(harness);
  });

  it('keeps Garden UI off the private transport while serving canonical admin API routes', async () => {
    const dashboardRes = await requestSocket(harness.socketPath, 'GET', '/api/admin/dashboard');
    expect(dashboardRes.status).toBe(200);
    const payload = JSON.parse(dashboardRes.body) as { stats: { sessionCount: number } };
    expect(payload.stats.sessionCount).toBeTypeOf('number');

    const uiRes = await requestSocket(harness.socketPath, 'GET', '/memory');
    expect(uiRes.status).toBe(404);
  });

  it('proxies admin API routes through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/dashboard');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { stats: { sessionCount: number } };
    expect(payload.stats.sessionCount).toBeTypeOf('number');
  });

  it('proxies GET, POST, health, and telemetry over an explicit HTTPS/WSS admin transport', async () => {
    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-https' });

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(200);
      expect(JSON.parse(healthRes.body)).toEqual({
        status: 'ok',
        uptime: expect.any(Number),
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: true,
            status: 'ok',
            httpStatus: 200,
          },
        },
      });

      const getRes = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(getRes.status).toBe(200);
      expect(JSON.parse(getRes.body)).toMatchObject({ stats: { sessionCount: 1 } });

      const providersJson = JSON.stringify({ schemaVersion: 1, providers: [] });
      const postRes = await requestPort(
        networkHarness.port,
        'POST',
        '/api/admin/settings/providers',
        new URLSearchParams({ configJson: providersJson }).toString(),
        { 'content-type': 'application/x-www-form-urlencoded' },
      );
      expect(postRes.status).toBe(200);
      expect(postRes.body).toBe('providers.json saved');
      expect(networkHarness.services.settings.saveSubConfigJson).toHaveBeenCalledWith(
        'providers',
        providersJson,
      );

      const ws = await openWebSocket(networkHarness.port, '/api/admin/events');
      const messagePromise = readWebSocketMessage<{ type: string }>(ws);
      await networkHarness.eventBus.emit('agent.turn.usage', {
        message: {
          id: 'msg-network-usage-1',
          channelId: 'test-channel',
          channelType: 'terminal',
          authorId: 'user-1',
          authorName: 'Tester',
          content: 'hello',
          timestamp: new Date(),
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          llmCalls: 1,
          toolCalls: 0,
          contextUtilization: 5,
          estimatedCostUsd: 0.001,
        },
      });

      expect(await messagePromise).toMatchObject({ type: 'agent.turn.usage' });
      ws.close();
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('proxies admin API routes over an explicit HTTP admin transport', async () => {
    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-http' });

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(200);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'ok',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: true,
            status: 'ok',
            httpStatus: 200,
          },
        },
      });

      const res = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ stats: { sessionCount: 1 } });
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('proxies persisted model usage routes through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/model-usage?limit=5&sinceMs=100');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { totals: { totalTokens: number }; query: { limit?: number; sinceMs?: number } };
    expect(payload.totals.totalTokens).toBe(15);
    expect(payload.query).toMatchObject({ limit: 5, sinceMs: 100 });
  });

  it('proxies observer eval sidecar health through the operator surface', async () => {
    const res = await requestPort(harness.port, 'GET', '/api/admin/evals/observer-sidecar/health');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { status: string; persistence: { available: boolean } };
    expect(payload.status).toBe('disabled');
    expect(payload.persistence.available).toBe(false);
  });

  it('proxies canonical admin settings owner-file routes through the operator surface', async () => {
    const canonicalRes = await requestPort(harness.port, 'GET', '/api/admin/settings/providers');
    expect(canonicalRes.status).toBe(200);
    expect(JSON.parse(canonicalRes.body)).toEqual({
      schemaVersion: 1,
      providers: [
        {
          id: 'litellm',
          type: 'litellm_proxy',
          enabled: true,
          apiBaseUrl: 'http://localhost:4000/v1',
          apiKeyRef: { kind: 'env', envName: 'LITELLM_API_KEY' },
        },
      ],
    });

    const staleRes = await requestPort(harness.port, 'GET', '/api/settings/providers');
    expect(staleRes.status).toBe(404);
  });

  it('reports degraded health when the admin transport is unreachable', async () => {
    await harness.transportServer.stop();
    harness.transportStopped = true;

    const res = await requestPort(harness.port, 'GET', '/health');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({
      status: 'degraded',
      uptime: expect.any(Number),
      dependencies: {
        adminTransport: expect.objectContaining({
          mode: 'socket',
          reachable: false,
          status: 'degraded',
          error: expect.any(String),
        }),
      },
    });
  });

  it('returns clear 404 or 502 responses for wrong paths and closed network upstreams', async () => {
    const missingRes = await requestPort(harness.port, 'GET', '/api/admin/not-a-route');
    expect(missingRes.status).toBe(404);
    expect(missingRes.body).toContain('Not found: /api/admin/not-a-route');

    await expect(openWebSocketExpectStatus(harness.port, '/api/admin/events/not-a-route'))
      .resolves.toBe(404);

    let networkHarness: Harness | undefined;
    try {
      networkHarness = await createHarness({ transportMode: 'network-http', timeoutMs: 250 });
      await networkHarness.transportServer.stop();
      networkHarness.transportStopped = true;

      const proxyRes = await requestPort(networkHarness.port, 'GET', '/api/admin/dashboard');
      expect(proxyRes.status).toBe(502);
      expect(proxyRes.body).toContain('admin transport unavailable');

      const healthRes = await requestPort(networkHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: false,
            status: 'degraded',
          },
        },
      });
    } finally {
      if (networkHarness) {
        await destroyHarness(networkHarness);
      }
    }
  });

  it('reports degraded health and returns 502 when the upstream network endpoint serves the wrong path', async () => {
    const upstreamPort = await allocatePort();
    let wrongPathServer: http.Server | undefined;
    let operatorHarness: OperatorOnlyHarness | undefined;
    try {
      wrongPathServer = await listenPortServer(upstreamPort, (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('wrong admin transport path');
      });
      wrongPathServer.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      });
      operatorHarness = await createOperatorOnlyHarness({
        mode: 'network',
        httpUrl: new URL(`http://127.0.0.1:${upstreamPort}`),
        wsUrl: new URL(`ws://127.0.0.1:${upstreamPort}`),
        timeoutMs: 250,
        peerAuthMode: 'none',
      });

      const healthRes = await requestPort(operatorHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: true,
            status: 'degraded',
            httpStatus: 404,
          },
        },
      });

      await expect(openWebSocketExpectStatus(operatorHarness.port, '/api/admin/events'))
        .resolves.toBe(502);
    } finally {
      if (operatorHarness) {
        await destroyOperatorOnlyHarness(operatorHarness);
      }
      if (wrongPathServer) {
        await closeServer(wrongPathServer);
      }
    }
  });

  it('returns 502 and degraded health when the network upstream times out', async () => {
    const slowPort = await allocatePort();
    let slowServer: http.Server | undefined;
    let operatorHarness: OperatorOnlyHarness | undefined;
    try {
      slowServer = await listenPortServer(slowPort, () => undefined);
      operatorHarness = await createOperatorOnlyHarness({
        mode: 'network',
        httpUrl: new URL(`http://127.0.0.1:${slowPort}`),
        wsUrl: new URL(`ws://127.0.0.1:${slowPort}`),
        timeoutMs: 100,
        peerAuthMode: 'none',
      });

      const proxyRes = await requestPort(operatorHarness.port, 'GET', '/api/admin/dashboard');
      expect(proxyRes.status).toBe(502);
      expect(proxyRes.body).toContain('admin transport timed out');

      const healthRes = await requestPort(operatorHarness.port, 'GET', '/health');
      expect(healthRes.status).toBe(503);
      expect(JSON.parse(healthRes.body)).toMatchObject({
        status: 'degraded',
        dependencies: {
          adminTransport: {
            mode: 'network',
            reachable: false,
            status: 'degraded',
            error: expect.stringContaining('timed out'),
          },
        },
      });
    } finally {
      if (operatorHarness) {
        await destroyOperatorOnlyHarness(operatorHarness);
      }
      if (slowServer) {
        await closeServer(slowServer);
      }
    }
  });

  it('reports degraded health when the admin transport probe reports an error', async () => {
    await harness.transportServer.stop();
    harness.transportStopped = true;

    const unhealthyTransport = await listenSocketServer(harness.socketPath, (_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'transport unavailable' }));
    });

    try {
      const res = await requestPort(harness.port, 'GET', '/health');
      expect(res.status).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'degraded',
        uptime: expect.any(Number),
        dependencies: {
          adminTransport: {
            mode: 'socket',
            reachable: true,
            status: 'degraded',
            httpStatus: 503,
            error: 'transport unavailable',
          },
        },
      });
    } finally {
      await closeServer(unhealthyTransport);
      rmSync(harness.socketPath, { force: true });
    }
  });

  it('reports healthy transport status in operator health', async () => {
    const res = await requestPort(harness.port, 'GET', '/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      status: 'ok',
      uptime: expect.any(Number),
      dependencies: {
        adminTransport: {
          mode: 'socket',
          reachable: true,
          status: 'ok',
          httpStatus: 200,
        },
      },
    });
  });

  it('bridges telemetry websocket events through the operator surface', async () => {
    const ws = await openWebSocket(harness.port, '/api/admin/events');
    const messagePromise = readWebSocketMessage<{ type: string }>(ws);

    await harness.eventBus.emit('agent.turn.usage', {
      message: {
        id: 'msg-usage-1',
        channelId: 'test-channel',
        channelType: 'terminal',
        authorId: 'user-1',
        authorName: 'Tester',
        content: 'hello',
        timestamp: new Date(),
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        llmCalls: 1,
        toolCalls: 0,
        contextUtilization: 5,
        estimatedCostUsd: 0.001,
      },
    });

    const telemetry = await messagePromise;
    expect(telemetry.type).toBe('agent.turn.usage');
    ws.close();
  });
});
