import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';

function createHarness() {
  const methods = new Map<string, (params: any) => Promise<any>>();
  const stream = vi.fn(async () => ({
    content: 'streamed',
    toolCalls: [],
    model: 'mock-model',
    inputTokens: 5,
    outputTokens: 3,
    stopReason: 'stop',
  }));
  const complete = vi.fn(async () => ({
    content: 'completed',
    model: 'mock-model',
    inputTokens: 4,
    outputTokens: 2,
    stopReason: 'stop',
  }));

  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: any) => Promise<any>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {
      stream,
      complete,
    } as any,
    embeddingService: {
      embed: vi.fn(),
      embedBatch: vi.fn(async () => []),
      dims: 1,
    } as any,
    discordAdapter: {} as any,
    policyConfig: { workspacePath: process.cwd() },
    workspacePath: process.cwd(),
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test' } },
    notifyAll: vi.fn(),
    listPendingConfirmations: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'gw-1',
    audited: (_method, handler) => handler,
    gated: (_method, handler) => handler,
  };

  registerLLMMethods(runtime);
  return {
    invoke(method: 'llm.chat' | 'llm.complete', params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Method not registered: ${method}`);
      }
      return handler(params);
    },
    stream,
    complete,
  };
}

describe('registerLLMMethods', () => {
  it('defaults shard chat correlation to tool callType and shard execution purpose', async () => {
    const harness = createHarness();

    await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'hello shard' }],
      systemPrompt: 'system',
      channelId: 'shard:shard-123',
    });

    expect(harness.stream).toHaveBeenCalledTimes(1);
    const firstCall = harness.stream.mock.calls[0][0];
    expect(firstCall.correlation).toMatchObject({
      channelId: 'shard:shard-123',
      callType: 'tool',
      purpose: 'shard.execution',
    });
  });

  it('fails closed on malformed shard channel ids', async () => {
    const harness = createHarness();

    await expect(harness.invoke('llm.chat', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'hello shard' }],
      systemPrompt: 'system',
      channelId: 'shard:',
    })).rejects.toThrow('non-empty shard identifier');
  });
});
