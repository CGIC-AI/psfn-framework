import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import WebSocket from 'ws';
import Database from 'better-sqlite3';
import { EventBus } from '../../shared/event-bus.js';
import { ContactStore } from '../../core/contacts/store.js';
import { ApiServer } from './server.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { AgentResponse, IntentionalNoReplyMetadata, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { ApiServerHealthChecks } from './types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { DEFAULT_COMPANION_ID } from '../../core/identity/companion-naming.js';
import {
  deriveApiKeyPrincipalId,
  INSECURE_LOCAL_API_PRINCIPAL_ID,
} from '../backplane/http/auth.js';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { resolveApiCorsAllowedOrigins } from './http-policy.js';
import type {
  VoiceWebSocketCloseReason,
  VoiceWebSocketRuntimeHooks,
} from './voice-websocket.js';

// ── Helpers ──

const WAIT_TIMEOUT_MS = 2_000;

const SATELLITE_TEST_REGISTRY = parseSatelliteRegistryConfig({
  schemaVersion: 1,
  enabled: true,
  satellites: [
    {
      satelliteId: 'android-phone',
      displayName: 'Android Mobile Satellite',
      mobility: 'mobile',
      endpoints: [
        {
          endpointId: 'companion-app',
          displayName: 'Companion App',
          claimTypes: ['android-mobile'],
          promptChannelType: 'mobile_satellite',
          auth: { mode: 'api_key' },
          defaultIdentity: {
            authorId: 'primary-user',
            authorName: 'Primary User',
            canonicalContactId: 'contact-primary-user',
            channelPrivacy: 'private',
          },
          maxCapabilities: [
            'text',
            'audio_input',
            'speech_to_text',
            'audio_output',
            'text_to_speech',
            'vision',
            'image_upload',
            'location',
          ],
          telemetryScopes: ['location', 'timezone', 'presence'],
          runtime: {
            schemaVersion: 1,
            transport: {
              mode: 'openhome_bridge',
            },
            audio: {
              inputDevice: 'plughw:1,0',
              outputDevice: 'default',
              sampleRateHz: 16000,
              channelCount: 1,
              frameMs: 20,
            },
            refresh: {
              intervalMs: 300000,
              jitterMs: 30000,
              restartPolicy: 'restart_on_runtime_change',
              restartGraceMs: 5000,
            },
          },
        },
      ],
    },
  ],
});

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

interface ParsedSseEvent {
  event: string;
  data: string;
}

function parseSseFrame(frame: string): ParsedSseEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join('\n'),
  };
}

function streamRequest(
  port: number,
  body: object,
  headers?: Record<string, string>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  chunks: string[];
  events: ParsedSseEvent[];
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        const chunks: string[] = [];
        const events: ParsedSseEvent[] = [];
        let buffer = '';
        const flushFrame = (frame: string) => {
          const parsed = parseSseFrame(frame);
          if (!parsed) return;
          events.push(parsed);
          if (parsed.event === 'message') {
            chunks.push(parsed.data);
          }
        };
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let frameEnd = buffer.indexOf('\n\n');
          while (frameEnd !== -1) {
            const frame = buffer.slice(0, frameEnd);
            buffer = buffer.slice(frameEnd + 2);
            flushFrame(frame);
            frameEnd = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => {
          if (buffer.trim()) {
            flushFrame(buffer);
          }
          resolve({ status: res.statusCode!, headers: res.headers, chunks, events });
        });
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

function createApiServer(config: ConstructorParameters<typeof ApiServer>[0]): ApiServer {
  return new ApiServer({
    companionId: DEFAULT_COMPANION_ID,
    ...config,
  });
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

function emitQueuedTurnResult(
  eventBus: EventBus,
  message: SubstrateMessage,
  response: AgentResponse,
  deltas: string[] = [],
): void {
  queueMicrotask(() => {
    void (async () => {
      for (const delta of deltas) {
        await eventBus.emit('agent.stream.delta', { channelId: message.channelId, text: delta });
      }
      await eventBus.emit('agent.turn.end', { message, response });
    })();
  });
}

function makeNoReplyMetadata(channelId: string): IntentionalNoReplyMetadata {
  return {
    schemaVersion: 1,
    disposition: 'intentional_no_reply',
    source: 'response_control_tool',
    auditId: `no-reply:test-turn:${channelId}`,
    decidedAt: Date.parse('2026-03-08T12:00:00Z'),
    turnId: '018f0000-0000-7000-9000-000000000001' as IntentionalNoReplyMetadata['turnId'],
    requestId: 'api-no-reply-request',
    channelId,
    toolCallId: 'tool-call-no-reply',
    reason: 'intentional quiet',
  };
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
    server = createApiServer({
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
      const localServer = createApiServer({
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
      expect(body.data[0].id).toBe('companion');
      expect(body.data[0].object).toBe('model');
      expect(body.data[0].owned_by).toBe('psfn');
    });

    it('returns custom model name', async () => {
      await server.stop();
      server = createApiServer({
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

  describe('GET /v1/identity', () => {
    it('returns companion identity and configured Amica contact identity', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        modelName: 'purrsephone',
        companionName: 'Purrsephone',
        externalChannelProfiles: {
          'psfn-amica': {
            authorId: 'admin-user',
            authorName: 'Vega',
            canonicalContactId: 'contact-vega',
            channelPrivacy: 'invite_only',
          },
        },
      });
      await server.init();
      await server.start();

      const res = await request(port, 'GET', '/v1/identity');
      expect(res.status).toBe(200);

      const body = JSON.parse(res.body);
      expect(body).toEqual({
        object: 'psfn.identity',
        companion: {
          id: 'purrsephone',
          name: 'Purrsephone',
        },
        channels: {
          'psfn-amica': {
            user: {
              id: 'admin-user',
              name: 'Vega',
            },
            canonicalContactId: 'contact-vega',
            channelPrivacy: 'invite_only',
          },
        },
      });
    });
  });

  describe('GET /health', () => {
    it('returns structured healthy subsystem status', async () => {
      await server.stop();
      server = createApiServer({
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
      expect(body.continuity.status).toBe('healthy');
      expect(body.subsystems.memory.status).toBe('healthy');
      expect(body.subsystems.llm.status).toBe('healthy');
      expect(body.subsystems.discord.status).toBe('healthy');
      expect(body.subsystems.embeddings.status).toBe('healthy');
      expect(body.subsystems.scheduler.status).toBe('healthy');
      expect(body.continuity.checks.database.status).toBe('healthy');
      expect(body.continuity.checks.gatewayLink.status).toBe('healthy');
      expect(body.continuity.checks.schedulerHealthcheck.status).toBe('healthy');
      expect(typeof body.subsystems.llm.meta.checkLatencyMs).toBe('number');
      expect(typeof body.subsystems.embeddings.meta.checkLatencyMs).toBe('number');
    });

    it('returns degraded health when any subsystem check fails', async () => {
      await server.stop();
      server = createApiServer({
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
      expect(body.continuity.status).toBe('healthy');
      expect(body.subsystems.llm.status).toBe('degraded');
      expect(body.subsystems.llm.detail).toContain('LLM provider timeout');
      expect(typeof body.subsystems.llm.meta.checkLatencyMs).toBe('number');
      expect(body.subsystems.memory.status).toBe('healthy');
      expect(body.subsystems.discord.status).toBe('healthy');
      expect(body.subsystems.embeddings.status).toBe('healthy');
      expect(body.subsystems.scheduler.status).toBe('healthy');
      expect(body.continuity.checks.database.status).toBe('healthy');
      expect(body.continuity.checks.gatewayLink.status).toBe('healthy');
      expect(body.continuity.checks.schedulerHealthcheck.status).toBe('healthy');
    });

    it('degrades health when scheduler healthcheck is stale beyond threshold', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        healthChecks: createHealthyHealthChecks(),
        schedulerHealthcheckStaleAfterMs: 1_000,
      });
      await server.init();
      await server.start();
      await eventBus.emit('schedule.healthcheck', {
        timestamp: Date.now() - 10_000,
        taskCount: 2,
      });

      const res = await request(port, 'GET', '/health');
      expect(res.status).toBe(503);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('degraded');
      expect(body.continuity.status).toBe('degraded');
      expect(body.continuity.checks.schedulerHealthcheck.status).toBe('degraded');
      expect(body.continuity.checks.schedulerHealthcheck.detail).toContain('Scheduler healthcheck stale');
    });

    it('uses fresh schedule.healthcheck events for scheduler continuity health', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        healthChecks: createHealthyHealthChecks(),
        schedulerHealthcheckStaleAfterMs: 1_000,
      });
      await server.init();
      await server.start();

      await eventBus.emit('schedule.healthcheck', {
        timestamp: Date.now(),
        taskCount: 2,
      });

      const res = await request(port, 'GET', '/health');
      expect(res.status).toBe(200);

      const body = JSON.parse(res.body);
      expect(body.status).toBe('healthy');
      expect(body.continuity.status).toBe('healthy');
      expect(body.continuity.checks.schedulerHealthcheck.status).toBe('healthy');
      expect(body.continuity.checks.schedulerHealthcheck.meta.healthcheckObserved).toBe(true);
    });
  });

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('returns valid OpenAI response shape', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('chat.completion');
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe(DEFAULT_COMPANION_ID);
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBe('Hello world');
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.completion_tokens).toBe(5);
      expect(body.usage.total_tokens).toBe(15);
    });

    it('returns an empty completion for structured intentional no-reply responses', async () => {
      await server.stop();
      const mockAgent = {
        handleMessage: vi.fn(async (msg: SubstrateMessage) => ({
          content: '',
          channelId: msg.channelId,
          metadata: {
            model: 'test-model',
            inputTokens: 4,
            outputTokens: 1,
            durationMs: 12,
            noReply: makeNoReplyMetadata(msg.channelId),
          },
        } satisfies AgentResponse)),
      } as unknown as SubstrateAgent;
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Just observe this.' }],
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('');
      expect(body.usage.prompt_tokens).toBe(4);
      expect(body.usage.completion_tokens).toBe(1);
    });

    it('treats literal NO_REPLY API content as ordinary assistant text', async () => {
      await server.stop();
      const mockAgent = {
        handleMessage: vi.fn(async (msg: SubstrateMessage) => ({
          content: 'NO_REPLY',
          channelId: msg.channelId,
          metadata: { model: 'test-model', inputTokens: 2, outputTokens: 1, durationMs: 3 },
        } satisfies AgentResponse)),
      } as unknown as SubstrateAgent;
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Say the marker literally.' }],
      });

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('NO_REPLY');
    });

    it('rejects empty agent output without a no-reply marker', async () => {
      await server.stop();
      const mockAgent = {
        handleMessage: vi.fn(async (msg: SubstrateMessage) => ({
          content: '   ',
          channelId: msg.channelId,
          metadata: { model: 'test-model', inputTokens: 2, outputTokens: 0, durationMs: 3 },
        } satisfies AgentResponse)),
      } as unknown as SubstrateAgent;
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Return nothing.' }],
      });

      expect(res.status).toBe(502);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('model_error');
      expect(body.error.message).toContain('intentional no-reply marker');
    });

    it('binds author identity to the local insecure principal and ignores spoofed headers', async () => {
      await server.stop();
      const mockAgent = createMockAgentLoop(eventBus);
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
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
        messages: [{ role: 'user', content: 'Talk with Companion.' }],
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

    it('passes explicit channel privacy to substrate messages', async () => {
      await server.stop();
      const mockAgent = createMockAgentLoop(eventBus);
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Prepare a public draft.' }],
      }, {
        'X-Channel-Privacy': 'public',
      });
      expect(res.status).toBe(200);

      const call = (mockAgent.handleMessage as any).mock.calls[0][0] as SubstrateMessage;
      expect(call.routing?.channelPrivacy).toBe('public');
    });

    it('rejects the retired broadcast privacy header fail-closed (E3.3: broadcast is a channel-owned flag)', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Prepare a broadcast draft.' }],
      }, {
        'X-Channel-Privacy': 'broadcast',
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid channel privacy headers', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'test' }],
      }, {
        'X-Channel-Privacy': 'friends-only',
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('X-Channel-Privacy');
    });

    it('rejects invalid response_style overrides', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
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
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
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
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
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
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'spoofed claim' }],
      }, {
        'X-Canonical-Contact-ID': contact.id,
        'X-Identity-Claim-Channel': 'discord',
        'X-Identity-Claim-User-ID': 'not-linked-user',
      });
      expect(spoofed.status).toBe(403);
      expect(JSON.parse(spoofed.body).error.type).toBe('identity_claim_source_not_linked');

      const initial = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
    });

    it('returns 400 for empty messages array', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [],
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid message roles', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'tool', content: 'unsupported role' }],
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('messages[0].role');
    });

    it('returns 400 for malformed content parts', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { detail: 'high' } }],
        }],
      });

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
      expect(body.error.message).toContain('messages[0].content[0].image_url.url');
    });

    it('returns 400 for bad stream and max_tokens values', async () => {
      const badStream = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        stream: 'true',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(badStream.status).toBe(400);
      expect(JSON.parse(badStream.body).error.message).toContain('stream must be a boolean');

      const badMaxTokens = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        max_tokens: 0,
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(badMaxTokens.status).toBe(400);
      expect(JSON.parse(badMaxTokens.body).error.message).toContain('max_tokens must be greater than or equal to 1');
    });

    it('accepts valid mixed text and image content parts', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        stream: false,
        max_tokens: 32,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is in these images?' },
            {
              type: 'image_url',
              image_url: {
                url: 'https://images.example.test/current.png',
                detail: 'high',
              },
            },
            {
              type: 'image',
              data: 'iVBORw0KGgo=',
              mimeType: 'image/png',
              name: 'inline.png',
            },
          ],
        }],
      });

      expect(res.status).toBe(200);
      expect(JSON.parse(res.body).choices[0].message.content).toBe('Hello world');
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

    it('queues same-session in-flight contention through follow-up delivery when supported', async () => {
      const deferred = createDeferred<AgentResponse>();
      const mockAgent = {
        handleMessage: vi.fn().mockImplementationOnce(async () => deferred.promise),
        followUp: vi.fn((message: SubstrateMessage) => {
          emitQueuedTurnResult(eventBus, message, {
            content: 'Second done',
            channelId: insecureSessionChannel('same-session'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          });
        }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'First' }],
      }, { 'X-Session-ID': 'same-session' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Second' }],
      }, { 'X-Session-ID': 'same-session' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
      expect(mockAgent.followUp).not.toHaveBeenCalled();

      deferred.resolve({
        content: 'First done',
        channelId: insecureSessionChannel('same-session'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

      const first = await firstRequest;
      const second = await secondRequest;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
      expect(mockAgent.followUp).toHaveBeenCalledTimes(1);
      const queuedFollowUp = (mockAgent.followUp as ReturnType<typeof vi.fn>).mock.calls[0][0] as SubstrateMessage;
      expect(queuedFollowUp.authorId).toBe(INSECURE_LOCAL_API_PRINCIPAL_ID);
      expect(queuedFollowUp.channelId).toBe(insecureSessionChannel('same-session'));
      expect(JSON.parse(second.body).choices[0].message.content).toBe('Second done');
    });

    it('falls back to channel lock delivery when queued same-session follow-up is unavailable', async () => {
      const deferred = createDeferred<AgentResponse>();
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockResolvedValue({
            content: 'Second done',
            channelId: insecureSessionChannel('same-session-fallback'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'First' }],
      }, { 'X-Session-ID': 'same-session-fallback' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Second' }],
      }, { 'X-Session-ID': 'same-session-fallback' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);

      deferred.resolve({
        content: 'First done',
        channelId: insecureSessionChannel('same-session-fallback'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

      const first = await firstRequest;
      const second = await secondRequest;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(2);
      expect(JSON.parse(second.body).choices[0].message.content).toBe('Second done');
    });

    it('does not seed queued session history before the active turn releases the channel', async () => {
      const deferred = createDeferred<AgentResponse>();
      let sessionMessageCount = 0;
      const recordUserMessage = vi.fn(() => {
        sessionMessageCount += 1;
      });
      const recordAssistantMessage = vi.fn(() => {
        sessionMessageCount += 1;
      });
      const mockSessionManager = {
        getMessageCount: vi.fn(() => sessionMessageCount),
        recordUserMessage,
        recordAssistantMessage,
      } as unknown as SessionManager;
      const mockAgent = {
        handleMessage: vi
          .fn()
          .mockImplementationOnce(async () => deferred.promise)
          .mockResolvedValue({
            content: 'Second done',
            channelId: insecureSessionChannel('seed-queue'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: mockSessionManager,
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'First' }],
      }, { 'X-Session-ID': 'seed-queue' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [
          { role: 'assistant', content: 'Queued assistant context' },
          { role: 'user', content: 'Second' },
        ],
      }, { 'X-Session-ID': 'seed-queue' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(recordAssistantMessage).not.toHaveBeenCalled();
      expect(recordUserMessage).not.toHaveBeenCalled();

      deferred.resolve({
        content: 'First done',
        channelId: insecureSessionChannel('seed-queue'),
        metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
      });

      const first = await firstRequest;
      const second = await secondRequest;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(recordAssistantMessage).toHaveBeenCalledTimes(1);
      expect(recordAssistantMessage).toHaveBeenCalledWith(
        insecureSessionChannel('seed-queue'),
        'Queued assistant context',
      );
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
          .mockResolvedValue({
            content: 'Second telemetry turn',
            channelId: insecureSessionChannel('queue-telemetry'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'First telemetry turn' }],
      }, { 'X-Session-ID': 'queue-telemetry' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondRequest = request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
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
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Long task' }],
      }, { 'X-Session-ID': 'timeout-session' });

      expect(timedOut.status).toBe(504);
      expect(JSON.parse(timedOut.body).error.type).toBe('request_timeout');
      expect(abortSpy).toHaveBeenCalledTimes(1);

      const queuedTimeout = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
        followUp: vi.fn((message: SubstrateMessage) => {
          emitQueuedTurnResult(eventBus, message, {
            content: 'After disconnect',
            channelId: insecureSessionChannel('disconnect-session'),
            metadata: { model: 'test', inputTokens: 2, outputTokens: 3, durationMs: 5 },
          });
        }),
        abort: abortSpy,
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
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
          model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
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
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'normal turn' }],
      }, { 'X-Session-ID': 'disconnect-session' });
      expect(recovered.status).toBe(200);
      expect(JSON.parse(recovered.body).choices[0].message.content).toBe('After disconnect');
    });
  });

  describe('POST /v1/chat/completions (streaming)', () => {
    it('returns proper SSE format', async () => {
      const res = await streamRequest(port, {
        model: DEFAULT_COMPANION_ID,
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

    it('emits machine-readable SSE errors for empty streaming agent responses', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async (message: SubstrateMessage) => ({
          content: '',
          channelId: message.channelId,
          metadata: { model: 'test-model', inputTokens: 1, outputTokens: 0, durationMs: 1 },
        })),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await streamRequest(port, {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      expect(res.status).toBe(200);
      const errorEvent = res.events.find((event) => event.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(JSON.parse(errorEvent!.data).error).toMatchObject({
        type: 'empty_response',
        message: 'Agent returned empty content',
      });
      expect(res.chunks[res.chunks.length - 1]).toBe('[DONE]');
      const nonDoneDataChunks = res.chunks.filter((chunk) => chunk !== '[DONE]');
      expect(nonDoneDataChunks.some((chunk) => {
        const parsed = JSON.parse(chunk) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
        return parsed.choices?.some((choice) => (
          choice.delta?.content?.includes('[Error:') === true
          || choice.finish_reason === 'stop'
        )) === true;
      })).toBe(false);
    });

    it('emits machine-readable SSE errors for streaming agent-busy failures', async () => {
      const mockAgent = {
        handleMessage: vi.fn(async () => {
          throw new Error('Agent is already processing a prompt');
        }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const res = await streamRequest(port, {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      });

      expect(res.status).toBe(200);
      const errorEvent = res.events.find((event) => event.event === 'error');
      expect(errorEvent).toBeDefined();
      expect(JSON.parse(errorEvent!.data).error).toMatchObject({
        type: 'agent_busy',
        message: 'Agent is already processing another prompt',
      });
      expect(res.chunks[res.chunks.length - 1]).toBe('[DONE]');
    });

    it('delivers queued streaming follow-ups after the active stream finishes', async () => {
      const releaseFirst = createDeferred<void>();
      const mockAgent = {
        handleMessage: vi.fn(async (message: SubstrateMessage) => {
          await eventBus.emit('agent.stream.delta', { channelId: message.channelId, text: 'First' });
          await releaseFirst.promise;
          await eventBus.emit('agent.stream.delta', { channelId: message.channelId, text: ' done' });
          return {
            content: 'First done',
            channelId: insecureSessionChannel('stream-queue'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 2, durationMs: 2 },
          } satisfies AgentResponse;
        }),
        followUp: vi.fn((message: SubstrateMessage) => {
          emitQueuedTurnResult(eventBus, message, {
            content: 'Second done',
            channelId: insecureSessionChannel('stream-queue'),
            metadata: { model: 'test', inputTokens: 1, outputTokens: 1, durationMs: 1 },
          }, ['Second done']);
        }),
      } as unknown as SubstrateAgent;

      await server.stop();
      server = createApiServer({
        port,
        agentLoop: mockAgent,
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      const firstStreamPromise = streamRequest(port, {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'First stream turn' }],
        stream: true,
      }, { 'X-Session-ID': 'stream-queue' });

      await new Promise(resolve => setTimeout(resolve, 20));

      const secondStreamPromise = streamRequest(port, {
        model: DEFAULT_COMPANION_ID,
        messages: [{ role: 'user', content: 'Second stream turn' }],
        stream: true,
      }, { 'X-Session-ID': 'stream-queue' });

      await new Promise(resolve => setTimeout(resolve, 20));
      expect(mockAgent.followUp).not.toHaveBeenCalled();

      releaseFirst.resolve();

      const firstStream = await firstStreamPromise;
      const secondStream = await secondStreamPromise;

      const firstContent = firstStream.chunks
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk).choices[0].delta.content)
        .filter(Boolean);
      const secondContent = secondStream.chunks
        .filter((chunk) => chunk !== '[DONE]')
        .map((chunk) => JSON.parse(chunk).choices[0].delta.content)
        .filter(Boolean);

      expect(firstContent).toEqual(['First', ' done']);
      expect(secondContent).toEqual(['Second done']);
      expect(mockAgent.handleMessage).toHaveBeenCalledTimes(1);
      expect(mockAgent.followUp).toHaveBeenCalledTimes(1);
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
      server = createApiServer({
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
      expect(res.headers['access-control-allow-headers']).toContain('X-Channel-Privacy');
      expect(res.headers.vary).toContain('Origin');
    });

    it('allows preflight for split-mode admin origin derived from admin host/port', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: resolveApiCorsAllowedOrigins({
          explicitAllowlist: [],
          adminHost: 'psfn.local',
          adminPort: 3001,
        }),
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Origin: 'http://psfn.local:3001',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization, Content-Type, X-Session-ID, X-User-ID, X-User-Name',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://psfn.local:3001');
      expect(res.headers['access-control-allow-headers']).toContain('X-User-ID');
      expect(res.headers['access-control-allow-headers']).toContain('X-User-Name');
      expect(res.headers.vary).toContain('Origin');
    });

    it('allows preflight for split-mode admin origin when admin host is wildcard bind', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: resolveApiCorsAllowedOrigins({
          explicitAllowlist: [],
          adminHost: '0.0.0.0',
          adminPort: 3201,
        }),
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Host: `psfn.local.mesh:${port}`,
        Origin: 'http://psfn.local.mesh:3201',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://psfn.local.mesh:3201');
      expect(res.headers.vary).toContain('Origin');
    });

    it('rejects wildcard-bind split-mode preflight when origin host differs from request host', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: resolveApiCorsAllowedOrigins({
          explicitAllowlist: [],
          adminHost: '0.0.0.0',
          adminPort: 3201,
        }),
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Host: `psfn.local.mesh:${port}`,
        Origin: 'http://evil.example:3201',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.type).toBe('cors_origin_not_allowed');
    });

    it('allows wildcard LAN preflight when configured origin host matches', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: ['http://*.local:3201'],
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Origin: 'http://garden.local:3201',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://garden.local:3201');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers.vary).toContain('Origin');
    });

    it('rejects wildcard LAN preflight when origin does not match configured port', async () => {
      await server.stop();
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: createMockSessionManager(),
        allowInsecureWithoutAuth: true,
        corsAllowedOrigins: ['http://*.local:3201'],
      });
      await server.init();
      await server.start();

      const res = await request(port, 'OPTIONS', '/v1/chat/completions', undefined, {
        Origin: 'http://garden.local:3202',
        'Access-Control-Request-Method': 'POST',
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).error.type).toBe('cors_origin_not_allowed');
    });
  });

  describe('GET /v1/voice/ws (websocket upgrade)', () => {
    it('accepts websocket upgrades and forwards messages to runtime hooks', async () => {
      const voice = createVoiceHooksProbe();

      await server.stop();
      server = createApiServer({
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
      server = createApiServer({
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
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: mockSessionMgr,
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
      server = createApiServer({
        port,
        agentLoop: createMockAgentLoop(eventBus),
        eventBus,
        sessionManager: mockSessionMgr,
        allowInsecureWithoutAuth: true,
      });
      await server.init();
      await server.start();

      await request(port, 'POST', '/v1/chat/completions', {
        model: DEFAULT_COMPANION_ID,
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
    const server = createApiServer({
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
    const server = createApiServer({
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
    server = createApiServer({
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

  it('serves authorized satellite config pulls from the core registry', async () => {
    await server.stop();
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      satelliteRegistry: SATELLITE_TEST_REGISTRY,
    });
    await server.init();
    await server.start();

    const res = await request(
      port,
      'GET',
      '/v1/satellites/config?satelliteId=android-phone&endpointId=companion-app&claimType=android-mobile',
      undefined,
      { Authorization: 'Bearer test-secret-key' },
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      object: 'companion.satellite_config',
      schemaVersion: 1,
      satellite: {
        satelliteId: 'android-phone',
        displayName: 'Android Mobile Satellite',
        mobility: 'mobile',
      },
      endpoint: {
        endpointId: 'companion-app',
        promptChannelType: 'mobile_satellite',
        claimType: 'android-mobile',
      },
      identity: {
        authorId: 'primary-user',
        authorName: 'Primary User',
        canonicalContactId: 'contact-primary-user',
        channelPrivacy: 'private',
      },
      session: {
        channelIdTemplate: 'satellite:android-mobile:{sessionId}',
        fixedHeaders: {
          claimType: 'android-mobile',
          satelliteId: 'android-phone',
          endpointId: 'companion-app',
        },
      },
      runtime: {
        transport: { mode: 'openhome_bridge' },
        audio: {
          inputDevice: 'plughw:1,0',
          sampleRateHz: 16000,
        },
        refresh: {
          intervalMs: 300000,
          restartPolicy: 'restart_on_runtime_change',
        },
      },
    });
    expect(body.configVersion).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when satellite config pulls are not registry-backed', async () => {
    const res = await request(
      port,
      'GET',
      '/v1/satellites/config?satelliteId=android-phone&endpointId=companion-app&claimType=android-mobile',
      undefined,
      { Authorization: 'Bearer test-secret-key' },
    );
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.type).toBe('satellite_registry_not_configured');
  });

  it('accepts requests with admin token when configured as alternate auth token', async () => {
    await server.stop();
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      adminToken: 'test-admin-token',
    });
    await server.init();
    await server.start();

    const res = await request(port, 'GET', '/v1/models', undefined, {
      Authorization: 'Bearer test-admin-token',
    });
    expect(res.status).toBe(200);
  });

  it('accepts requests with admin auth cookie when configured as alternate auth token', async () => {
    await server.stop();
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      adminToken: 'test-admin-token',
    });
    await server.init();
    await server.start();

    const res = await request(port, 'GET', '/v1/models', undefined, {
      Cookie: 'psfn_token=test-admin-token',
    });
    expect(res.status).toBe(200);
  });

  it('requires authentication for health probes and accepts valid bearer auth', async () => {
    const unauthenticated = await request(port, 'GET', '/health');
    expect(unauthenticated.status).toBe(401);
    const unauthenticatedBody = JSON.parse(unauthenticated.body);
    expect(unauthenticatedBody.error.type).toBe('invalid_api_key');

    const authenticated = await request(port, 'GET', '/health', undefined, {
      Authorization: 'Bearer test-secret-key',
    });
    expect(authenticated.status).not.toBe(401);
    const authenticatedBody = JSON.parse(authenticated.body);
    expect(['healthy', 'degraded']).toContain(authenticatedBody.status);
    expect(authenticatedBody.continuity).toBeDefined();
  });

  it('binds message identity to authenticated principal and ignores spoofed user headers', async () => {
    await server.stop();
    const mockAgent = createMockAgentLoop(eventBus);
    server = createApiServer({
      port,
      agentLoop: mockAgent,
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      externalChannelProfiles: {
        'psfn-amica': {
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'invite_only',
        },
      },
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
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

  it('routes authenticated PSFN Amica claims into psfn-amica channel sessions', async () => {
    await server.stop();
    const mockAgent = createMockAgentLoop(eventBus);
    server = createApiServer({
      port,
      agentLoop: mockAgent,
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      externalChannelProfiles: {
        'psfn-amica': {
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'invite_only',
        },
      },
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'satellite hello' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Channel-Type': 'psfn-amica',
      'X-PSFN-Channel-ID': 'psfn-amica:test:display',
      'X-PSFN-Author-ID': 'primary-user',
      'X-PSFN-Author-Name': 'Primary User',
    });
    expect(res.status).toBe(200);

    const call = (mockAgent.handleMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe('psfn-amica:test:display');
    expect(call.channelType).toBe('psfn-amica');
    expect(call.authorId).toBe('primary-user');
    expect(call.authorName).toBe('Primary User');
    expect(call.routing?.source).toBe('psfn-amica');
    expect(call.routing?.canonicalContactId).toBe('contact-primary-user');
    expect(call.routing?.channelPrivacy).toBe('invite_only');
  });

  it('routes registry-backed satellite claims with effective speech and vision capabilities', async () => {
    await server.stop();
    const mockAgent = createMockAgentLoop(eventBus);
    server = createApiServer({
      port,
      agentLoop: mockAgent,
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      satelliteRegistry: SATELLITE_TEST_REGISTRY,
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'walk with me' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Satellite-Claim-Type': 'android-mobile',
      'X-PSFN-Satellite-ID': 'android-phone',
      'X-PSFN-Satellite-Endpoint-ID': 'companion-app',
      'X-PSFN-Satellite-Session-ID': 'weekend-walk',
      'X-PSFN-Satellite-Capabilities': 'text,audio_input,speech_to_text,audio_output,text_to_speech,vision,image_upload,location',
      'X-PSFN-Satellite-Telemetry-Scopes': 'location,timezone,presence',
    });
    expect(res.status).toBe(200);

    const call = (mockAgent.handleMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe('satellite:android-mobile:weekend-walk');
    expect(call.channelType).toBe('api');
    expect(call.authorId).toBe('primary-user');
    expect(call.authorName).toBe('Primary User');
    expect(call.routing?.source).toBe('satellite');
    expect(call.routing?.canonicalContactId).toBe('contact-primary-user');
    expect(call.routing?.channelPrivacy).toBe('private');
    expect(call.routing?.satellite).toMatchObject({
      satelliteId: 'android-phone',
      endpointId: 'companion-app',
      claimType: 'android-mobile',
      promptChannelType: 'mobile_satellite',
      mobility: 'mobile',
      telemetryScopes: ['location', 'timezone', 'presence'],
    });
    expect(call.routing?.satellite.capabilities.effective).toEqual([
      'text',
      'audio_input',
      'speech_to_text',
      'audio_output',
      'text_to_speech',
      'vision',
      'image_upload',
      'location',
    ]);
  });

  it('applies configured psfn-amica defaults when the caller only claims channel type and id', async () => {
    await server.stop();
    const mockAgent = createMockAgentLoop(eventBus);
    server = createApiServer({
      port,
      agentLoop: mockAgent,
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      externalChannelProfiles: {
        'psfn-amica': {
          authorId: 'primary-user',
          authorName: 'Primary User',
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'invite_only',
        },
      },
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'satellite hello' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Channel-Type': 'psfn-amica',
      'X-PSFN-Channel-ID': 'psfn-amica:test:display',
    });
    expect(res.status).toBe(200);

    const call = (mockAgent.handleMessage as any).mock.calls[0][0];
    expect(call.channelId).toBe('psfn-amica:test:display');
    expect(call.channelType).toBe('psfn-amica');
    expect(call.authorId).toBe('primary-user');
    expect(call.authorName).toBe('Primary User');
    expect(call.routing?.source).toBe('psfn-amica');
    expect(call.routing?.canonicalContactId).toBe('contact-primary-user');
    expect(call.routing?.channelPrivacy).toBe('invite_only');
  });

  it('fails closed for psfn-amica claims when the PSFN-side profile is missing', async () => {
    await server.stop();
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
    });
    await server.init();
    await server.start();

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'satellite hello' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Channel-Type': 'psfn-amica',
      'X-PSFN-Channel-ID': 'psfn-amica:test:display',
    });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.type).toBe('external_channel_not_configured');
  });

  it('binds identity claims to the authenticated principal and prevents X-User-ID spoofing', async () => {
    const db = new Database(':memory:');
    const contactStore = new ContactStore(db);
    const contact = contactStore.upsert({
      displayName: 'PrimaryUser',
      channelIdentities: [{ channel: 'discord', userId: 'user-discord' }],
    });

    await server.stop();
    server = createApiServer({
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
      model: DEFAULT_COMPANION_ID,
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
      model: DEFAULT_COMPANION_ID,
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

  it('rejects biometric-shaped telemetry payloads before any emit (H5)', async () => {
    const cases: Array<{ label: string; payload: Record<string, unknown> }> = [
      { label: 'faceVector key', payload: { status: 'ok', faceVector: [0.1, 0.2, 0.3] } },
      { label: 'embedding key', payload: { status: 'ok', embedding: 'AAA' } },
      { label: 'descriptor key', payload: { status: 'ok', descriptor: 'x' } },
      { label: 'iris key', payload: { status: 'ok', iris: 'x' } },
      { label: 'raw image blob key', payload: { status: 'ok', image: 'x' } },
      {
        label: 'deeply nested vector',
        payload: { status: 'ok', origin: { satelliteId: 'sat', meta: { data: { faceVector: [1, 2] } } } },
      },
      {
        label: 'renamed numeric vector under innocuous key',
        payload: { status: 'ok', load: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] },
      },
    ];

    for (const { label, payload } of cases) {
      const seen: Array<any> = [];
      const unsub = eventBus.on('external.telemetry.ingested', ({ event }) => {
        seen.push(event);
      });

      const res = await request(port, 'POST', '/v1/telemetry/ingest', {
        source: 'sensor-a',
        eventType: 'external.telemetry.status',
        timestamp: new Date().toISOString(),
        nonce: `nonce-bio-${label.replace(/\s+/g, '-')}-${Date.now()}`,
        payload,
      }, {
        Authorization: 'Bearer test-secret-key',
      });

      expect(res.status, label).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type, label).toBe('biometric_payload_rejected');
      expect(seen, `${label}: must not emit`).toHaveLength(0);
      unsub();
    }
  });

  it('rejects oversized telemetry payloads before any emit (H5)', async () => {
    const seen: Array<any> = [];
    const unsub = eventBus.on('external.telemetry.ingested', ({ event }) => {
      seen.push(event);
    });

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce: `nonce-oversize-${Date.now()}`,
      payload: { status: 'ok', detail: 'x'.repeat(20 * 1024) },
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    // 20KB single string trips the per-field string-length cap first.
    expect([400, 413]).toContain(res.status);
    expect(seen).toHaveLength(0);
    unsub();
  });

  it('rejects telemetry payloads with fields outside the per-eventType allowlist (H5)', async () => {
    const seen: Array<any> = [];
    const unsub = eventBus.on('external.telemetry.ingested', ({ event }) => {
      seen.push(event);
    });

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.heartbeat',
      timestamp: new Date().toISOString(),
      nonce: `nonce-unknown-field-${Date.now()}`,
      payload: { status: 'ok', ssn: '123-45-6789' },
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('payload_field_not_allowed');
    expect(seen).toHaveLength(0);
    unsub();
  });

  it('accepts a legit presence status payload after screening (H5)', async () => {
    const seen: Array<any> = [];
    const unsub = eventBus.on('external.telemetry.ingested', ({ event }) => {
      seen.push(event);
    });

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sensor-a',
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce: `nonce-presence-ok-${Date.now()}`,
      payload: { satelliteId: 'sat-a', present: true, confidence: 0.91, occupancyCount: 1 },
      scope: 'presence',
    }, {
      Authorization: 'Bearer test-secret-key',
    });

    expect(res.status).toBe(202);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({
      satelliteId: 'sat-a',
      present: true,
      confidence: 0.91,
      occupancyCount: 1,
    });
    unsub();
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

// ── Sprint-10 C1/H4/04-M1: satellite auth hardening ──

describe('ApiServer satellite auth hardening (Sprint-10 C1/H4/04-M1)', () => {
  const FINGERPRINT = 'a1'.repeat(32);
  const SUBJECT = 'CN=pi-voice, O=PSFN';
  const PROXY_TOKEN = 'proxy-shared-secret-of-32-chars!';
  const KEY_A = 'satellite-key-alpha-0001';
  const KEY_B = 'satellite-key-beta-0002';
  const PRINCIPAL_A = `api-key-${createHash('sha256').update(KEY_A).digest('hex').slice(0, 24)}`;
  const PRINCIPAL_B = `api-key-${createHash('sha256').update(KEY_B).digest('hex').slice(0, 24)}`;

  const MTLS_REGISTRY = parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    satellites: [
      {
        satelliteId: 'pi-voice',
        displayName: 'Kitchen Voice Pi',
        mobility: 'static',
        endpoints: [
          {
            endpointId: 'wyoming-voice',
            displayName: 'Wyoming Voice Endpoint',
            claimTypes: ['voice-pi'],
            promptChannelType: 'voice_satellite',
            auth: {
              mode: 'mtls',
              clientCertFingerprintSha256: FINGERPRINT,
              clientCertSubject: SUBJECT,
            },
            defaultIdentity: {
              authorId: 'primary-user',
              authorName: 'Primary User',
              canonicalContactId: 'contact-primary-user',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['text'],
            runtime: {
              schemaVersion: 1,
              transport: { mode: 'openhome_bridge' },
              refresh: { intervalMs: 300000, restartPolicy: 'manual' },
            },
          },
        ],
      },
    ],
  });

  const PER_KEY_REGISTRY = parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    satellites: [
      {
        satelliteId: 'sat-a',
        displayName: 'Satellite A',
        mobility: 'static',
        endpoints: [
          {
            endpointId: 'endpoint-a',
            displayName: 'Endpoint A',
            claimTypes: ['claim-a'],
            promptChannelType: 'voice_satellite',
            auth: { mode: 'api_key', apiKeyPrincipalIds: [PRINCIPAL_A] },
            defaultIdentity: {
              authorId: 'user-a',
              authorName: 'User A',
              canonicalContactId: 'contact-a',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['text'],
          },
        ],
      },
      {
        satelliteId: 'sat-b',
        displayName: 'Satellite B',
        mobility: 'static',
        endpoints: [
          {
            endpointId: 'endpoint-b',
            displayName: 'Endpoint B',
            claimTypes: ['claim-b'],
            promptChannelType: 'voice_satellite',
            auth: { mode: 'api_key', apiKeyPrincipalIds: [PRINCIPAL_B] },
            defaultIdentity: {
              authorId: 'user-b',
              authorName: 'User B',
              canonicalContactId: 'contact-b',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['text'],
          },
        ],
      },
    ],
  });

  let eventBus: EventBus;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = await allocatePort();
  });

  afterEach(async () => {
    await stopServer(server);
  });

  async function startServer(config: Partial<ConstructorParameters<typeof ApiServer>[0]> = {}): Promise<void> {
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key',
      ...config,
    });
    await server.init();
    await server.start();
  }

  const CONFIG_PULL_PATH = '/v1/satellites/config?satelliteId=pi-voice&endpointId=wyoming-voice&claimType=voice-pi';

  it('REJECTS mTLS config pulls that present only forged X-PSFN-Client-Cert-* headers (C1)', async () => {
    await startServer({ satelliteRegistry: MTLS_REGISTRY });

    const res = await request(port, 'GET', CONFIG_PULL_PATH, undefined, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
      'X-PSFN-Client-Cert-Subject': SUBJECT,
      'X-PSFN-Client-Cert-SPKI-SHA256': 'b2'.repeat(32),
      'X-PSFN-Client-Cert-SAN': 'DNS:pi-voice.local',
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.type).toBe('satellite_client_certificate_required');
  });

  it('REJECTS mTLS satellite chat claims that replay cert headers without an authenticated cert (C1)', async () => {
    await startServer({ satelliteRegistry: MTLS_REGISTRY });

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Satellite-Claim-Type': 'voice-pi',
      'X-PSFN-Satellite-ID': 'pi-voice',
      'X-PSFN-Satellite-Endpoint-ID': 'wyoming-voice',
      'X-PSFN-Satellite-Session-ID': 'kitchen',
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
      'X-PSFN-Client-Cert-Subject': SUBJECT,
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error.type).toBe('satellite_client_certificate_required');
  });

  it('accepts trusted-proxy asserted certs only with the proxy token, and requires ALL bindings to match (C1)', async () => {
    await startServer({
      satelliteRegistry: MTLS_REGISTRY,
      trustedProxyClientCertToken: PROXY_TOKEN,
    });

    // Full binding set + authenticated proxy → allowed.
    const allowed = await request(port, 'GET', CONFIG_PULL_PATH, undefined, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Trusted-Proxy-Token': PROXY_TOKEN,
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
      'X-PSFN-Client-Cert-Subject': SUBJECT,
    });
    expect(allowed.status).toBe(200);
    expect(JSON.parse(allowed.body).auth.certBound).toBe(true);

    // Same headers WITHOUT the proxy token → rejected.
    const noToken = await request(port, 'GET', CONFIG_PULL_PATH, undefined, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
      'X-PSFN-Client-Cert-Subject': SUBJECT,
    });
    expect(noToken.status).toBe(403);
    expect(JSON.parse(noToken.body).error.type).toBe('satellite_client_certificate_required');

    // Single-attribute match (fingerprint only, subject binding unmet) → rejected.
    const partial = await request(port, 'GET', CONFIG_PULL_PATH, undefined, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Trusted-Proxy-Token': PROXY_TOKEN,
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
    });
    expect(partial.status).toBe(403);
    expect(JSON.parse(partial.body).error.type).toBe('satellite_certificate_not_allowed');
  });

  it('strips inbound client-cert headers before anything downstream sees them (C1)', async () => {
    const forwardedHeaders: Array<Record<string, string | undefined>> = [];
    await startServer({
      runtime: {
        handleHealth: async () => { throw new Error('not under test'); },
        handleTelemetryIngest: async () => { throw new Error('not under test'); },
        handleChatCompletion: async (input) => {
          forwardedHeaders.push({ ...input.headers });
          return {
            ok: true,
            response: { content: 'ok', channelId: 'api:test', inputTokens: 1, outputTokens: 1 },
          };
        },
      },
    });

    const res = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      Authorization: 'Bearer test-secret-key',
      'X-PSFN-Client-Cert-Fingerprint-SHA256': FINGERPRINT,
      'X-PSFN-Client-Cert-Subject': SUBJECT,
      'X-PSFN-Trusted-Proxy-Token': PROXY_TOKEN,
      'X-Harmless-Header': 'kept',
    });

    expect(res.status).toBe(200);
    expect(forwardedHeaders).toHaveLength(1);
    const headerNames = Object.keys(forwardedHeaders[0]!);
    expect(headerNames).toContain('x-harmless-header');
    expect(headerNames.filter(name => name.startsWith('x-psfn-client-cert-'))).toEqual([]);
    expect(headerNames).not.toContain('x-psfn-trusted-proxy-token');
  });

  it('gives distinct satellite keys distinct principals; a header swap cannot claim the other endpoint (H4)', async () => {
    const mockAgent = createMockAgentLoop(eventBus);
    await startServer({
      agentLoop: mockAgent,
      satelliteRegistry: PER_KEY_REGISTRY,
      satelliteApiKeys: [KEY_A, KEY_B],
    });

    const claimHeaders = (key: string, satelliteId: string, endpointId: string, claimType: string) => ({
      Authorization: `Bearer ${key}`,
      'X-PSFN-Satellite-Claim-Type': claimType,
      'X-PSFN-Satellite-ID': satelliteId,
      'X-PSFN-Satellite-Endpoint-ID': endpointId,
      'X-PSFN-Satellite-Session-ID': 'session-1',
    });
    const chatBody = {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'hello' }],
    };

    // Key A on its own endpoint → accepted with endpoint A's identity.
    const own = await request(port, 'POST', '/v1/chat/completions', chatBody,
      claimHeaders(KEY_A, 'sat-a', 'endpoint-a', 'claim-a'));
    expect(own.status).toBe(200);
    const call = (mockAgent.handleMessage as any).mock.calls[0][0];
    expect(call.authorId).toBe('user-a');
    expect(call.routing?.satellite?.auth?.principalId).toBe(PRINCIPAL_A);

    // Key A swapping headers to endpoint B → rejected.
    const swapped = await request(port, 'POST', '/v1/chat/completions', chatBody,
      claimHeaders(KEY_A, 'sat-b', 'endpoint-b', 'claim-b'));
    expect(swapped.status).toBe(403);
    expect(JSON.parse(swapped.body).error.type).toBe('satellite_principal_not_allowed');
    expect((mockAgent.handleMessage as any).mock.calls).toHaveLength(1);
  });

  it('confines satellite-scoped keys to satellite surfaces (H4)', async () => {
    await startServer({
      satelliteRegistry: PER_KEY_REGISTRY,
      satelliteApiKeys: [KEY_A],
    });

    const models = await request(port, 'GET', '/v1/models', undefined, {
      Authorization: `Bearer ${KEY_A}`,
    });
    expect(models.status).toBe(403);
    expect(JSON.parse(models.body).error.type).toBe('satellite_scoped_principal_not_allowed');

    const chatWithoutClaim = await request(port, 'POST', '/v1/chat/completions', {
      model: DEFAULT_COMPANION_ID,
      messages: [{ role: 'user', content: 'hello' }],
    }, {
      Authorization: `Bearer ${KEY_A}`,
    });
    expect(chatWithoutClaim.status).toBe(403);
    expect(JSON.parse(chatWithoutClaim.body).error.type).toBe('satellite_scoped_principal_requires_satellite_claim');

    // The shared operator key keeps full API access.
    const sharedModels = await request(port, 'GET', '/v1/models', undefined, {
      Authorization: 'Bearer test-secret-key',
    });
    expect(sharedModels.status).toBe(200);
  });

  it('refuses to start with satellite keys colliding with the shared API key (H4, fail closed)', async () => {
    expect(() => createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      apiKey: 'test-secret-key-16ch',
      satelliteApiKeys: ['test-secret-key-16ch'],
    })).toThrow('must not reuse API_KEY or ADMIN_TOKEN');
    // afterEach stop guard: give it something stoppable.
    server = createApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
      allowInsecureWithoutAuth: true,
    });
  });

  it('stamps telemetry with the authenticated origin context (04-M1)', async () => {
    await startServer({ satelliteApiKeys: [KEY_A] });

    const ingested: any[] = [];
    eventBus.on('external.telemetry.ingested', ({ event }) => {
      ingested.push(event);
    });

    const res = await request(port, 'POST', '/v1/telemetry/ingest', {
      source: 'sat-a',
      eventType: 'external.telemetry.status',
      timestamp: new Date().toISOString(),
      nonce: `nonce-${Date.now()}`,
      payload: { satelliteId: 'sat-a', present: true },
    }, {
      Authorization: `Bearer ${KEY_A}`,
    });

    expect(res.status).toBe(202);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].auth).toEqual({
      principalId: PRINCIPAL_A,
      principalMode: 'api_key',
      satelliteScoped: true,
    });
  });
});
