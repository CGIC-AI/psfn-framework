import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { EventBus } from '../../event-bus.js';
import { AdminServer } from './server.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore } from '../../session/store.js';
import { SessionManager } from '../../session/manager.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { ShardManager } from '../../shards/manager.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { SubstrateConfig } from '../../types.js';
import type { LLMProvider } from '../../agent/contracts.js';
import { resetRuntimeTrustPolicy } from '../../trust/runtime-policy.js';

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: { ...headers } },
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

function openWebSocket(port: number, path: string, headers?: Record<string, string>): Promise<WebSocket> {
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
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    let responseBuffer = '';

    const resolveStatus = (status: number): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(status);
    };

    const rejectWith = (error: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };

    const maybeResolve = (): boolean => {
      const match = /^HTTP\/1\.1 (\d{3})/m.exec(responseBuffer);
      if (!match) return false;
      resolveStatus(Number(match[1]));
      return true;
    };

    socket.once('connect', () => {
      const requestHeaders = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`,
      ];
      for (const [name, value] of Object.entries(headers ?? {})) {
        requestHeaders.push(`${name}: ${value}`);
      }
      requestHeaders.push('\r\n');
      socket.write(requestHeaders.join('\r\n'));
    });

    socket.on('data', (chunk: Buffer) => {
      responseBuffer += chunk.toString('utf8');
      maybeResolve();
    });

    socket.once('end', () => {
      if (maybeResolve()) return;
      rejectWith(new Error('Expected websocket upgrade to fail with status'));
    });

    socket.once('error', (error) => {
      if (maybeResolve()) return;
      rejectWith(error as Error);
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
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

const testCard: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'TestBot',
    description: 'A test character',
    personality: 'Friendly and helpful',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['test'],
    creator: 'tester',
  },
};

interface ServerHarness {
  tempDir: string;
  db: Database.Database;
  eventBus: EventBus;
  server: AdminServer;
  port: number;
}

async function createHarness(options: { token?: string; allowInsecureWithoutToken?: boolean }): Promise<ServerHarness> {
  const tempDir = mkdtempSync(join(tmpdir(), 'admin-server-test-'));
  const characterCardPath = join(tempDir, 'character.json');
  const sessionsDir = join(tempDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(characterCardPath, `${JSON.stringify(testCard, null, 2)}\n`, 'utf-8');

  const config: SubstrateConfig = {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-extract',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '123',
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
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
    },
  };

  const db = new Database(':memory:');
  sqliteVec.load(db);
  const eventBus = new EventBus();
  const memoryStore = new MemoryStore(db, 3);
  const sessionStore = new SessionStore(sessionsDir);
  const sessionManager = new SessionManager(sessionStore, config, eventBus);
  const scheduler = new Scheduler(eventBus);
  scheduler.registerHeartbeat(() => {});

  const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
  const shardManager = new ShardManager({
    eventBus,
    llmProvider: mockLlmProvider,
    sessionStore,
    embeddingService: null,
    memoryProvider: null,
    config,
    parentSystemPrompt: '',
  });

  const port = await allocatePort();
  const server = new AdminServer({
    port,
    token: options.token,
    allowInsecureWithoutToken: options.allowInsecureWithoutToken ?? false,
    memoryStore,
    sessionStore,
    sessionManager,
    scheduler,
    shardManager,
    eventBus,
    characterCard: testCard,
    config,
    embeddingService: null,
  });
  await server.init();
  await server.start();

  return { tempDir, db, eventBus, server, port };
}

async function destroyHarness(harness: ServerHarness): Promise<void> {
  await harness.server.stop();
  harness.db.close();
  rmSync(harness.tempDir, { recursive: true, force: true });
  resetRuntimeTrustPolicy();
}

describe('AdminServer legacy UI removal', () => {
  describe('routing without auth token', () => {
    let harness: ServerHarness;

    beforeEach(async () => {
      harness = await createHarness({ allowInsecureWithoutToken: true });
    });

    afterEach(async () => {
      await destroyHarness(harness);
    });

    it('redirects / to /garden', async () => {
      const res = await request(harness.port, 'GET', '/');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/garden');
    });

    it('does not route legacy paths', async () => {
      const legacyRoot = await request(harness.port, 'GET', '/legacy');
      expect(legacyRoot.status).toBe(404);

      const legacyPage = await request(harness.port, 'GET', '/memory');
      expect(legacyPage.status).toBe(404);
    });

    it('keeps /garden route active and fail-closed when build assets are unavailable', async () => {
      const res = await request(harness.port, 'GET', '/garden');
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(res.headers['content-type']).toContain('text/html');
      } else {
        expect(res.body).toContain('Not found: /garden');
      }
    });

    it('keeps canonical /api/admin JSON routes reachable', async () => {
      const res = await request(harness.port, 'GET', '/api/admin/dashboard');
      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body) as { stats: { sessionCount: number } };
      expect(payload.stats.sessionCount).toBeTypeOf('number');
    });
  });

  describe('auth/login/logout and telemetry websocket', () => {
    let harness: ServerHarness;
    const token = 'test-admin-secret';
    const bearerHeaders = { Authorization: `Bearer ${token}` };

    beforeEach(async () => {
      harness = await createHarness({ token });
    });

    afterEach(async () => {
      await destroyHarness(harness);
    });

    it('requires auth for /garden and /api/admin routes', async () => {
      const gardenRes = await request(harness.port, 'GET', '/garden', undefined, {
        Accept: 'text/html',
      });
      expect(gardenRes.status).toBe(302);
      expect(gardenRes.headers.location).toBe('/login');

      const apiRes = await request(harness.port, 'GET', '/api/admin/dashboard');
      expect(apiRes.status).toBe(401);
    });

    it('keeps login page reachable and sets auth cookie on successful login', async () => {
      const loginPageRes = await request(harness.port, 'GET', '/login');
      expect(loginPageRes.status).toBe(200);
      expect(loginPageRes.body).toContain('Login - PSFN\'s Garden');

      const loginBody = new URLSearchParams({ token }).toString();
      const loginRes = await request(harness.port, 'POST', '/login', loginBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(loginRes.status).toBe(302);
      expect(loginRes.headers.location).toBe('/garden');

      const setCookie = loginRes.headers['set-cookie'];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      expect(cookie).toContain('psfn_token=');

      const cookieHeader = cookie!.split(';')[0];
      const authorizedApi = await request(harness.port, 'GET', '/api/admin/dashboard', undefined, {
        Cookie: cookieHeader,
      });
      expect(authorizedApi.status).toBe(200);
    });

    it('clears auth cookie on /api/admin/logout', async () => {
      const loginBody = new URLSearchParams({ token }).toString();
      const loginRes = await request(harness.port, 'POST', '/login', loginBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      const setCookie = loginRes.headers['set-cookie'];
      const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const cookieHeader = cookie!.split(';')[0];

      const logoutRes = await request(harness.port, 'POST', '/api/admin/logout', undefined, {
        Cookie: cookieHeader,
      });
      expect(logoutRes.status).toBe(200);
      const logoutCookie = logoutRes.headers['set-cookie'];
      const cleared = Array.isArray(logoutCookie) ? logoutCookie[0] : logoutCookie;
      expect(cleared).toContain('psfn_token=');
      expect(cleared).toContain('Max-Age=0');
    });

    it('keeps /legacy routes unavailable when authenticated', async () => {
      const res = await request(harness.port, 'GET', '/legacy', undefined, bearerHeaders);
      expect(res.status).toBe(404);
    });

    it('preserves /api/admin/events websocket auth and event streaming', async () => {
      const unauthorizedStatus = await openWebSocketExpectStatus(harness.port, '/api/admin/events');
      expect(unauthorizedStatus).toBe(401);

      const ws = await openWebSocket(harness.port, '/api/admin/events', bearerHeaders);
      const messagePromise = new Promise<{ type: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket telemetry')), 2000);
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
            resolve(JSON.parse(text) as { type: string });
          } catch (error) {
            reject(error);
          }
        });
      });

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
});
