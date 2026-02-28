import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { SubstrateConfig } from '../../types.js';
import type { CharacterCardV2 } from '../../identity/types.js';
import type { EmbeddingService, LLMProvider } from '../../agent/contracts.js';

function request(
  port: number,
  method: string,
  path: string,
  body?: string,
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
  const token = 'test-admin-token';
  const authHeaders = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'admin-api-test-'));
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
  });

  it('enforces auth on JSON API routes', async () => {
    const unauthorized = await request(port, 'GET', '/api/admin/dashboard');
    expect(unauthorized.status).toBe(401);

    const authorized = await request(port, 'GET', '/api/admin/dashboard', undefined, authHeaders);
    expect(authorized.status).toBe(200);
    const payload = JSON.parse(authorized.body) as { stats: { memoryTotal: number } };
    expect(payload.stats.memoryTotal).toBeGreaterThanOrEqual(0);
  });

  it('supports memory list/detail/search/supersede endpoints', async () => {
    memoryStore.insertMemory({
      id: 'api-mem-1',
      text: 'API semantic memory one',
      type: 'semantic',
      importance: 0.7,
      confidence: 0.9,
      emotionalValence: 0.1,
      salience: 0.5,
      sourceRef: 'api:test:1',
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
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
      extractedAt: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
      tags: ['api'],
      sensitivity: 'personal',
    }, new Float32Array([0.2, 0.3, 0.4]));

    const listRes = await request(port, 'GET', '/api/admin/memory?limit=1&offset=1', undefined, authHeaders);
    expect(listRes.status).toBe(200);
    const listPayload = JSON.parse(listRes.body) as { memories: Array<{ id: string }> };
    expect(listPayload.memories).toHaveLength(1);

    const filteredRes = await request(port, 'GET', '/api/admin/memory?type=semantic', undefined, authHeaders);
    expect(filteredRes.status).toBe(200);
    const filteredPayload = JSON.parse(filteredRes.body) as { memories: Array<{ type: string }> };
    expect(filteredPayload.memories.every(memory => memory.type === 'semantic')).toBe(true);

    const detailRes = await request(port, 'GET', '/api/admin/memory/api-mem-1', undefined, authHeaders);
    expect(detailRes.status).toBe(200);
    const detailPayload = JSON.parse(detailRes.body) as { memory: { id: string } };
    expect(detailPayload.memory.id).toBe('api-mem-1');

    const searchRes = await request(port, 'GET', '/api/admin/memory/search?q=memory', undefined, authHeaders);
    expect(searchRes.status).toBe(200);
    const searchPayload = JSON.parse(searchRes.body) as { results: Array<{ id: string }> };
    expect(searchPayload.results.length).toBeGreaterThan(0);

    const deleteRes = await request(port, 'DELETE', '/api/admin/memory/api-mem-2', undefined, authHeaders);
    expect(deleteRes.status).toBe(200);
    expect(memoryStore.getById('api-mem-2')?.supersededBy).toMatch(/^admin-/);

    const missingDelete = await request(port, 'DELETE', '/api/admin/memory/missing-id', undefined, authHeaders);
    expect(missingDelete.status).toBe(404);

    const badType = await request(port, 'GET', '/api/admin/memory?type=not-a-type', undefined, authHeaders);
    expect(badType.status).toBe(400);
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

  it('renders memory page with bulk and link UI wiring', async () => {
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

    const pageRes = await request(
      port,
      'GET',
      '/memory',
      undefined,
      { Authorization: `Bearer ${token}` },
    );

    expect(pageRes.status).toBe(200);
    expect(pageRes.body).toContain('id="memory-admin-actions"');
    expect(pageRes.body).toContain('data-memory-select-all');
    expect(pageRes.body).toContain('data-memory-select value="ui-memory-1"');
    expect(pageRes.body).toContain('data-memory-bulk-delete');
    expect(pageRes.body).toContain('data-memory-bulk-update');
    expect(pageRes.body).toContain('data-memory-link-form');
    expect(pageRes.body).toContain('data-memory-links-load-form');
    expect(pageRes.body).toContain('/api/admin/memory/bulk-delete');
    expect(pageRes.body).toContain('/api/admin/memory/bulk-update');
    expect(pageRes.body).toContain('/api/admin/memory/link');
    expect(pageRes.body).toContain('/api/admin/memory/');
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
      authorName: 'Purrsephone',
      timestamp: Date.now() + 1,
      channelVisibility: 'direct',
    });

    const sessionsRes = await request(port, 'GET', '/api/admin/sessions', undefined, authHeaders);
    expect(sessionsRes.status).toBe(200);
    const sessionsPayload = JSON.parse(sessionsRes.body) as { channels: Array<{ channelId: string }> };
    expect(sessionsPayload.channels.some(channel => channel.channelId === 'api-session')).toBe(true);

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

    const patchRes = await request(
      port,
      'PATCH',
      `/api/admin/contacts/${contact.id}`,
      JSON.stringify({ trustLevel: 'trusted', notes: 'after patch' }),
      authHeaders,
    );
    expect(patchRes.status).toBe(200);
    expect(contactStore.getById(contact.id)?.trustLevel).toBe('trusted');
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
    const settingsPayload = JSON.parse(settingsRes.body) as { config: { sessionMessageLimit: number } };
    expect(settingsPayload.config.sessionMessageLimit).toBe(testConfig.sessionMessageLimit);

    const settingsPatchRes = await request(
      port,
      'PATCH',
      '/api/admin/settings',
      JSON.stringify({ sessionMessageLimit: 55 }),
      authHeaders,
    );
    expect(settingsPatchRes.status).toBe(200);

    const identityRes = await request(port, 'GET', '/api/admin/identity', undefined, authHeaders);
    expect(identityRes.status).toBe(200);
    const identityPayload = JSON.parse(identityRes.body) as { card: { data: { name: string } } };
    expect(identityPayload.card.data.name).toBe('ApiTestBot');

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

    const layerId = promptsPayload.layers[0].id;
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

    const missingPrompt = await request(port, 'GET', '/api/admin/prompts/missing-layer', undefined, authHeaders);
    expect(missingPrompt.status).toBe(404);
  });

  it('records operator-attributed audit entries for /api/admin/identity mutation routes and renders actor labels', async () => {
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

    const eventsRes = await request(port, 'GET', '/events?timeRange=all', undefined, authHeaders);
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.body).toContain('Actor: Operator');
    expect(eventsRes.body).toContain('/api/admin/identity/fields');
    expect(eventsRes.body).toContain('/api/admin/identity/rollback');
    expect(eventsRes.body).toContain('/api/admin/identity/import');
    expect(eventsRes.body).toContain('/api/admin/identity/upload');
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
