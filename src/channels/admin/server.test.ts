import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { EventBus } from '../../event-bus.js';
import { AdminServer } from './server.js';
import { MemoryStore } from '../../memory/store.js';
import { SessionStore } from '../../session/store.js';
import { SessionManager } from '../../session/manager.js';
import { Scheduler } from '../../scheduler/scheduler.js';
import { ShardManager } from '../../shards/manager.js';
import { ContactStore } from '../../contacts/store.js';
import type { SubstrateConfig } from '../../types.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { LLMProvider } from '../../agent-loop.js';

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
  let server: AdminServer;
  let port: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-test-'));
    testConfig.dataDir = tempDir;
    const sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });

    db = new Database(':memory:');
    sqliteVec.load(db);
    eventBus = new EventBus();
    memoryStore = new MemoryStore(db, 3);
    sessionStore = new SessionStore(sessionsDir);
    sessionManager = new SessionManager(sessionStore, testConfig);
    scheduler = new Scheduler(eventBus);
    scheduler.register({
      id: 'test-task',
      name: 'Test Task',
      type: 'every',
      intervalMs: 60000,
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

    port = 30000 + Math.floor(Math.random() * 10000);
    server = new AdminServer({
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
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('Dashboard', () => {
    it('returns 200 with HTML', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.body).toContain("Purrsephone's Garden");
      expect(res.body).toContain('Dashboard');
    });

    it('shows memory stats', async () => {
      const res = await request(port, 'GET', '/');
      expect(res.body).toContain('Total Memories');
      expect(res.body).toContain('Scheduled Tasks');
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

  describe('Identity', () => {
    it('returns identity page with character info', async () => {
      const res = await request(port, 'GET', '/identity');
      expect(res.status).toBe(200);
      expect(res.body).toContain('TestBot');
      expect(res.body).toContain('tester');
    });

    it('shows runtime config without secrets', async () => {
      const res = await request(port, 'GET', '/identity');
      expect(res.body).toContain('test-model');
      expect(res.body).not.toContain('discordToken');
    });
  });

  describe('Settings', () => {
    it('returns settings page with config info', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Settings');
      expect(res.body).toContain('Models');
      expect(res.body).toContain('Token Limits');
      expect(res.body).toContain('Memory');
      expect(res.body).toContain('Sessions');
      expect(res.body).toContain('Secrets');
    });

    it('shows model configuration in form', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.body).toContain('test-model');
      expect(res.body).toContain('test-extract');
      expect(res.body).toContain('name="primaryModel"');
    });

    it('shows memory settings', async () => {
      const res = await request(port, 'GET', '/settings');
      expect(res.body).toContain('Retrieval Limit');
      expect(res.body).toContain('Extraction Interval');
      expect(res.body).toContain('Salience Floor');
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

    it('rejects invalid settings values', async () => {
      const body = 'primaryMaxTokens=100';  // min 256
      const res = await request(port, 'POST', '/api/settings', body, {
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('primaryMaxTokens');
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
    });
  });

  describe('Events', () => {
    it('returns events page', async () => {
      const res = await request(port, 'GET', '/events');
      expect(res.status).toBe(200);
      expect(res.body).toContain('Garden Pulse');
      expect(res.body).toContain('sse-connect');
    });

    it('SSE endpoint returns correct headers', async () => {
      const res = await sseRequest(port, '/events/stream');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');
    }, 5000);
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

    port = 30000 + Math.floor(Math.random() * 10000);
    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
    server = new AdminServer({
      port,
      token: 'test-admin-secret',
      memoryStore: new MemoryStore(db, 3),
      sessionStore: new SessionStore(sessionsDir),
      sessionManager: new SessionManager(new SessionStore(sessionsDir), testConfig),
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
});

describe('AdminServer with contacts', () => {
  let tempDir: string;
  let db: Database.Database;
  let eventBus: EventBus;
  let contactStore: ContactStore;
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

    port = 30000 + Math.floor(Math.random() * 10000);
    const mockLlmProvider = { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProvider;
    server = new AdminServer({
      port,
      memoryStore: new MemoryStore(db, 3),
      sessionStore: new SessionStore(sessionsDir),
      sessionManager: new SessionManager(new SessionStore(sessionsDir), testConfig),
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

    const body = 'trustLevel=trusted&relationshipType=friend&notes=A+good+friend';
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

  it('returns empty for edit form of non-existent contact', async () => {
    const res = await request(port, 'GET', '/api/contacts/nonexistent/edit');
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
  });
});
