import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { EventBus } from '../../event-bus.js';
import { ApiServer } from './server.js';
import type { AgentLoop } from '../../agent-loop.js';
import type { SessionManager } from '../../session/manager.js';
import type { AgentResponse } from '../../types.js';

// ── Helpers ──

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

// ── Mocks ──

function createMockAgentLoop(eventBus: EventBus): AgentLoop {
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
  } as unknown as AgentLoop;
}

function createMockSessionManager(): SessionManager {
  return {
    getMessageCount: vi.fn(() => 0),
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
  } as unknown as SessionManager;
}

// ── Tests ──

describe('ApiServer', () => {
  let eventBus: EventBus;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = 30000 + Math.floor(Math.random() * 10000);
    server = new ApiServer({
      port,
      agentLoop: createMockAgentLoop(eventBus),
      eventBus,
      sessionManager: createMockSessionManager(),
    });
    await server.init();
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  describe('GET /v1/models', () => {
    it('returns model list', async () => {
      const res = await request(port, 'GET', '/v1/models');
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('list');
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe('purrsephone');
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
        modelName: 'custom-model',
      });
      await server.init();
      await server.start();

      const res = await request(port, 'GET', '/v1/models');
      const body = JSON.parse(res.body);
      expect(body.data[0].id).toBe('custom-model');
    });
  });

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it('returns valid OpenAI response shape', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'purrsephone',
        messages: [{ role: 'user', content: 'Hello' }],
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.object).toBe('chat.completion');
      expect(body.id).toMatch(/^chatcmpl-/);
      expect(body.model).toBe('purrsephone');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(body.choices[0].message.content).toBe('Hello world');
      expect(body.choices[0].finish_reason).toBe('stop');
      expect(body.usage.prompt_tokens).toBe(10);
      expect(body.usage.completion_tokens).toBe(5);
      expect(body.usage.total_tokens).toBe(15);
    });

    it('returns 400 for missing messages', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'purrsephone',
      });
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.type).toBe('invalid_request');
    });

    it('returns 400 for empty messages array', async () => {
      const res = await request(port, 'POST', '/v1/chat/completions', {
        model: 'purrsephone',
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
  });

  describe('POST /v1/chat/completions (streaming)', () => {
    it('returns proper SSE format', async () => {
      const res = await streamRequest(port, {
        model: 'purrsephone',
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
    it('returns CORS headers on normal request', async () => {
      const res = await request(port, 'GET', '/v1/models');
      expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('handles OPTIONS preflight', async () => {
      const res = await request(port, 'OPTIONS', '/v1/chat/completions');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('X-Session-ID');
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
      });
      await server.init();
      await server.start();

      await request(port, 'POST', '/v1/chat/completions', {
        model: 'purrsephone',
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'First response' },
          { role: 'user', content: 'Second message' },
        ],
      }, { 'X-Session-ID': 'test-seed' });

      // Prior messages (first two) should be seeded, last user message handled by agentLoop
      expect(mockSessionMgr.recordUserMessage).toHaveBeenCalledWith(
        'api:test-seed', 'First message', 'api-user', 'User',
      );
      expect(mockSessionMgr.recordAssistantMessage).toHaveBeenCalledWith(
        'api:test-seed', 'First response',
      );
    });
  });
});

describe('ApiServer with auth', () => {
  let eventBus: EventBus;
  let server: ApiServer;
  let port: number;

  beforeEach(async () => {
    eventBus = new EventBus();
    port = 30000 + Math.floor(Math.random() * 10000);
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
    await server.stop();
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

  it('allows OPTIONS without auth (CORS preflight)', async () => {
    const res = await request(port, 'OPTIONS', '/v1/chat/completions');
    expect(res.status).toBe(204);
  });
});
