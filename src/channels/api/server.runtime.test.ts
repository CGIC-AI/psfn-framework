import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiServer } from './server.js';
import type { ApiServerRuntime } from './types.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SensorIngestPort } from '../../shared/telemetry/sensor-ingest-port.js';

const API_KEY = 'runtime-test-key';

function createInertEventBus(): EventBus {
  return {
    emit: async () => undefined,
    on: () => () => {},
  } as unknown as EventBus;
}

function createServer(runtime: ApiServerRuntime): ApiServer {
  return new ApiServer({
    port: 0,
    host: '127.0.0.1',
    agentLoop: {
      handleMessage: async () => {
        throw new Error('unreachable');
      },
    } as unknown as SubstrateAgent,
    eventBus: createInertEventBus(),
    sessionManager: {
      recordAssistantMessage: () => undefined,
    } as unknown as SessionManager,
    sensorIngest: {
      ingestTelemetry: async () => {
        throw new Error('unreachable');
      },
    } as unknown as SensorIngestPort,
    apiKey: API_KEY,
    runtime,
    modelName: 'runtime-model',
  });
}

async function startServer(server: ApiServer): Promise<number> {
  await server.start();
  const address = (server as unknown as { server: { address: () => { port: number } | null } }).server.address();
  if (!address || typeof address.port !== 'number') {
    throw new Error('server did not bind a port');
  }
  return address.port;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ApiServer runtime seam', () => {
  it('serves non-streaming chat completions through the injected runtime', async () => {
    const runtime: ApiServerRuntime = {
      handleHealth: async () => ({
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        uptimeSeconds: 1,
        subsystems: {
          memory: { status: 'healthy' },
          llm: { status: 'healthy' },
          discord: { status: 'healthy' },
          embeddings: { status: 'healthy' },
          scheduler: { status: 'healthy' },
        },
        continuity: {
          status: 'healthy',
          checks: {
            database: { status: 'healthy' },
            gatewayLink: { status: 'healthy' },
            schedulerHeartbeat: { status: 'healthy' },
          },
        },
      }),
      handleTelemetryIngest: async () => ({
        ok: true,
        response: { ok: true, id: 'telemetry-1', acceptedEventType: 'external.telemetry.heartbeat' },
      }),
      handleChatCompletion: vi.fn(async () => ({
        ok: true,
        response: {
          content: 'runtime answer',
          channelId: 'api:local',
          inputTokens: 5,
          outputTokens: 3,
        },
      })),
    };
    const server = createServer(runtime);
    const port = await startServer(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'runtime-model',
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.choices[0].message.content).toBe('runtime answer');
      expect(runtime.handleChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
        request: expect.objectContaining({ model: 'runtime-model' }),
        principal: expect.objectContaining({ mode: 'api_key' }),
      }));
    } finally {
      await server.stop();
    }
  });

  it('streams chat completions through runtime-provided deltas', async () => {
    const runtime: ApiServerRuntime = {
      handleHealth: async () => ({
        status: 'healthy',
        checkedAt: new Date().toISOString(),
        uptimeSeconds: 1,
        subsystems: {
          memory: { status: 'healthy' },
          llm: { status: 'healthy' },
          discord: { status: 'healthy' },
          embeddings: { status: 'healthy' },
          scheduler: { status: 'healthy' },
        },
        continuity: {
          status: 'healthy',
          checks: {
            database: { status: 'healthy' },
            gatewayLink: { status: 'healthy' },
            schedulerHeartbeat: { status: 'healthy' },
          },
        },
      }),
      handleTelemetryIngest: async () => ({
        ok: true,
        response: { ok: true, id: 'telemetry-1', acceptedEventType: 'external.telemetry.heartbeat' },
      }),
      handleChatCompletion: async ({ onDelta }) => {
        onDelta?.('runtime delta');
        return {
          ok: true,
          response: {
            content: 'runtime streamed answer',
            channelId: 'api:local',
            inputTokens: 5,
            outputTokens: 3,
          },
        };
      },
    };
    const server = createServer(runtime);
    const port = await startServer(server);

    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'runtime-model',
          stream: true,
          messages: [{ role: 'user', content: 'hello' }],
        }),
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain('runtime delta');
      expect(body).toContain('[DONE]');
    } finally {
      await server.stop();
    }
  });
});
