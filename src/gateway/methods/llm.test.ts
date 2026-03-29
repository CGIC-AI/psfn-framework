import { describe, expect, it, vi } from 'vitest';
import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';

function createHarness() {
  const methods = new Map<string, (params: any) => Promise<any>>();
  const stream = vi.fn(async () => ({
    content: 'streamed',
    reasoning: 'stream-thinking',
    providerObservability: {
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      requestedModel: 'mock-model',
      backendProvider: 'openrouter',
      backendModel: 'mock-model',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
        supportsSystemRole: true,
        supportsDeveloperRole: true,
        usesOutOfBandSystemPrompt: false,
      },
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: 'system' },
      ],
    },
    toolCalls: [],
    model: 'mock-model',
    inputTokens: 5,
    outputTokens: 3,
    stopReason: 'stop',
  }));
  const complete = vi.fn(async () => ({
    content: 'completed',
    reasoning: 'complete-thinking',
    providerObservability: {
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      requestedModel: 'mock-model',
      backendProvider: 'openrouter',
      backendModel: 'mock-model',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_system',
        supportsSystemRole: true,
        supportsDeveloperRole: false,
        usesOutOfBandSystemPrompt: false,
      },
      providerWireMessages: [
        { role: 'system', source: 'system_prompt', content: 'system' },
      ],
    },
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

  it('preserves model knob fields from llm.chat params into provider context hints', async () => {
    const harness = createHarness();

    await harness.invoke('llm.chat', {
      model: 'openrouter:z-ai/glm-5',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      maxTokens: 321,
      contextWindow: 99999,
      thinkingEnabled: true,
      thinkingEffort: 'high',
      temperature: 0.33,
      topP: 0.77,
      topK: 42,
      frequencyPenalty: 0.12,
      repetitionPenalty: 1.03,
    });

    expect(harness.stream).toHaveBeenCalledTimes(1);
    const firstCall = harness.stream.mock.calls[0][0];
    expect(firstCall.modelHint).toEqual({
      model: 'openrouter:z-ai/glm-5',
      provider: 'openrouter',
      maxTokens: 321,
      contextWindow: 99999,
      thinkingEnabled: true,
      thinkingEffort: 'high',
      temperature: 0.33,
      topP: 0.77,
      topK: 42,
      frequencyPenalty: 0.12,
      repetitionPenalty: 1.03,
    });
  });

  it('returns reasoning and provider observability from llm.chat', async () => {
    const harness = createHarness();

    const result = await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
    });

    expect(result.reasoning).toBe('stream-thinking');
    expect(result.providerObservability).toMatchObject({
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
      },
    });
  });

  it('preserves model knob fields from llm.complete params into provider context hints', async () => {
    const harness = createHarness();

    await harness.invoke('llm.complete', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'summarize' }],
      systemPrompt: 'system',
      purpose: 'summary',
      maxTokens: 222,
      contextWindow: 120000,
      thinkingEnabled: false,
      thinkingEffort: 'medium',
      temperature: 0.21,
      topP: 0.66,
      topK: 16,
      frequencyPenalty: -0.3,
      repetitionPenalty: 1.2,
    });

    expect(harness.complete).toHaveBeenCalledTimes(1);
    const firstCall = harness.complete.mock.calls[0][0];
    expect(firstCall.modelHint).toEqual({
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      maxTokens: 222,
      contextWindow: 120000,
      thinkingEnabled: false,
      thinkingEffort: 'medium',
      temperature: 0.21,
      topP: 0.66,
      topK: 16,
      frequencyPenalty: -0.3,
      repetitionPenalty: 1.2,
    });
  });

  it('returns reasoning and provider observability from llm.complete', async () => {
    const harness = createHarness();

    const result = await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'summarize' }],
      systemPrompt: 'system',
      purpose: 'summary',
    });

    expect(result.reasoning).toBe('complete-thinking');
    expect(result.providerObservability).toMatchObject({
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_system',
      },
    });
  });
});
