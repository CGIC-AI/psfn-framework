import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import WebSocket from 'ws';
import { EventBus } from '../../event-bus.js';
import { AdminServer } from './server.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore } from '../../session/store.js';
import { SessionManager } from '../../session/manager.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { ShardManager } from '../../shards/manager.js';
import { ContactStore } from '../../contacts/store.js';
import { PromptLayerStore } from '../../identity/prompt-store.js';
import { PromptRegistryStore } from '../../identity/prompt-registry.js';
import { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import { loadSettings } from '../../settings.js';
import { saveCapabilityTierConfig } from '../../config/capability-tier-config.js';
import { loadModelsConfig, saveModelsConfig } from '../../config/models-config.js';
import { saveSchedulerConfig } from '../../config/scheduler-config.js';
import { saveSkillsConfig } from '../../config/skills-config.js';
import { saveTrustPolicyConfig } from '../../config/trust-policy-config.js';
import type { SubstrateConfig } from '../../types.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { EmbeddingService, LLMProvider } from '../../agent/contracts.js';
import type { ScheduledTask } from '../../scheduler/types.js';
import { registerStreamingSttProvider } from '../../voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../voice/connectors/tts/index.js';

function request(
  port: number,
  method: string,
  path: string,
  body?: string | Buffer,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const requestHeaders: Record<string, string> = {
      ...(headers ?? {}),
    };
    if (typeof body === 'string' && body.length > 0) {
      const hasContentLength = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length');
      if (!hasContentLength) {
        requestHeaders['Content-Length'] = String(Buffer.byteLength(body));
      }
    }
    if (Buffer.isBuffer(body) && body.length > 0) {
      const hasContentLength = Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'content-length');
      if (!hasContentLength) {
        requestHeaders['Content-Length'] = String(body.length);
      }
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: requestHeaders,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function buildMultipartBody(
  boundary: string,
  parts: Array<{
    name: string;
    filename?: string;
    contentType?: string;
    content: string | Buffer;
  }>,
): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    let disposition = `Content-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      disposition += `; filename="${part.filename}"`;
    }
    chunks.push(Buffer.from(`${disposition}\r\n`));
    if (part.contentType) {
      chunks.push(Buffer.from(`Content-Type: ${part.contentType}\r\n`));
    }
    chunks.push(Buffer.from('\r\n'));
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaMetadataCandidates(entry: Record<string, unknown>): Record<string, unknown>[] {
  const candidates = [entry];
  for (const key of ['schema', 'metadata', 'validation', 'ownership']) {
    const nested = entry[key];
    if (isObjectRecord(nested)) {
      candidates.push(nested);
    }
  }
  return candidates;
}

function entryNameMatches(entry: Record<string, unknown>, name: string): boolean {
  return ['id', 'name', 'key', 'slug', 'field'].some((key) => entry[key] === name);
}

function findNamedSchemaEntry(
  collection: unknown,
  name: string,
): Record<string, unknown> | undefined {
  if (Array.isArray(collection)) {
    return collection.find((entry): entry is Record<string, unknown> => (
      isObjectRecord(entry) && entryNameMatches(entry, name)
    ));
  }

  if (!isObjectRecord(collection)) return undefined;

  const direct = collection[name];
  if (isObjectRecord(direct)) {
    return direct;
  }

  return Object.entries(collection).find(([, entry]) => (
    isObjectRecord(entry) && entryNameMatches(entry, name)
  ))?.[1] as Record<string, unknown> | undefined;
}

function getSchemaRoot(payload: unknown): Record<string, unknown> {
  if (!isObjectRecord(payload)) {
    throw new Error('Expected settings schema payload to be an object');
  }
  return isObjectRecord(payload.schema)
    ? payload.schema
    : payload;
}

function getNamedSchemaEntry(
  root: Record<string, unknown>,
  collectionKeys: readonly string[],
  name: string,
): Record<string, unknown> {
  for (const collectionKey of collectionKeys) {
    const entry = findNamedSchemaEntry(root[collectionKey], name);
    if (entry) {
      return entry;
    }
  }

  throw new Error(`Expected schema entry for ${name}`);
}

function readStringMetadata(
  entry: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const candidate of schemaMetadataCandidates(entry)) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'string') {
        return value;
      }
    }
  }
  return undefined;
}

function readBooleanMetadata(
  entry: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const candidate of schemaMetadataCandidates(entry)) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'boolean') {
        return value;
      }
    }
  }
  return undefined;
}

function readNumberMetadata(
  entry: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const candidate of schemaMetadataCandidates(entry)) {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }
  }
  return undefined;
}

function collectSchemaStrings(
  rawValue: unknown,
  values: string[],
  seen: Set<string>,
): void {
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      values.push(trimmed);
    }
    return;
  }

  if (Array.isArray(rawValue)) {
    rawValue.forEach((value) => collectSchemaStrings(value, values, seen));
    return;
  }

  if (!isObjectRecord(rawValue)) return;

  for (const key of ['id', 'value', 'name', 'file', 'path', 'ownerFile']) {
    if (typeof rawValue[key] === 'string') {
      collectSchemaStrings(rawValue[key], values, seen);
      return;
    }
  }

  for (const [key, value] of Object.entries(rawValue)) {
    if (isObjectRecord(value) || Array.isArray(value)) {
      collectSchemaStrings(key, values, seen);
    }
  }
}

function readOwnerFiles(entry: Record<string, unknown>): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const candidate of schemaMetadataCandidates(entry)) {
    for (const key of ['owner', 'ownerFile', 'ownerPath', 'file', 'jsonFile', 'ownerFiles', 'owners']) {
      collectSchemaStrings(candidate[key], values, seen);
    }
  }

  return values.map((value) => value.split(/[\\/]/).at(-1) ?? value);
}

function readEnumLikeValues(entry: Record<string, unknown>): string[] {
  const values: string[] = [];
  const seen = new Set<string>();

  for (const candidate of schemaMetadataCandidates(entry)) {
    for (const key of ['enum', 'enumValues', 'values', 'options', 'allowedValues']) {
      collectSchemaStrings(candidate[key], values, seen);
    }
  }

  return values;
}

function isRawOnlySchemaSubsystem(entry: Record<string, unknown>): boolean {
  if (readBooleanMetadata(entry, ['rawOnly']) === true) {
    return true;
  }

  const mode = readStringMetadata(entry, ['exposure', 'mode', 'uiExposure', 'gardenExposure']);
  return mode === 'raw-only' || mode === 'raw_only';
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

function openWebSocket(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_request, response) => {
      reject(new Error(`Unexpected response status ${response.statusCode}`));
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
    let settled = false;
    const settle = (status: number): void => {
      if (settled) return;
      settled = true;
      ws.removeAllListeners();
      ws.terminate();
      resolve(status);
    };
    ws.once('unexpected-response', (_request, response) => {
      settle(response.statusCode ?? 0);
    });
    ws.once('open', () => {
      settled = true;
      ws.close();
      reject(new Error('Expected websocket upgrade to fail'));
    });
    ws.once('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      const match = message.match(/Unexpected server response:\s*(\d{3})/);
      if (match) {
        settle(Number(match[1]));
        return;
      }
      if (message.toLowerCase().includes('socket hang up')) {
        settle(401);
        return;
      }
      if (!settled) reject(error instanceof Error ? error : new Error(message));
    });
  });
}

const testConfig: SubstrateConfig = {
  primaryModel: 'test-model',
  primaryProvider: 'test',
  extractionModel: 'test-extract',
  extractionProvider: 'test',
  discordToken: '',
  discordBotId: '123',
  characterCardPath: '',
  dataDir: './data',
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

const testCard: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'ApiTestBot',
    description: 'API test character',
    personality: 'Calm',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['test'],
    creator: 'tester',
  },
};

const testEmbeddingService: EmbeddingService = {
  dims: 3,
  embed: async (text: string) => {
    const normalized = text.trim().toLowerCase();
    return new Float32Array([
      Math.min(1, Math.max(0.1, normalized.length / 50)),
      normalized.includes('memory') ? 0.9 : 0.2,
      normalized.includes('session') ? 0.8 : 0.3,
    ]);
  },
  embedBatch: async (texts: string[]) => Promise.all(texts.map(text => testEmbeddingService.embed(text))),
};

describe('AdminServer JSON API routes', () => {
  let tempDir: string;
  let db: Database.Database;
  let eventBus: EventBus;
  let memoryStore: MemoryStore;
  let sessionStore: SessionStore;
  let sessionManager: SessionManager;
  let scheduler: Scheduler;
  let shardManager: ShardManager;
  let contactStore: ContactStore;
  let promptStore: PromptLayerStore;
  let promptRegistry: PromptRegistryStore;
  let cardVersionStore: CharacterCardVersionStore;
  let server: AdminServer;
  let port: number;
  let refreshModelsSpy: ReturnType<typeof vi.fn>;
  let refreshCapabilitiesSpy: ReturnType<typeof vi.fn>;
  const token = 'test-admin-token';
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-api-test-'));
    refreshModelsSpy = vi.fn();
    refreshCapabilitiesSpy = vi.fn();
    testConfig.runtimeHooks = {
      refreshModels: refreshModelsSpy,
      refreshCapabilities: refreshCapabilitiesSpy,
    };
    testConfig.capabilityTier = 'nursery';
    testConfig.dataDir = tempDir;
    testConfig.characterCardPath = join(tempDir, 'character.json');
    writeFileSync(testConfig.characterCardPath, `${JSON.stringify(testCard, null, 2)}\n`, 'utf-8');
    const sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    db = new Database(':memory:');
    sqliteVec.load(db);
    eventBus = new EventBus();
    memoryStore = new MemoryStore(db, 3);
    sessionStore = new SessionStore(sessionsDir);
    sessionManager = new SessionManager(sessionStore, testConfig, eventBus);
    scheduler = new Scheduler(eventBus);
    contactStore = new ContactStore(db, 'primary-user');
    promptStore = new PromptLayerStore(
      join(tempDir, 'prompt-layers.json'),
      join(tempDir, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('Base prompt');
    promptRegistry = new PromptRegistryStore(
      join(tempDir, 'prompt-registry.json'),
      join(tempDir, 'prompt-registry-history.jsonl'),
    );
    cardVersionStore = new CharacterCardVersionStore(
      testConfig.characterCardPath,
      join(tempDir, 'character-card-history.jsonl'),
    );

    scheduler.register({
      id: 'test-task',
      name: 'Test Task',
      type: 'every',
      intervalMs: 60_000,
      handler: () => {},
      state: 'idle',
    });

    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
    shardManager = new ShardManager({
      eventBus,
      llmProvider: mockLlmProvider,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: testConfig,
      parentSystemPrompt: '',
    });
    const adaptiveToolsStateProvider = {
      getAdaptiveToolRuntimeState: () => ({
        generatedAt: 1_701_234_567_890,
        coreTools: ['load_tools'],
        extendedTools: ['repo_status', 'repo_diff', 'repo_apply_patch'],
        promotedToolsConfigured: ['repo_status'],
        promotedToolsActive: ['repo_status'],
        promotedToolsSkipped: [
          {
            toolName: 'repo_apply_patch',
            source: 'promoted',
            reason: 'capability_denied',
            missingTokens: ['git.write'],
          },
        ],
        loadedExtendedTools: [
          {
            toolName: 'repo_diff',
            source: 'autoload',
            activatedAt: 1_701_234_560_000,
            lastActivatedAt: 1_701_234_567_000,
          },
        ],
        activeTools: [
          { toolName: 'load_tools', source: 'core' },
          { toolName: 'repo_status', source: 'promoted' },
          { toolName: 'repo_diff', source: 'autoload' },
        ],
        lastSnapshot: null,
      }),
    };

    port = await allocatePort();
    server = new AdminServer({
      port,
      token,
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: testCard,
      config: testConfig,
      embeddingService: testEmbeddingService,
      contactStore,
      promptStore,
      promptRegistry,
      cardVersionStore,
      adaptiveToolsStateProvider,
      skillsRuntime: {
        getSnapshot: () => null,
        invalidate: () => {},
      } as any,
      allowInsecureWithoutToken: false,
    });

    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    testConfig.runtimeHooks = undefined;
    testConfig.capabilityTier = undefined;
  });

  it('enforces auth on JSON API routes', async () => {
    const unauthorized = await request(port, 'GET', '/api/admin/dashboard');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(port, 'GET', '/api/admin/dashboard', undefined, authHeaders);
    expect(authorized.status).toBe(200);
    const payload = JSON.parse(authorized.body) as { stats: { memoryTotal: number } };
    expect(payload.stats.memoryTotal).toBeGreaterThanOrEqual(0);
  });

  it('returns period-bounded dashboard cost windows and honors costWindow selection', async () => {
    type UsageSample = {
      timestampMs: number;
      llmCalls: number;
      toolCalls: number;
      estimatedCostUsd?: number;
    };

    const nowMs = Date.now();
    const samples: UsageSample[] = [
      { timestampMs: nowMs - (1 * 60 * 60 * 1000), llmCalls: 2, toolCalls: 1, estimatedCostUsd: 0.1111 },
      { timestampMs: nowMs - (3 * 24 * 60 * 60 * 1000), llmCalls: 1, toolCalls: 2, estimatedCostUsd: 0.2222 },
      { timestampMs: nowMs - (15 * 24 * 60 * 60 * 1000), llmCalls: 4, toolCalls: 3, estimatedCostUsd: 0.3333 },
      { timestampMs: nowMs - (45 * 24 * 60 * 60 * 1000), llmCalls: 9, toolCalls: 9, estimatedCostUsd: 0.9999 },
      { timestampMs: Number.NaN, llmCalls: 8, toolCalls: 8, estimatedCostUsd: 0.7777 },
      { timestampMs: nowMs - (2 * 60 * 60 * 1000), llmCalls: 3, toolCalls: 0 },
    ];

    for (const [index, sample] of samples.entries()) {
      await eventBus.emit('agent.turn.usage', {
        message: {
          id: `dashboard-cost-${index}`,
          channelId: 'api-session',
          channelType: 'api',
          authorId: 'operator',
          authorName: 'Operator',
          content: 'dashboard cost sample',
          timestamp: new Date(sample.timestampMs),
        },
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          llmCalls: sample.llmCalls,
          toolCalls: sample.toolCalls,
          contextUtilization: 10,
          estimatedCostUsd: sample.estimatedCostUsd,
        },
      });
    }

    const now = new Date(nowMs);
    const dayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const weekOffsetDays = (now.getUTCDay() + 6) % 7;
    const weekStartMs = dayStartMs - (weekOffsetDays * 86_400_000);
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);

    const expected = {
      today: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
      week: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
      month: { turns: 0, llmCalls: 0, toolCalls: 0, estimatedCostUsd: 0 },
    };

    for (const sample of samples) {
      if (!Number.isFinite(sample.timestampMs) || sample.timestampMs < monthStartMs) {
        continue;
      }
      expected.month.turns += 1;
      expected.month.llmCalls += sample.llmCalls;
      expected.month.toolCalls += sample.toolCalls;
      expected.month.estimatedCostUsd += sample.estimatedCostUsd ?? 0;

      if (sample.timestampMs >= weekStartMs) {
        expected.week.turns += 1;
        expected.week.llmCalls += sample.llmCalls;
        expected.week.toolCalls += sample.toolCalls;
        expected.week.estimatedCostUsd += sample.estimatedCostUsd ?? 0;
      }

      if (sample.timestampMs >= dayStartMs) {
        expected.today.turns += 1;
        expected.today.llmCalls += sample.llmCalls;
        expected.today.toolCalls += sample.toolCalls;
        expected.today.estimatedCostUsd += sample.estimatedCostUsd ?? 0;
      }
    }

    const res = await request(port, 'GET', '/api/admin/dashboard?costWindow=week', undefined, authHeaders);
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as {
      stats: {
        sessionUsage: {
          costWindows: {
            selected: string;
            byWindow: {
              today: { turns: number; llmCalls: number; toolCalls: number; estimatedCostUsd: number };
              week: { turns: number; llmCalls: number; toolCalls: number; estimatedCostUsd: number };
              month: { turns: number; llmCalls: number; toolCalls: number; estimatedCostUsd: number };
            };
          };
        };
      };
    };

    expect(payload.stats.sessionUsage.costWindows.selected).toBe('week');
    expect(payload.stats.sessionUsage.costWindows.byWindow.today.turns).toBe(expected.today.turns);
    expect(payload.stats.sessionUsage.costWindows.byWindow.today.llmCalls).toBe(expected.today.llmCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.today.toolCalls).toBe(expected.today.toolCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.today.estimatedCostUsd).toBeCloseTo(expected.today.estimatedCostUsd, 8);

    expect(payload.stats.sessionUsage.costWindows.byWindow.week.turns).toBe(expected.week.turns);
    expect(payload.stats.sessionUsage.costWindows.byWindow.week.llmCalls).toBe(expected.week.llmCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.week.toolCalls).toBe(expected.week.toolCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.week.estimatedCostUsd).toBeCloseTo(expected.week.estimatedCostUsd, 8);

    expect(payload.stats.sessionUsage.costWindows.byWindow.month.turns).toBe(expected.month.turns);
    expect(payload.stats.sessionUsage.costWindows.byWindow.month.llmCalls).toBe(expected.month.llmCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.month.toolCalls).toBe(expected.month.toolCalls);
    expect(payload.stats.sessionUsage.costWindows.byWindow.month.estimatedCostUsd).toBeCloseTo(expected.month.estimatedCostUsd, 8);
  });

  it('returns active-session context pressure and fails closed when active-session telemetry is missing', async () => {
    sessionManager.setActiveContextSession('discord:active-session');

    await eventBus.emit('agent.turn.usage', {
      message: {
        id: 'active-session-pressure',
        channelId: 'api:operator',
        channelType: 'api',
        authorId: 'operator',
        authorName: 'Operator',
        content: 'session pressure sample',
        timestamp: new Date(),
      },
      usage: {
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 5,
        llmCalls: 1,
        toolCalls: 0,
        contextUtilization: 61.7,
        estimatedCostUsd: 0.001,
      },
    });

    let res = await request(port, 'GET', '/api/admin/dashboard', undefined, authHeaders);
    expect(res.status).toBe(200);
    let payload = JSON.parse(res.body) as {
      stats: {
        sessionUsage: {
          activeSessionContextPressure: {
            sessionId: string | null;
            utilizationPct: number;
            hasTelemetry: boolean;
          };
        };
      };
    };
    expect(payload.stats.sessionUsage.activeSessionContextPressure).toEqual({
      sessionId: 'discord:active-session',
      utilizationPct: 61.7,
      hasTelemetry: true,
    });

    sessionManager.setActiveContextSession('discord:no-telemetry');
    res = await request(port, 'GET', '/api/admin/dashboard', undefined, authHeaders);
    expect(res.status).toBe(200);
    payload = JSON.parse(res.body) as {
      stats: {
        sessionUsage: {
          activeSessionContextPressure: {
            sessionId: string | null;
            utilizationPct: number;
            hasTelemetry: boolean;
          };
        };
      };
    };
    expect(payload.stats.sessionUsage.activeSessionContextPressure).toEqual({
      sessionId: 'discord:no-telemetry',
      utilizationPct: 0,
      hasTelemetry: false,
    });
  });

  it('rejects invalid dashboard costWindow query values', async () => {
    const res = await request(port, 'GET', '/api/admin/dashboard?costWindow=all-time', undefined, authHeaders);
    expect(res.status).toBe(400);
    const payload = JSON.parse(res.body) as { error: string };
    expect(payload.error).toContain('Invalid costWindow query parameter');
  });

  it('includes cadence fields for recurring tasks in /api/admin/scheduler', async () => {
    scheduler.register({
      id: 'cadence-hourly',
      name: 'Cadence Hourly Task',
      type: 'every',
      intervalMs: 60_000,
      handler: () => {},
      state: 'idle',
      cadence: {
        kind: 'hourly',
        minute: 15,
        timezone: 'utc',
      },
    } as Parameters<Scheduler['register']>[0] & {
      cadence: { kind: 'hourly'; minute: number; timezone: string };
    });

    const res = await request(port, 'GET', '/api/admin/scheduler', undefined, authHeaders);
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as {
      tasks: Array<{
        id: string;
        type: string;
        cadence?: { kind: string; hour?: number; minute: number; timezone?: string };
      }>;
    };

    expect(payload.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cadence-hourly',
        type: 'every',
        cadence: {
          kind: 'hourly',
          minute: 15,
          timezone: 'utc',
        },
      }),
    ]));
  });

  it('accepts cadence updates on PATCH /api/admin/scheduler/tasks/:taskId', async () => {
    const res = await request(
      port,
      'PATCH',
      '/api/admin/scheduler/tasks/test-task',
      JSON.stringify({
        cadence: {
          kind: 'daily',
          hour: 6,
          minute: 30,
          timezone: 'utc',
        },
      }),
      authHeaders,
    );

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as { ok: boolean; message: string };
    expect(payload.ok).toBe(true);
    expect(payload.message).toContain('updated');
  });

  it('round-trips recurring cadence on POST /api/admin/scheduler/tasks + GET /api/admin/scheduler', async () => {
    const createRes = await request(
      port,
      'POST',
      '/api/admin/scheduler/tasks',
      JSON.stringify({
        id: 'cadence-created-task',
        name: 'Cadence Created Task',
        type: 'every',
        intervalMs: 120_000,
        cadence: {
          kind: 'daily',
          hour: 9,
          minute: 5,
          timezone: 'utc',
        },
      }),
      authHeaders,
    );
    expect(createRes.status).toBe(201);
    const createPayload = JSON.parse(createRes.body) as { ok: boolean; message: string };
    expect(createPayload.ok).toBe(true);

    const getRes = await request(port, 'GET', '/api/admin/scheduler', undefined, authHeaders);
    expect(getRes.status).toBe(200);
    const getPayload = JSON.parse(getRes.body) as {
      tasks: Array<{
        id: string;
        type: string;
        cadence?: { kind: string; hour?: number; minute: number; timezone?: string };
      }>;
    };

    expect(getPayload.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'cadence-created-task',
        type: 'every',
        cadence: {
          kind: 'daily',
          hour: 9,
          minute: 5,
          timezone: 'utc',
        },
      }),
    ]));
  });

  it('rejects invalid cadence payloads on PATCH /api/admin/scheduler/tasks/:taskId', async () => {
    const invalidCadenceCases: Array<[cadence: Record<string, unknown>, errorFragment: string]> = [
      [{ kind: 'weekly', minute: 0 }, 'cadence.kind'],
      [{ kind: 'daily', hour: 24, minute: 0, timezone: 'utc' }, 'cadence.hour'],
      [{ kind: 'hourly', minute: 60, timezone: 'utc' }, 'cadence.minute'],
      [{ kind: 'daily', hour: 8, minute: 0, timezone: 'Not/AZone' }, 'cadence.timezone'],
    ];

    for (const [cadence, errorFragment] of invalidCadenceCases) {
      const res = await request(
        port,
        'PATCH',
        '/api/admin/scheduler/tasks/test-task',
        JSON.stringify({ cadence }),
        authHeaders,
      );

      expect(res.status).toBe(400);
      const payload = JSON.parse(res.body) as { ok: boolean; message: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain(errorFragment);
    }
  });

  it('rejects invalid cadence payloads on POST /api/admin/scheduler/tasks', async () => {
    const invalidCadenceCases: Array<[cadence: Record<string, unknown>, errorFragment: string]> = [
      [{ kind: 'weekly', minute: 0 }, 'cadence.kind'],
      [{ kind: 'daily', hour: 24, minute: 0, timezone: 'utc' }, 'cadence.hour'],
      [{ kind: 'hourly', minute: 60, timezone: 'utc' }, 'cadence.minute'],
      [{ kind: 'daily', hour: 8, minute: 0, timezone: 'Not/AZone' }, 'cadence.timezone'],
    ];

    for (const [index, [cadence, errorFragment]] of invalidCadenceCases.entries()) {
      const res = await request(
        port,
        'POST',
        '/api/admin/scheduler/tasks',
        JSON.stringify({
          id: `invalid-cadence-task-${index}`,
          name: `Invalid cadence task ${index}`,
          type: 'every',
          intervalMs: 60_000,
          cadence,
        }),
        authHeaders,
      );

      expect(res.status).toBe(400);
      const payload = JSON.parse(res.body) as { ok: boolean; message: string };
      expect(payload.ok).toBe(false);
      expect(payload.message).toContain(errorFragment);
    }
  });

  it('persists reflection cadence updates from task PATCH into heartbeat policy', async () => {
    scheduler.register({
      id: 'reflection:whisper',
      name: 'Whisper',
      type: 'every',
      intervalMs: 3_600_000,
      handler: () => {},
      state: 'idle',
      cadence: {
        kind: 'hourly',
        minute: 0,
        timezone: 'local',
      },
    } as Parameters<Scheduler['register']>[0]);

    const patchRes = await request(
      port,
      'PATCH',
      '/api/admin/scheduler/tasks/reflection%3Awhisper',
      JSON.stringify({
        intervalMs: 86_400_000,
        enabled: false,
        cadence: {
          kind: 'daily',
          hour: 7,
          minute: 15,
          timezone: 'utc',
        },
      }),
      authHeaders,
    );
    expect(patchRes.status).toBe(200);
    const patchPayload = JSON.parse(patchRes.body) as { ok: boolean; message: string };
    expect(patchPayload.ok).toBe(true);

    const task = scheduler.getTask('reflection:whisper') as (ScheduledTask & {
      cadence?: { kind: string; hour?: number; minute?: number; timezone?: string };
    }) | undefined;
    expect(task?.state).toBe('paused');
    expect(task?.intervalMs).toBe(86_400_000);
    expect(task?.cadence).toEqual({
      kind: 'daily',
      hour: 7,
      minute: 15,
      timezone: 'utc',
    });

    const getRes = await request(port, 'GET', '/api/admin/scheduler', undefined, authHeaders);
    expect(getRes.status).toBe(200);
    const getPayload = JSON.parse(getRes.body) as {
      reflections: Array<{
        id: string;
        enabled: boolean;
        intervalMs: number;
        cadence?: { kind: string; hour?: number; minute?: number; timezone?: string };
      }>;
    };
    const whisper = getPayload.reflections.find(reflection => reflection.id === 'whisper');
    expect(whisper).toMatchObject({
      id: 'whisper',
      enabled: false,
      intervalMs: 86_400_000,
      cadence: {
        kind: 'daily',
        hour: 7,
        minute: 15,
        timezone: 'utc',
      },
    });
  });

  it('fails closed when reflection task has no matching policy template', async () => {
    scheduler.register({
      id: 'reflection:missing-template',
      name: 'Missing Template',
      type: 'every',
      intervalMs: 60_000,
      handler: () => {},
      state: 'idle',
    });

    const res = await request(
      port,
      'PATCH',
      '/api/admin/scheduler/tasks/reflection%3Amissing-template',
      JSON.stringify({ intervalMs: 120_000 }),
      authHeaders,
    );

    expect(res.status).toBe(400);
    const payload = JSON.parse(res.body) as { ok: boolean; message: string };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain('Reflection template "missing-template" not found');

    const task = scheduler.getTask('reflection:missing-template');
    expect(task?.intervalMs).toBe(60_000);
  });

  it('returns adaptive tool runtime state and recent adaptive telemetry', async () => {
    await eventBus.emit('agent.tools.adaptive.decision', {
      turnId: 'turn-adaptive-1',
      requestId: 'turn-adaptive-1',
      channelId: 'api-session',
      callType: 'chat',
      purpose: 'agent.tools.adaptive.decision',
      timestamp: Date.now(),
      toolName: 'repo_diff',
      source: 'autoload',
      decision: 'activated',
      reason: 'autoload_candidate',
      taskKind: null,
      intent: 'dev',
    });
    await eventBus.emit('agent.tools.adaptive.snapshot', {
      turnId: 'turn-adaptive-1',
      requestId: 'turn-adaptive-1',
      channelId: 'api-session',
      callType: 'chat',
      purpose: 'agent.tools.adaptive.snapshot',
      timestamp: Date.now(),
      taskKind: null,
      intent: 'dev',
      tools: [
        { toolName: 'load_tools', source: 'core' },
        { toolName: 'repo_status', source: 'promoted' },
        { toolName: 'repo_diff', source: 'autoload' },
      ],
      skipped: [
        {
          toolName: 'repo_apply_patch',
          source: 'autoload',
          reason: 'capability_denied',
          missingTokens: ['git.write'],
        },
      ],
      counts: {
        core: 1,
        promoted: 1,
        extendedLoaded: 0,
        autoload: 1,
        deferred: 0,
        total: 3,
      },
    });

    const adaptiveRes = await request(port, 'GET', '/api/admin/tools/adaptive', undefined, authHeaders);
    expect(adaptiveRes.status).toBe(200);
    const adaptivePayload = JSON.parse(adaptiveRes.body) as {
      state: {
        coreTools: string[];
        activeTools: Array<{ toolName: string; source: string }>;
      } | null;
      recentTelemetry: Array<{
        type: 'decision' | 'snapshot';
        payload: Record<string, unknown>;
      }>;
    };

    expect(adaptivePayload.state).not.toBeNull();
    expect(adaptivePayload.state?.coreTools).toContain('load_tools');
    expect(adaptivePayload.state?.activeTools).toEqual(expect.arrayContaining([
      expect.objectContaining({ toolName: 'repo_status', source: 'promoted' }),
      expect.objectContaining({ toolName: 'repo_diff', source: 'autoload' }),
    ]));
    expect(adaptivePayload.recentTelemetry).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'decision',
        payload: expect.objectContaining({
          toolName: 'repo_diff',
          source: 'autoload',
          decision: 'activated',
        }),
      }),
      expect.objectContaining({
        type: 'snapshot',
        payload: expect.objectContaining({
          tools: expect.arrayContaining([
            expect.objectContaining({ toolName: 'repo_status', source: 'promoted' }),
          ]),
          skipped: expect.arrayContaining([
            expect.objectContaining({ toolName: 'repo_apply_patch', reason: 'capability_denied' }),
          ]),
        }),
      }),
    ]));
  });

  it('supports memory list filters and detail fetch path for modal', async () => {
    const semanticTimestamp = Date.UTC(2026, 0, 10, 12, 0, 0);
    const episodicTimestamp = Date.UTC(2026, 1, 22, 9, 30, 0);
    memoryStore.insertMemory({
      id: 'api-mem-1',
      text: 'API semantic memory one',
      type: 'semantic',
      importance: 0.7,
      confidence: 0.9,
      emotionalValence: 0.1,
      salience: 0.5,
      sourceRef: 'api:test:1',
      extractedAt: semanticTimestamp,
      lastAccessed: semanticTimestamp,
      accessCount: 0,
      tags: ['api'],
      sensitivity: 'personal',
    }, new Float32Array([0.1, 0.2, 0.3]));
    memoryStore.insertMemory({
      id: 'api-mem-2',
      text: 'API episodic memory two',
      type: 'episodic',
      importance: 0.6,
      confidence: 0.8,
      emotionalValence: 0,
      salience: 0.6,
      sourceRef: 'api:test:2',
      extractedAt: episodicTimestamp,
      lastAccessed: episodicTimestamp,
      accessCount: 0,
      tags: ['api'],
      sensitivity: 'confidential',
    }, new Float32Array([0.2, 0.3, 0.4]));
    memoryStore.insertMemory({
      id: 'api-mem-cf',
      text: 'Context feedback for turn test-turn. Score=0.88 bucket=high.',
      type: 'procedural',
      importance: 0.3,
      confidence: 0.4,
      emotionalValence: 0,
      salience: 0.1,
      sourceRef: 'source:context_feedback|turn:test-turn|score:0.88|model:test-model',
      extractedAt: Date.UTC(2026, 1, 25, 10, 0, 0),
      lastAccessed: Date.UTC(2026, 1, 25, 10, 0, 0),
      accessCount: 0,
      tags: ['context_feedback', 'procedural_learning'],
      sensitivity: 'public',
    }, new Float32Array([0.3, 0.2, 0.1]));

    const listRes = await request(port, 'GET', '/api/admin/memory?limit=1&offset=1', undefined, authHeaders);
    expect(listRes.status).toBe(200);
    const listPayload = JSON.parse(listRes.body) as { memories: Array<{ id: string }> };
    expect(listPayload.memories).toHaveLength(1);
    expect(listPayload.memories.some(memory => memory.id === 'api-mem-cf')).toBe(false);

    const filteredRes = await request(port, 'GET', '/api/admin/memory?type=semantic', undefined, authHeaders);
    expect(filteredRes.status).toBe(200);
    const filteredPayload = JSON.parse(filteredRes.body) as { memories: Array<{ type: string }> };
    expect(filteredPayload.memories.every(memory => memory.type === 'semantic')).toBe(true);

    const sensitivityRes = await request(port, 'GET', '/api/admin/memory?sensitivity=confidential', undefined, authHeaders);
    expect(sensitivityRes.status).toBe(200);
    const sensitivityPayload = JSON.parse(sensitivityRes.body) as { memories: Array<{ sensitivity: string }> };
    expect(sensitivityPayload.memories).toHaveLength(1);
    expect(sensitivityPayload.memories[0]?.sensitivity).toBe('confidential');

    const dateRangeRes = await request(
      port,
      'GET',
      '/api/admin/memory?startDate=2026-01-01&endDate=2026-01-31',
      undefined,
      authHeaders,
    );
    expect(dateRangeRes.status).toBe(200);
    const dateRangePayload = JSON.parse(dateRangeRes.body) as { memories: Array<{ id: string }> };
    expect(dateRangePayload.memories).toHaveLength(1);
    expect(dateRangePayload.memories[0]?.id).toBe('api-mem-1');

    const combinedFilterRes = await request(
      port,
      'GET',
      '/api/admin/memory?type=episodic&sensitivity=confidential&startDate=2026-02-01&endDate=2026-02-28',
      undefined,
      authHeaders,
    );
    expect(combinedFilterRes.status).toBe(200);
    const combinedFilterPayload = JSON.parse(combinedFilterRes.body) as { memories: Array<{ id: string }> };
    expect(combinedFilterPayload.memories).toHaveLength(1);
    expect(combinedFilterPayload.memories[0]?.id).toBe('api-mem-2');

    const detailRes = await request(port, 'GET', '/api/admin/memory/api-mem-1', undefined, authHeaders);
    expect(detailRes.status).toBe(200);
    const detailPayload = JSON.parse(detailRes.body) as { memory: { id: string } };
    expect(detailPayload.memory.id).toBe('api-mem-1');

    const searchRes = await request(port, 'GET', '/api/admin/memory/search?q=memory', undefined, authHeaders);
    expect(searchRes.status).toBe(200);
    const searchPayload = JSON.parse(searchRes.body) as { results: Array<{ id: string }> };
    expect(searchPayload.results.length).toBeGreaterThan(0);
    expect(searchPayload.results.some(memory => memory.id === 'api-mem-cf')).toBe(false);

    const deleteRes = await request(port, 'DELETE', '/api/admin/memory/api-mem-2', undefined, authHeaders);
    expect(deleteRes.status).toBe(200);
    expect(memoryStore.getById('api-mem-2')?.supersededBy).toMatch(/^admin-/);

    const missingDelete = await request(port, 'DELETE', '/api/admin/memory/missing-id', undefined, authHeaders);
    expect(missingDelete.status).toBe(404);

    const badType = await request(port, 'GET', '/api/admin/memory?type=not-a-type', undefined, authHeaders);
    expect(badType.status).toBe(400);

    const badSensitivity = await request(port, 'GET', '/api/admin/memory?sensitivity=top-secret', undefined, authHeaders);
    expect(badSensitivity.status).toBe(400);

    const badStartDate = await request(port, 'GET', '/api/admin/memory?startDate=2026-02-30', undefined, authHeaders);
    expect(badStartDate.status).toBe(400);

    const badRange = await request(
      port,
      'GET',
      '/api/admin/memory?startDate=2026-02-10&endDate=2026-02-01',
      undefined,
      authHeaders,
    );
    expect(badRange.status).toBe(400);
  });

  it('supports memory bulk update/delete and link/unlink endpoints', async () => {
    const now = Date.now();
    memoryStore.insertMemory({
      id: 'bulk-mem-1',
      text: 'Bulk memory one',
      type: 'semantic',
      importance: 0.6,
      confidence: 0.8,
      emotionalValence: 0.1,
      salience: 0.6,
      sourceRef: 'api:bulk:1',
      extractedAt: now,
      lastAccessed: now,
      accessCount: 0,
      tags: ['bulk'],
      sensitivity: 'personal',
    }, new Float32Array([0.2, 0.1, 0.3]));
    memoryStore.insertMemory({
      id: 'bulk-mem-2',
      text: 'Bulk memory two',
      type: 'episodic',
      importance: 0.7,
      confidence: 0.75,
      emotionalValence: 0.2,
      salience: 0.65,
      sourceRef: 'api:bulk:2',
      extractedAt: now + 1,
      lastAccessed: now + 1,
      accessCount: 0,
      tags: ['bulk'],
      sensitivity: 'personal',
    }, new Float32Array([0.25, 0.15, 0.35]));
    memoryStore.insertMemory({
      id: 'bulk-mem-3',
      text: 'Bulk memory three',
      type: 'procedural',
      importance: 0.55,
      confidence: 0.72,
      emotionalValence: 0.05,
      salience: 0.52,
      sourceRef: 'api:bulk:3',
      extractedAt: now + 2,
      lastAccessed: now + 2,
      accessCount: 0,
      tags: ['bulk'],
      sensitivity: 'personal',
    }, new Float32Array([0.3, 0.2, 0.4]));

    const linkRes = await request(
      port,
      'POST',
      '/api/admin/memory/link',
      JSON.stringify({ id1: 'bulk-mem-2', id2: 'bulk-mem-1', linkType: 'supports' }),
      authHeaders,
    );
    expect(linkRes.status).toBe(201);
    const linkPayload = JSON.parse(linkRes.body) as {
      ok: boolean;
      link: { id1: string; id2: string; linkType: string };
    };
    expect(linkPayload.ok).toBe(true);
    expect([linkPayload.link.id1, linkPayload.link.id2].sort()).toEqual(['bulk-mem-1', 'bulk-mem-2']);
    expect(linkPayload.link.linkType).toBe('supports');

    const linksRes = await request(port, 'GET', '/api/admin/memory/bulk-mem-1/links', undefined, authHeaders);
    expect(linksRes.status).toBe(200);
    const linksPayload = JSON.parse(linksRes.body) as { links: Array<{ id1: string; id2: string; linkType: string }> };
    expect(linksPayload.links).toHaveLength(1);
    expect(linksPayload.links[0]?.linkType).toBe('supports');

    const bulkUpdateRes = await request(
      port,
      'POST',
      '/api/admin/memory/bulk-update',
      JSON.stringify({
        ids: ['bulk-mem-1', 'bulk-mem-2'],
        fields: { memoryType: 'emotional', sensitivity: 'confidential' },
      }),
      authHeaders,
    );
    expect(bulkUpdateRes.status).toBe(200);
    const bulkUpdatePayload = JSON.parse(bulkUpdateRes.body) as { ok: boolean; count: number };
    expect(bulkUpdatePayload.ok).toBe(true);
    expect(bulkUpdatePayload.count).toBe(2);
    expect(memoryStore.getById('bulk-mem-1')?.type).toBe('emotional');
    expect(memoryStore.getById('bulk-mem-1')?.sensitivity).toBe('confidential');
    expect(memoryStore.getById('bulk-mem-2')?.type).toBe('emotional');
    expect(memoryStore.getById('bulk-mem-2')?.sensitivity).toBe('confidential');

    const unlinkRes = await request(
      port,
      'DELETE',
      '/api/admin/memory/link',
      JSON.stringify({ id1: 'bulk-mem-1', id2: 'bulk-mem-2' }),
      authHeaders,
    );
    expect(unlinkRes.status).toBe(200);

    const linksAfterUnlinkRes = await request(port, 'GET', '/api/admin/memory/bulk-mem-1/links', undefined, authHeaders);
    expect(linksAfterUnlinkRes.status).toBe(200);
    const linksAfterUnlinkPayload = JSON.parse(linksAfterUnlinkRes.body) as { links: Array<{ id1: string; id2: string }> };
    expect(linksAfterUnlinkPayload.links).toHaveLength(0);

    const bulkDeleteRes = await request(
      port,
      'POST',
      '/api/admin/memory/bulk-delete',
      JSON.stringify({ ids: ['bulk-mem-2', 'bulk-mem-3'] }),
      authHeaders,
    );
    expect(bulkDeleteRes.status).toBe(200);
    const bulkDeletePayload = JSON.parse(bulkDeleteRes.body) as { ok: boolean; count: number };
    expect(bulkDeletePayload.ok).toBe(true);
    expect(bulkDeletePayload.count).toBe(2);
    expect(memoryStore.getById('bulk-mem-2')?.deletedAt).toBeDefined();
    expect(memoryStore.getById('bulk-mem-3')?.deletedAt).toBeDefined();
    expect(memoryStore.listActiveMemories({ limit: 10, offset: 0 }).map(memory => memory.id)).not.toContain('bulk-mem-2');
    expect(memoryStore.listActiveMemories({ limit: 10, offset: 0 }).map(memory => memory.id)).not.toContain('bulk-mem-3');
  });

  it('removes legacy memory page and keeps canonical /api/admin memory data', async () => {
    memoryStore.insertMemory({
      id: 'ui-memory-1',
      text: 'UI memory one',
      type: 'semantic',
      importance: 0.55,
      confidence: 0.8,
      emotionalValence: 0.12,
      salience: 0.62,
      sourceRef: 'api:ui:1',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      tags: ['ui'],
      sensitivity: 'personal',
    }, new Float32Array([0.3, 0.1, 0.2]));

    const legacyRes = await request(
      port,
      'GET',
      '/legacy/memory',
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    expect(legacyRes.status).toBe(404);

    const apiRes = await request(
      port,
      'GET',
      '/api/admin/memory',
      undefined,
      { Authorization: `Bearer ${token}` },
    );
    expect(apiRes.status).toBe(200);
    const payload = JSON.parse(apiRes.body) as { memories: Array<{ id: string }> };
    expect(payload.memories.some(memory => memory.id === 'ui-memory-1')).toBe(true);
  });

  it('supports session list and messages endpoints', async () => {
    sessionStore.append({
      channelId: 'api-session',
      role: 'user',
      content: 'hello',
      authorId: 'user-1',
      authorName: 'User',
      timestamp: Date.now(),
      channelVisibility: 'direct',
    });
    sessionStore.append({
      channelId: 'api-session',
      role: 'assistant',
      content: 'world',
      authorId: 'assistant',
      authorName: 'Companion',
      timestamp: Date.now() + 1,
      channelVisibility: 'direct',
    });

    const sessionsRes = await request(port, 'GET', '/api/admin/sessions', undefined, authHeaders);
    expect(sessionsRes.status).toBe(200);
    const sessionsPayload = JSON.parse(sessionsRes.body) as {
      channels: Array<{ channelId: string; lastActivityAt?: number }>;
    };
    const listed = sessionsPayload.channels.find(channel => channel.channelId === 'api-session');
    expect(listed).toBeDefined();
    expect(typeof listed?.lastActivityAt).toBe('number');

    const messagesRes = await request(port, 'GET', '/api/admin/sessions/api-session', undefined, authHeaders);
    expect(messagesRes.status).toBe(200);
    const messagesPayload = JSON.parse(messagesRes.body) as { messages: Array<{ content: string }> };
    expect(messagesPayload.messages.map(message => message.content)).toContain('hello');
    expect(messagesPayload.messages.map(message => message.content)).toContain('world');
  });

  it('supports contact list/detail/update endpoints', async () => {
    const contact = contactStore.upsert({
      displayName: 'Api Contact',
      trustLevel: 'acquainted',
      relationshipType: 'friend',
      notes: 'before',
    });

    const listRes = await request(port, 'GET', '/api/admin/contacts', undefined, authHeaders);
    expect(listRes.status).toBe(200);
    const listPayload = JSON.parse(listRes.body) as { contacts: Array<{ id: string }> };
    expect(listPayload.contacts.some(entry => entry.id === contact.id)).toBe(true);

    const detailRes = await request(port, 'GET', `/api/admin/contacts/${contact.id}`, undefined, authHeaders);
    expect(detailRes.status).toBe(200);
    const detailPayload = JSON.parse(detailRes.body) as { contact: { id: string } };
    expect(detailPayload.contact.id).toBe(contact.id);

    const putRes = await request(
      port,
      'PUT',
      `/api/admin/contacts/${contact.id}`,
      JSON.stringify({ trustLevel: 'trusted', notes: 'after put' }),
      authHeaders,
    );
    expect(putRes.status).toBe(200);
    expect(contactStore.getById(contact.id)?.trustLevel).toBe('trusted');
    expect(contactStore.getById(contact.id)?.notes).toBe('after put');

    const patchRes = await request(
      port,
      'PATCH',
      `/api/admin/contacts/${contact.id}`,
      JSON.stringify({ notes: 'after patch' }),
      authHeaders,
    );
    expect(patchRes.status).toBe(200);
    expect(contactStore.getById(contact.id)?.notes).toBe('after patch');

    const badPatch = await request(
      port,
      'PATCH',
      `/api/admin/contacts/${contact.id}`,
      JSON.stringify({ trustLevel: 'bad-level' }),
      authHeaders,
    );
    expect(badPatch.status).toBe(400);

    const missingDetail = await request(port, 'GET', '/api/admin/contacts/missing-id', undefined, authHeaders);
    expect(missingDetail.status).toBe(404);
  });

  it('supports settings, identity, and prompts endpoints', async () => {
    const settingsRes = await request(port, 'GET', '/api/admin/settings', undefined, authHeaders);
    expect(settingsRes.status).toBe(200);
    const settingsPayload = JSON.parse(settingsRes.body) as {
      config: {
        sessionMessageLimit: number;
        sessionRestartBehavior: string;
        primaryModel?: string;
        maintenanceIntervalMs?: number;
        capabilityTier?: string;
      };
      editors: {
        models: {
          modelCatalog: Record<string, { model?: string }>;
        };
        scheduler: {
          salienceDecayIntervalMs: number;
        };
        capabilities: {
          tier: string;
        };
      };
    };
    expect(settingsPayload.config.sessionMessageLimit).toBe(testConfig.sessionMessageLimit);
    expect(settingsPayload.config.sessionRestartBehavior).toBe('reuse_latest_session');
    expect(settingsPayload.config.primaryModel).toBeUndefined();
    expect(settingsPayload.config.maintenanceIntervalMs).toBeUndefined();
    expect(settingsPayload.config.capabilityTier).toBeUndefined();
    const persistedModels = JSON.parse(readFileSync(join(tempDir, 'models.json'), 'utf8')) as {
      schemaVersion: number;
      models: Array<{ id: string; identity?: { model?: string } }>;
    };
    expect(persistedModels.schemaVersion).toBe(1);
    const persistedPrimaryModel = persistedModels.models.find((entry) => entry.id === 'primary')?.identity?.model;
    expect(typeof persistedPrimaryModel).toBe('string');
    expect(settingsPayload.editors.models.modelCatalog.primary.model).toBe(persistedPrimaryModel);
    expect(settingsPayload.editors.scheduler.salienceDecayIntervalMs).toBe(testConfig.maintenanceIntervalMs);
    expect(settingsPayload.editors.capabilities.tier).toBe(testConfig.capabilityTier);

    const settingsPatchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({ sessionMessageLimit: 55, sessionRestartBehavior: 'new_session' }),
      authHeaders,
    );
    expect(settingsPatchRes.status).toBe(200);
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);
    const settingsAfterPatchRes = await request(port, 'GET', '/api/admin/settings', undefined, authHeaders);
    expect(settingsAfterPatchRes.status).toBe(200);
    const settingsAfterPatch = JSON.parse(settingsAfterPatchRes.body) as {
      config: {
        sessionMessageLimit: number;
        sessionRestartBehavior: string;
        primaryModel?: string;
      };
    };
    expect(settingsAfterPatch.config.sessionMessageLimit).toBe(55);
    expect(settingsAfterPatch.config.sessionRestartBehavior).toBe('new_session');
    expect(settingsAfterPatch.config.primaryModel).toBeUndefined();

    const ownerPatchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({
        primaryModel: 'z-ai/glm-5',
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
          },
        },
        maintenanceIntervalMs: 240000,
        capabilityTier: 'custom',
        customTokens: ['identity.read', 'git.read'],
      }),
      authHeaders,
    );
    expect(ownerPatchRes.status).toBe(400);
    const ownerPatchPayload = JSON.parse(ownerPatchRes.body) as {
      ok: boolean;
      message: string;
      validationErrors?: Array<{ field: string; message: string; code?: string }>;
    };
    expect(ownerPatchPayload.ok).toBe(false);
    expect(ownerPatchPayload.message).toContain('primaryModel is owned by models.json');
    expect(ownerPatchPayload.message).toContain('maintenanceIntervalMs is owned by scheduler.json');
    expect(ownerPatchPayload.message).toContain('capabilityTier is owned by capability-tier.json');
    expect(ownerPatchPayload.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'primaryModel',
        message: 'primaryModel is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'modelCatalog',
        message: 'modelCatalog is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'maintenanceIntervalMs',
        message: 'maintenanceIntervalMs is owned by scheduler.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'capabilityTier',
        message: 'capabilityTier is owned by capability-tier.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'customTokens',
        message: 'customTokens is owned by capability-tier.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
    ]));
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);
    expect(loadSettings(tempDir).sessionMessageLimit).toBe(55);

    const identityRes = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(identityRes.status).toBe(200);
    const identityPayload = JSON.parse(identityRes.body) as { card: { data: { name: string } } };
    expect(identityPayload.card.data.name).toBe('ApiTestBot');

    const appearancePatchRes = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({ field: 'extensions.visual_description', value: 'golden eyes and ivy hair' }),
      authHeaders,
    );
    expect(appearancePatchRes.status).toBe(200);

    const greetingsPatchRes = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({
        field: 'alternate_greetings',
        value: JSON.stringify(['hello v', 'hi in moonlight']),
      }),
      authHeaders,
    );
    expect(greetingsPatchRes.status).toBe(200);

    const identityAfterPatchRes = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(identityAfterPatchRes.status).toBe(200);
    const identityAfterPatch = JSON.parse(identityAfterPatchRes.body) as {
      card: {
        data: {
          extensions?: Record<string, unknown>;
          alternate_greetings?: string[];
        };
      };
    };
    expect(identityAfterPatch.card.data.extensions?.visual_description).toBe('golden eyes and ivy hair');
    expect(identityAfterPatch.card.data.alternate_greetings).toEqual(['hello v', 'hi in moonlight']);

    const identityImportRes = await request(
      port,
      'POST',
      '/api/admin/identity/import',
      JSON.stringify({ path: join(tempDir, 'missing-card.json') }),
      authHeaders,
    );
    expect(identityImportRes.status).toBe(400);

    const promptsRes = await request(port, 'GET', '/api/admin/prompts', undefined, authHeaders);
    expect(promptsRes.status).toBe(200);
    const promptsPayload = JSON.parse(promptsRes.body) as { layers: Array<{ id: string }> };
    expect(promptsPayload.layers.length).toBeGreaterThan(0);

    const foundationLayerId = promptsPayload.layers[0].id;
    const foundationPatchRes = await request(
      port,
      'PATCH',
      `/api/admin/prompts/${foundationLayerId}`,
      JSON.stringify({ content: 'Updated API prompt content' }),
      authHeaders,
    );
    expect(foundationPatchRes.status).toBe(400);
    expect(JSON.parse(foundationPatchRes.body)).toEqual({
      error: 'Character Foundation is derived from the character card and must be edited through Identity.',
    });

    const editableLayer = promptStore.create({
      type: 'runtime',
      name: 'API Editable Runtime Layer',
      content: 'Original API prompt content',
    });
    const layerId = editableLayer.id;
    const promptDetailRes = await request(port, 'GET', `/api/admin/prompts/${layerId}`, undefined, authHeaders);
    expect(promptDetailRes.status).toBe(200);

    const promptPatchRes = await request(
      port,
      'PATCH',
      `/api/admin/prompts/${layerId}`,
      JSON.stringify({ content: 'Updated API prompt content' }),
      authHeaders,
    );
    expect(promptPatchRes.status).toBe(200);
    expect(promptStore.getById(layerId)?.content).toContain('Updated API prompt content');

    const promptDiffRes = await request(
      port,
      'GET',
      `/api/admin/prompts/${layerId}/diff`,
      undefined,
      authHeaders,
    );
    expect(promptDiffRes.status).toBe(200);
    const promptDiffPayload = JSON.parse(promptDiffRes.body) as { oldContent: string; newContent: string };
    expect(promptDiffPayload.oldContent.length).toBeGreaterThan(0);
    expect(promptDiffPayload.oldContent).not.toContain('Updated API prompt content');
    expect(promptDiffPayload.newContent).toContain('Updated API prompt content');

    const priorityOnlyPatchRes = await request(
      port,
      'PATCH',
      `/api/admin/prompts/${layerId}`,
      JSON.stringify({ priority: 7 }),
      authHeaders,
    );
    expect(priorityOnlyPatchRes.status).toBe(200);
    expect(promptStore.getById(layerId)?.priority).toBe(7);
    expect(promptStore.getById(layerId)?.content).toContain('Updated API prompt content');

    const postPriorityDiffRes = await request(
      port,
      'GET',
      `/api/admin/prompts/${layerId}/diff`,
      undefined,
      authHeaders,
    );
    expect(postPriorityDiffRes.status).toBe(200);
    const postPriorityDiffPayload = JSON.parse(postPriorityDiffRes.body) as { oldContent: string; newContent: string };
    expect(postPriorityDiffPayload.oldContent).toContain('Updated API prompt content');
    expect(postPriorityDiffPayload.newContent).toContain('Updated API prompt content');

    const createPromptA = await request(
      port,
      'POST',
      '/api/admin/prompts',
      JSON.stringify({ name: 'Runtime Layer A', type: 'runtime', content: 'runtime-a', priority: 25 }),
      authHeaders,
    );
    expect(createPromptA.status).toBe(201);

    const createPromptB = await request(
      port,
      'POST',
      '/api/admin/prompts',
      JSON.stringify({ name: 'Runtime Layer B', type: 'runtime', content: 'runtime-b', priority: 26 }),
      authHeaders,
    );
    expect(createPromptB.status).toBe(201);

    const promptsBeforeReorderRes = await request(port, 'GET', '/api/admin/prompts', undefined, authHeaders);
    expect(promptsBeforeReorderRes.status).toBe(200);
    const promptsBeforeReorderPayload = JSON.parse(promptsBeforeReorderRes.body) as { layers: Array<{ id: string }> };
    const reorderedLayerIds = promptsBeforeReorderPayload.layers.map(layer => layer.id);
    const [movedLayerId] = reorderedLayerIds.splice(reorderedLayerIds.length - 1, 1);
    if (movedLayerId) reorderedLayerIds.unshift(movedLayerId);

    const reorderRes = await request(
      port,
      'POST',
      '/api/admin/prompts/reorder',
      JSON.stringify({ layerIds: reorderedLayerIds }),
      authHeaders,
    );
    expect(reorderRes.status).toBe(200);

    for (const [index, reorderedLayerId] of reorderedLayerIds.entries()) {
      expect(promptStore.getById(reorderedLayerId)?.priority).toBe(index);
    }
    expect(promptStore.getById(layerId)?.content).toContain('Updated API prompt content');

    const missingPrompt = await request(port, 'GET', '/api/admin/prompts/missing-layer', undefined, authHeaders);
    expect(missingPrompt.status).toBe(404);
  });

  it('supports constitution snapshot and mutable-layer round-trip with immutable fail-closed edits', async () => {
    const runtimeA = promptStore.create({
      type: 'runtime',
      name: 'Constitution Runtime A',
      content: 'constitution-runtime-a',
      updatedBy: 'admin',
    });
    const runtimeB = promptStore.create({
      type: 'runtime',
      name: 'Constitution Runtime B',
      content: 'constitution-runtime-b',
      updatedBy: 'admin',
    });

    const snapshotRes = await request(port, 'GET', '/api/admin/prompts/constitution', undefined, authHeaders);
    expect(snapshotRes.status).toBe(200);
    const snapshotPayload = JSON.parse(snapshotRes.body) as {
      immutableBlocks: Array<{ id: string; editable: boolean }>;
      mutableLayers: Array<{
        id: string;
        content: string;
        enabled: boolean;
        identifier?: string;
        role?: string;
        promptOrder?: number;
      }>;
      preview: { text: string };
    };
    expect(snapshotPayload.immutableBlocks).toHaveLength(3);
    expect(snapshotPayload.immutableBlocks.every(block => block.editable === false)).toBe(true);
    expect(snapshotPayload.preview.text).toContain('[Immutable Human-Safety Amendments]');

    const mutableLayers = snapshotPayload.mutableLayers.map(layer => ({
      id: layer.id,
      content: layer.content,
      enabled: layer.enabled,
      identifier: layer.identifier ?? null,
      role: layer.role ?? null,
      promptOrder: layer.promptOrder ?? null,
    }));
    const aIndex = mutableLayers.findIndex(layer => layer.id === runtimeA.id);
    const bIndex = mutableLayers.findIndex(layer => layer.id === runtimeB.id);
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThanOrEqual(0);
    if (aIndex >= 0 && bIndex >= 0) {
      const [moved] = mutableLayers.splice(bIndex, 1);
      mutableLayers.splice(aIndex, 0, moved);
      const runtimeBPayload = mutableLayers.find(layer => layer.id === runtimeB.id);
      if (runtimeBPayload) runtimeBPayload.content = 'constitution-runtime-b-updated';
    }

    const saveRes = await request(
      port,
      'PUT',
      '/api/admin/prompts/constitution',
      JSON.stringify({ mutableLayers }),
      authHeaders,
    );
    expect(saveRes.status).toBe(200);
    const savePayload = JSON.parse(saveRes.body) as {
      ok: boolean;
      snapshot?: { preview: { text: string } };
    };
    expect(savePayload.ok).toBe(true);
    expect(promptStore.getById(runtimeB.id)?.content).toBe('constitution-runtime-b-updated');
    expect(savePayload.snapshot?.preview.text).toContain('constitution-runtime-b-updated');
    for (const [index, layer] of mutableLayers.entries()) {
      expect(promptStore.getById(layer.id)?.priority).toBe(index);
    }

    const immutableAttemptPayload = mutableLayers.map((layer, index) => (
      index === 0
        ? { ...layer, id: 'constitution:immutable:1', content: 'forbidden immutable edit' }
        : layer
    ));
    const immutableAttemptRes = await request(
      port,
      'PUT',
      '/api/admin/prompts/constitution',
      JSON.stringify({ mutableLayers: immutableAttemptPayload }),
      authHeaders,
    );
    expect(immutableAttemptRes.status).toBe(400);
    expect(JSON.parse(immutableAttemptRes.body)).toEqual({
      error: 'Immutable constitution layers are read-only and cannot be edited',
    });
  });

  it('supports onboarding setup actions for keep starter and identity edits', async () => {
    const current = cardVersionStore.getCurrent().card;
    cardVersionStore.update({
      ...current,
      data: {
        ...current.data,
        creator: 'system',
        tags: ['bootstrap'],
        name: 'Companion',
        personality: 'Starter personality',
      },
    }, 'test:seed', 'Seed onboarding starter state');

    const keepStarterRes = await request(
      port,
      'POST',
      '/api/admin/identity/onboarding',
      JSON.stringify({ action: 'keep_starter' }),
      authHeaders,
    );
    expect(keepStarterRes.status).toBe(200);
    const keepStarterPayload = JSON.parse(keepStarterRes.body) as {
      ok: boolean;
      action?: string;
      onboardingRequired: boolean;
    };
    expect(keepStarterPayload.ok).toBe(true);
    expect(keepStarterPayload.action).toBe('keep_starter');
    expect(keepStarterPayload.onboardingRequired).toBe(false);
    const afterKeepStarter = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(afterKeepStarter.status).toBe(200);
    expect((JSON.parse(afterKeepStarter.body) as { card: { data: { tags?: string[] } } }).card.data.tags ?? [])
      .not.toContain('bootstrap');

    const reset = cardVersionStore.getCurrent().card;
    cardVersionStore.update({
      ...reset,
      data: {
        ...reset.data,
        creator: 'system',
        tags: ['bootstrap'],
        name: 'Companion',
        personality: 'Starter personality',
      },
    }, 'test:seed', 'Reset onboarding starter state');

    const editRes = await request(
      port,
      'POST',
      '/api/admin/identity/onboarding',
      JSON.stringify({
        action: 'edit_identity',
        fields: {
          name: 'Canopy Guide',
          personality: 'Grounded and practical.',
          description: 'Garden onboarding identity',
        },
      }),
      authHeaders,
    );
    expect(editRes.status).toBe(200);
    const editPayload = JSON.parse(editRes.body) as {
      ok: boolean;
      action?: string;
      onboardingRequired: boolean;
      updatedFields?: string[];
    };
    expect(editPayload.ok).toBe(true);
    expect(editPayload.action).toBe('edit_identity');
    expect(editPayload.onboardingRequired).toBe(false);
    expect(editPayload.updatedFields).toEqual(expect.arrayContaining(['name', 'personality', 'description']));
    const identityAfterEditRes = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(identityAfterEditRes.status).toBe(200);
    const identityAfterEdit = JSON.parse(identityAfterEditRes.body) as {
      card: {
        data: {
          name: string;
          personality: string;
          description: string;
          tags?: string[];
        };
      };
    };
    expect(identityAfterEdit.card.data.name).toBe('Canopy Guide');
    expect(identityAfterEdit.card.data.personality).toBe('Grounded and practical.');
    expect(identityAfterEdit.card.data.description).toBe('Garden onboarding identity');
    expect(identityAfterEdit.card.data.tags ?? []).not.toContain('bootstrap');
  });

  it('fails closed on invalid onboarding setup payloads', async () => {
    const current = cardVersionStore.getCurrent().card;
    cardVersionStore.update({
      ...current,
      data: {
        ...current.data,
        creator: 'system',
        tags: ['bootstrap'],
      },
    }, 'test:seed', 'Seed onboarding starter state for validation test');

    const invalidFieldRes = await request(
      port,
      'POST',
      '/api/admin/identity/onboarding',
      JSON.stringify({
        action: 'edit_identity',
        fields: {
          tags: 'bootstrap',
        },
      }),
      authHeaders,
    );
    expect(invalidFieldRes.status).toBe(400);
    const invalidFieldPayload = JSON.parse(invalidFieldRes.body) as { error: string; onboardingRequired?: boolean };
    expect(invalidFieldPayload.error).toContain('Unsupported onboarding identity field');
    expect(invalidFieldPayload.onboardingRequired).toBe(true);

    const extraFieldRes = await request(
      port,
      'POST',
      '/api/admin/identity/onboarding',
      JSON.stringify({
        action: 'keep_starter',
        reason: 'extra-key-not-allowed',
      }),
      authHeaders,
    );
    expect(extraFieldRes.status).toBe(400);
    const extraFieldPayload = JSON.parse(extraFieldRes.body) as { error: string };
    expect(extraFieldPayload.error).toContain('keep_starter does not accept additional fields');
  });

  it('round-trips runtime settings PATCH/GET without drifting subsystem-owned editors', async () => {
    const beforeRes = await request(port, 'GET', '/api/admin/settings', undefined, authHeaders);
    expect(beforeRes.status).toBe(200);
    const beforePayload = JSON.parse(beforeRes.body) as {
      config: Record<string, unknown>;
      editors: Record<string, unknown>;
    };

    const patch = {
      sessionHistoryBudgetPct: 9,
      memoryRetrievalBudgetPct: 4,
      sessionMessageLimit: 44,
      sessionRestartBehavior: 'new_session',
      memoryRetrievalLimit: 12,
      extractionInterval: 6,
      defaultContextWindow: 196000,
      memoryBudgetPct: 24,
      extractionThresholdPct: 34,
      compactionThresholdPct: 76,
      compactionEmotionalSalienceThresholdPct: 83,
      retryMaxAttempts: 4,
      retryBaseDelayMs: 2500,
      openRouterProviderOrder: ['parasail', 'openai'],
      importProcessingRouteMode: 'local_endpoint',
      importProcessingStrictPolicy: true,
      importProcessingLocalEndpointUrl: 'http://127.0.0.1:4000/v1',
      importProcessingLocalModel: 'llama.cpp/local',
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api', 'discord'],
        allowedPurposes: ['retrieval', 'think'],
      },
      webFetchAllowHttp: true,
      webFetchDomainAllowlist: ['example.com', 'internal.local'],
      webFetchAllowInternalNetwork: true,
      webFetchTlsCaCertPaths: ['/tmp/root-ca.pem'],
      ttsProvider: 'echo',
      voiceId: 'voice-123',
      echoTtsUrl: 'http://127.0.0.1:8001/v1/audio/speech',
      echoTtsVoice: 'allison',
      echoTtsPreset: 'wide',
      sttProvider: 'deepgram',
      deepgramModel: 'nova-3',
      discordEnabled: true,
      discordHeartbeatChannel: '1234567890',
      discordTriggerWords: 'pixie, hello companion',
      discordTriggerReactions: '👆, 🔥',
      discordTriggerListenWindowMs: 180000,
      telegramEnabled: true,
      telegramAuthorizedUsers: '123, 456',
      obsidianVaultName: 'companion',
      obsidianCliPath: '/usr/local/bin/obsidian',
      obsidianAutoPublish: true,
      obsidianTimeoutMs: 12000,
      moaEnabled: true,
      moaReferenceModels: ['openai/gpt-4.1-mini', 'moonshotai/kimi-k2.5'],
      moaAggregatorModel: 'openai/gpt-4.1-mini',
      moaMaxRounds: 3,
      moaMaxTokensPerRound: 2048,
      moaTimeoutMs: 30000,
    };

    const patchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify(patch),
      authHeaders,
    );
    expect(patchRes.status).toBe(200);

    const afterRes = await request(port, 'GET', '/api/admin/settings', undefined, authHeaders);
    expect(afterRes.status).toBe(200);
    const afterPayload = JSON.parse(afterRes.body) as {
      config: Record<string, unknown>;
      editors: Record<string, unknown>;
    };

    expect(afterPayload.config).toEqual(expect.objectContaining(patch));
    expect(afterPayload.config.primaryModel).toBeUndefined();
    expect(afterPayload.config.maintenanceIntervalMs).toBeUndefined();
    expect(afterPayload.config.capabilityTier).toBeUndefined();
    expect(afterPayload.editors).toEqual(beforePayload.editors);

    const persistedSettings = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(persistedSettings).toEqual(expect.objectContaining(patch));
    expect(persistedSettings.primaryModel).toBeUndefined();
    expect(persistedSettings.maintenanceIntervalMs).toBeUndefined();
    expect(persistedSettings.capabilityTier).toBeUndefined();
  });

  it('keeps /api/admin/settings PATCH reachable through the canonical JSON handler', async () => {
    const malformedPatch = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      '{',
      authHeaders,
    );

    expect(malformedPatch.status).toBe(400);
    expect(JSON.parse(malformedPatch.body)).toEqual({
      error: 'Invalid JSON payload',
    });
  });

  it('returns field-level validation details for invalid settings payloads', async () => {
    const res = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({
        sessionMessageLimit: 0,
        importProcessingRouteMode: 'local_endpoint',
        importProcessingLocalEndpointUrl: '',
        importProcessingLocalModel: '',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: [],
          allowedChannelTypes: [],
          allowedPurposes: [],
        },
      }),
      authHeaders,
    );

    expect(res.status).toBe(400);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      message: string;
      validationErrors?: Array<{ field: string; message: string; code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain('sessionMessageLimit must be 5-200');
      expect(payload.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'sessionMessageLimit',
        message: 'sessionMessageLimit must be 5-200',
      }),
      expect.objectContaining({
        field: 'importProcessingLocalEndpointUrl',
        message: 'importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint',
      }),
      expect.objectContaining({
        field: 'importProcessingLocalModel',
        message: 'importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint',
      }),
      expect.objectContaining({
        field: 'compositionalPolicy.allowedTiers',
        message: 'compositionalPolicy.allowedTiers must list at least one value when compositionalPolicy.enabled=true',
      }),
      expect.objectContaining({
        field: 'compositionalPolicy.allowedChannelTypes',
        message: 'compositionalPolicy.allowedChannelTypes must list at least one value when compositionalPolicy.enabled=true',
      }),
      expect.objectContaining({
        field: 'compositionalPolicy.allowedPurposes',
        message: 'compositionalPolicy.allowedPurposes must list at least one value when compositionalPolicy.enabled=true',
      }),
    ]));
  });

  it('rejects model-owned settings fields on the generic admin settings route', async () => {
    const res = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            routing: {
              providerOrder: 'parasail',
            },
          },
        },
      }),
      authHeaders,
    );

    expect(res.status).toBe(400);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      message: string;
      validationErrors?: Array<{ field: string; message: string; code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.message).toContain('modelCatalog is owned by models.json');
    expect(payload.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'modelCatalog',
        message: 'modelCatalog is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
    ]));
  });

  it('returns schema metadata for subsystem ownership and schema-driven settings editors', async () => {
    const restoreSttProvider = registerStreamingSttProvider('schema-plugin-stt', {
      createConnector: vi.fn(() => {
        throw new Error('not used in schema metadata');
      }),
      metadata: {
        isConfigured: () => false,
      },
    });
    const restoreTtsProvider = registerStreamingTtsProvider('schema-plugin-tts', {
      createConnector: vi.fn(() => {
        throw new Error('not used in schema metadata');
      }),
      metadata: {
        isConfigured: () => false,
      },
    });

    try {
      const res = await request(
        port,
        'GET',
        '/api/admin/settings/schema',
        undefined,
        authHeaders,
      );

      expect(res.status).toBe(200);
      const schemaRoot = getSchemaRoot(JSON.parse(res.body));

      const runtimeSubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'runtime');
      const modelsSubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'models');
      const schedulerSubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'scheduler');
      const capabilitiesSubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'capabilities');
      const skillsSubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'skills');
      const trustPolicySubsystem = getNamedSchemaEntry(schemaRoot, ['subsystems', 'subsystemSchemas'], 'trustPolicy');

      expect(readOwnerFiles(runtimeSubsystem)).toContain('settings.json');
      expect(readOwnerFiles(modelsSubsystem)).toContain('models.json');
      expect(readOwnerFiles(schedulerSubsystem)).toContain('scheduler.json');
      expect(readOwnerFiles(capabilitiesSubsystem)).toContain('capability-tier.json');
      expect(isRawOnlySchemaSubsystem(skillsSubsystem)).toBe(true);
      expect(isRawOnlySchemaSubsystem(trustPolicySubsystem)).toBe(true);

      const sessionMessageLimitField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'sessionMessageLimit');
      const primaryModelField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'primaryModel');
      const modelCatalogField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'modelCatalog');
      const modelRoleAssignmentsField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'modelRoleAssignments');
      const modelRosterField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'modelRoster');
      const maintenanceIntervalMsField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'maintenanceIntervalMs');
      const capabilityTierField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'capabilityTier');
      const compositionalPolicyField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'compositionalPolicy');
      const sttProviderField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'sttProvider');
      const ttsProviderField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'ttsProvider');
      const textEmotionModelField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'textEmotionModel');
      const textEmotionCacheDirField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'textEmotionCacheDir');
      const textEmotionDtypeField = getNamedSchemaEntry(schemaRoot, ['fields', 'fieldSchemas'], 'textEmotionDtype');

      expect(['number', 'integer']).toContain(
        readStringMetadata(sessionMessageLimitField, ['type', 'kind', 'valueType', 'inputType']),
      );
      expect(readNumberMetadata(sessionMessageLimitField, ['min', 'minimum'])).toBe(5);
      expect(readNumberMetadata(sessionMessageLimitField, ['max', 'maximum'])).toBe(200);

      expect(readOwnerFiles(primaryModelField)).toContain('models.json');
      expect(readOwnerFiles(modelCatalogField)).toContain('models.json');
      expect(readOwnerFiles(modelRoleAssignmentsField)).toContain('models.json');
      expect(readOwnerFiles(modelRosterField)).toContain('models.json');
      expect(readStringMetadata(modelCatalogField, ['type', 'kind', 'valueType', 'inputType'])).toBe('object');
      expect(readStringMetadata(modelRoleAssignmentsField, ['type', 'kind', 'valueType', 'inputType'])).toBe('object');
      expect(readStringMetadata(modelRosterField, ['type', 'kind', 'valueType', 'inputType'])).toBe('object');
      expect(readOwnerFiles(maintenanceIntervalMsField)).toContain('scheduler.json');
      expect(readOwnerFiles(capabilityTierField)).toContain('capability-tier.json');
      expect(readOwnerFiles(compositionalPolicyField)).toContain('settings.json');
      expect(readStringMetadata(compositionalPolicyField, ['type', 'kind', 'valueType', 'inputType'])).toBe('object');
      expect(readOwnerFiles(textEmotionModelField)).toContain('settings.json');
      expect(readOwnerFiles(textEmotionCacheDirField)).toContain('settings.json');
      expect(readOwnerFiles(textEmotionDtypeField)).toContain('settings.json');
      expect(readStringMetadata(textEmotionModelField, ['type', 'kind', 'valueType', 'inputType'])).toBe('string');
      expect(readStringMetadata(textEmotionCacheDirField, ['type', 'kind', 'valueType', 'inputType'])).toBe('string');
      expect(readStringMetadata(textEmotionDtypeField, ['type', 'kind', 'valueType', 'inputType'])).toBe('enum');
      expect(readEnumLikeValues(textEmotionDtypeField)).toEqual(expect.arrayContaining([
        'auto',
        'fp32',
        'q8',
      ]));

      expect(readEnumLikeValues(sttProviderField)).toEqual(expect.arrayContaining([
        'disabled',
        'deepgram',
        'schema-plugin-stt',
      ]));
      expect(readEnumLikeValues(ttsProviderField)).toEqual(expect.arrayContaining([
        'disabled',
        'echo',
        'elevenlabs',
        'schema-plugin-tts',
      ]));
    } finally {
      restoreSttProvider();
      restoreTtsProvider();
    }
  });

  it('round-trips runtime settings and subsystem owner files through the canonical admin settings payload', async () => {
    const runtimePatch = {
      sessionMessageLimit: 44,
      sessionRestartBehavior: 'new_session',
      openRouterProviderOrder: ['parasail', 'openai'],
      compositionalPolicy: {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['retrieval'],
      },
      webFetchDomainAllowlist: ['example.com', 'internal.local'],
      promotedExtendedTools: ['memory.search', 'contacts.lookup'],
      chatApiBaseUrl: 'https://admin.example.test/api',
      uiThemeId: 'generic-light',
      ttsProvider: 'disabled',
      sttProvider: 'disabled',
      textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
      textEmotionCacheDir: '/tmp/admin-text-emotion-cache',
      textEmotionDtype: 'q8',
      moaEnabled: true,
      moaReferenceModels: ['openai/gpt-4.1-mini', 'moonshotai/kimi-k2.5'],
      moaAggregatorModel: 'openai/gpt-4.1-mini',
      moaMaxRounds: 3,
      moaMaxTokensPerRound: 2048,
      moaTimeoutMs: 30000,
    } as const;

    const runtimePatchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify(runtimePatch),
      authHeaders,
    );
    expect(runtimePatchRes.status).toBe(200);

    const expectedModels = saveModelsConfig(tempDir, {
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
        },
      ],
    }, {
      defaultContextWindow: testConfig.defaultContextWindow,
    });
    const expectedScheduler = saveSchedulerConfig(tempDir, {
      tickIntervalMs: 1500,
      heartbeatIntervalMs: 9000,
      salienceDecayIntervalMs: 12000,
    });
    const expectedSkills = saveSkillsConfig(tempDir, {
      enabled: true,
      directories: ['skills'],
      extraDirectories: ['history/skills'],
      maxLoadedSkills: 16,
      maxSkillChars: 12000,
      disabledSkills: ['git-ops'],
    });
    const expectedTrustPolicy = saveTrustPolicyConfig(tempDir, {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        semi_private: ['public', 'personal'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'public',
        visibilityOverrides: {
          exact: {
            'custom:exact-room': 'broadcast',
          },
          prefix: {
            'custom:': 'private',
          },
        },
      },
    });
    const expectedCapabilities = saveCapabilityTierConfig(tempDir, {
      tier: 'custom',
      customTokens: ['identity.read', 'git.read'],
    });

    const res = await request(
      port,
      'GET',
      '/api/admin/settings',
      undefined,
      authHeaders,
    );

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as {
      config: Record<string, unknown>;
      editors: {
        models: unknown;
        scheduler: unknown;
        skills: unknown;
        trustPolicy: unknown;
        capabilities: unknown;
      };
    };

    expect(payload.config).toEqual(expect.objectContaining(runtimePatch));
    expect(payload.editors.models).toEqual(expectedModels);
    expect(payload.editors.scheduler).toEqual(expectedScheduler);
    expect(payload.editors.skills).toEqual(expectedSkills);
    expect(payload.editors.trustPolicy).toEqual(expectedTrustPolicy);
    expect(payload.editors.capabilities).toEqual(expectedCapabilities);
    expect(loadSettings(tempDir)).toEqual(expect.objectContaining(runtimePatch));
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);
  });

  it('round-trips model-control runtime fields via /api/admin/settings with persistence and reload coverage', async () => {
    const beforeModels = loadModelsConfig(tempDir, {
      defaultContextWindow: testConfig.defaultContextWindow,
    });
    const beforeModelsFile = readFileSync(join(tempDir, 'models.json'), 'utf8');
    const runtimeModelControls = {
      thinkMaxTokens: 64000,
      thinkMaxWallTimeMs: 120000,
      thinkMaxSubQueries: 8,
      openRouterProviderOrder: ['parasail', 'openai'],
      uiThemeId: 'generic-dark',
    };

    const patchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify(runtimeModelControls),
      authHeaders,
    );
    expect(patchRes.status).toBe(200);
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);

    const getRes = await request(port, 'GET', '/api/admin/settings', undefined, authHeaders);
    expect(getRes.status).toBe(200);
    const payload = JSON.parse(getRes.body) as {
      config: Record<string, unknown>;
      editors: {
        models: ReturnType<typeof loadModelsConfig>;
      };
    };
    expect(payload.config).toEqual(expect.objectContaining(runtimeModelControls));
    expect(payload.config.primaryModel).toBeUndefined();

    const reloadedModels = loadModelsConfig(tempDir, {
      defaultContextWindow: testConfig.defaultContextWindow,
    });
    expect(payload.editors.models).toEqual(beforeModels);
    expect(reloadedModels).toEqual(beforeModels);
    expect(readFileSync(join(tempDir, 'models.json'), 'utf8')).toBe(beforeModelsFile);

    const persistedSettings = loadSettings(tempDir);
    expect(persistedSettings).toEqual(expect.objectContaining(runtimeModelControls));
  });

  it('returns field-level validation errors for malformed and out-of-range model-control payloads', async () => {
    const modelsBefore = loadModelsConfig(tempDir, {
      defaultContextWindow: testConfig.defaultContextWindow,
    });
    const settingsBefore = loadSettings(tempDir);

    const res = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({
        thinkMaxTokens: 999,
        thinkMaxWallTimeMs: 1000,
        thinkMaxSubQueries: 0,
        modelCatalog: {
          primary: {
            routing: {
              providerOrder: ['openrouter', 99],
            },
          },
        },
      }),
      authHeaders,
    );

    expect(res.status).toBe(400);
    const payload = JSON.parse(res.body) as {
      ok: boolean;
      message: string;
      validationErrors?: Array<{ field: string; message: string; code?: string }>;
    };
    expect(payload.ok).toBe(false);
    expect(payload.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'thinkMaxTokens',
        message: 'thinkMaxTokens must be 1000-1000000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxWallTimeMs',
        message: 'thinkMaxWallTimeMs must be 5000-600000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxSubQueries',
        message: 'thinkMaxSubQueries must be 1-100',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'modelCatalog',
        message: 'modelCatalog is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'modelCatalog.primary.routing.providerOrder',
        message: 'modelCatalog.primary.routing.providerOrder must be an array of strings',
        code: 'invalid_type',
      }),
    ]));
    expect(payload.message).toContain('modelCatalog is owned by models.json');

    const modelsAfter = loadModelsConfig(tempDir, {
      defaultContextWindow: testConfig.defaultContextWindow,
    });
    expect(modelsAfter).toEqual(modelsBefore);
    expect(loadSettings(tempDir).thinkMaxTokens).toBe(settingsBefore.thinkMaxTokens);
    expect(loadSettings(tempDir).thinkMaxWallTimeMs).toBe(settingsBefore.thinkMaxWallTimeMs);
    expect(loadSettings(tempDir).thinkMaxSubQueries).toBe(settingsBefore.thinkMaxSubQueries);
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);
  });

  it('accepts registered STT provider ids through admin settings patch', async () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => {
        throw new Error('not used in admin settings validation');
      }),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
    });

    try {
      const res = await request(
        port,
        'PATCH',
        '/api/admin/settings',
        JSON.stringify({
          sttProvider: 'plugin-test',
        }),
        authHeaders,
      );

      expect(res.status).toBe(200);
      expect(loadSettings(tempDir).sttProvider).toBe('plugin-test');
      expect((testConfig as SubstrateConfig & { sttProvider?: string }).sttProvider).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });

  it('lists registered STT/TTS provider ids in admin settings payload for registry-backed Garden suggestions', async () => {
    const restoreSttProvider = registerStreamingSttProvider('plugin-stt', {
      createConnector: vi.fn(() => {
        throw new Error('not used in admin settings payload');
      }),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
    });
    const restoreTtsProvider = registerStreamingTtsProvider('plugin-tts', {
      createConnector: vi.fn(() => {
        throw new Error('not used in admin settings payload');
      }),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
    });

    try {
      (testConfig as SubstrateConfig & { pluginSttToken?: string; pluginTtsToken?: string }).pluginSttToken = 'stt-token';
      (testConfig as SubstrateConfig & { pluginSttToken?: string; pluginTtsToken?: string }).pluginTtsToken = 'tts-token';

      const res = await request(
        port,
        'GET',
        '/api/admin/settings',
        undefined,
        authHeaders,
      );

      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body) as {
        voiceProviders?: {
          stt?: Array<{ id: string; configured: boolean; requiredTokens: string[] }>;
          tts?: Array<{ id: string; configured: boolean; requiredTokens: string[] }>;
        };
      };
      expect(payload.voiceProviders?.stt).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-stt',
          configured: true,
          requiredTokens: ['external.web'],
        }),
      ]));
      expect(payload.voiceProviders?.tts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'plugin-tts',
          configured: true,
          requiredTokens: ['external.web'],
        }),
      ]));
    } finally {
      delete (testConfig as SubstrateConfig & { pluginSttToken?: string; pluginTtsToken?: string }).pluginSttToken;
      delete (testConfig as SubstrateConfig & { pluginSttToken?: string; pluginTtsToken?: string }).pluginTtsToken;
      restoreSttProvider();
      restoreTtsProvider();
    }
  });

  it('accepts registered TTS provider ids through admin settings patch', async () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => {
        throw new Error('not used in admin settings validation');
      }),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
    });

    try {
      const res = await request(
        port,
        'PATCH',
        '/api/admin/settings',
        JSON.stringify({
          ttsProvider: 'plugin-test',
        }),
        authHeaders,
      );

      expect(res.status).toBe(200);
      expect(loadSettings(tempDir).ttsProvider).toBe('plugin-test');
      expect((testConfig as SubstrateConfig & { ttsProvider?: string }).ttsProvider).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });

  it('imports uploaded identity cards authoritatively and refreshes Character Foundation prompt', async () => {
    const setAppearance = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({ field: 'extensions.visual_description', value: 'old visual description' }),
      authHeaders,
    );
    expect(setAppearance.status).toBe(200);

    const setGreetings = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({ field: 'alternate_greetings', value: JSON.stringify(['old greeting']) }),
      authHeaders,
    );
    expect(setGreetings.status).toBe(200);

    const setCreatorNotes = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({ field: 'creator_notes', value: 'legacy notes to clear' }),
      authHeaders,
    );
    expect(setCreatorNotes.status).toBe(200);

    const uploadedCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Imported Identity',
        description: 'Fresh description',
        personality: 'New personality baseline',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['imported'],
        creator: 'importer',
      },
    };

    const boundary = '----ApiIdentityUploadBoundary';
    const multipartBody = buildMultipartBody(boundary, [
      {
        name: 'file',
        filename: 'imported-card.json',
        contentType: 'application/json',
        content: JSON.stringify(uploadedCard),
      },
    ]);

    const uploadRes = await request(
      port,
      'POST',
      '/api/admin/identity/upload',
      multipartBody,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
    );
    expect(uploadRes.status).toBe(201);

    const uploadPayload = JSON.parse(uploadRes.body) as { ok: boolean; message: string; containerFormat?: string };
    expect(uploadPayload.ok).toBe(true);
    expect(uploadPayload.containerFormat).toBe('json');

    const identityRes = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(identityRes.status).toBe(200);
    const identityPayload = JSON.parse(identityRes.body) as {
      card: {
        data: {
          name: string;
          personality: string;
          creator_notes?: string;
          alternate_greetings?: string[];
          extensions?: Record<string, unknown>;
        };
      };
    };

    expect(identityPayload.card.data.name).toBe('Imported Identity');
    expect(identityPayload.card.data.personality).toBe('New personality baseline');
    expect(identityPayload.card.data.creator_notes).toBeUndefined();
    expect(identityPayload.card.data.alternate_greetings).toBeUndefined();
    expect(identityPayload.card.data.extensions?.visual_description).toBeUndefined();

    const foundationLayer = promptStore.getAll().find(
      layer => layer.type === 'base' && layer.name === 'Character Foundation',
    );
    expect(foundationLayer).toBeDefined();
    expect(foundationLayer?.content).toContain('You are {{char}}.');
    expect(foundationLayer?.content).toContain('{{description}}');
    expect(foundationLayer?.content).toContain('{{personality}}');
    expect(foundationLayer?.content).not.toContain('Imported Identity');
  });

  it('sanitizes identity upload responses for hostile filenames and card names', async () => {
    const hostileFilename = '<img src=x onerror=alert(1)>.txt';
    const badBoundary = '----ApiIdentityUploadBoundaryHostileFilename';
    const badExtensionBody = buildMultipartBody(badBoundary, [
      {
        name: 'file',
        filename: hostileFilename,
        contentType: 'application/json',
        content: '{}',
      },
    ]);

    const badExtensionRes = await request(
      port,
      'POST',
      '/api/admin/identity/upload',
      badExtensionBody,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${badBoundary}`,
      },
    );
    expect(badExtensionRes.status).toBe(400);
    const badExtensionPayload = JSON.parse(badExtensionRes.body) as { error?: string };
    expect(badExtensionPayload.error).toContain('.json, .png, or .charx');
    expect(badExtensionPayload.error).not.toContain('<img');
    expect(badExtensionPayload.error).not.toContain('onerror');

    const hostileCard = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '<script>alert(1)</script>',
        description: 'Safe description',
        personality: 'Safe personality',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['safe'],
        creator: 'tester',
      },
    };

    const hostileNameBoundary = '----ApiIdentityUploadBoundaryHostileCardName';
    const hostileNameBody = buildMultipartBody(hostileNameBoundary, [
      {
        name: 'file',
        filename: 'hostile-card.json',
        contentType: 'application/json',
        content: JSON.stringify(hostileCard),
      },
    ]);

    const hostileNameRes = await request(
      port,
      'POST',
      '/api/admin/identity/upload',
      hostileNameBody,
      {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${hostileNameBoundary}`,
      },
    );
    expect(hostileNameRes.status).toBe(201);
    const hostileNamePayload = JSON.parse(hostileNameRes.body) as { message?: string };
    expect(hostileNamePayload.message).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(hostileNamePayload.message).not.toContain('<script>');
  });

  it('supports /api/admin/identity mutation routes without legacy audit page dependencies', async () => {
    const fieldPatchRes = await request(
      port,
      'PATCH',
      '/api/admin/identity/fields',
      JSON.stringify({ field: 'name', value: 'ApiRouteAuditBot' }),
      authHeaders,
    );
    expect(fieldPatchRes.status).toBe(200);

    const rollbackRes = await request(
      port,
      'POST',
      '/api/admin/identity/rollback',
      JSON.stringify({ version: 1 }),
      authHeaders,
    );
    expect(rollbackRes.status).toBe(200);

    const importDeniedRes = await request(
      port,
      'POST',
      '/api/admin/identity/import',
      JSON.stringify({ path: join(tempDir, 'missing-audit-import-card.json') }),
      authHeaders,
    );
    expect(importDeniedRes.status).toBe(400);

    const uploadDeniedRes = await request(
      port,
      'POST',
      '/api/admin/identity/upload',
      JSON.stringify({ not: 'multipart' }),
      authHeaders,
    );
    expect(uploadDeniedRes.status).toBeGreaterThanOrEqual(400);

    expect(uploadDeniedRes.status).toBeLessThan(500);
  });

  it('streams telemetry over websocket and enforces websocket auth', async () => {
    const unauthorizedStatus = await openWebSocketExpectStatus(port, '/api/admin/events');
    expect(unauthorizedStatus).toBe(401);

    const ws = await openWebSocket(port, '/api/admin/events', {
      Authorization: `Bearer ${token}`,
    });

    const message = await new Promise<{ type: string; timestamp: number }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for telemetry event')), 2000);
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
          resolve(JSON.parse(text) as { type: string; timestamp: number });
        } catch (error) {
          reject(error);
        }
      });
      setTimeout(() => {
        eventBus.emit('message.sent', {
          response: {
            channelId: 'api-session',
            content: 'telemetry test',
            metadata: {
              model: 'test-model',
              durationMs: 1,
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              llmCalls: 1,
              toolCalls: 0,
              contextUtilization: 0.1,
            },
          },
        }).catch(reject);
      }, 25);
    });

    expect(message.type).toBe('message.sent');
    expect(typeof message.timestamp).toBe('number');
    ws.close();
  });
});
