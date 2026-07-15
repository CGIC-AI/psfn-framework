import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel } from '../../../primitives/llm/discovery.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';
import type { ModelUsageEventInput } from '../../../shared/telemetry/model-usage.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { IcpConversationCostBreakerError } from '../../../primitives/llm/icp-conversation-cost-breaker.js';
import { GatewayErrors } from '../protocol.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createHarness(options: {
  embeddingService?: GatewayMethodRuntime['embeddingService'] & {
    embedBatchWithUsage?: (texts: string[]) => Promise<unknown>;
  };
  usageEvents?: ModelUsageEventInput[];
  authorizeIcpConversationCorrelation?: GatewayMethodRuntime['authorizeIcpConversationCorrelation'];
} = {}) {
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
  const modelDiscovery = {
    getAvailableModels: vi.fn<() => Promise<DiscoveredModel[]>>(async () => [{ id: 'model-1' }]),
    invalidateCache: vi.fn(),
  };

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
    embeddingService: options.embeddingService ?? {
      embed: vi.fn(),
      embedBatch: vi.fn(async () => []),
      dims: 1,
    } as any,
    ...(options.usageEvents ? {
      modelUsageRecorder: {
        async recordUsageEvent(event: ModelUsageEventInput) {
          options.usageEvents?.push(event);
        },
      },
    } : {}),
    modelDiscovery,
    discordAdapter: {} as any,
    policyConfig: { workspacePath: process.cwd() },
    workspacePath: process.cwd(),
    sessionHmacKeyring: { activeVersion: 'v1', keys: { v1: 'test' } },
    notifyRequester: vi.fn(),
    listPendingConfirmations: () => [],
    listConfirmationHistory: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'gw-1',
    ...(options.authorizeIcpConversationCorrelation
      ? { authorizeIcpConversationCorrelation: options.authorizeIcpConversationCorrelation }
      : {}),
    audited: (_method, handler) => handler,
    approvalBoundary: {
      gate: (_options) => async (params) => _options.handler(params),
    } as any,
  };

  registerLLMMethods(runtime);
  return {
    invoke(method: string, params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Method not registered: ${method}`);
      }
      return handler(params);
    },
    stream,
    complete,
    modelDiscovery,
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

  it('propagates private telemetry generically and strips source identifiers', async () => {
    const harness = createHarness();

    await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'private work' }],
      systemPrompt: 'private',
      purpose: 'background',
      turnId: 'source-turn',
      requestId: 'source-request',
      channelId: 'source-channel',
      originStage: 'revealing.private.operation',
      telemetryVisibility: 'companion_private',
    });

    const correlation = harness.complete.mock.calls[0]?.[0].correlation;
    expect(correlation).toEqual({
      requestId: 'companion-private',
      callType: 'background',
      purpose: 'companion_private.background',
      originType: 'background',
      originStage: 'companion_private.background',
      telemetryVisibility: 'companion_private',
    });
  });

  it('preserves model knob fields from llm.chat params into provider context hints', async () => {
    const harness = createHarness();

    await harness.invoke('llm.chat', {
      model: 'openrouter:z-ai/glm-5',
      provider: 'openrouter',
      pin: true,
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
      pin: true,
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

  it('preserves validated caller-owned accounting identity into the provider context', async () => {
    const harness = createHarness();

    await harness.invoke('llm.chat', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      pin: true,
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      accounting: {
        logicalCallId: 'llm:caller-operation',
        attempt: 4,
        retryOwner: 'caller',
      },
    });

    expect(harness.stream.mock.calls[0]?.[0]).toMatchObject({
      accounting: {
        logicalCallId: 'llm:caller-operation',
        attempt: 4,
        retryOwner: 'caller',
      },
    });

    await harness.invoke('llm.complete', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      pin: true,
      messages: [{ role: 'user', content: 'summarize' }],
      systemPrompt: 'system',
      purpose: 'summary',
      accounting: {
        logicalCallId: 'llm:caller-completion',
        attempt: 9,
        retryOwner: 'caller',
      },
    });
    expect(harness.complete.mock.calls[0]?.[0]).toMatchObject({
      accounting: {
        logicalCallId: 'llm:caller-completion',
        attempt: 9,
        retryOwner: 'caller',
      },
    });
  });

  it('requires durable gateway episode authorization for nested ICP cost correlation', async () => {
    const correlation: IcpConversationCorrelation = {
      conversationId: '33333333-3333-4333-8333-333333333333',
      rootInitiationId: '44444444-4444-4444-8444-444444444444',
      initiatedByCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      peerCompanionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      peerContactId: 'contact-b',
      channelId: 'companion-dm:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      turnId: 'turn-1',
      messageId: 'message-1',
      requestId: 'request-1',
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'summary',
      costOriginStage: 'post_turn',
      fatigueDecision: 'not_evaluated',
    };
    const authorizeIcpConversationCorrelation = vi.fn(async value => value);
    const harness = createHarness({ authorizeIcpConversationCorrelation });

    await harness.invoke('llm.complete', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'summary' }],
      systemPrompt: 'system',
      purpose: 'summary',
      icpCorrelation: correlation,
    });
    expect(authorizeIcpConversationCorrelation).toHaveBeenCalledWith(correlation);
    expect(harness.complete.mock.calls[0]?.[0]).toMatchObject({
      correlation: {
        companionId: correlation.localCompanionId,
        conversationId: correlation.conversationId,
        rootInitiationId: correlation.rootInitiationId,
        icpCorrelation: correlation,
      },
    });

    await expect(createHarness().invoke('llm.complete', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'forged summary' }],
      systemPrompt: 'system',
      purpose: 'summary',
      icpCorrelation: correlation,
    })).rejects.toMatchObject({ code: -32011 });
  });

  it('exposes a typed ICP pre-call block over JSON-RPC', async () => {
    const harness = createHarness();
    const event = {
      timestampMs: 123,
      outcome: 'blocked' as const,
      reason: 'hard_limit_exceeded' as const,
      logicalCallId: 'logical-1',
      attempt: 1,
      conversationId: '33333333-3333-4333-8333-333333333333',
      rootInitiationId: '44444444-4444-4444-8444-444444444444',
      localCompanionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      costPurpose: 'conversation_turn' as const,
      costOriginStage: 'reply' as const,
      provider: 'openrouter',
      model: 'test/model',
      routingPurpose: 'chat',
      projectedRequestCostUsd: 0.5,
      replayed: false,
    };
    harness.stream.mockRejectedValueOnce(new IcpConversationCostBreakerError(event));

    await expect(harness.invoke('llm.chat', {
      model: 'test/model',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'blocked' }],
      systemPrompt: 'system',
    })).rejects.toMatchObject({
      code: GatewayErrors.ICP_CONVERSATION_COST_BLOCKED,
      data: event,
    });
  });

  it('rejects malformed caller-owned accounting identity before provider transport', async () => {
    const harness = createHarness();

    await expect(harness.invoke('llm.chat', {
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      accounting: {
        logicalCallId: '',
        attempt: 0,
        retryOwner: 'caller',
      },
    })).rejects.toThrow('accounting.logicalCallId');
    expect(harness.stream).not.toHaveBeenCalled();
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
      pin: true,
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
      pin: true,
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

  it('routes model discovery through the privileged discovery backend', async () => {
    const harness = createHarness();

    await expect(harness.invoke('llm.discover_models', {})).resolves.toEqual({
      models: [{ id: 'model-1' }],
    });
    expect(harness.modelDiscovery.getAvailableModels).toHaveBeenCalledTimes(1);
  });

  it('invalidates the privileged discovery cache on demand', async () => {
    const harness = createHarness();

    await expect(harness.invoke('llm.invalidate_model_discovery', {})).resolves.toEqual({
      success: true,
    });
    expect(harness.modelDiscovery.invalidateCache).toHaveBeenCalledTimes(1);
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

  it('pipes upstream LiteLLM cost from the gateway edge into llm.complete usage details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
        cost: 0.123,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const harness = createHarness();
    harness.complete.mockImplementationOnce(async () => {
      await fetch('http://litellm.test/v1/chat/completions');
      return {
        content: 'completed',
        model: 'mock-model',
        inputTokens: 10,
        outputTokens: 2,
        usageDetails: {
          input: 10,
          output: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 12,
        },
        stopReason: 'stop',
      };
    });

    const result = await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'summarize' }],
      systemPrompt: 'system',
      purpose: 'summary',
    });

    expect(result.usageDetails).toMatchObject({
      input: 10,
      output: 2,
      cost: {
        total: 0.123,
        currency: 'USD',
      },
    });
  });

  it('awaits canonical embedding usage persistence with provider token and cost evidence', async () => {
    const usageEvents: ModelUsageEventInput[] = [];
    const embeddingService = {
      kind: 'api',
      model: 'text-embedding-3-small',
      dims: 3,
      embed: vi.fn(),
      embedBatch: vi.fn(async () => []),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2, 3])],
        usageDetails: {
          input: 7,
          output: 0,
          cacheRead: 2,
          cacheWrite: 0,
          totalTokens: 9,
          cost: { total: 0.000009, currency: 'USD' },
          raw: { prompt_tokens: 9, total_tokens: 9 },
        },
      })),
    };
    const harness = createHarness({ embeddingService, usageEvents });

    await expect(harness.invoke('llm.embed', {
      texts: ['first'],
      companionId: 'companion-a',
      sessionId: 'session-1',
      channelId: 'shard:shard-1',
      channelType: 'api',
      chargeLane: 'shard',
      chargeSurface: 'externalEmbedding',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-run-1',
      shardId: 'shard-1',
      workloadType: 'shard',
      workloadId: 'shard-1',
    })).resolves.toEqual({
      embeddings: [[1, 2, 3]],
    });

    expect(embeddingService.embedBatchWithUsage).toHaveBeenCalledWith(['first']);
    expect(embeddingService.embedBatch).not.toHaveBeenCalled();
    expect(usageEvents).toMatchObject([{
      attempt: 1,
      status: 'success',
      settlement: 'complete',
      callKind: 'embedding',
      attribution: {
        companionId: 'companion-a',
        sessionId: 'session-1',
        channelId: 'shard:shard-1',
        channelType: 'api',
        chargeLane: 'shard',
        chargeSurface: 'externalEmbedding',
        chargeEventId: 'charge-event-1',
        chargeRunId: 'run-1',
        chargeRootRunId: 'root-run-1',
        shardId: 'shard-1',
        workloadType: 'shard',
        workloadId: 'shard-1',
      },
      provider: 'api',
      model: 'text-embedding-3-small',
      inputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 2,
      cacheWriteTokens: 0,
      totalTokens: 9,
      providerCost: { total: 0.000009, currency: 'USD' },
      metadata: expect.objectContaining({
        rawUsage: { prompt_tokens: 9, total_tokens: 9 },
      }),
    }]);
  });

  it('records direct gateway embedding cost conflicts as partially settled', async () => {
    const usageEvents: ModelUsageEventInput[] = [];
    const embeddingService = {
      kind: 'api',
      model: 'text-embedding-3-small',
      dims: 3,
      embed: vi.fn(),
      embedBatch: vi.fn(async () => []),
      embedBatchWithUsage: vi.fn(async () => ({
        embeddings: [new Float32Array([1, 2, 3])],
        usageDetails: {
          input: 7,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 7,
          raw: {
            providerCostEvidence: {
              bodyUsage: { total: 0.1, currency: 'USD' },
              headers: { total: 0.2, currency: 'USD' },
            },
            providerCostEvidenceConflict: { fields: ['total'] },
          },
        },
      })),
    };
    const harness = createHarness({ embeddingService, usageEvents });

    await harness.invoke('llm.embed', { texts: ['first'] });

    expect(usageEvents).toMatchObject([{
      status: 'success',
      settlement: 'partial',
      inputTokens: 7,
      metadata: expect.objectContaining({
        rawUsage: expect.objectContaining({
          providerCostEvidenceConflict: { fields: ['total'] },
        }),
      }),
    }]);
  });
});
