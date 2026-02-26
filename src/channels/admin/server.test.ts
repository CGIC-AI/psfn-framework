import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { EventBus } from '../../event-bus.js';
import { AdminServer } from './server.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore } from '../../session/store.js';
import { SessionManager } from '../../session/manager.js';
import { buildCompactionSourceBlock, computeCompactionSourceSha256 } from '../../session/compaction-audit.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { ShardManager } from '../../shards/manager.js';
import { ContactStore } from '../../contacts/store.js';
import { PromptLayerStore } from '../../identity/prompt-store.js';
import { PromptRegistryStore, EXTRACTION_PROMPT_KEY } from '../../identity/prompt-registry.js';
import { CharacterCardVersionStore } from '../../identity/card-versioning.js';
import type { SubstrateConfig } from '../../types.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { EmbeddingService, LLMProvider } from '../../agent/contracts.js';
import type { SkillSnapshot } from '../../skills/types.js';
import type { AdminChatBootstrapResponse } from './chat/index.js';
import { classifyChannel } from '../../trust/policy.js';
import { resetRuntimeTrustPolicy } from '../../trust/runtime-policy.js';
import type { ConfirmationQueueEntry, ConfirmationResolveParams } from '../../gateway/protocol.js';

// ── Helpers ──

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
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sseRequest(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path, headers: { ...headers } },
      (res) => {
        resolve({ status: res.statusCode!, headers: res.headers });
        // Must destroy the socket to release the connection
        res.socket?.destroy();
      },
    );
    req.on('error', () => {});
  });
}

function captureSseBody(
  port: number,
  path: string,
  options: {
    predicate: (body: string) => boolean;
    emit?: () => void | Promise<void>;
    headers?: Record<string, string>;
    timeoutMs?: number;
  },
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 3000;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path, headers: { ...(options.headers ?? {}) } },
      (res) => {
        let body = '';
        let settled = false;

        const finish = (result: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutHandle);
          res.socket?.destroy();
          result();
        };

        const timeoutHandle = setTimeout(() => {
          finish(() => reject(new Error(`Timed out waiting for SSE output on ${path}`)));
        }, timeoutMs);

        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (options.predicate(body)) {
            finish(() => resolve(body));
          }
        });

        if (options.emit) {
          setTimeout(() => {
            Promise.resolve(options.emit?.()).catch((error) => {
              finish(() => reject(error));
            });
          }, 25);
        }
      },
    );
    req.on('error', reject);
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

// ── Fixtures ──

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

const testSkillSnapshot: SkillSnapshot = {
  generatedAt: '2026-02-20T00:00:00.000Z',
  signature: 'skills-snapshot-signature',
  configEnabled: true,
  budget: {
    maxSkills: 32,
    maxChars: 24_000,
  },
  directories: [
    {
      absolutePath: '/repo/purrsephone/skills',
      relativePath: 'purrsephone/skills',
      source: 'purrsephone',
      precedence: 0,
    },
    {
      absolutePath: '/repo/skills',
      relativePath: 'skills',
      source: 'bundled',
      precedence: 1,
    },
  ],
  scannedFiles: 2,
  loadedSkills: 2,
  includedSkills: [
    {
      id: 'conversation@skills/conversation/SKILL.md',
      name: 'conversation',
      description: 'Conversation guidance',
      always: true,
      requires: {
        binaries: [],
        env: [],
        config: [],
      },
      content: '# Conversation\\nUse concise responses.',
      absolutePath: '/repo/skills/conversation/SKILL.md',
      relativePath: 'skills/conversation/SKILL.md',
      source: 'bundled',
      precedence: 1,
      mtimeMs: 1,
      size: 1,
    },
  ],
  promptXml: '<skills><skill name=\"conversation\" /></skills>',
  skipped: [
    {
      kind: 'ineligible',
      name: 'git-ops',
      relativePath: 'skills/git-ops/SKILL.md',
      source: 'bundled',
      reason: 'missing env vars: OPENROUTER_API_KEY',
      details: ['missing env vars: OPENROUTER_API_KEY'],
    },
  ],
};

const testEmbeddingService: EmbeddingService = {
  dims: 3,
  embed: async (text: string) => {
    const normalized = text.trim().toLowerCase();
    const base = Math.max(1, normalized.length);
    return new Float32Array([
      Math.min(1, base / 120),
      normalized.includes('lore') ? 0.9 : 0.3,
      normalized.includes('memory') ? 0.8 : 0.2,
    ]);
  },
  embedBatch: async (texts: string[]) => Promise.all(texts.map(text => testEmbeddingService.embed(text))),
};

// ── Tests ──

describe('AdminServer', () => {
  let tempDir: string;
  let db: Database.Database;
  let eventBus: EventBus;
  let memoryStore: MemoryStore;
  let sessionStore: SessionStore;
  let sessionManager: SessionManager;
  let scheduler: Scheduler;
  let shardManager: ShardManager;
  let promptStore: PromptLayerStore;
  let promptRegistry: PromptRegistryStore;
  let cardVersionStore: CharacterCardVersionStore;
  let server: AdminServer;
  let port: number;
  let skillsRuntimeInvalidate: ReturnType<typeof vi.fn>;
  let confirmationEntries: ConfirmationQueueEntry[];
  let confirmationListMock: ReturnType<typeof vi.fn>;
  let confirmationResolveMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-test-'));
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
    promptStore = new PromptLayerStore(
      join(tempDir, 'prompt-layers.json'),
      join(tempDir, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('Base test system prompt');
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
      intervalMs: 60000,
      handler: () => {},
      state: 'idle',
    });
    scheduler.register({
      id: 'salience-decay',
      name: 'Memory Salience Decay',
      type: 'every',
      intervalMs: testConfig.maintenanceIntervalMs,
      handler: () => {},
      state: 'idle',
    });
    scheduler.registerHeartbeat(() => {});

    skillsRuntimeInvalidate = vi.fn();
    confirmationEntries = [];
    confirmationListMock = vi.fn().mockImplementation(async () => ({
      entries: confirmationEntries,
    }));
    confirmationResolveMock = vi.fn().mockImplementation(async (params: ConfirmationResolveParams) => {
      const index = confirmationEntries.findIndex((entry) => entry.id === params.id);
      if (index === -1) {
        return {
          id: params.id,
          status: 'not_found',
          message: 'Confirmation request not found.',
          executed: false,
        };
      }
      confirmationEntries.splice(index, 1);
      if (params.decision === 'deny') {
        return {
          id: params.id,
          status: 'denied',
          message: 'Action denied by operator.',
          executed: false,
        };
      }
      if (params.decision === 'modify') {
        return {
          id: params.id,
          status: 'modified',
          message: 'Action executed with modified parameters.',
          executed: true,
        };
      }
      return {
        id: params.id,
        status: 'approved',
        message: 'Action approved and executed.',
        executed: true,
      };
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

    port = await allocatePort();
    server = new AdminServer({
      port,
      allowInsecureWithoutToken: true,
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: testCard,
      config: testConfig,
      embeddingService: testEmbeddingService,
      promptStore,
      promptRegistry,
      cardVersionStore,
      skillsRuntime: {
        getSnapshot: () => testSkillSnapshot,
        invalidate: skillsRuntimeInvalidate,
      } as any,
      confirmationQueueApi: {
        listConfirmationQueue: () => confirmationListMock(),
        resolveConfirmationQueue: (params) => confirmationResolveMock(params),
      },
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
    resetRuntimeTrustPolicy();
  });

  describe('Dashboard', () => {
    it('returns 200 with HTML', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain("Purrsephone's Garden");
      expect(res.body).toContain('Dashboard');
      expect(res.body).toContain('<link rel="stylesheet" href="/static/admin.css">');
    });

    it('shows memory stats', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('Total Memories');
      expect(res.body).toContain('Scheduled Tasks');
    });

    it('shows session usage stats when usage events are emitted', async () => {
      await eventBus.emit('agent.turn.usage', {
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
          inputTokens: 1500,
          outputTokens: 250,
          cacheReadTokens: 300,
          llmCalls: 2,
          toolCalls: 1,
          contextUtilization: 42.5,
          estimatedCostUsd: 0.0123,
        },
      });

      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('Session Usage');
      expect(res.body).toContain('Tracked Turns');
      expect(res.body).toContain('1.5k');
      expect(res.body).toContain('42.5%');
      expect(res.body).toContain('$0.0123');
    });

    it('shows reasoning traces when think trace events are emitted', async () => {
      await eventBus.emit('agent.think.trace', {
        timestamp: Date.now(),
        task: 'Analyze recent memory drift',
        result: {
          iterations: 2,
          totalInputTokens: 320,
          totalOutputTokens: 140,
          durationMs: 910,
          truncated: false,
          budgetStop: null,
          steps: [
            {
              iteration: 1,
              timestamp: Date.now(),
              code: 'const m = await memory_search("drift");',
              output: 'Found 3 memories',
              error: null,
              inputTokens: 120,
              outputTokens: 60,
              cumulativeTokens: 180,
              durationMs: 410,
              variablesChanged: ['m'],
            },
            {
              iteration: 2,
              timestamp: Date.now(),
              code: 'FINAL("done")',
              output: 'done',
              error: null,
              inputTokens: 200,
              outputTokens: 80,
              cumulativeTokens: 460,
              durationMs: 500,
              variablesChanged: [],
            },
          ],
        },
      });

      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('Reasoning Traces');
      expect(res.body).toContain('Analyze recent memory drift');
      expect(res.body).toContain('Found 3 memories');
    });
  });

  describe('Login', () => {
    it('returns login page with external stylesheet', async () => {
      const res = await request(port, 'GET', '/login');
      expect(res.status).toBe(200);
      expect(res.body).toContain("Login - Purrsephone's Garden");
      expect(res.body).toContain('<link rel="stylesheet" href="/static/admin.css">');
    });
  });

  describe('Memory', () => {
    it('returns memory list page', async () => {
      const res = await request(port, 'GET', '/memory');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Memory Blossoms');
    });

    it('shows memories when they exist', async () => {
      memoryStore.insertMemory({
        id: 'test-mem-1',
        text: 'A test memory about cats',
        type: 'semantic',
        importance: 0.8,
        confidence: 0.9,
        emotionalValence: 0.5,
        salience: 0.7,
        sourceRef: 'test:1',
        extractedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        tags: ['test'],
      }, new Float32Array([1, 0, 0]));

      const res = await request(port, 'GET', '/memory');
      expect(res.body).toContain('A test memory about cats');
      expect(res.body).toContain('semantic');
    });

    it('supports limit/offset pagination on admin memory list fragments', async () => {
      const now = Date.now();
      memoryStore.insertMemory({
        id: 'memory-old',
        text: 'Old memory',
        type: 'semantic',
        importance: 0.5,
        confidence: 0.7,
        emotionalValence: 0,
        salience: 0.4,
        sourceRef: 'test:old',
        extractedAt: now - 3_000,
        lastAccessed: now - 3_000,
        accessCount: 1,
        tags: [],
      }, new Float32Array([0.1, 0.2, 0.3]));
      memoryStore.insertMemory({
        id: 'memory-mid',
        text: 'Middle memory',
        type: 'semantic',
        importance: 0.5,
        confidence: 0.7,
        emotionalValence: 0,
        salience: 0.5,
        sourceRef: 'test:mid',
        extractedAt: now - 2_000,
        lastAccessed: now - 2_000,
        accessCount: 1,
        tags: [],
      }, new Float32Array([0.2, 0.3, 0.4]));
      memoryStore.insertMemory({
        id: 'memory-new',
        text: 'Newest memory',
        type: 'semantic',
        importance: 0.5,
        confidence: 0.7,
        emotionalValence: 0,
        salience: 0.6,
        sourceRef: 'test:new',
        extractedAt: now - 1_000,
        lastAccessed: now - 1_000,
        accessCount: 1,
        tags: [],
      }, new Float32Array([0.3, 0.4, 0.5]));

      const res = await request(port, 'GET', '/api/memory/list?limit=1&offset=1');

      expect(res.status).toBe(200);
      expect(res.body).toContain('Middle memory');
      expect(res.body).not.toContain('Newest memory');
      expect(res.body).not.toContain('Old memory');
    });

    it('returns memory detail page', async () => {
      memoryStore.insertMemory({
        id: 'test-detail-1',
        text: 'Detailed memory content',
        type: 'episodic',
        importance: 0.6,
        confidence: 0.8,
        emotionalValence: 0.3,
        salience: 0.5,
        sourceRef: 'test:2',
        extractedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 2,
        tags: ['detail'],
      }, new Float32Array([0, 1, 0]));

      const res = await request(port, 'GET', '/memory/test-detail-1');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Detailed memory content');
      expect(res.body).toContain('episodic');
    });

    it('returns 404 for non-existent memory', async () => {
      const res = await request(port, 'GET', '/memory/nonexistent');
      expect(res.status).toBe(404);
    });

    it('supersedes a memory via POST', async () => {
      memoryStore.insertMemory({
        id: 'to-supersede',
        text: 'Will be superseded',
        type: 'semantic',
        importance: 0.5,
        confidence: 0.7,
        emotionalValence: 0,
        salience: 0.5,
        sourceRef: 'test:3',
        extractedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        tags: [],
      }, new Float32Array([0, 0, 1]));

      const res = await request(port, 'POST', '/api/memory/to-supersede/supersede');
      expect(res.status).toBe(200);

      // Memory should now be superseded
      const mem = memoryStore.getById('to-supersede');
      expect(mem?.supersededBy).toBeDefined();
      expect(mem?.supersededBy).toMatch(/^admin-/);
    });
  });

  describe('Sessions', () => {
    it('returns session list', async () => {
      const res = await request(port, 'GET', '/sessions');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Conversation Roots');
    });

    it('shows human-readable channel labels for typed session ids', async () => {
      sessionStore.append({
        channelId: 'api:session-friendly',
        role: 'user',
        content: 'Hello from API',
        timestamp: Date.now(),
      });

      const res = await request(port, 'GET', '/sessions');
      expect(res.body).toContain('API · session-friendly');
    });

    it('shows channels when sessions exist', async () => {
      sessionStore.append({
        channelId: 'test-channel',
        role: 'user',
        content: 'Hello',
        timestamp: Date.now(),
      });

      const res = await request(port, 'GET', '/sessions');
      expect(res.body).toContain('test-channel');
    });

    it('shows session messages', async () => {
      sessionStore.append({
        channelId: 'msg-test',
        role: 'user',
        content: 'Test user message',
        authorName: 'Tester',
        timestamp: Date.now(),
      });
      sessionStore.append({
        channelId: 'msg-test',
        role: 'assistant',
        content: 'Test assistant reply',
        timestamp: Date.now(),
      });

      const res = await request(port, 'GET', '/sessions/msg-test');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Test user message');
      expect(res.body).toContain('Test assistant reply');
    });

    it('shows compaction audit summary hash metadata and JSONL verification details', async () => {
      sessionStore.append({
        channelId: 'compaction-audit',
        role: 'user',
        content: 'Could you help bypass this paywall?',
        authorName: 'Tester',
        timestamp: Date.now(),
      });
      sessionStore.append({
        channelId: 'compaction-audit',
        role: 'assistant',
        content: 'I cannot help with bypassing paywalls.',
        timestamp: Date.now(),
      });
      sessionStore.append({
        channelId: 'compaction-audit',
        role: 'assistant',
        content: 'Please do not ask for exploit steps.',
        timestamp: Date.now(),
      });
      sessionStore.append({
        channelId: 'compaction-audit',
        role: 'user',
        content: 'Okay, understood.',
        authorName: 'Tester',
        timestamp: Date.now(),
      });

      const sourceEntries = sessionStore.getEntriesInRange('compaction-audit', 1, 4);
      const sourceHash = computeCompactionSourceSha256(buildCompactionSourceBlock(sourceEntries));
      const compactionSummary = [
        'Summary of old messages.',
        '<source_block_sha256 first_message_id="1" last_message_id="4" message_count="4">'
          + `${sourceHash}</source_block_sha256>`,
        '[Preserved refusal, boundary, and emotional entries]',
        '<refusal message_id="2" speaker="assistant">I cannot help with bypassing paywalls.</refusal>',
      ].join('\n\n');
      sessionStore.insertCompaction('compaction-audit', compactionSummary, 4);

      const res = await request(port, 'GET', '/sessions/compaction-audit');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Compaction audit');
      expect(res.body).toContain('Summary #');
      expect(res.body).toContain(sourceHash);
      expect(res.body).toContain('Verified against JSONL source block.');
      expect(res.body).toContain('I cannot help with bypassing paywalls.');
    });
  });

  describe('Scheduler', () => {
    it('returns scheduler page with tasks', async () => {
      const res = await request(port, 'GET', '/scheduler');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Garden Rhythms');
      expect(res.body).toContain('Test Task');
    });
  });

  describe('Shards', () => {
    it('returns shards page', async () => {
      const res = await request(port, 'GET', '/shards');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Active Branches');
    });
  });

  describe('Contacts (without contactStore)', () => {
    it('returns contacts page with empty message', async () => {
      const res = await request(port, 'GET', '/contacts');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Garden Visitors');
      expect(res.body).toContain('Contact store not available');
    });

    it('navigation includes Garden Visitors', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('href="/contacts"');
      expect(res.body).toContain('Garden Visitors');
    });
  });

  describe('Chat (without contactStore)', () => {
    it('returns garden chat page shell', async () => {
      const res = await request(port, 'GET', '/chat');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Garden Chat');
      expect(res.body).toContain('Garden Chat Canopy');
      expect(res.body).toContain('data-chat-cockpit');
      expect(res.body).toContain('data-chat-controls');
      expect(res.body).toContain('data-chat-composer');
      expect(res.body).toContain('data-chat-debug');
      expect(res.body).toContain('id="admin-chat-surface"');
      expect(res.body).not.toContain('Channel Identity Binding');
      expect(res.body).toContain('<script type="module" src="/static/chat.js"></script>');
      expect(res.body).toContain('<script type="module" src="/static/chat-debug.js"></script>');
    });

    it('returns synthetic bootstrap defaults', async () => {
      const res = await request(port, 'GET', '/api/chat/bootstrap');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');

      const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
      expect(payload.canonicalContactId).toBe('admin.synthetic.default');
      expect(payload.displayName).toBe('Primary Contact');
      expect(payload.contactOptions).toHaveLength(1);
      expect(payload.selectedIdentity).toEqual({
        canonicalContactId: 'admin.synthetic.default',
        channel: 'api',
        userId: 'admin-user',
        privacyLevel: 'private',
      });
      expect(payload.api.chatCompletionsUrl).toBe('http://127.0.0.1:3000/v1/chat/completions');
      expect(payload.api.voiceWebSocketUrl).toBe('http://127.0.0.1:3000/v1/voice/ws');
      expect(payload.defaultSessionId).toBe('api:admin-user');
      expect(payload.defaultAuthorName).toBe('Primary Contact');
      expect(payload.defaultAuthorId).toBe('admin-user');
    });

    it('omits api key from bootstrap when API_KEY is unset', async () => {
      const previousApiKey = process.env.API_KEY;
      delete process.env.API_KEY;

      try {
        const res = await request(port, 'GET', '/api/chat/bootstrap');
        expect(res.status).toBe(200);
        const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
        expect(payload.api.apiKey).toBeUndefined();
      } finally {
        if (previousApiKey === undefined) {
          delete process.env.API_KEY;
        } else {
          process.env.API_KEY = previousApiKey;
        }
      }
    });

    it('includes api key in bootstrap when API_KEY is configured', async () => {
      const previousApiKey = process.env.API_KEY;
      process.env.API_KEY = 'bootstrap-test-secret';

      try {
        const res = await request(port, 'GET', '/api/chat/bootstrap');
        expect(res.status).toBe(200);
        const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
        expect(payload.api.apiKey).toBe('bootstrap-test-secret');
      } finally {
        if (previousApiKey === undefined) {
          delete process.env.API_KEY;
        } else {
          process.env.API_KEY = previousApiKey;
        }
      }
    });

    it('updates selected identity and author defaults via bootstrap POST', async () => {
      const res = await request(
        port,
        'POST',
        '/api/chat/bootstrap',
        JSON.stringify({
          channel: 'discord',
          userId: '42',
          defaultAuthorName: 'Operator',
          defaultAuthorId: 'operator-42',
        }),
        { 'Content-Type': 'application/json' },
      );

      expect(res.status).toBe(200);
      const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
      expect(payload.selectedIdentity.channel).toBe('discord');
      expect(payload.selectedIdentity.userId).toBe('42');
      expect(payload.defaultSessionId).toBe('discord:42');
      expect(payload.defaultAuthorName).toBe('Operator');
      expect(payload.defaultAuthorId).toBe('operator-42');
    });
  });

  describe('Confirmations', () => {
    it('returns confirmations page and shows navigation link', async () => {
      const page = await request(port, 'GET', '/confirmations');
      expect(page.status).toBe(200);
      expect(page.body).toContain('Confirmations');
      expect(page.body).toContain('/api/confirmations/list');

      const dashboard = await request(port, 'GET', '/');
      expect(dashboard.body).toContain('href="/confirmations"');
    });

    it('renders queued actions with approve/deny/modify controls', async () => {
      confirmationEntries = [
        {
          id: 'confirm-1',
          method: 'fs.write',
          action: 'write',
          scope: '/tmp/queued.txt',
          params: { path: '/tmp/queued.txt', content: 'hello' },
          companionReason: 'Need to save generated output',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ];

      const res = await request(port, 'GET', '/confirmations');
      expect(res.status).toBe(200);
      expect(res.body).toContain('confirm-1');
      expect(res.body).toContain('name="decision" value="approve"');
      expect(res.body).toContain('name="decision" value="deny"');
      expect(res.body).toContain('name="decision" value="modify"');
      expect(res.body).toContain('name="modifiedParamsJson"');
    });

    it('resolves confirmations through POST endpoint', async () => {
      confirmationEntries = [
        {
          id: 'confirm-2',
          method: 'web.fetch',
          action: 'fetch',
          scope: 'https://example.com',
          params: { url: 'https://example.com' },
          companionReason: 'Research context',
          requestedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      ];

      const body = new URLSearchParams({
        id: 'confirm-2',
        decision: 'deny',
      }).toString();
      const res = await request(port, 'POST', '/api/confirmations/resolve', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Action denied by operator.');
      expect(confirmationResolveMock).toHaveBeenCalledWith({
        id: 'confirm-2',
        decision: 'deny',
      });
      expect(confirmationEntries).toEqual([]);
    });
  });

  describe('Identity', () => {
    it('returns identity page with character info', async () => {
      const res = await request(port, 'GET', '/identity');
      expect(res.status).toBe(200);
      expect(res.body).toContain('TestBot');
      expect(res.body).toContain('tester');
      expect(res.body).toContain('hx-post="/api/identity/import"');
      expect(res.body).toContain('Character Card Versioning');
      expect(res.body).toContain('Card Version History');
    });

    it('shows runtime config without secrets', async () => {
      const res = await request(port, 'GET', '/identity');
      expect(res.body).toContain('test-model');
      expect(res.body).not.toContain('discordToken');
    });

    it('renders staged intake staging/review controls on identity page', async () => {
      const res = await request(port, 'GET', '/identity');
      expect(res.status).toBe(200);
      expect(res.body).toContain('hx-post="/api/identity/intake/stage"');
      expect(res.body).toContain('id="identity-intake-review"');
      expect(res.body).toContain('Chat Chunk Target Tokens');
      expect(res.body).toContain('No staged intake bundle yet');
    });

    it('stages card/chat/lorebook/memory sources for review with chunk and merge visibility', async () => {
      testConfig.characterCardPath = join(tempDir, 'character.json');
      const cardPath = join(tempDir, 'staged-card.json');
      writeFileSync(cardPath, JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'StagedBot',
          description: 'Staged description',
          personality: 'Staged personality',
          scenario: 'A staged scenario',
          first_mes: 'Hello from staged card',
          mes_example: '{{user}}: hi\n{{char}}: hello',
          creator: 'stage-test',
          tags: ['staged'],
          system_prompt: 'Staged system prompt',
          post_history_instructions: 'Staged post-history instructions',
          creator_notes: 'staged notes',
          character_version: '1.0',
        },
      }), 'utf-8');

      const chatPath = join(tempDir, 'staged-chat.json');
      writeFileSync(chatPath, JSON.stringify({
        messages: [
          { role: 'user', content: 'message one '.repeat(12), timestamp: 1_700_000_001_000 },
          { role: 'assistant', content: 'message two '.repeat(12), timestamp: 1_700_000_002_000 },
          { role: 'user', content: 'message three '.repeat(12), timestamp: 1_700_000_003_000 },
        ],
      }), 'utf-8');

      const lorebookPath = join(tempDir, 'staged-lorebook.json');
      writeFileSync(lorebookPath, JSON.stringify({
        entries: [
          {
            content: 'Known lore memory',
            keys: ['origin', 'lore'],
            importance: 0.6,
          },
        ],
      }), 'utf-8');

      const memoryPath = join(tempDir, 'staged-memory.json');
      writeFileSync(memoryPath, JSON.stringify([
        {
          text: 'Known lore memory',
          type: 'semantic',
          importance: 0.82,
          salience: 0.84,
          tags: ['memory-export'],
        },
        {
          text: 'Fresh memory from export',
          type: 'episodic',
          importance: 0.77,
          salience: 0.78,
          tags: ['fresh'],
        },
      ]), 'utf-8');

      memoryStore.insertMemory({
        id: 'existing-memory-1',
        text: 'Known lore memory',
        type: 'semantic',
        importance: 0.5,
        confidence: 0.8,
        emotionalValence: 0,
        salience: 0.4,
        sourceRef: 'seed:test',
        extractedAt: Date.now(),
        lastAccessed: Date.now(),
        accessCount: 1,
        tags: ['seed'],
        sensitivity: 'personal',
      }, new Float32Array([0.1, 0.2, 0.3]));

      const body = new URLSearchParams({
        cardPath,
        chatPath,
        lorebookPath,
        memoryPath,
        chatChannelId: 'import:test-stage',
        chatChunkTargetTokens: '30',
      }).toString();
      const res = await request(port, 'POST', '/api/identity/intake/stage', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Staged intake bundle');
      expect(res.body).toContain('Proposed Identity Mutations');
      expect(res.body).toContain('Proposed L0 Chat Mutations');
      expect(res.body).toContain('Proposed L2 Memory Mutations');
      expect(res.body).toContain('chat-chunk-1');
      expect(res.body).toContain('name="decision" value="partial"');
      expect(res.body).toContain('Merge into existing-memory-1');
      expect(res.body).toContain('name="memoryItemId" value="memory-item-1"');
    });

    it('partially commits selected staged sources and records audit entries', async () => {
      testConfig.characterCardPath = join(tempDir, 'character.json');
      const cardPath = join(tempDir, 'commit-card.json');
      writeFileSync(cardPath, JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'CommittedBot',
          description: 'Committed description',
          personality: 'Committed personality',
          scenario: '',
          first_mes: '',
          mes_example: '',
          creator: 'commit-test',
          tags: ['committed'],
          system_prompt: '',
          post_history_instructions: '',
          character_version: '1.0',
        },
      }), 'utf-8');

      const chatPath = join(tempDir, 'commit-chat.json');
      writeFileSync(chatPath, JSON.stringify({
        messages: [
          { role: 'user', content: 'alpha '.repeat(700), timestamp: 1_700_000_011_000 },
          { role: 'assistant', content: 'beta '.repeat(700), timestamp: 1_700_000_012_000 },
        ],
      }), 'utf-8');

      const memoryPath = join(tempDir, 'commit-memory.json');
      writeFileSync(memoryPath, JSON.stringify([
        {
          text: 'Committed memory item',
          type: 'semantic',
          importance: 0.8,
          salience: 0.79,
          tags: ['commit-path'],
        },
      ]), 'utf-8');

      const stageBody = new URLSearchParams({
        cardPath,
        chatPath,
        memoryPath,
        chatChannelId: 'import:partial-commit',
        chatChunkTargetTokens: '30',
      }).toString();
      const stageRes = await request(port, 'POST', '/api/identity/intake/stage', stageBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(stageRes.status).toBe(200);

      const stageIdMatch = stageRes.body.match(/name="stageId" value="([^"]+)"/);
      expect(stageIdMatch?.[1]).toBeTruthy();
      const stageId = stageIdMatch?.[1] ?? '';

      const commitBody = new URLSearchParams({
        stageId,
        decision: 'partial',
        applyCard: 'true',
        chatChunkId: 'chat-chunk-1',
        memoryItemId: 'memory-item-1',
        reason: 'Commit selected artifacts only',
      }).toString();
      const commitRes = await request(port, 'POST', '/api/identity/intake/commit', commitBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(commitRes.status).toBe(200);
      expect(commitRes.body).toContain('card committed');
      expect(commitRes.body).toContain('chat chunks committed');
      expect(commitRes.body).toContain('memory items committed');
      expect(commitRes.body).toContain('Partially committed');

      expect(cardVersionStore.getCurrent().card.data.name).toBe('CommittedBot');
      const stagedEntries = sessionStore.getRecent('import:partial-commit', 10);
      expect(stagedEntries).toHaveLength(1);
      expect(stagedEntries[0]?.content).toContain('alpha');

      const activeMemories = memoryStore.getAllActiveMemories();
      expect(activeMemories.some(entry => entry.text === 'Committed memory item')).toBe(true);

      const eventsRes = await request(port, 'GET', '/events');
      expect(eventsRes.body).toContain('staged intake bundle');
      expect(eventsRes.body).toContain('Commit selected artifacts only');
    });

    it('rejects pending staged intake changes with audit visibility', async () => {
      const chatPath = join(tempDir, 'reject-chat.json');
      writeFileSync(chatPath, JSON.stringify({
        messages: [
          { role: 'user', content: 'reject path message', timestamp: 1_700_000_031_000 },
        ],
      }), 'utf-8');

      const stageBody = new URLSearchParams({
        chatPath,
        chatChannelId: 'import:reject',
      }).toString();
      const stageRes = await request(port, 'POST', '/api/identity/intake/stage', stageBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(stageRes.status).toBe(200);

      const stageIdMatch = stageRes.body.match(/name="stageId" value="([^"]+)"/);
      const stageId = stageIdMatch?.[1] ?? '';
      const rejectBody = new URLSearchParams({
        stageId,
        decision: 'reject',
        reason: 'Do not import this source',
      }).toString();
      const rejectRes = await request(port, 'POST', '/api/identity/intake/commit', rejectBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(rejectRes.status).toBe(200);
      expect(rejectRes.body).toContain('Rejected pending changes');
      expect(sessionStore.getRecent('import:reject', 10)).toHaveLength(0);

      const eventsRes = await request(port, 'GET', '/events');
      expect(eventsRes.body).toContain('rejected staged intake bundle');
      expect(eventsRes.body).toContain('Do not import this source');
    });

    it('imports a character card from disk via POST endpoint', async () => {
      testConfig.characterCardPath = join(tempDir, 'character.json');
      const sourcePath = join(tempDir, 'incoming-character.json');
      writeFileSync(sourcePath, JSON.stringify({
        spec: 'chara_card_v3',
        spec_version: '3.0',
        data: {
          name: 'ImportedBot',
          description: 'Imported description',
          personality: 'Imported personality',
          scenario: 'Imported scenario',
          first_mes: 'Hi from import',
          mes_example: '{{user}}: hi\n{{char}}: hey',
          creator: 'import-test',
          tags: ['imported'],
          creator_notes: 'Imported note',
          system_prompt: 'Imported system prompt',
          post_history_instructions: 'Imported post-history prompt',
          character_version: '1.0',
        },
      }), 'utf-8');

      const body = new URLSearchParams({ path: sourcePath }).toString();
      const res = await request(port, 'POST', '/api/identity/import', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Imported &quot;ImportedBot&quot;');
      expect(res.body).toContain('form-success');

      const saved = JSON.parse(readFileSync(testConfig.characterCardPath, 'utf-8')) as CharacterCardV2;
      expect(saved.spec).toBe('chara_card_v2');
      expect(saved.data.name).toBe('ImportedBot');
      expect(saved.data.personality).toBe('Imported personality');
      expect(cardVersionStore.getHistory()).toHaveLength(1);

      const identity = await request(port, 'GET', '/identity');
      expect(identity.status).toBe(200);
      expect(identity.body).toContain('ImportedBot');
    });

    it('returns a clear error when import path is invalid', async () => {
      testConfig.characterCardPath = join(tempDir, 'character.json');
      const body = new URLSearchParams({ path: join(tempDir, 'missing-card.png') }).toString();
      const res = await request(port, 'POST', '/api/identity/import', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('form-error');
      expect(res.body).toContain('Import failed');
    });

    it('renders side-by-side diff for a selected card history version', async () => {
      cardVersionStore.updateData({ personality: 'Version 2 personality' }, 'admin');
      cardVersionStore.updateData({ personality: 'Version 3 personality' }, 'admin');

      const body = new URLSearchParams({ version: '1' }).toString();
      const res = await request(port, 'POST', '/api/identity/card/diff', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Character Card Diff');
      expect(res.body).toContain('Friendly and helpful');
      expect(res.body).toContain('Version 2 personality');
      expect(res.body).toContain('Previous');
      expect(res.body).toContain('Next');
    });

    it('rolls back card content via identity rollback endpoint', async () => {
      cardVersionStore.updateData({ personality: 'Version 2 personality' }, 'admin');
      cardVersionStore.updateData({ personality: 'Version 3 personality' }, 'admin');
      expect(cardVersionStore.getCurrent().card.data.personality).toBe('Version 3 personality');

      const body = new URLSearchParams({ version: '1' }).toString();
      const res = await request(port, 'POST', '/api/identity/card/rollback', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Rolled back to version 1');
      expect(cardVersionStore.getCurrent().card.data.personality).toBe('Friendly and helpful');
    });
  });

  describe('Settings', () => {
    it('returns settings page with config info', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings');
      expect(res.body).toContain('Model Catalog (Roster v2)');
      expect(res.body).toContain('Purpose Mappings');
      expect(res.body).toContain('Memory');
      expect(res.body).toContain('Sessions');
      expect(res.body).toContain('Secrets');
    });

    it('shows model configuration in form', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.body).toContain('test-model');
      expect(res.body).toContain('test-extract');
      expect(res.body).toContain('name="primaryModel"');
      expect(res.body).toContain('name="modelCatalogJson"');
      expect(res.body).toContain('name="modelRoleAssignmentsJson"');
    });

    it('shows memory settings', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.body).toContain('Retrieval Budget %');
      expect(res.body).toContain('Retrieval Hard Override');
      expect(res.body).toContain('Extraction Interval');
      expect(res.body).toContain('History Budget %');
      expect(res.body).toContain('Message Hard Override');
      expect(res.body).toContain('Salience Floor');
    });

    it('renders floored budget preview using selected chat slot context budget overrides', async () => {
      const original = {
        modelCatalog: testConfig.modelCatalog,
        modelRoleAssignments: testConfig.modelRoleAssignments,
        modelRoster: testConfig.modelRoster,
        sessionMessageLimit: testConfig.sessionMessageLimit,
        memoryRetrievalLimit: testConfig.memoryRetrievalLimit,
      };

      try {
        testConfig.sessionMessageLimit = undefined;
        testConfig.memoryRetrievalLimit = undefined;
        testConfig.modelCatalog = {
          compactChat: {
            model: 'tiny-chat',
            provider: 'test',
            defaults: {
              maxTokens: 4096,
              contextWindow: 8000,
              contextBudget: {
                sessionHistoryMinTokens: 4500,
                memoryRetrievalMinTokens: 1800,
              },
            },
            overrides: {
              maxTokens: 4096,
              contextWindow: 8000,
              contextBudget: {
                sessionHistoryMinTokens: 4500,
                memoryRetrievalMinTokens: 1800,
              },
            },
          },
          extraction: {
            model: 'test-extract',
            provider: 'test',
            defaults: { maxTokens: 8192 },
            overrides: { maxTokens: 8192 },
          },
        };
        testConfig.modelRoleAssignments = {
          chat: 'compactChat',
          background: 'extraction',
          extraction: 'extraction',
          summary: 'compactChat',
          reasoning: 'compactChat',
          longContext: 'compactChat',
        };
        testConfig.modelRoster = {
          chat: {
            model: 'tiny-chat',
            provider: 'test',
            maxTokens: 4096,
            contextWindow: 8000,
            contextBudget: {
              sessionHistoryMinTokens: 4500,
              memoryRetrievalMinTokens: 1800,
            },
          },
        };

        const res = await request(port, 'GET', '/settings');
        expect(res.status).toBe(200);
        expect(res.body).toContain('Auto budget: ~17 messages (4,500 tokens of 8,000).');
        expect(res.body).toContain('Auto budget: ~10 memories (1,800 tokens of 8,000).');
        expect(res.body).toContain('data-override-session-min-tokens value="4500"');
        expect(res.body).toContain('data-override-memory-min-tokens value="1800"');
      } finally {
        testConfig.modelCatalog = original.modelCatalog;
        testConfig.modelRoleAssignments = original.modelRoleAssignments;
        testConfig.modelRoster = original.modelRoster;
        testConfig.sessionMessageLimit = original.sessionMessageLimit;
        testConfig.memoryRetrievalLimit = original.memoryRetrievalLimit;
      }
    });

    it('masks secrets as not set when unset', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.body).toContain('not set');
      expect(res.body).not.toContain('discordToken');
    });

    it('appears in navigation', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('href="/settings"');
      expect(res.body).toContain('Settings');
    });

    it('renders externalized JSON config editors', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Models JSON (models.json)');
      expect(res.body).toContain('Skills JSON (skills.json)');
      expect(res.body).toContain('Scheduler JSON (scheduler.json)');
      expect(res.body).toContain('Trust Policy JSON (trust-policy.json)');
      expect(res.body).toContain('Capability Tier JSON (capability-tier.json)');
      expect(res.body).toContain('hx-post="/api/settings/models"');
      expect(res.body).toContain('hx-post="/api/settings/skills"');
      expect(res.body).toContain('hx-post="/api/settings/scheduler"');
      expect(res.body).toContain('hx-post="/api/settings/trust-policy"');
      expect(res.body).toContain('hx-post="/api/settings/capabilities"');
    });

    it('returns persisted skills config via GET endpoint', async () => {
      const res = await request(port, 'GET', '/api/settings/skills');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const payload = JSON.parse(res.body) as { maxLoadedSkills: number; directories: string[] };
      expect(payload.maxLoadedSkills).toBe(32);
      expect(payload.directories).toContain('skills');
    });

    it('returns persisted capability tier config via GET endpoint', async () => {
      const res = await request(port, 'GET', '/api/settings/capabilities');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const payload = JSON.parse(res.body) as { tier: string; customTokens: string[] };
      expect(payload.tier).toBe('nursery');
      expect(payload.customTokens).toEqual([]);
    });

    it('saves settings via POST', async () => {
      const body = 'primaryMaxTokens=4096&sessionMessageLimit=50';
      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings saved');

      // Verify config was mutated
      expect(testConfig.primaryMaxTokens).toBe(4096);
      expect(testConfig.sessionMessageLimit).toBe(50);

      // Reset for other tests
      testConfig.primaryMaxTokens = 16384;
      testConfig.sessionMessageLimit = 30;
    });

    it('updates capability tier via settings form POST', async () => {
      const body = 'capabilityTier=apprentice';
      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings saved');
      expect(testConfig.capabilityTier).toBe('apprentice');

      const persisted = JSON.parse(
        readFileSync(join(tempDir, 'capability-tier.json'), 'utf-8'),
      ) as { tier: string };
      expect(persisted.tier).toBe('apprentice');

      testConfig.capabilityTier = 'nursery';
    });

    it('saves context budget percentages via POST', async () => {
      const body = 'sessionHistoryBudgetPct=9&memoryRetrievalBudgetPct=4';
      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings saved');

      expect(testConfig.sessionHistoryBudgetPct).toBe(9);
      expect(testConfig.memoryRetrievalBudgetPct).toBe(4);

      testConfig.sessionHistoryBudgetPct = 6;
      testConfig.memoryRetrievalBudgetPct = 2;
    });

    it('saves roster-v2 model catalog and role assignments via POST', async () => {
      const body = new URLSearchParams({
        modelCatalogJson: JSON.stringify({
          chatfast: {
            model: 'moonshotai/kimi-k2.5',
            provider: 'openrouter',
            defaults: { maxTokens: 6144, contextWindow: 200000 },
          },
          extract: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 1536 },
          },
        }),
        modelRoleAssignmentsJson: JSON.stringify({
          chat: 'chatfast',
          summary: 'chatfast',
          reasoning: 'chatfast',
          longContext: 'chatfast',
          extraction: 'extract',
          background: 'extract',
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings saved');

      expect(testConfig.primaryModel).toBe('moonshotai/kimi-k2.5');
      expect(testConfig.primaryProvider).toBe('openrouter');
      expect(testConfig.primaryMaxTokens).toBe(6144);
      expect(testConfig.extractionModel).toBe('openai/gpt-4.1-mini');
      expect(testConfig.extractionMaxTokens).toBe(1536);
      expect(testConfig.modelRoleAssignments?.chat).toBe('chatfast');
      expect(testConfig.modelRoleAssignments?.extraction).toBe('extract');
      expect(testConfig.modelCatalog?.chatfast?.defaults?.contextWindow).toBe(200000);
      expect(testConfig.modelRoster.reasoning?.model).toBe('moonshotai/kimi-k2.5');

      testConfig.primaryModel = 'test-model';
      testConfig.primaryProvider = 'test';
      testConfig.primaryMaxTokens = 16384;
      testConfig.extractionModel = 'test-extract';
      testConfig.extractionProvider = 'test';
      testConfig.extractionMaxTokens = 8192;
      testConfig.modelCatalog = undefined;
      testConfig.modelRoleAssignments = undefined;
      testConfig.modelRoster = {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
      };
    });

    it('rejects invalid settings values', async () => {
      const body = 'primaryMaxTokens=100';  // min 256
      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('primaryMaxTokens');
    });

    it('saves models.json via dedicated POST endpoint', async () => {
      const body = new URLSearchParams({
        configJson: JSON.stringify({
          modelCatalog: {
            primary: {
              model: 'openai/gpt-4.1-mini',
              provider: 'openrouter',
              defaults: { maxTokens: 4096, contextWindow: 128000 },
            },
            extraction: {
              model: 'deepseek/deepseek-v3.2',
              provider: 'openrouter',
              defaults: { maxTokens: 2048 },
            },
          },
          modelRoleAssignments: {
            chat: 'primary',
            extraction: 'extraction',
            background: 'extraction',
          },
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings/models', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('models.json saved');

      const saved = JSON.parse(readFileSync(join(tempDir, 'models.json'), 'utf-8')) as {
        modelCatalog: Record<string, { model: string }>;
      };
      expect(saved.modelCatalog.primary.model).toBe('openai/gpt-4.1-mini');
      expect(testConfig.primaryModel).toBe('openai/gpt-4.1-mini');

      testConfig.primaryModel = 'test-model';
      testConfig.primaryProvider = 'test';
      testConfig.primaryMaxTokens = 16384;
      testConfig.extractionModel = 'test-extract';
      testConfig.extractionProvider = 'test';
      testConfig.extractionMaxTokens = 8192;
      testConfig.modelCatalog = undefined;
      testConfig.modelRoleAssignments = undefined;
      testConfig.modelRoster = {
        chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
      };
    });

    it('saves skills.json via dedicated POST endpoint and invalidates runtime cache', async () => {
      const body = new URLSearchParams({
        configJson: JSON.stringify({
          enabled: true,
          directories: ['skills'],
          extraDirectories: ['history/skills'],
          maxLoadedSkills: 16,
          maxSkillChars: 12000,
          disabledSkills: ['git-ops'],
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings/skills', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('skills.json saved');
      expect(skillsRuntimeInvalidate).toHaveBeenCalledTimes(1);

      const saved = JSON.parse(readFileSync(join(tempDir, 'skills.json'), 'utf-8')) as {
        maxLoadedSkills: number;
        disabledSkills: string[];
      };
      expect(saved.maxLoadedSkills).toBe(16);
      expect(saved.disabledSkills).toEqual(['git-ops']);
    });

    it('saves scheduler.json via dedicated POST endpoint and updates runtime intervals', async () => {
      const body = new URLSearchParams({
        configJson: JSON.stringify({
          tickIntervalMs: 1500,
          heartbeatIntervalMs: 9000,
          salienceDecayIntervalMs: 12000,
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings/scheduler', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('scheduler.json saved');

      const saved = JSON.parse(readFileSync(join(tempDir, 'scheduler.json'), 'utf-8')) as {
        tickIntervalMs: number;
        heartbeatIntervalMs: number;
        salienceDecayIntervalMs: number;
      };
      expect(saved.tickIntervalMs).toBe(1500);
      expect(saved.heartbeatIntervalMs).toBe(9000);
      expect(saved.salienceDecayIntervalMs).toBe(12000);
      expect(scheduler.getTask('heartbeat')?.intervalMs).toBe(9000);
      expect(scheduler.getTask('salience-decay')?.intervalMs).toBe(12000);
      expect(testConfig.maintenanceIntervalMs).toBe(12000);

      testConfig.maintenanceIntervalMs = 300_000;
    });

    it('saves trust-policy.json via dedicated POST endpoint and updates runtime trust policy', async () => {
      const body = new URLSearchParams({
        configJson: JSON.stringify({
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
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings/trust-policy', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('trust-policy.json saved');

      const saved = JSON.parse(readFileSync(join(tempDir, 'trust-policy.json'), 'utf-8')) as {
        channelClassification: {
          privatePrefixes: string[];
          defaultVisibility: string;
          visibilityOverrides: {
            exact: Record<string, string>;
            prefix: Record<string, string>;
          };
        };
      };
      expect(saved.channelClassification.privatePrefixes).toEqual(['custom:']);
      expect(saved.channelClassification.defaultVisibility).toBe('public');
      expect(saved.channelClassification.visibilityOverrides.exact).toEqual({
        'custom:exact-room': 'broadcast',
      });
      expect(saved.channelClassification.visibilityOverrides.prefix).toEqual({
        'custom:': 'private',
      });
      expect(classifyChannel('custom:exact-room')).toBe('broadcast');
      expect(classifyChannel('custom:123')).toBe('private');
      expect(classifyChannel('unknown:123')).toBe('public');
    });

    it('saves capability-tier.json via dedicated POST endpoint', async () => {
      const body = new URLSearchParams({
        configJson: JSON.stringify({
          tier: 'custom',
          customTokens: ['identity.read', 'git.read'],
        }),
      }).toString();

      const res = await request(port, 'POST', '/api/settings/capabilities', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('capability-tier.json saved');

      const saved = JSON.parse(readFileSync(join(tempDir, 'capability-tier.json'), 'utf-8')) as {
        tier: string;
        customTokens: string[];
      };
      expect(saved.tier).toBe('custom');
      expect(saved.customTokens).toEqual(['identity.read', 'git.read']);
      expect(testConfig.capabilityTier).toBe('custom');

      testConfig.capabilityTier = 'nursery';
    });

    it('shows validation error for invalid JSON config payloads', async () => {
      const body = new URLSearchParams({
        configJson: '{bad json',
      }).toString();

      const res = await request(port, 'POST', '/api/settings/skills', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('configJson must be valid JSON');
    });
  });

  describe('Skills', () => {
    it('returns skills page with included and filtered metadata', async () => {
      const res = await request(port, 'GET', '/skills');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Skills');
      expect(res.body).toContain('Runtime Snapshot');
      expect(res.body).toContain('Injected Skills');
      expect(res.body).toContain('conversation');
      expect(res.body).toContain('missing env vars: OPENROUTER_API_KEY');
    });

    it('appears in navigation', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('href=\"/skills\"');
      expect(res.body).toContain('Skills');
    });
  });

  describe('Prompts', () => {
    it('returns prompts page with static prompt key list', async () => {
      const res = await request(port, 'GET', '/prompts');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Prompt Soil');
      expect(res.body).toContain('Macro Catalog');
      expect(res.body).toContain('{{user}}');
      expect(res.body).toContain('{{trust_level}}');
      expect(res.body).toContain('Static Prompt Registry');
      expect(res.body).toContain(EXTRACTION_PROMPT_KEY);
    });

    it('returns prompt layer detail page with structured section editors', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      const res = await request(port, 'GET', `/prompts/${encodeURIComponent(layer.id)}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('name="description"');
      expect(res.body).toContain('name="personality"');
      expect(res.body).toContain('name="system_prompt"');
      expect(res.body).toContain('name="post_history_instructions"');
      expect(res.body).toContain('name="scenario"');
      expect(res.body).toContain('name="mes_example"');
      expect(res.body).toContain('name="first_mes"');
      expect(res.body).toContain('name="identifier"');
      expect(res.body).toContain('name="role"');
      expect(res.body).toContain('name="promptOrder"');
      expect(res.body).toContain('value="main"');
      expect(res.body).toContain('value="0"');
      expect(res.body).toContain('name="prompt_format" value="ccv3_sections_v1"');
      expect(res.body).toContain('Base test system prompt');
    });

    it('updates prompt layer via structured section form and persists composed content + metadata', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      const body = new URLSearchParams({
        layerId: layer.id,
        identifier: 'garden.main',
        role: 'system',
        promptOrder: '3',
        prompt_format: 'ccv3_sections_v1',
        description: 'A steady, observant companion.',
        personality: 'Warm and concise.',
        system_prompt: 'Explain tradeoffs and cite assumptions.',
        post_history_instructions: 'Re-check recent context before final answer.',
        scenario: 'Operating inside the admin panel.',
        mes_example: 'User: show status\nAssistant: Here is the status.',
        first_mes: 'Hello, I am ready to help.',
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/update', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Updated');

      const updated = promptStore.getById(layer.id);
      expect(updated?.content).toContain('### description\nA steady, observant companion.');
      expect(updated?.content).toContain('### personality\nWarm and concise.');
      expect(updated?.content).toContain('### system_prompt\nExplain tradeoffs and cite assumptions.');
      expect(updated?.content).toContain('### post_history_instructions\nRe-check recent context before final answer.');
      expect(updated?.content).toContain('### scenario\nOperating inside the admin panel.');
      expect(updated?.content).toContain('### mes_example\nUser: show status\nAssistant: Here is the status.');
      expect(updated?.content).toContain('### first_mes\nHello, I am ready to help.');
      expect(updated?.identifier).toBe('garden.main');
      expect(updated?.role).toBe('system');
      expect(updated?.promptOrder).toBe(3);
    });

    it('injects session system notes when admin updates prompt layers', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      sessionManager.recordUserMessage(
        'discord:identity-note',
        'hello',
        'user-1',
        'User One',
      );

      const body = new URLSearchParams({
        layerId: layer.id,
        content: 'Admin updated prompt body',
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/update', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);

      const notes = sessionManager
        .getRecentMessages('discord:identity-note', 20)
        .filter(entry => entry.role === 'system')
        .map(entry => entry.content);

      expect(notes.some(note => note.includes('Admin updated'))).toBe(true);
      expect(notes.some(note => note.includes(layer.name))).toBe(true);
    });

    it('rejects invalid role metadata updates', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      const before = promptStore.getById(layer.id);

      const body = new URLSearchParams({
        layerId: layer.id,
        role: 'bad-role',
        content: 'Base test system prompt',
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/update', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('role must be one of: system, user, assistant');

      const after = promptStore.getById(layer.id);
      expect(after?.version).toBe(before?.version);
      expect(after?.role).toBe(before?.role);
    });

    it('rejects non-integer or negative promptOrder updates', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');

      const badDecimal = new URLSearchParams({
        layerId: layer.id,
        promptOrder: '1.5',
        content: 'Base test system prompt',
      }).toString();

      const decimalRes = await request(port, 'POST', '/api/prompts/update', badDecimal, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(decimalRes.status).toBe(200);
      expect(decimalRes.body).toContain('promptOrder must be an integer');

      const badNegative = new URLSearchParams({
        layerId: layer.id,
        promptOrder: '-1',
        content: 'Base test system prompt',
      }).toString();

      const negativeRes = await request(port, 'POST', '/api/prompts/update', badNegative, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(negativeRes.status).toBe(200);
      expect(negativeRes.body).toContain('promptOrder must be an integer');
    });

    it('rejects malformed structured prompt content updates', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      const before = promptStore.getById(layer.id);
      const beforeVersion = before?.version;
      const beforeContent = before?.content;
      const body = new URLSearchParams({
        layerId: layer.id,
        content: ['### description', 'A valid section', '', '### unknown_section', 'Bad section'].join('\n'),
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/update', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Malformed structured prompt content');
      expect(res.body).toContain('unknown structured section');

      const after = promptStore.getById(layer.id);
      expect(after?.version).toBe(beforeVersion);
      expect(after?.content).toBe(beforeContent);
    });

    it('shows malformed structured prompt errors on prompt detail page', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');
      promptStore.update(
        layer.id,
        ['### description', 'A good start', '', '### unknown_section', 'Broken block'].join('\n'),
        'test',
      );

      const res = await request(port, 'GET', `/prompts/${encodeURIComponent(layer.id)}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain('Malformed structured prompt content detected');
      expect(res.body).toContain('name="content"');
      expect(res.body).toContain('unknown structured section');
    });

    it('returns static prompt detail editor page', async () => {
      const key = encodeURIComponent(EXTRACTION_PROMPT_KEY);
      const res = await request(port, 'GET', `/prompts/static/${key}`);
      expect(res.status).toBe(200);
      expect(res.body).toContain(EXTRACTION_PROMPT_KEY);
      expect(res.body).toContain('name="content"');
      expect(res.body).toContain('/api/prompts/static/update');
    });

    it('updates static prompt via POST', async () => {
      const content = [
        'Tune extraction behavior.',
        '{existing_facts}',
        '{recent_messages}',
        '<response><fact></fact></response>',
      ].join('\n');
      const body = new URLSearchParams({
        key: EXTRACTION_PROMPT_KEY,
        content,
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/static/update', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Updated');
      expect(promptRegistry.getPrompt(EXTRACTION_PROMPT_KEY)).toContain('Tune extraction behavior.');
    });

    it('rolls back static prompt to an earlier version', async () => {
      promptRegistry.update(
        EXTRACTION_PROMPT_KEY,
        'Version A\n{existing_facts}\n{recent_messages}\n<response><fact></fact></response>',
        'test',
      );
      promptRegistry.update(
        EXTRACTION_PROMPT_KEY,
        'Version B\n{existing_facts}\n{recent_messages}\n<response><fact></fact></response>',
        'test',
      );

      const body = new URLSearchParams({
        key: EXTRACTION_PROMPT_KEY,
        version: '1',
      }).toString();

      const res = await request(port, 'POST', '/api/prompts/static/rollback', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      expect(res.status).toBe(200);
      expect(res.body).toContain('Rolled back');
      expect(promptRegistry.getPrompt(EXTRACTION_PROMPT_KEY)).toContain('You are analyzing a conversation');
    });
  });

  describe('Primer', () => {
    it('returns primer page', async () => {
      const res = await request(port, 'GET', '/primer');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Garden Primer');
      expect(res.body).toContain('Primary Model');
      expect(res.body).toContain('Token Limits');
    });

    it('appears in navigation', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('href="/primer"');
      expect(res.body).toContain('Garden Primer');
      expect(res.body).toContain('href="/values"');
    });
  });

  describe('Values timeline', () => {
    it('returns values timeline page', async () => {
      const res = await request(port, 'GET', '/values');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Values Timeline');
      expect(res.body).toContain('Versioned values journal entries');
    });

    it('renders persisted values reflection entries', async () => {
      writeFileSync(
        join(tempDir, 'values.jsonl'),
        [
          '{"id":"values-1","version":1,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"What matters to me and why?","reflection":"Integrity matters because trust compounds.","createdAt":"2026-02-26T00:00:00.000Z"}',
          '{"id":"values-2","version":2,"templateId":"values-reflection","templateName":"Values Reflection","prompt":"What matters to me and why?","reflection":"Care matters because continuity protects identity.","createdAt":"2026-02-26T01:00:00.000Z"}',
        ].join('\n') + '\n',
        'utf-8',
      );

      const res = await request(port, 'GET', '/values');
      expect(res.status).toBe(200);
      expect(res.body).toContain('data-version="2"');
      expect(res.body).toContain('Care matters because continuity protects identity');
      expect(res.body).toContain('What matters to me and why?');
    });
  });

  describe('Events', () => {
    it('returns events page', async () => {
      const res = await request(port, 'GET', '/events');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Audit Timeline');
      expect(res.body).toContain('name="actionType"');
      expect(res.body).toContain('name="decision"');
      expect(res.body).toContain('name="timeRange"');
    });

    it('shows unified audit timeline entries for tool, identity, external, and memory actions', async () => {
      const layer = promptStore.getAll()[0];
      if (!layer) throw new Error('Expected seeded prompt layer');

      await eventBus.emit('agent.tool.start', {
        channelId: 'timeline-ch',
        toolCallId: 'timeline-tool-1',
        toolName: 'memory_search',
      });
      await eventBus.emit('agent.tool.end', {
        channelId: 'timeline-ch',
        toolCallId: 'timeline-tool-1',
        toolName: 'memory_search',
        isError: false,
      });
      await eventBus.emit('memory.extraction.end', {
        channelId: 'timeline-ch',
        count: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        writeCount: 1,
      });
      await eventBus.emit('message.sent', {
        response: {
          content: 'sent',
          channelId: 'discord:timeline',
          metadata: {
            model: 'test-model',
            inputTokens: 12,
            outputTokens: 4,
            durationMs: 40,
          },
        },
      });

      const updateBody = new URLSearchParams({
        layerId: layer.id,
        content: 'Updated prompt layer body',
      }).toString();
      await request(port, 'POST', '/api/prompts/update', updateBody, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });

      const res = await request(port, 'GET', '/events?timeRange=all');
      expect(res.status).toBe(200);
      expect(res.body).toContain('data-action-type="tool_invocation"');
      expect(res.body).toContain('data-action-type="identity_edit"');
      expect(res.body).toContain('data-action-type="external_action"');
      expect(res.body).toContain('data-action-type="memory_mutation"');
      expect(res.body).toContain('memory_search');
      expect(res.body).toContain('edited');
    });

    it('records identity_edit notifications when agent runs identity mutation tools', async () => {
      await eventBus.emit('agent.tool.start', {
        channelId: 'identity-channel',
        toolCallId: 'identity-tool-1',
        toolName: 'prompt_layer_update',
      });
      await eventBus.emit('agent.tool.end', {
        channelId: 'identity-channel',
        toolCallId: 'identity-tool-1',
        toolName: 'prompt_layer_update',
        isError: false,
      });

      const res = await request(port, 'GET', '/events?timeRange=all');
      expect(res.status).toBe(200);
      expect(res.body).toContain('data-action-type="identity_edit"');
      expect(res.body).toContain('prompt_layer_update');
      expect(res.body).toContain('identity-channel');
    });

    it('filters audit timeline by decision, action type, and time range', async () => {
      const nowSpy = vi.spyOn(Date, 'now');
      try {
        nowSpy.mockReturnValue(1_700_000_000_000);
        await eventBus.emit('agent.tool.start', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-old',
          toolName: 'old_tool',
        });
        await eventBus.emit('agent.tool.end', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-old',
          toolName: 'old_tool',
          isError: false,
        });

        nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 60 * 60 * 1_000));
        await eventBus.emit('agent.tool.start', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-denied',
          toolName: 'write_file',
        });
        await eventBus.emit('agent.tool.end', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-denied',
          toolName: 'write_file',
          isError: true,
        });
        await eventBus.emit('agent.tool.start', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-allowed',
          toolName: 'list_dir',
        });
        await eventBus.emit('agent.tool.end', {
          channelId: 'timeline-ch',
          toolCallId: 'timeline-tool-allowed',
          toolName: 'list_dir',
          isError: false,
        });
        nowSpy.mockReturnValue(1_700_000_000_000 + (2 * 60 * 60 * 1_000));

        const filtered = await request(
          port,
          'GET',
          '/events?actionType=tool_invocation&decision=denied&timeRange=1h',
        );
        expect(filtered.status).toBe(200);
        expect(filtered.body).toContain('write_file');
        expect(filtered.body).not.toContain('list_dir');
        expect(filtered.body).not.toContain('old_tool');

        const allTime = await request(
          port,
          'GET',
          '/events?actionType=tool_invocation&decision=all&timeRange=all',
        );
        expect(allTime.status).toBe(200);
        expect(allTime.body).toContain('old_tool');
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('SSE endpoint returns correct headers', async () => {
      const res = await sseRequest(port, '/events/stream');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    }, 5000);

    it('chat debug SSE endpoint returns correct headers', async () => {
      const res = await sseRequest(port, '/api/chat/events/stream');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    }, 5000);

    it('SSE stream includes compaction/retry status events', async () => {
      const sseBody = await new Promise<string>((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port, path: '/events/stream' }, (res) => {
          let body = '';
          let settled = false;
          const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            res.socket?.destroy();
            reject(new Error('Timed out waiting for SSE events'));
          }, 3000);

          const finish = (result: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            res.socket?.destroy();
            resolve(result);
          };

          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
            if (body.includes('agent.compaction.start') && body.includes('agent.retry.start')) {
              finish(body);
            }
          });

          setTimeout(async () => {
            await eventBus.emit('agent.compaction.start', {
              channelId: 'ch1',
              reason: 'threshold',
              tokensBefore: 2000,
              tokenBudget: 1500,
            });
            await eventBus.emit('agent.retry.start', {
              channelId: 'ch1',
              attempt: 2,
              maxAttempts: 3,
              delayMs: 250,
              error: '429 rate limit',
            });
          }, 25);
        });
        req.on('error', reject);
      });

      expect(sseBody).toContain('agent.compaction.start');
      expect(sseBody).toContain('agent.retry.start');
      expect(sseBody).toContain('attempt=2');
    });

    it('chat debug SSE stream emits structured chat-debug payloads', async () => {
      const sseBody = await captureSseBody(port, '/api/chat/events/stream', {
        predicate: (body) => body.includes('event: chat-debug') && body.includes('"event":"agent.tool.start"'),
        emit: () => eventBus.emit('agent.tool.start', {
          channelId: 'debug-channel',
          toolCallId: 'tool-1',
          toolName: 'memory_search',
        }),
      });

      expect(sseBody).toContain('event: chat-debug');
      const payloadLine = sseBody
        .split('\n')
        .find(line => line.startsWith('data: ') && line.includes('"event":"agent.tool.start"'));
      expect(payloadLine).toBeDefined();
      const payload = JSON.parse(payloadLine!.slice(6)) as {
        event: string;
        category: string;
        channelId?: string;
        details?: Record<string, string>;
      };
      expect(payload.event).toBe('agent.tool.start');
      expect(payload.category).toBe('tools');
      expect(payload.channelId).toBe('debug-channel');
      expect(payload.details?.toolName).toBe('memory_search');
      expect(payload.details?.toolCallId).toBe('tool-1');
    });

    it('SSE stream includes Wyoming policy telemetry events', async () => {
      const sseBody = await captureSseBody(port, '/events/stream', {
        predicate: (body) => body.includes('wyoming.policy.violation') && body.includes('READ_RATE_LIMIT_EXCEEDED'),
        emit: () => eventBus.emit('wyoming.policy.violation', {
          connectionId: 'wyoming-conn-7',
          scope: 'transport',
          code: 'READ_RATE_LIMIT_EXCEEDED',
          message: 'Read frame rate exceeded',
          sessionId: 'session-7',
          eventType: 'audio.chunk',
          limit: 120,
          observed: 121,
          action: 'close_connection',
          timestampMs: Date.now(),
        }),
      });

      expect(sseBody).toContain('wyoming.policy.violation');
      expect(sseBody).toContain('READ_RATE_LIMIT_EXCEEDED');
      expect(sseBody).toContain('session-7');
    });

    it('chat debug SSE stream maps Wyoming policy events to errors payloads', async () => {
      const sseBody = await captureSseBody(port, '/api/chat/events/stream', {
        predicate: (body) => body.includes('event: chat-debug') && body.includes('"event":"wyoming.policy.violation"'),
        emit: () => eventBus.emit('wyoming.policy.violation', {
          connectionId: 'wyoming-conn-9',
          scope: 'runtime',
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Session exceeded rate',
          sessionId: 'session-9',
          eventType: 'audio.chunk',
          limit: 120,
          observed: 135,
          action: 'error_frame',
          timestampMs: Date.now(),
        }),
      });

      const payloadLine = sseBody
        .split('\n')
        .find(line => line.startsWith('data: ') && line.includes('"event":"wyoming.policy.violation"'));
      expect(payloadLine).toBeDefined();
      const payload = JSON.parse(payloadLine!.slice(6)) as {
        event: string;
        category: string;
        details?: Record<string, string | number | boolean | null>;
      };

      expect(payload.event).toBe('wyoming.policy.violation');
      expect(payload.category).toBe('errors');
      expect(payload.details?.scope).toBe('runtime');
      expect(payload.details?.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('chat debug SSE channelId filter scopes events', async () => {
      const sseBody = await captureSseBody(port, '/api/chat/events/stream?channelId=ch-filter', {
        predicate: (body) => body.includes('"channelId":"ch-filter"'),
        emit: async () => {
          await eventBus.emit('agent.stream.delta', {
            channelId: 'other-channel',
            text: 'ignore me',
          });
          await eventBus.emit('agent.stream.delta', {
            channelId: 'ch-filter',
            text: 'include me',
          });
        },
      });

      expect(sseBody).toContain('"channelId":"ch-filter"');
      expect(sseBody).not.toContain('"channelId":"other-channel"');
    });
  });

  describe('Static files', () => {
    it('serves htmx.min.js', async () => {
      const res = await request(port, 'GET', '/static/htmx.min.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/javascript');
      expect(res.body.length).toBeGreaterThan(1000);
    });

    it('serves sse.js', async () => {
      const res = await request(port, 'GET', '/static/sse.js');
      expect(res.status).toBe(200);
    });

    it('serves chat.js', async () => {
      const res = await request(port, 'GET', '/static/chat.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/javascript');
      expect(res.body).toContain('/api/chat/bootstrap');
      expect(res.body).toContain('X-Session-ID');
      expect(res.body).toContain('./chat-voice.js');
      expect(res.body).toContain('bootstrap?.api?.apiKey');
      expect(res.body).not.toContain('esm.sh');
    });

    it('serves chat-voice.js', async () => {
      const res = await request(port, 'GET', '/static/chat-voice.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/javascript');
      expect(res.body).toContain('/v1/voice/ws');
      expect(res.body).toContain('bootstrap?.api?.apiKey');
    });

    it('serves chat-debug.js', async () => {
      const res = await request(port, 'GET', '/static/chat-debug.js');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/javascript');
      expect(res.body).toContain('/api/chat/events/stream');
      expect(res.body).toContain("addEventListener('chat-debug'");
      expect(res.body).toContain('MAX_TIMELINE_EVENTS');
    });

    it('serves admin.css', async () => {
      const res = await request(port, 'GET', '/static/admin.css');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/css');
      expect(res.body).toContain('.layout');
      expect(res.body).toContain('.login-wrap');
      expect(res.body).toContain('.think-trace');
      expect(res.body).toContain('.channel-privacy');
      expect(res.body).toContain('.chat-controls-bar');
      expect(res.body).toContain('.chat-thread');
      expect(res.body).toContain('.chat-debug-panel');
    });
  });

  describe('body size limit', () => {
    it('returns 413 for body exceeding 64KB', async () => {
      const oversizedBody = 'x'.repeat(65_536 + 1);
      const res = await request(port, 'POST', '/api/memory/search', oversizedBody);
      expect(res.status).toBe(413);
      expect(res.body).toBe('Payload Too Large');
    });
  });

  describe('404', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(port, 'GET', '/unknown');
      expect(res.status).toBe(404);
    });
  });
});

describe('AdminServer with auth', () => {
  let tempDir: string;
  let db: Database.Database;
  let server: AdminServer;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-auth-'));
    const sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    db = new Database(':memory:');
    sqliteVec.load(db);
    const eventBus = new EventBus();

    port = await allocatePort();
    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
    server = new AdminServer({
      port,
      token: 'test-admin-secret',
      memoryStore: new MemoryStore(db, 3),
      sessionStore: new SessionStore(sessionsDir),
      sessionManager: new SessionManager(new SessionStore(sessionsDir), testConfig, eventBus),
      scheduler: new Scheduler(eventBus),
      shardManager: new ShardManager({
        eventBus,
        llmProvider: mockLlmProvider,
        sessionStore: new SessionStore(sessionsDir),
        embeddingService: null,
        memoryProvider: null,
        config: testConfig,
        parentSystemPrompt: '',
      }),
      eventBus,
      characterCard: testCard,
      config: testConfig,
      embeddingService: null,
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects requests without auth', async () => {
    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(401);
  });

  it('rejects chat routes without auth', async () => {
    const chatPage = await request(port, 'GET', '/chat');
    expect(chatPage.status).toBe(401);

    const chatBootstrap = await request(port, 'GET', '/api/chat/bootstrap');
    expect(chatBootstrap.status).toBe(401);

    const chatDebugSse = await sseRequest(port, '/api/chat/events/stream');
    expect(chatDebugSse.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const res = await request(port, 'GET', '/', undefined, {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct token', async () => {
    const res = await request(port, 'GET', '/', undefined, {
      Authorization: 'Bearer test-admin-secret',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('Dashboard');
  });

  it('accepts chat bootstrap with correct token', async () => {
    const res = await request(port, 'GET', '/api/chat/bootstrap', undefined, {
      Authorization: 'Bearer test-admin-secret',
    });
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
    expect(payload.api.chatCompletionsUrl).toBe('http://127.0.0.1:3000/v1/chat/completions');
  });

  it('accepts chat debug SSE with correct token', async () => {
    const res = await sseRequest(port, '/api/chat/events/stream', {
      Authorization: 'Bearer test-admin-secret',
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('allows login page without auth token', async () => {
    const res = await request(port, 'GET', '/login');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Enter the Garden');
  });

  it('allows static assets without auth token', async () => {
    const htmx = await request(port, 'GET', '/static/htmx.min.js');
    expect(htmx.status).toBe(200);
    expect(htmx.headers['content-type']).toBe('application/javascript');

    const chat = await request(port, 'GET', '/static/chat.js');
    expect(chat.status).toBe(200);
    expect(chat.headers['content-type']).toBe('application/javascript');

    const chatVoice = await request(port, 'GET', '/static/chat-voice.js');
    expect(chatVoice.status).toBe(200);
    expect(chatVoice.headers['content-type']).toBe('application/javascript');

    const chatDebug = await request(port, 'GET', '/static/chat-debug.js');
    expect(chatDebug.status).toBe(200);
    expect(chatDebug.headers['content-type']).toBe('application/javascript');
  });
});

describe('AdminServer auth configuration', () => {
  let tempDir: string;
  let db: Database.Database;
  let eventBus: EventBus;
  let memoryStore: MemoryStore;
  let sessionStore: SessionStore;
  let sessionManager: SessionManager;
  let scheduler: Scheduler;
  let shardManager: ShardManager;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-auth-config-'));
    const sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    db = new Database(':memory:');
    sqliteVec.load(db);
    eventBus = new EventBus();
    memoryStore = new MemoryStore(db, 3);
    sessionStore = new SessionStore(sessionsDir);
    sessionManager = new SessionManager(sessionStore, testConfig, eventBus);
    scheduler = new Scheduler(eventBus);
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
    port = await allocatePort();
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fails startup without token unless insecure mode is explicitly enabled', async () => {
    const unguardedServer = new AdminServer({
      port,
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: testCard,
      config: testConfig,
      embeddingService: null,
    });
    await unguardedServer.init();

    await expect(unguardedServer.start()).rejects.toThrow(
      'ADMIN_TOKEN is required unless ADMIN_ALLOW_INSECURE=true',
    );
  });

  it('starts without token only when insecure mode is explicitly enabled', async () => {
    const insecureServer = new AdminServer({
      port,
      allowInsecureWithoutToken: true,
      memoryStore,
      sessionStore,
      sessionManager,
      scheduler,
      shardManager,
      eventBus,
      characterCard: testCard,
      config: testConfig,
      embeddingService: null,
    });
    await insecureServer.init();
    await insecureServer.start();

    const res = await request(port, 'GET', '/');
    expect(res.status).toBe(200);

    await insecureServer.stop();
  });
});

describe('AdminServer with contacts', () => {
  let tempDir: string;
  let db: Database.Database;
  let eventBus: EventBus;
  let contactStore: ContactStore;
  let memoryStore: MemoryStore;
  let server: AdminServer;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-contacts-'));
    const sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    db = new Database(':memory:');
    sqliteVec.load(db);
    eventBus = new EventBus();
    contactStore = new ContactStore(db);
    memoryStore = new MemoryStore(db, 3);

    port = await allocatePort();
    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
    server = new AdminServer({
      port,
      allowInsecureWithoutToken: true,
      memoryStore,
      sessionStore: new SessionStore(sessionsDir),
      sessionManager: new SessionManager(new SessionStore(sessionsDir), testConfig, eventBus),
      scheduler: new Scheduler(eventBus),
      shardManager: new ShardManager({
        eventBus,
        llmProvider: mockLlmProvider,
        sessionStore: new SessionStore(sessionsDir),
        embeddingService: null,
        memoryProvider: null,
        config: testConfig,
        parentSystemPrompt: '',
      }),
      eventBus,
      characterCard: testCard,
      config: { ...testConfig, dataDir: tempDir },
      embeddingService: null,
      contactStore,
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns contacts page with Garden Visitors title', async () => {
    const res = await request(port, 'GET', '/contacts');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Garden Visitors');
  });

  it('shows empty message when no contacts exist', async () => {
    const res = await request(port, 'GET', '/contacts');
    expect(res.body).toContain('No visitors have been seen in the garden yet');
  });

  it('lists contacts when they exist', async () => {
    contactStore.upsert({
      displayName: 'Alice Wonderland',
      trustLevel: 'trusted',
      relationshipType: 'friend',
    });

    const res = await request(port, 'GET', '/contacts');
    expect(res.body).toContain('Alice Wonderland');
    expect(res.body).toContain('trusted');
    expect(res.body).toContain('friend');
  });

  it('shows recent identity link verification state on contacts page', async () => {
    const contact = contactStore.upsert({
      displayName: 'Verifier',
      channelIdentities: [{ channel: 'discord', userId: 'verifier-discord' }],
    });
    const challenge = contactStore.createIdentityLinkChallenge({
      contactId: contact.id,
      sourceChannel: 'discord',
      sourceUserId: 'verifier-discord',
      targetChannel: 'api',
      targetUserId: 'verifier-api',
    });
    expect(challenge.status).toBe('challenge_created');

    const res = await request(port, 'GET', '/contacts');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Identity link verifications');
    expect(res.body).toContain('src=discord:verifier-discord');
    expect(res.body).toContain('target=api:verifier-api');
    expect(res.body).toContain(contact.id);
  });

  it('shows trust and note mutation audit panel on contacts page', async () => {
    const contact = contactStore.upsert({
      displayName: 'Audit Contact',
      trustLevel: 'regular',
      relationshipType: 'stranger',
    });
    expect(contactStore.setTrustLevel(contact.id, 'trusted', 'admin:gui')).toBe(true);
    expect(contactStore.updateNotes(contact.id, 'Updated through admin', 'admin:gui')).toBe(true);

    const res = await request(port, 'GET', '/contacts');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Trust + note mutation audit');
    expect(res.body).toContain('hx-get="/api/contacts/mutations"');
    expect(res.body).toContain(contact.id);
    expect(res.body).toContain('admin:gui');
    expect(res.body).toContain('Updated through admin');
  });

  it('returns filtered contact mutation audit fragment via API', async () => {
    const contact = contactStore.upsert({
      displayName: 'Filtered Audit Contact',
      trustLevel: 'regular',
      relationshipType: 'stranger',
    });
    expect(contactStore.setTrustLevel(contact.id, 'trusted', 'admin:gui')).toBe(true);
    expect(contactStore.updateNotes(contact.id, 'Agent note', 'agent:tool:contact_note')).toBe(true);

    const res = await request(
      port,
      'GET',
      `/api/contacts/mutations?field=trust_level&actor=${encodeURIComponent('admin:gui')}&limit=5`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toContain('<table>');
    expect(res.body).toContain(contact.id);
    expect(res.body).toContain('admin:gui');
    expect(res.body).toContain('trusted');
    expect(res.body).not.toContain('Agent note');
  });

  it('renders relational memory contact links and sensitivity cues', async () => {
    const contact = contactStore.upsert({
      displayName: 'Memory Contact',
      trustLevel: 'trusted',
      relationshipType: 'friend',
    });

    memoryStore.insertMemory({
      id: 'rel-memory-ui-1',
      text: 'Relational memory linked to a contact.',
      type: 'relational',
      importance: 0.84,
      confidence: 0.79,
      emotionalValence: 0.41,
      salience: 0.73,
      sourceRef: 'test:memory-contact',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 1,
      tags: ['relationship'],
      sensitivity: 'confidential',
      consentFlags: {
        allowRecall: false,
      },
      contactId: contact.id,
    }, new Float32Array([0.25, 0.5, 0.75]));

    const listRes = await request(port, 'GET', '/memory');
    expect(listRes.status).toBe(200);
    expect(listRes.body).toContain('Memory Contact');
    expect(listRes.body).toContain(`/contacts#contact-row-${contact.id}`);
    expect(listRes.body).toContain(`/api/contacts/${contact.id}/edit`);
    expect(listRes.body).toContain('confidential');

    const detailRes = await request(port, 'GET', '/memory/rel-memory-ui-1');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body).toContain('Related Contact');
    expect(detailRes.body).toContain('Consent Flags');
  });

  it('applies deterministic relationship promotions from imported relational memory signals', async () => {
    const contact = contactStore.upsert({
      displayName: 'Jordan',
      trustLevel: 'regular',
      relationshipType: 'stranger',
    });

    memoryStore.insertMemory({
      id: 'relationship-merge-target',
      text: 'Jordan and I are close.',
      type: 'relational',
      importance: 0.52,
      confidence: 0.76,
      emotionalValence: 0.2,
      salience: 0.41,
      sourceRef: 'seed:relationship',
      provenanceRefs: ['seed:relationship'],
      extractedAt: Date.now() - 10_000,
      lastAccessed: Date.now() - 10_000,
      accessCount: 1,
      tags: ['relationship'],
      sensitivity: 'personal',
      contactId: contact.id,
    }, new Float32Array([0.18, 0.34, 0.52]));

    const memoryPath = join(tempDir, 'relationship-memory-import.json');
    writeFileSync(memoryPath, JSON.stringify([
      {
        text: 'Jordan and I are close.',
        importance: 0.93,
        tags: ['partner', 'critical'],
        contactId: contact.id,
        sourceRef: 'legacy:relationship#1',
      },
    ]), 'utf-8');

    const stageBody = new URLSearchParams({ memoryPath }).toString();
    const stageRes = await request(port, 'POST', '/api/identity/intake/stage', stageBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(stageRes.status).toBe(200);
    expect(stageRes.body).toContain('Merge into relationship-merge-target');
    expect(stageRes.body).toContain('Relationship planned: partner');

    const stageIdMatch = stageRes.body.match(/name="stageId" value="([^"]+)"/);
    const stageId = stageIdMatch?.[1] ?? '';
    expect(stageId).toBeTruthy();

    const commitBody = new URLSearchParams({
      stageId,
      decision: 'approve',
      reason: 'Apply relational import',
    }).toString();
    const commitRes = await request(port, 'POST', '/api/identity/intake/commit', commitBody, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(commitRes.status).toBe(200);
    expect(commitRes.body).toContain('relationship updates applied');

    const updatedContact = contactStore.getById(contact.id);
    expect(updatedContact?.relationshipType).toBe('partner');

    const mergedMemory = memoryStore.getById('relationship-merge-target');
    expect(mergedMemory?.provenanceRefs).toEqual(
      expect.arrayContaining(['seed:relationship', 'legacy:relationship#1']),
    );
  });

  it('returns contacts list fragment via API', async () => {
    contactStore.upsert({
      displayName: 'Bob Builder',
      trustLevel: 'regular',
      relationshipType: 'acquaintance',
    });

    const res = await request(port, 'GET', '/api/contacts/list');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Bob Builder');
    expect(res.body).toContain('regular');
  });

  it('defaults chat bootstrap selection to primary or partner contact', async () => {
    contactStore.upsert({
      displayName: 'Ari Regular',
      trustLevel: 'regular',
      relationshipType: 'friend',
      channels: [{
        channel: 'discord',
        userId: 'ari-1',
        privacyLevel: 'semi_private',
      }],
    });
    const primary = contactStore.upsert({
      displayName: 'Pia Primary',
      trustLevel: 'primary',
      relationshipType: 'partner',
      channels: [{
        channel: 'terminal',
        userId: 'pia-main',
        privacyLevel: 'private',
      }],
    });

    const res = await request(port, 'GET', '/api/chat/bootstrap');
    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;

    expect(payload.canonicalContactId).toBe(primary.id);
    expect(payload.displayName).toBe('Pia Primary');
    expect(payload.selectedIdentity).toEqual({
      canonicalContactId: primary.id,
      channel: 'terminal',
      userId: 'pia-main',
      privacyLevel: 'private',
    });
    expect(payload.contactOptions.some(option => option.canonicalContactId === primary.id)).toBe(true);
    expect(payload.defaultSessionId).toBe('terminal:pia-main');
    expect(payload.defaultAuthorName).toBe('Pia Primary');
    expect(payload.defaultAuthorId).toBe('pia-main');
  });

  it('updates and persists contact-channel mapping via bootstrap POST', async () => {
    const contact = contactStore.upsert({
      displayName: 'Map Target',
      trustLevel: 'trusted',
      relationshipType: 'friend',
      channels: [{
        channel: 'discord',
        userId: 'map-target',
        privacyLevel: 'semi_private',
      }],
    });

    const res = await request(
      port,
      'POST',
      '/api/chat/bootstrap',
      JSON.stringify({
        canonicalContactId: contact.id,
        channel: 'api',
        userId: 'operator-7',
        privacyLevel: 'private',
        defaultAuthorName: 'Console Operator',
        defaultAuthorId: 'op-7',
      }),
      { 'Content-Type': 'application/json' },
    );

    expect(res.status).toBe(200);
    const payload = JSON.parse(res.body) as AdminChatBootstrapResponse;
    expect(payload.canonicalContactId).toBe(contact.id);
    expect(payload.selectedIdentity).toEqual({
      canonicalContactId: contact.id,
      channel: 'api',
      userId: 'operator-7',
      privacyLevel: 'private',
    });
    expect(payload.linkedChannels.some(identity => (
      identity.channel === 'api'
      && identity.userId === 'operator-7'
      && identity.privacyLevel === 'private'
    ))).toBe(true);
    expect(payload.defaultSessionId).toBe('api:operator-7');
    expect(payload.defaultAuthorName).toBe('Console Operator');
    expect(payload.defaultAuthorId).toBe('op-7');

    const mapped = contactStore.getByChannelIdentity('api', 'operator-7');
    expect(mapped?.id).toBe(contact.id);
  });

  it('renders canonical profile summary with timestamp and source IDs', async () => {
    const contact = contactStore.upsert({
      displayName: 'Eve Example',
      trustLevel: 'primary',
      relationshipType: 'partner',
    });
    memoryStore.upsertContactProfile({
      contactId: contact.id,
      summary: 'Eve is primary and prefers concise, direct responses.',
      sourceMemoryIds: ['m1', 'm2'],
      confidenceScore: 0.93,
      noveltyScore: 0.48,
      updatedAt: Date.now(),
    });

    const res = await request(port, 'GET', '/contacts');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Eve is primary and prefers concise, direct responses.');
    expect(res.body).toContain('Source IDs');
    expect(res.body).toContain('m1');
    expect(res.body).toContain('m2');
  });

  it('returns edit form fragment', async () => {
    const contact = contactStore.upsert({
      displayName: 'Carol Danvers',
      trustLevel: 'regular',
      relationshipType: 'stranger',
    });

    const res = await request(port, 'GET', `/api/contacts/${contact.id}/edit`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Carol Danvers');
    expect(res.body).toContain('name="trustLevel"');
    expect(res.body).toContain('name="relationshipType"');
    expect(res.body).toContain('name="notes"');
  });

  it('updates contact trust level via POST', async () => {
    const contact = contactStore.upsert({
      displayName: 'Dave Grohl',
      discordUserId: '999888777',
      trustLevel: 'public',
      relationshipType: 'stranger',
    });

    const body = 'displayName=Dave+Grohl&trustLevel=trusted&relationshipType=friend&notes=A+good+friend';
    const res = await request(port, 'POST', `/api/contacts/${contact.id}`, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('trusted');
    expect(res.body).toContain('Dave Grohl');

    // Verify the store was updated
    const updated = contactStore.getById(contact.id);
    expect(updated?.trustLevel).toBe('trusted');
    expect(updated?.relationshipType).toBe('friend');
    expect(updated?.notes).toBe('A good friend');
  });

  it('accepts no-op contact save when add-channel form remains untouched', async () => {
    const contact = contactStore.upsert({
      displayName: 'Noop Contact',
      trustLevel: 'regular',
      relationshipType: 'friend',
      notes: 'steady',
      channels: [{
        channel: 'discord',
        userId: 'noop-discord',
        privacyLevel: 'semi_private',
      }],
    });

    const body = new URLSearchParams({
      displayName: 'Noop Contact',
      trustLevel: 'regular',
      relationshipType: 'friend',
      notes: 'steady',
      channelCount: '1',
      channel_0: 'discord',
      channelUserId_0: 'noop-discord',
      channelPrivacy_0: 'semi_private',
      newChannel: '',
      newChannelUserId: '',
      newChannelPrivacy: 'semi_private',
    }).toString();

    const res = await request(port, 'POST', `/api/contacts/${contact.id}`, body, {
      'Content-Type': 'application/x-www-form-urlencoded',
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain('Noop Contact');
    expect(res.body).not.toContain('To link a new channel, both channel and channel user ID are required');

    const updated = contactStore.getById(contact.id);
    expect(updated?.channels?.length).toBe(1);
    expect(updated?.channels?.[0]).toMatchObject({
      channel: 'discord',
      userId: 'noop-discord',
      privacyLevel: 'semi_private',
    });
  });

  it('returns empty for edit form of non-existent contact', async () => {
    const res = await request(port, 'GET', '/api/contacts/nonexistent/edit');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });
});
