import { describe, expect, it, vi } from 'vitest';
import { GatewayApiRuntime, computeGatewayChatRequestTimeoutMs } from './gateway-runtime.js';
import type { ApiRuntimeChatRequest } from './types.js';

function createChatRequest(): ApiRuntimeChatRequest {
  return {
    request: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    },
    principal: { id: 'principal-1', mode: 'api_key' },
    headers: { 'x-session-id': 'session-1' },
  };
}

describe('GatewayApiRuntime', () => {
  it('brokers chat completions and forwards stream deltas', async () => {
    const onDelta = vi.fn();
    let streamListener: ((text: string) => void) | undefined;
    const unsubscribe = vi.fn();
    const requestAgent = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'api.chat.completion') {
        streamListener?.('partial delta');
        expect(params.requestId).toMatch(/^api-/);
        return {
          ok: true,
          response: {
            content: 'done',
            channelId: 'api:principal-1:session-1',
            inputTokens: 3,
            outputTokens: 2,
          },
        };
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: (_requestId, listener) => {
        streamListener = listener;
        return () => {
          unsubscribe();
        };
      },
    });

    const result = await runtime.handleChatCompletion({
      ...createChatRequest(),
      onDelta,
    });

    expect(result).toEqual({
      ok: true,
      response: {
        content: 'done',
        channelId: 'api:principal-1:session-1',
        inputTokens: 3,
        outputTokens: 2,
      },
    });
    expect(onDelta).toHaveBeenCalledWith('partial delta');
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('sends cancellation to the agent when the request aborts', async () => {
    const controller = new AbortController();
    let resolveCompletion: ((value: unknown) => void) | undefined;
    const requestAgent = vi.fn((method: string) => {
      if (method === 'api.chat.cancel') {
        return Promise.resolve({ cancelled: true });
      }
      if (method === 'api.chat.completion') {
        return new Promise((resolve) => {
          resolveCompletion = resolve;
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: () => () => {},
    });

    const completionPromise = runtime.handleChatCompletion({
      ...createChatRequest(),
      signal: controller.signal,
    });
    controller.abort();
    resolveCompletion?.({
      ok: true,
      response: {
        content: 'done',
        channelId: 'api:principal-1:session-1',
        inputTokens: 3,
        outputTokens: 2,
      },
    });

    await completionPromise;

    expect(requestAgent).toHaveBeenCalledWith('api.chat.cancel', expect.objectContaining({ requestId: expect.any(String) }));
  });

  it('degrades health instead of throwing when no agent is connected yet', async () => {
    const runtime = new GatewayApiRuntime({
      requestAgent: vi.fn(async () => {
        throw new Error('No agent connected');
      }),
      subscribeApiStream: vi.fn(() => () => {}),
    });

    const health = await runtime.handleHealth();

    expect(health.status).toBe('degraded');
    expect(health.subsystems.memory.status).toBe('degraded');
    expect(health.continuity.status).toBe('degraded');
    expect(health.continuity.checks.gatewayLink.status).toBe('degraded');
    expect(health.continuity.checks.gatewayLink.detail).toContain('No agent connected');
    expect(health.continuity.checks.gatewayLink.meta).toEqual({ agentConnected: false });
  });

  it('passes an explicit chat completion timeout to the gateway request', async () => {
    const requestAgent = vi.fn(async () => ({
      ok: true,
      response: {
        content: 'ok',
        channelId: 'api:test',
        inputTokens: 1,
        outputTokens: 1,
      },
    }));
    const runtime = new GatewayApiRuntime({
      requestAgent,
      subscribeApiStream: vi.fn(() => () => {}),
    }, {
      chatRequestTimeoutMs: 123_456,
    });

    await runtime.handleChatCompletion({
      request: {
        model: 'openrouter/moonshotai/kimi-k2.5',
        messages: [{ role: 'user', content: 'hello' }],
      },
      principal: { id: 'principal-1', mode: 'api_key' },
      headers: {},
    });

    expect(requestAgent).toHaveBeenCalledWith(
      'api.chat.completion',
      expect.objectContaining({
        request: expect.objectContaining({
          model: 'openrouter/moonshotai/kimi-k2.5',
        }),
      }),
      123_456,
    );
  });

  it('adds a small buffer to the API request timeout when computing the gateway timeout', () => {
    expect(computeGatewayChatRequestTimeoutMs(120_000)).toBe(125_000);
    expect(computeGatewayChatRequestTimeoutMs(undefined)).toBe(95_000);
  });
});
