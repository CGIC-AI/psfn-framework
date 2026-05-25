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

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
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
  transportServer: GardenAdminTransportServer;
  operatorSurface: GardenOperatorSurface;
  transportStopped: boolean;
}

async function createHarness(): Promise<Harness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'garden-operator-surface-test-'));
  const characterCardPath = join(tempDir, 'character.json');
  mkdirSync(join(tempDir, 'sessions'), { recursive: true });
  writeFileSync(characterCardPath, '{}\n', 'utf-8');

  const config: SubstrateConfig = {
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

  const eventBus = new EventBus();
  const services = {
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

  const socketPath = join(tempDir, 'garden-admin.sock');
  const transportServer = new GardenAdminTransportServer({
    socketPath,
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
    transportSocketPath: socketPath,
  });
  await operatorSurface.init();
  await operatorSurface.start();

  return {
    tempDir,
    socketPath,
    port,
    eventBus,
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
          reachable: false,
          status: 'error',
          error: expect.any(String),
        }),
      },
    });
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
            reachable: true,
            status: 'error',
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
