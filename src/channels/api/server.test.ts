import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { EventBus } from '../../event-bus.js';
import { ContactStore } from '../../contacts/store.js';
import { ApiServer } from './server.js';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import type { SessionManager } from '../../session/manager.js';
import type { AgentResponse, SubstrateMessage } from '../../types.js';
import type { ApiServerHealthChecks } from './types.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  deriveApiKeyPrincipalId,
  INSECURE_LOCAL_API_PRINCIPAL_ID,
} from '../http/auth.js';
import type {
  VoiceWebSocketCloseReason,
  VoiceWebSocketRuntimeHooks,
} from './voice-websocket.js';

// ── Helpers ──

const WAIT_TIMEOUT_MS = 2_000;

function insecureSessionChannel(sessionId: string): string {
  return `api:${INSECURE_LOCAL_API_PRINCIPAL_ID}:${sessionId}`;
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

function request(
  port: number,
  method: string,
  path: string,
  body?: object,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function streamRequest(
  port: number,
  body: object,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          // Split SSE data lines
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              chunks.push(line.slice(6));
            }
          }
        });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, chunks }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
      const status = response.statusCode ?? 0;
      response.resume();
      reject(new Error(`Unexpected websocket response: ${status}`));
    });

    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

function openWebSocketWithProtocols(
  port: number,
  path: string,
  protocols: string[],
  headers?: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, { headers });
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
      const status = response.statusCode ?? 0;
      response.resume();
      reject(new Error(`Unexpected websocket response: ${status}`));
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

    ws.once('unexpected-response', (_request, response) => {
      cleanup();
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });

    ws.once('open', () => {
      cleanup();
      ws.close();
      reject(new Error('Expected websocket upgrade to fail'));
    });

    ws.once('error', (error) => {
      cleanup();
      reject(error);
    });
  });
}

async function stopServer(server: ApiServer): Promise<void> {
  try {
    await server.stop();
  } catch (error) {
    const message = toErrorMessage(error);
    if (message.includes('ERR_SERVER_NOT_RUNNING') || message.includes('Server is not running')) return;
    throw error;
  }
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function toAuthSubprotocol(apiToken: string): string {
  const encoded = Buffer.from(apiToken, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `auth.b64.${encoded}`;
}

// ── Mocks ──

function createMockAgentLoop(eventBus: EventBus): SubstrateAgent {
  return {
    handleMessage: vi.fn(async (msg) => {
      // Emit stream deltas for streaming tests
      await eventBus.emit('agent.stream.delta', { channelId: msg.channelId, text: 'Hello' });
      await eventBus.emit('agent.stream.delta', { channelId: msg.channelId, text: ' world' });
      return {
        content: 'Hello world',
        channelId: msg.channelId,
        metadata: { model: 'test-model', inputTokens: 10, outputTokens: 5, durationMs: 42 },
      } satisfies AgentResponse;
    }),
  } as unknown as SubstrateAgent;
}

function createMockSessionManager(): SessionManager {
  return {
    getMessageCount: vi.fn(() => 0),
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
  } as unknown as SessionManager;
}

function createVoiceHooksProbe(): {
  probe: {
    opened: string[];
    closed: Array<{ id: string; reason: VoiceWebSocketCloseReason }>;
    messages: string[];
  };
  hooks: VoiceWebSocketRuntimeHooks;
} {
  const probe = {
    opened: [] as string[],
    closed: [] as Array<{ id: string; reason: VoiceWebSocketCloseReason }>,
    messages: [] as string[],
  };

  return {
    probe,
    hooks: {
      onSessionOpen: (session) => {
        probe.opened.push(session.id);
      },
      onSessionClose: (session, reason) => {
        probe.closed.push({ id: session.id, reason });
      },
      onMessage: (_session, data) => {
        probe.messages.push(data);
      },
    },
  };
}

function createHealthyHealthChecks(
  overrides: ApiServerHealthChecks = {},
): ApiServerHealthChecks {
  return {
    memory: () => ({ status: 'healthy', meta: { total: 3 } }),
    llm: () => ({ status: 'healthy', meta: { provider: 'test', model: 'test-model' } }),
    discord: () => ({ status: 'healthy', meta: { accountId: 'discord-bot' } }),
    embeddings: () => ({ status: 'healthy', meta: { dims: 1024 } }),
    scheduler: () => ({ status: 'healthy', meta: { taskCount: 2 } }),
    ...overrides,
  };
}

// ── Tests ──

describe('ApiServer', () => {
  let eventBus: EventBus;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = await allocatePort();
    server = new ApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await stopServer(server);
  });

  describe('channel adapter facets', () => {
    it('exposes prompt/capability metadata for registry integration', () => {
      expect(server.id).toBe('api');
      expect(server.name).toBe('api');
      expect(server.meta.label).toBe('API Server');
      expect(server.capabilities.promptChannelType).toBe('api');
      expect(server.gateway).toBe(server);
      expect(server.prompt.resolveChannelType({
        id: 'msg-1',
        channelId: 'api:session-1',
        channelType: 'api',
        authorId: 'api-user',
        authorName: 'User',
        content: 'hello',
        timestamp: new Date(),
      } satisfies SubstrateMessage)).toBe('api');
    });

    it('routes outbound text through session manager without mutating API routes', async () => {
      const mockSessionMgr = createMockSessionManager();
      const localServer = new ApiServer({
        port: await allocatePort(),
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: mockSessionMgr,
      allowInsecureWithoutAuth: true,
      });

      await localServer.outbound.sendText({ channelId: 'api:facet' }, '  assistant reply  ');
      await localServer.send('api:facet', 'second reply');

      expect(mockSessionMgr.recordAssistantMessage).toHaveBeenCalledWith(
        'api:facet',
        'assistant reply',
      );
      expect(mockSessionMgr.recordAssistantMessage).toHaveBeenCalledWith(
        'api:facet',
        'second reply',
      );
    });
  });

  describe('GET /v1/models', () => {
    it('returns model list', async () => {
      const res = await request(port, 'GET', '/v1/models');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('list');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('psfn');
      expect(body.data[0].object).toBe('model');
      expect(body.data[0].owned_by).toBe('psfn');
    });

    it('returns custom model name', async () => {
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        modelName: 'custom-model',
      });
      await server.init();
      await server.start();

      const res = await request(port, 'GET', '/v1/models');
      const body = JSON.parse(res.body);
      expect(body.data[0].id).toBe('custom-model');
    });
  });

  describe('GET /health', () => {
    it('returns structured healthy subsystem status', async () => {
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        healthChecks: createHealthyHealthChecks(),
      });
      await server.init();
      await server.start();

      const res = await request(port, 'GET', '/health');
      expect(res.status).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(typeof body.checkedAt).toBe('string');
      expect(typeof body.uptimeSeconds).toBe('number');
      expect(body.subsystems.memory.status).toBe('healthy');
      expect(body.subsystems.llm.status).toBe('healthy');
      expect(body.subsystems.discord.status).toBe('healthy');
      expect(body.subsystems.embeddings.status).toBe('healthy');
      expect(body.subsystems.scheduler.status).toBe('healthy');
      expect(typeof body.subsystems.llm.meta.checkLatencyMs).toBe('number');
      expect(typeof body.subsystems.embeddings.meta.checkLatencyMs).toBe('number');
    });

    it('returns degraded health when any subsystem check fails', async () => {
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        healthChecks: createHealthyHealthChecks({
          llm: () => {
            throw new Error('LLM provider timeout');
          },
        }),
      });
      await server.init();
      await server.start();

      const res = await request(port, 'GET', '/health');
      expect(res.status).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('degraded');
      expect(body.subsystems.llm.status).toBe('degraded');
      expect(body.subsystems.llm.detail).toContain('LLM provider timeout');
      expect(typeof body.subsystems.llm.meta.checkLatencyMs).toBe('number');
      expect(body.subsystems.memory.status).toBe('healthy');
      expect(body.subsystems.discord.status).toBe('healthy');
      expect(body.subsystems.embeddings.status).toBe('healthy');
      expect(body.subsystems.scheduler.status).toBe('healthy');
    });
  });

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('returns valid OpenAI response shape', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('chat.completion');
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe('psfn');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBe('Hello world');
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.completion_tokens).toBe(5);
      expect(body.usage.total_tokens).toBe(15);
    });

    it('binds author identity to the local insecure principal and ignores spoofed headers', async () => {
      await server.stop();
      const mockAgent = createMockAgentLoop(eventBus);
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Hello' }],
      }, {
        'X-User-ID': 'v-primary',
        'X-User-Name': 'V',
      });
      expect(res.status).toBe(200);

      const call = (mockAgent.handleMessage as any).mock.calls[0][0];
      expect(call.authorId).toBe(INSECURE_LOCAL_API_PRINCIPAL_ID);
      expect(call.authorName).toBe('Local API Principal');
    });

    it('passes direct-provider, prompt, and style overrides to substrate messages', async () => {
      await server.stop();
      const mockAgent = createMockAgentLoop(eventBus);
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'claude-opus-4',
        provider: 'anthropic',
        system_prompt_mode: 'none',
        response_style: 'concise',
        messages: [{ role: 'user', content: 'Talk with PSFN.' }],
      });
      expect(res.status).toBe(200);

      const call = (mockAgent.handleMessage as any).mock.calls[0][0] as SubstrateMessage;
      expect(call.routing?.modelOverride).toEqual({
        provider: 'anthropic',
        model: 'claude-opus-4',
      });
      expect(call.routing?.promptOverride).toEqual({
        mode: 'none',
      });
      expect(call.routing?.responseStyle).toBe('concise');
    });

    it('rejects invalid response_style overrides', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        response_style: 'verbose',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('response_style must be one of');
    });

    it('rejects provider overrides outside the direct-provider allowlist', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        messages: [{ role: 'user', content: 'This should be rejected.' }],
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('provider override must be one of');
    });

    it('rejects caller-provided primary trust fields in API payloads', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        trustLevel: 'primary',
        contact: { trust_level: 'primary' },
        messages: [{ role: 'user', content: 'attempt privilege escalation' }],
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('primary trust level');
    });

    it('returns explicit verification challenge and does not link unverified identity claims', async () => {
      const db = new Database(':memory:');
      const contactStore = new ContactStore(db);
      const contact = contactStore.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
      });

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        contactStore,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'hello with claim' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
      });

      expect(res.status).toBe(428);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('identity_verification_required');
      expect(body.error.details?.verification?.nonce).toBeTruthy();
      expect(body.error.details?.verification?.expiresAt).toBeTruthy();
      expect(body.error.details?.verification?.signature).toBeTruthy();
      expect(body.error.details?.verification?.targetUserId).toBe(INSECURE_LOCAL_API_PRINCIPAL_ID);
      expect(contactStore.getByChannelIdentity('api', INSECURE_LOCAL_API_PRINCIPAL_ID)).toBeUndefined();

      db.close();
    });

    it('links claimed identity after challenge verification and rejects replayed proof', async () => {
      const db = new Database(':memory:');
      const contactStore = new ContactStore(db);
      const contact = contactStore.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
      });

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        contactStore,
      });
      await server.init();
      await server.start();

      const initial = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'claim me' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
      });
      const initialBody = JSON.parse(initial.body);
      const verification = initialBody.error.details.verification as {
        nonce: string;
        expiresAt: string;
        signature: string;
      };

      const verified = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'claim me verified' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
        'X-Identity-Claim-Nonce': verification.nonce,
        'X-Identity-Claim-Expires': verification.expiresAt,
        'X-Identity-Claim-Signature': verification.signature,
      });

      expect(verified.status).toBe(200);
      expect(contactStore.getByChannelIdentity('api', INSECURE_LOCAL_API_PRINCIPAL_ID)?.id).toBe(contact.id);

      const replay = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'replay proof' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
        'X-Identity-Claim-Nonce': verification.nonce,
        'X-Identity-Claim-Expires': verification.expiresAt,
        'X-Identity-Claim-Signature': verification.signature,
      });

      expect(replay.status).toBe(409);
      expect(JSON.parse(replay.body).error.type).toBe('identity_verification_replayed');

      db.close();
    });

    it('rejects expired and spoofed identity claim verification attempts', async () => {
      const db = new Database(':memory:');
      const contactStore = new ContactStore(db);
      const contact = contactStore.upsert({
        displayName: 'PrimaryUser',
        channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
      });

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        contactStore,
      });
      await server.init();
      await server.start();

      const spoofed = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'spoofed claim' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'not-linked-user',
      });
      expect(spoofed.status).toBe(403);
      expect(JSON.parse(spoofed.body).error.type).toBe('identity_claim_source_not_linked');

      const initial = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'issue challenge' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
      });
      const initialBody = JSON.parse(initial.body);
      const verification = initialBody.error.details.verification as {
        nonce: string;
        expiresAt: string;
        signature: string;
      };

      const expiredAt = new Date(Date.now() - 60_000).toISOString();
      db.prepare(`
        UPDATE contact_identity_link_verifications
        SET expires_at = ?
        WHERE nonce = ?
      `).run(expiredAt, verification.nonce);

      const expired = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'use expired challenge' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'user-discord',
        'X-Identity-Claim-Nonce': verification.nonce,
        'X-Identity-Claim-Expires': expiredAt,
        'X-Identity-Claim-Signature': verification.signature,
      });

      expect(expired.status).toBe(410);
      expect(JSON.parse(expired.body).error.type).toBe('identity_verification_expired');

      db.close();
    });

    it('returns 400 for missing messages', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
    });

    it('returns 400 for empty messages array', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid JSON', async () => {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } },
          (r) => {
            let data = '';
            r.on('data', (c: Buffer) => { data += c.toString(); });
            r.on('end', () => resolve({ status: r.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.write('not json');
        req.end();
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_json');
    });

    it('queues same-session in-flight contention and runs requests in order', async () => {
      const deferred = createDeferred<AgentResponse>();
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockImplementationOnce(async () => ({
            content: 'Second done',
            channelId: insecureSessionChannel('same-session'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          })),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'First' }],
      }, { 'X-Session-ID': 'same-session' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Second' }],
      }, { 'X-Session-ID': 'same-session' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);

      deferred.resolve({
        content: 'First done',
        channelId: insecureSessionChannel('same-session'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

      const first = await firstRequest;
      const second = await secondRequest;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(2);
      expect(JSON.parse(second.body).choices[0].message.content).toBe('Second done');
    });

    it('emits queue telemetry for queued API contention', async () => {
      const deferred = createDeferred<AgentResponse>();
      const queueEvents: Array<Record<string, unknown>> = [];
      eventBus.on('channel.queue.telemetry', (event) => {
        queueEvents.push(event as unknown as Record<string, unknown>);
      });
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockImplementationOnce(async () => ({
            content: 'Second telemetry turn',
            channelId: insecureSessionChannel('queue-telemetry'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          })),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'First telemetry turn' }],
      }, { 'X-Session-ID': 'queue-telemetry' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Second telemetry turn' }],
      }, { 'X-Session-ID': 'queue-telemetry' });

      await new Promise(resolve => setTimeout(resolve, 20));
      deferred.resolve({
        content: 'First telemetry done',
        channelId: insecureSessionChannel('queue-telemetry'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

      await firstRequest;
      await secondRequest;

      expect(queueEvents.some(event =>
        event.phase === 'contended'
        && event.policy === 'queue'
        && event.source === 'api'
        && event.channelId === insecureSessionChannel('queue-telemetry')
      )).toBe(true);
      expect(queueEvents.some(event =>
        event.phase === 'acquired'
        && event.policy === 'queue'
        && event.source === 'api'
      )).toBe(true);
      expect(queueEvents.some(event =>
        event.phase === 'released'
        && event.policy === 'queue'
        && event.source === 'api'
      )).toBe(true);
    });

    it('returns timeout error and recovers after in-flight settles', async () => {
      const deferred = createDeferred<AgentResponse>();
      const abortSpy = vi.fn();
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockImplementation(async () => ({
            content: 'Recovered',
            channelId: insecureSessionChannel('timeout-session'),
            metadata: { model: 'test', inputTokens: 2, outputTokens: 2, durationMs: 2 },
          })),
        abort: abortSpy,
      } as unknown as SubstrateAgent;

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        requestTimeoutMs: 40,
      });
      await server.init();
      await server.start();

      const timedOut = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Long task' }],
      }, { 'X-Session-ID': 'timeout-session' });

      expect(timedOut.status).toBe(504);
      expect(JSON.parse(timedOut.body).error.type).toBe('request_timeout');
      expect(abortSpy).toHaveBeenCalledTimes(1);

      const queuedTimeout = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Retry too soon' }],
      }, { 'X-Session-ID': 'timeout-session' });
      expect(queuedTimeout.status).toBe(504);
      expect(JSON.parse(queuedTimeout.body).error.type).toBe('request_timeout');
      expect(abortSpy).toHaveBeenCalledTimes(1);

      deferred.resolve({
        content: 'Recovered from first',
        channelId: insecureSessionChannel('timeout-session'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });
      await new Promise(resolve => setTimeout(resolve, 10));

      const recovered = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Retry after settle' }],
      }, { 'X-Session-ID': 'timeout-session' });
      expect(recovered.status).toBe(200);
      expect(JSON.parse(recovered.body).choices[0].message.content).toBe('Recovered');
    });

    it('maps agent concurrency error to explicit busy status', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async () => {
          throw new Error('Agent is already processing a prompt');
        }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'hello' }],
      });

      expect(res.status).toBe(503);
      expect(JSON.parse(res.body).error.type).toBe('agent_busy');
    });

    it('handles client disconnect without poisoning subsequent turns', async () => {
      const deferred = createDeferred<AgentResponse>();
      const abortSpy = vi.fn();
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockImplementation(async () => ({
            content: 'After disconnect',
            channelId: insecureSessionChannel('disconnect-session'),
            metadata: { model: 'test', inputTokens: 2, outputTokens: 3, durationMs: 5 },
          })),
        abort: abortSpy,
      } as unknown as SubstrateAgent;

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        const payload = JSON.stringify({
          model: 'psfn',
          messages: [{ role: 'user', content: 'disconnect me' }],
        });
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/chat/completions',
            headers: {
              'Content-Type': 'application/json',
              'X-Session-ID': 'disconnect-session',
            },
          },
          () => {
            // no-op: client disconnects before reading
          },
        );
        req.on('error', finish);
        req.on('close', finish);
        req.write(payload);
        req.end();
        setTimeout(() => req.destroy(), 10);
        setTimeout(finish, 200);
      });

      const queuedRecovery = request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'still running' }],
      }, { 'X-Session-ID': 'disconnect-session' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);

      deferred.resolve({
        content: 'disconnected done',
        channelId: insecureSessionChannel('disconnect-session'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });
      const queued = await queuedRecovery;
      expect(queued.status).toBe(200);
      expect(JSON.parse(queued.body).choices[0].message.content).toBe('After disconnect');
      expect(abortSpy).toHaveBeenCalledTimes(1);

      const recovered = await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [{ role: 'user', content: 'normal turn' }],
      }, { 'X-Session-ID': 'disconnect-session' });
      expect(recovered.status).toBe(200);
      expect(JSON.parse(recovered.body).choices[0].message.content).toBe('After disconnect');
    });
  });

  describe('POST /v1/chat/completions (streaming)', () => {
    it('returns proper SSE format', async () => {
      const res = await streamRequest(port, {
        model: 'psfn',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');

      // chunks: role, "Hello", " world", finish, [DONE]
      expect(res.chunks.length).toBeGreaterThanOrEqual(4);

      // First chunk has role
      const roleChunk = JSON.parse(res.chunks[0]);
      expect(roleChunk.object).toBe('chat.completion.chunk');
      expect(roleChunk.choices[0].delta.role).toBe('assistant');

      // Content chunks
      const contentChunk = JSON.parse(res.chunks[1]);
      expect(contentChunk.choices[0].delta.content).toBe('Hello');

      // Last data chunk before [DONE] has finish_reason: "stop"
      const finishChunk = JSON.parse(res.chunks[res.chunks.length - 2]);
      expect(finishChunk.choices[0].finish_reason).toBe('stop');

      // Final signal
      expect(res.chunks[res.chunks.length - 1]).toBe('[DONE]');
    });
  });

  describe('body size limit', () => {
    it('returns 413 for body exceeding 1MB', async () => {
      const oversizedBody = 'x'.repeat(1_048_576 + 1);
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json' } },
          (r) => {
            let data = '';
            r.on('data', (c: Buffer) => { data += c.toString(); });
            r.on('end', () => resolve({ status: r.statusCode!, body: data }));
          },
        );
        req.on('error', reject);
        req.write(oversizedBody);
        req.end();
      });
      expect(res.status).toBe(413);
      expect(res.body).toBe('Payload Too Large');
    });
  });

  describe('CORS', () => {
    it('does not emit wildcard CORS headers by default', async () => {
      const res = await request(port, 'GET', '/v1/models');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('rejects preflight from non-allowlisted origins', async () => {
      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.type).toBe('cors_origin_not_allowed');
    });

    it('allows preflight when origin is in API_CORS_ALLOWLIST', async () => {
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: ['https://console.example'],
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Origin: 'https://console.example',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://console.example');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('X-Session-ID');
    });
  });

  describe('GET /v1/voice/ws (websocket upgrade)', () => {
    it('accepts websocket upgrades and forwards messages to runtime hooks', async () => {
      const voice = createVoiceHooksProbe();

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        voiceWebSocketHooks: voice.hooks,
      });
      await server.init();
      await server.start();

      const ws = await openWebSocket(port, '/v1/voice/ws');
      ws.send('voice-frame-1');
      await waitFor(() => voice.probe.messages.includes('voice-frame-1'));

      ws.close();
      await waitFor(() => voice.probe.closed.length === 1);

      expect(voice.probe.opened).toHaveLength(1);
      expect(voice.probe.closed[0]).toEqual({
        id: voice.probe.opened[0],
        reason: 'client_disconnect',
      });
    });

    it('returns 404 for websocket upgrades on unknown paths', async () => {
      const status = await openWebSocketExpectStatus(port, '/v1/unknown');
      expect(status).toBe(404);
    });

    it('closes active voice websocket sessions on stop()', async () => {
      const voice = createVoiceHooksProbe();

      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
        voiceWebSocketHooks: voice.hooks,
      });
      await server.init();
      await server.start();

      const ws = await openWebSocket(port, '/v1/voice/ws');
      let closeCode: number | undefined;
      const closePromise = new Promise<void>((resolve) => {
        ws.once('close', (code) => {
          closeCode = code;
          resolve();
        });
      });

      await server.stop();
      await closePromise;
      await waitFor(() => voice.probe.closed.some((entry) => entry.reason === 'shutdown'));

      expect(closeCode).toBe(1012);
    });
  });

  describe('404', () => {
    it('returns 404 for unknown routes', async () => {
      const res = await request(port, 'GET', '/v1/unknown');
      expect(res.status).toBe(404);
    });
  });

  describe('session seeding', () => {
    it('seeds prior messages into session for new channel', async () => {
      const mockSessionMgr = createMockSessionManager();
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: mockSessionMgr,
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' },
        ],
      }, { 'X-Session-ID': 'test-seed' });

      // Prior messages (first two) should be seeded, last user message handled by agentLoop
      expect(mockSessionMgr.recordUserMessage).toHaveBeenCalledWith(
        insecureSessionChannel('test-seed'),
        'First message',
        INSECURE_LOCAL_API_PRINCIPAL_ID,
        'Local API Principal',
      );
      expect(mockSessionMgr.recordAssistantMessage).toHaveBeenCalledWith(
        insecureSessionChannel('test-seed'),
        'First response',
      );
    });

    it('ignores spoofed author headers when seeding prior user messages', async () => {
      const mockSessionMgr = createMockSessionManager();
      await server.stop();
      server = new ApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: mockSessionMgr,
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      await request(port, 'POST', '/v1/chat/completions', {
        model: 'psfn',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' },
        ],
      }, {
        'X-Session-ID': 'test-seed-headers',
        'X-User-ID': 'v-primary',
        'X-User-Name': 'V',
      });

      expect(mockSessionMgr.recordUserMessage).toHaveBeenCalledWith(
        insecureSessionChannel('test-seed-headers'),
        'First message',
        INSECURE_LOCAL_API_PRINCIPAL_ID,
        'Local API Principal',
      );
    });
  });

  describe('POST /v1/telemetry/ingest', () => {
    it('requires apiKey to be configured', async () => {
      const res = await request(port, 'POST', '/v1/telemetry/ingest', {
        source: 'sensor-a',
        eventType: 'external.telemetry.heartbeat',
        timestamp: new Date().toISOString(),
        nonce: 'nonce-telemetry-1',
        payload: { status: 'ok' },
      });

      expect(res.status).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('telemetry_auth_unconfigured');
    });
  });
});

describe('ApiServer startup auth guard', () => {
  it('fails startup without API key unless insecure local mode is explicit', async () => {
    const eventBus = new EventBus();
    const port = await allocatePort();
    const server = new ApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
    });
    await server.init();

    await expect(server.start()).rejects.toThrow(
      'API_KEY is required unless ALLOW_INSECURE_LOCAL_API=true',
    );
  });

  it('rejects insecure local mode when API_HOST is not loopback', async () => {
    const eventBus = new EventBus();
    const port = await allocatePort();
    const server = new ApiServer({
      port,
      host: '0.0.0.0',
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
    });
    await server.init();

    await expect(server.start()).rejects.toThrow(
      'ALLOW_INSECURE_LOCAL_API=true requires API_HOST to be loopback',
    );
  });
});

describe('ApiServer with auth', () => {
  let eventBus: EventBus;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = await allocatePort();
    server = new ApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await stopServer(server);
  });

  it('rejects requests without auth', async () => {
    const res = await request(port, 'GET', '/v1/models');
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('invalid_api_key');
  });

  it('rejects requests with wrong key', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      Authorization: 'Bearer wrong-key',
    });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct key', async () => {
    const res = await request(port, 'GET', '/v1/models', undefined, {
      Authorization: 'Bearer test-secret-key',
    });
    expect(res.status).toBe(200);
  });

  it('binds message identity to authenticated principal and ignores spoofed user headers', async () => {
    await server.stop();
    const mockAgent = createMockAgentLoop(eventBus);
    server = new ApiServer({
      port,
      agentLoop: mockAgent,
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: 'psfn',
      messages: [{ role: 'user', content: 'identity test' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-User-ID': 'spoofed-user',
      'X-User-Name': 'Spoof Name',
      'X-Session-ID': 'identity-session',
    });
    expect(res.status).toBe(200);

    const principalId = deriveApiKeyPrincipalId('test-secret-key');
    const call = (mockAgent.handleMessage as any).mock.calls[0][0];
    expect(call.authorId).toBe(principalId);
    expect(call.authorName).toBe('API Principal');
    expect(call.channelId).toBe(`api:${principalId}:identity-session`);
  });

  it('binds identity claims to the authenticated principal and prevents X-User-ID spoofing', async () => {
    const db = new Database(':memory:');
    const contactStore = new ContactStore(db);
    const contact = contactStore.upsert({
      displayName: 'PrimaryUser',
      channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
    });

    await server.stop();
    server = new ApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      contactStore,
    });
    await server.init();
    await server.start();

    const principalId = deriveApiKeyPrincipalId('test-secret-key');
    const challenge = await request(port, 'POST', '/v1/chat/completions', {
      model: 'psfn',
      messages: [{ role: 'user', content: 'claim identity' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-User-ID': 'spoofed-a',
      'X-Canonical-Contact-ID': contact.id,
      'X-Identity-Claim-Channel': 'discord',
      'X-Identity-Claim-User-ID': 'user-discord',
    });
    expect(challenge.status).toBe(428);
    const challengeBody = JSON.parse(challenge.body);
    expect(challengeBody.error.details?.verification?.targetUserId).toBe(principalId);

    const verification = challengeBody.error.details.verification as {
      nonce: string;
      expiresAt: string;
      signature: string;
    };
    const verified = await request(port, 'POST', '/v1/chat/completions', {
      model: 'psfn',
      messages: [{ role: 'user', content: 'claim identity verified' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-User-ID': 'spoofed-b',
      'X-Canonical-Contact-ID': contact.id,
      'X-Identity-Claim-Channel': 'discord',
      'X-Identity-Claim-User-ID': 'user-discord',
      'X-Identity-Claim-Nonce': verification.nonce,
      'X-Identity-Claim-Expires': verification.expiresAt,
      'X-Identity-Claim-Signature': verification.signature,
    });
    expect(verified.status).toBe(200);
    expect(contactStore.getByChannelIdentity('api', principalId)?.id).toBe(contact.id);
    expect(contactStore.getByChannelIdentity('api', 'spoofed-a')).toBeUndefined();
    expect(contactStore.getByChannelIdentity('api', 'spoofed-b')).toBeUndefined();

    db.close();
  });

  it('allows OPTIONS without auth (CORS preflight)', async () => {
    const res = await request(port, 'OPTIONS', '/v1/chat/completions');
    expect(res.status).toBe(204);
  });

  it('rejects websocket upgrades without auth', async () => {
    const status = await openWebSocketExpectStatus(port, '/v1/voice/ws');
    expect(status).toBe(401);
  });

  it('rejects websocket upgrades with wrong key', async () => {
    const status = await openWebSocketExpectStatus(port, '/v1/voice/ws', {
      Authorization: 'Bearer wrong-key',
    });
    expect(status).toBe(401);
  });

  it('rejects websocket upgrades with api_key query token', async () => {
    const status = await openWebSocketExpectStatus(port, '/v1/voice/ws?api_key=test-secret-key');
    expect(status).toBe(401);
  });

  it('rejects websocket upgrades with token query token', async () => {
    const status = await openWebSocketExpectStatus(port, '/v1/voice/ws?token=test-secret-key');
    expect(status).toBe(401);
  });

  it('rejects websocket upgrades with wrong query token', async () => {
    const status = await openWebSocketExpectStatus(port, '/v1/voice/ws?api_key=wrong-key');
    expect(status).toBe(401);
  });

  it('accepts websocket upgrades with correct key', async () => {
    const ws = await openWebSocket(port, '/v1/voice/ws', {
      Authorization: 'Bearer test-secret-key',
    });
    ws.close();
  });

  it('accepts websocket upgrades with secure auth subprotocol token', async () => {
    const ws = await openWebSocketWithProtocols(
      port,
      '/v1/voice/ws',
      ['voice-wire-v1', toAuthSubprotocol('test-secret-key')],
    );
    ws.close();
  });

  it('rejects telemetry ingestion without auth', async () => {
    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.heartbeat',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-telemetry-auth',
      payload: { status: 'ok' },
    });

    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('invalid_api_key');
  });

  it('rejects telemetry payloads that fail schema validation', async () => {
    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.heartbeat',
      timestamp: new Date().toISOString(),
      payload: { status: 'ok' },
    } as any, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('invalid_request');
  });

  it('rejects telemetry payloads with invalid JSON bodies', async () => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/telemetry/ingest',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-secret-key',
          },
        },
        (response) => {
          let data = '';
          response.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          response.on('end', () => resolve({ status: response.statusCode!, body: data }));
        },
      );
      req.on('error', reject);
      req.write('{bad json');
      req.end();
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('invalid_json');
  });

  it('rejects telemetry event types outside the allowlist', async () => {
    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.exec_shell',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-telemetry-unsafe',
      payload: { cmd: 'rm -rf /' },
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('event_type_not_allowed');
  });

  it('ingests valid telemetry and emits normalized EventBus event', async () => {
    const seen: Array<any> = [];
    eventBus.on('external.telemetry.ingested', ({ event }) => {
      seen.push(event);
    });

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.heartbeat',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-telemetry-ok',
      payload: { status: 'green', load: 0.42 },
      channelId: 'ops-room',
      scope: 'cluster-a',
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.acceptedEventType).toBe('external.telemetry.heartbeat');
    expect(typeof body.id).toBe('string');

    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe(body.id);
    expect(seen[0].source).toBe('sensor-a');
    expect(seen[0].eventType).toBe('external.telemetry.heartbeat');
    expect(seen[0].payload).toEqual({ status: 'green', load: 0.42 });
    expect(seen[0].channelId).toBe('ops-room');
    expect(seen[0].scope).toBe('cluster-a');
    expect(seen[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(seen[0].receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('rejects replayed telemetry nonces', async () => {
    const body = {
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce: 'nonce-telemetry-replay',
      payload: { state: 'ok' },
    };

    const first = await request(port, 'POST', '/v1/telemetry/ingest', body, {
      Authorization: 'Bearer test-secret-key',
    });
    const second = await request(port, 'POST', '/v1/telemetry/ingest', body, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.error.type).toBe('replay_detected');
  });
});
