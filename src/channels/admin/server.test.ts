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
import { formatPossessiveCompanionName } from '../../identity/companion-naming.js';
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

async function createHarness(options: {
  token?: string;
  allowInsecureWithoutToken?: boolean;
  modelDiscovery?: {
    getAvailableModels: () => Promise<unknown[]>;
    invalidateCache: () => void;
  } | null;
}): Promise<ServerHarness> {
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
    modelDiscovery: options.modelDiscovery ?? null,
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

    it('keeps canonical /api/admin chat and models routes aligned', async () => {
      const bootstrapRes = await request(harness.port, 'GET', '/api/admin/chat/bootstrap');
      expect(bootstrapRes.status).toBe(200);
      const bootstrapPayload = JSON.parse(bootstrapRes.body) as { defaultSessionId: string };
      expect(bootstrapPayload.defaultSessionId).toBeTypeOf('string');

      const patchRes = await request(
        harness.port,
        'PATCH',
        '/api/admin/chat/bootstrap',
        JSON.stringify({
          channel: 'api',
          userId: 'admin-user',
          privacyLevel: 'private',
        }),
        {
          'Content-Type': 'application/json',
        },
      );
      expect(patchRes.status).toBe(200);
      const patchPayload = JSON.parse(patchRes.body) as {
        ok: boolean;
        bootstrap?: { selectedIdentity?: { channel: string; userId: string } };
      };
      expect(patchPayload.ok).toBe(true);
      expect(patchPayload.bootstrap?.selectedIdentity?.channel).toBe('api');
      expect(patchPayload.bootstrap?.selectedIdentity?.userId).toBe('admin-user');

      const modelRoomRes = await request(harness.port, 'GET', '/api/admin/chat/model-room/bootstrap');
      expect(modelRoomRes.status).toBe(200);
      const modelRoomPayload = JSON.parse(modelRoomRes.body) as { defaultRoomId: string };
      expect(modelRoomPayload.defaultRoomId).toBeTypeOf('string');

      const modelsConfigRes = await request(harness.port, 'GET', '/api/admin/settings/models');
      expect(modelsConfigRes.status).toBe(200);
      const modelsConfigPayload = JSON.parse(modelsConfigRes.body) as {
        schemaVersion: number;
        models: unknown[];
      };
      expect(modelsConfigPayload.schemaVersion).toBe(1);
      expect(Array.isArray(modelsConfigPayload.models)).toBe(true);
    });

    it('accepts canonical models.json payloads via /api/admin/settings/models POST', async () => {
      const currentRes = await request(harness.port, 'GET', '/api/admin/settings/models');
      expect(currentRes.status).toBe(200);
      const currentPayload = JSON.parse(currentRes.body) as {
        schemaVersion: number;
        models: Array<{ id: string; rank: number }>;
      };
      expect(currentPayload.schemaVersion).toBe(1);
      expect(currentPayload.models.length).toBeGreaterThan(0);

      const targetModel = currentPayload.models[0]!;
      const nextRank = targetModel.rank + 7;
      const nextPayload = {
        ...currentPayload,
        models: currentPayload.models.map((entry, index) => (
          index === 0
            ? { ...entry, rank: nextRank }
            : entry
        )),
      };
      const postBody = new URLSearchParams();
      postBody.set('configJson', JSON.stringify(nextPayload));
      const postRes = await request(
        harness.port,
        'POST',
        '/api/admin/settings/models',
        postBody.toString(),
        {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      );
      expect(postRes.status).toBe(200);
      const postPayload = JSON.parse(postRes.body) as { ok: boolean; message: string };
      expect(postPayload.ok).toBe(true);
      expect(postPayload.message).toBe('models.json saved');

      const updatedRes = await request(harness.port, 'GET', '/api/admin/settings/models');
      expect(updatedRes.status).toBe(200);
      const updatedPayload = JSON.parse(updatedRes.body) as {
        schemaVersion: number;
        models: Array<{ id: string; rank: number }>;
      };
      expect(updatedPayload.schemaVersion).toBe(1);
      expect(updatedPayload.models.find((entry) => entry.id === targetModel.id)?.rank).toBe(nextRank);
    });

    it('fails closed for canonical model discovery routes when backend is unavailable', async () => {
      const listRes = await request(harness.port, 'GET', '/api/admin/models');
      expect(listRes.status).toBe(503);
      const listPayload = JSON.parse(listRes.body) as { error: string };
      expect(listPayload.error).toBe('Model discovery backend unavailable');

      const refreshRes = await request(harness.port, 'POST', '/api/admin/models/refresh');
      expect(refreshRes.status).toBe(503);
      const refreshPayload = JSON.parse(refreshRes.body) as { error: string };
      expect(refreshPayload.error).toBe('Model discovery backend unavailable');
    });

    it('does not expose stale non-admin chat/models API paths', async () => {
      const legacyBootstrap = await request(harness.port, 'GET', '/api/chat/bootstrap');
      expect(legacyBootstrap.status).toBe(404);

      const legacyModelRoom = await request(harness.port, 'GET', '/api/chat/model-room/bootstrap');
      expect(legacyModelRoom.status).toBe(404);

      const legacyModels = await request(harness.port, 'GET', '/api/models');
      expect(legacyModels.status).toBe(404);

      const legacyRefresh = await request(harness.port, 'POST', '/api/models/refresh');
      expect(legacyRefresh.status).toBe(404);
    });
  });

  describe('canonical model discovery endpoints with backend configured', () => {
    let harness: ServerHarness;
    const getAvailableModels = vi.fn<() => Promise<unknown[]>>(async () => [
      { id: 'openai/gpt-4.1-mini' },
      { id: 'anthropic/claude-3.7-sonnet' },
    ]);
    const invalidateCache = vi.fn<() => void>(() => {});

    beforeEach(async () => {
      getAvailableModels.mockClear();
      invalidateCache.mockClear();
      harness = await createHarness({
        allowInsecureWithoutToken: true,
        modelDiscovery: {
          getAvailableModels,
          invalidateCache,
        },
      });
    });

    afterEach(async () => {
      await destroyHarness(harness);
    });

    it('serves /api/admin/models and /api/admin/models/refresh', async () => {
      const listRes = await request(harness.port, 'GET', '/api/admin/models');
      expect(listRes.status).toBe(200);
      const listPayload = JSON.parse(listRes.body) as Array<{ id: string }>;
      expect(listPayload.map(model => model.id)).toEqual([
        'openai/gpt-4.1-mini',
        'anthropic/claude-3.7-sonnet',
      ]);
      expect(getAvailableModels).toHaveBeenCalledTimes(1);

      const refreshRes = await request(harness.port, 'POST', '/api/admin/models/refresh');
      expect(refreshRes.status).toBe(200);
      expect(invalidateCache).toHaveBeenCalledTimes(1);
      expect(getAvailableModels).toHaveBeenCalledTimes(2);
      expect(invalidateCache.mock.invocationCallOrder[0]).toBeLessThan(
        getAvailableModels.mock.invocationCallOrder[1],
      );
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
      const expectedGardenTitle = `${formatPossessiveCompanionName(testCard.data.name)} Garden`;
      const escapedExpectedGardenTitle = expectedGardenTitle.replaceAll('\'', '&#39;');
      expect(loginPageRes.body).toContain(`Login - ${escapedExpectedGardenTitle}`);
      expect(loginPageRes.body).not.toContain('Purrsephone\'s Garden');

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

    it('streams sanitized turn observability telemetry over /api/admin/events', async () => {
      const ws = await openWebSocket(harness.port, '/api/admin/events', bearerHeaders);
      const turnId = 'turn-live-1';
      const requestId = 'turn-live-1';
      const channelId = 'test-channel';

      const snapshotMessagePromise = readWebSocketMessage<{
        type: string;
        data: {
          snapshot: {
            memory?: {
              contactEmotionalMemories: Array<Record<string, unknown>>;
              semanticCandidates: Array<Record<string, unknown>>;
              proactiveCandidates: Array<Record<string, unknown>>;
            };
          };
        };
      }>(ws);
      await harness.eventBus.emit('agent.turn.snapshot', {
        turnId,
        requestId,
        channelId,
        callType: 'chat',
        purpose: 'agent.turn.snapshot',
        snapshot: {
          turnId,
          requestId,
          channelId,
          capturedAt: Date.now(),
          trustLevel: 'regular',
          memory: {
            channelId,
            contactEmotionalMemories: [
              {
                id: 'mem-visible',
                text: 'Visible memory',
                type: 'semantic',
                importance: 0.7,
                confidence: 0.8,
                emotionalValence: 0.1,
                salience: 0.9,
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                sourceRef: 'memory:test',
                extractedAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 1,
                tags: ['test'],
                sensitivity: 'personal',
              },
            ],
            semanticCandidates: [
              {
                id: 'mem-allowed',
                text: 'Allowed candidate',
                type: 'semantic',
                importance: 0.8,
                confidence: 0.8,
                emotionalValence: 0.05,
                salience: 0.7,
                embedding: new Float32Array([0.3, 0.4, 0.5]),
                sourceRef: 'memory:test',
                extractedAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 1,
                tags: ['api'],
                sensitivity: 'public',
                similarity: 0.88,
              },
              {
                id: 'mem-withheld',
                text: 'Withheld candidate should not leak',
                type: 'semantic',
                importance: 0.9,
                confidence: 0.9,
                emotionalValence: 0.2,
                salience: 0.8,
                embedding: new Float32Array([0.6, 0.7, 0.8]),
                sourceRef: 'memory:test',
                extractedAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 1,
                tags: ['private'],
                sensitivity: 'personal',
                similarity: 0.92,
              },
            ],
            lexicalCandidates: [],
            proactiveCandidates: [
              {
                id: 'mem-proactive-withheld',
                text: 'Withheld proactive recall should not leak',
                type: 'semantic',
                importance: 0.6,
                confidence: 0.7,
                emotionalValence: 0,
                salience: 0.6,
                embedding: new Float32Array([0.9, 0.1, 0.2]),
                sourceRef: 'memory:test',
                extractedAt: Date.now(),
                lastAccessed: Date.now(),
                accessCount: 1,
                tags: ['private'],
                sensitivity: 'confidential',
              },
            ],
            withheldCandidateIds: ['mem-withheld', 'mem-proactive-withheld'],
            versionPointer: 'memory-v1',
          },
        },
      });
      const snapshotMessage = await snapshotMessagePromise;
      expect(snapshotMessage.type).toBe('agent.turn.snapshot');
      expect(snapshotMessage.data.snapshot.memory?.contactEmotionalMemories[0]).not.toHaveProperty('embedding');
      expect(snapshotMessage.data.snapshot.memory?.semanticCandidates).toHaveLength(1);
      expect(snapshotMessage.data.snapshot.memory?.semanticCandidates[0]?.text).toBe('Allowed candidate');
      expect(snapshotMessage.data.snapshot.memory?.proactiveCandidates).toHaveLength(0);

      const stageMessagePromise = readWebSocketMessage<{
        type: string;
        data: {
          stage: string;
          callType?: string;
          data: { memoryChars?: number; proactiveRecallIncluded?: boolean };
        };
      }>(ws);
      await harness.eventBus.emit('agent.turn.stage', {
        turnId,
        requestId,
        channelId,
        callType: 'chat',
        purpose: 'agent.turn.stage.memory',
        stage: 'memory',
        elapsedMs: 25,
        memoryChars: 128,
        proactiveRecallIncluded: true,
      });
      const stageMessage = await stageMessagePromise;
      expect(stageMessage.type).toBe('agent.turn.stage');
      expect(stageMessage.data).toMatchObject({
        stage: 'memory',
        callType: 'chat',
        data: {
          memoryChars: 128,
          proactiveRecallIncluded: true,
        },
      });

      const retrievalMessagePromise = readWebSocketMessage<{
        type: string;
        data: {
          retrievalSource?: string;
          count: number;
          data: { candidateCount?: number; withheldCount?: number };
        };
      }>(ws);
      await harness.eventBus.emit('memory.retrieval', {
        turnId,
        requestId,
        channelId,
        callType: 'chat',
        purpose: 'memory.retrieval',
        count: 1,
        retrievalSource: 'embedding',
        candidateCount: 3,
        withheldCount: 2,
      });
      const retrievalMessage = await retrievalMessagePromise;
      expect(retrievalMessage.type).toBe('memory.retrieval');
      expect(retrievalMessage.data).toMatchObject({
        retrievalSource: 'embedding',
        count: 1,
        data: {
          candidateCount: 3,
          withheldCount: 2,
        },
      });

      ws.close();
    });
  });
});
