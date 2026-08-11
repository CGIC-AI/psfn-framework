import { EventEmitter } from 'node:events';
import { fromAny, fromPartial } from '@total-typescript/shoehorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredModel } from '../../../primitives/llm/discovery.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerLLMMethods } from './llm.js';
import type { ModelUsageEventInput } from '../../../shared/telemetry/model-usage.js';
import type { IcpConversationCorrelation } from '../../../shared/contracts/icp-autonomy.js';
import { IcpConversationCostBreakerError } from '../../../primitives/llm/icp-conversation-cost-breaker.js';
import { GatewayErrors } from '../protocol.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { LLMClient } from '../../../primitives/llm/client.js';
import { buildLLMWorkSpec } from '../../../primitives/llm/work-spec.js';
import { toWorkSpecWireParams } from '../../../primitives/llm/work-spec-wire.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { GatewayClient } from '../client.js';
import type { NdjsonConnection } from '../transport.js';
import {
  buildSubagentWorkSpec,
  createSubagentWorkSpecProvider,
} from '../../../faculties/subagents/work-spec.js';
import { GatewayLLMRequestCancellation } from '../llm-request-cancellation.js';
import { GatewayMcpInvocationAuthority } from '../mcp/invocation-authority.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createHarness(options: {
  embeddingService?: GatewayMethodRuntime['embeddingService'] & {
    embedBatchWithUsage?: (texts: string[]) => Promise<unknown>;
  };
  usageEvents?: ModelUsageEventInput[];
  authorizeIcpConversationCorrelation?: GatewayMethodRuntime['authorizeIcpConversationCorrelation'];
  llmProvider?: GatewayMethodRuntime['llmProvider'];
  audited?: GatewayMethodRuntime['audited'];
  authenticatedCompanionId?: string;
} = {}) {
  const methods = new Map<string, (params: any) => Promise<any>>();
  const stream = vi.fn<LLMProviderPort['stream']>(async () => ({
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
  const complete = vi.fn<LLMProviderPort['complete']>(async () => ({
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

  const mcpInvocationAuthority = new GatewayMcpInvocationAuthority();
  const runtime: GatewayMethodRuntime = {
    target: fromAny({
      addMethod(name: string, handler: (params: any) => Promise<any>) {
        methods.set(name, handler);
      },
    }),
    llmProvider: options.llmProvider ?? ({
      stream,
      complete,
    }),
    embeddingService: options.embeddingService ?? fromAny({
      embed: vi.fn(),
      embedBatch: vi.fn(async () => []),
      dims: 1,
    }),
    ...(options.usageEvents ? {
      modelUsageRecorder: {
        async recordUsageEvent(event: ModelUsageEventInput) {
          options.usageEvents?.push(event);
        },
      },
    } : {}),
    modelDiscovery,
    discordAdapter: fromPartial<Record<string, unknown>>({}),
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
    authenticatedCompanionId: () => options.authenticatedCompanionId,
    llmRequestCancellation: new GatewayLLMRequestCancellation(),
    mcpInvocationAuthority,
    ...(options.authorizeIcpConversationCorrelation
      ? { authorizeIcpConversationCorrelation: options.authorizeIcpConversationCorrelation }
      : {}),
    audited: options.audited ?? ((_method, handler) => handler),
    approvalBoundary: fromAny({
      gate: (_options) => async (params) => _options.handler(params),
    }),
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
    notifyRequester: runtime.notifyRequester,
    mcpInvocationAuthority,
  };
}

function createLinkedGatewayClient(
  invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>,
): GatewayClient {
  const emitter = new EventEmitter();
  const connection = {
    send(frame: unknown): boolean {
      const request = frame as {
        id?: number;
        method: string;
        params: Record<string, unknown>;
      };
      const result = Promise.resolve(invoke(request.method, request.params));
      if (request.id === undefined) {
        void result.catch(() => undefined);
        return true;
      }
      void result.then(
        result => emitter.emit('message', {
          jsonrpc: '2.0',
          id: request.id,
          result,
        }),
        error => emitter.emit('message', {
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: typeof error === 'object'
              && error !== null
              && 'code' in error
              && typeof error.code === 'number'
              ? error.code
              : -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      return true;
    },
    sendHeartbeat: () => true,
    onHeartbeat: (handler: () => void) => emitter.on('heartbeat', handler),
    onMessage: (handler: (message: unknown) => void) => emitter.on('message', handler),
    on: (event: string, handler: (...args: unknown[]) => void) => emitter.on(event, handler),
    destroy: () => emitter.removeAllListeners(),
  };
  return new GatewayClient(connection as unknown as NdjsonConnection, 1024);
}

describe('registerLLMMethods', () => {
  it('reserves completion cancellation before an awaited audit and passes the aborted signal upstream', async () => {
    let releaseAudit!: () => void;
    const auditGate = new Promise<void>(resolve => {
      releaseAudit = resolve;
    });
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn<LLMProviderPort['complete']>(async (_context, _purpose, options) => {
      providerSignal = options?.signal;
      if (providerSignal?.aborted) throw providerSignal.reason;
      return await new Promise((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    });
    const harness = createHarness({
      llmProvider: {
        stream: vi.fn(),
        complete,
      },
      // Gate ONLY the completion's audit so a fast cancel races the slow
      // provider handler. llm.cancel is itself audited now (oetdv), and its
      // audit is fast in production, so it must not be frozen by this gate.
      audited: (method, handler) => async params => {
        if (method === 'llm.complete') await auditGate;
        return await handler(params);
      },
    });
    const cancellationId = '11111111-1111-4111-8111-111111111111';

    const pending = harness.invoke('llm.complete', {
      cancellationId,
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'work' }],
      systemPrompt: 'system',
      purpose: 'background',
    });
    await expect(harness.invoke('llm.cancel', { cancellationId })).resolves.toEqual({
      cancelled: true,
    });
    releaseAudit();

    await expect(pending).rejects.toThrow('cancelled by its owning connection');
    expect(providerSignal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    await expect(harness.invoke('llm.cancel', { cancellationId })).resolves.toEqual({
      cancelled: false,
    });
  });

  it('oetdv: routes llm.cancel through the audited wrapper with the cancellationId in the audit summary', async () => {
    const auditCalls: Array<{ method: string; summary: Record<string, unknown> | undefined }> = [];
    const harness = createHarness({
      audited: (method, handler, summary) => async (params) => {
        // Audit-then-act: capture the summary BEFORE running the handler, exactly
        // like the real gateway wrapper, so the cancellationId lands in the row.
        auditCalls.push({ method, summary: summary?.(params) });
        return await handler(params);
      },
    });
    const cancellationId = '33333333-3333-4333-8333-333333333333';

    // An unknown id is harmless and bounded (cancelled:false) but must still be
    // audited with its cancellationId so the record identifies what was targeted.
    await expect(harness.invoke('llm.cancel', { cancellationId })).resolves.toEqual({
      cancelled: false,
    });
    expect(auditCalls).toContainEqual({ method: 'llm.cancel', summary: { cancellationId } });
  });

  it('oetdv: rejects a malformed llm.cancel with a typed gateway error inside the errors block and still audits it', async () => {
    const auditFailures: Array<{ method: string; error: unknown }> = [];
    const harness = createHarness({
      audited: (method, handler) => async (params) => {
        try {
          return await handler(params);
        } catch (error) {
          auditFailures.push({ method, error });
          throw error;
        }
      },
    });

    await expect(
      harness.invoke('llm.cancel', { cancellationId: 'not-a-canonical-uuid' }),
    ).rejects.toMatchObject({ code: GatewayErrors.INVALID_LLM_CANCELLATION });
    // The malformed cancel is observable: the audited wrapper saw the typed
    // failure rather than a silent bare-Error no-op.
    expect(auditFailures).toHaveLength(1);
    expect(auditFailures[0]?.method).toBe('llm.cancel');
    expect(auditFailures[0]?.error).toMatchObject({ code: GatewayErrors.INVALID_LLM_CANCELLATION });
  });

  it('passes connection-scoped cancellation through streamed chat provider options', async () => {
    let providerSignal: AbortSignal | undefined;
    const stream = vi.fn<LLMProviderPort['stream']>(async (_context, _callbacks, options) => {
      providerSignal = options?.signal;
      return await new Promise((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    });
    const harness = createHarness({
      llmProvider: {
        stream,
        complete: vi.fn(),
      },
    });
    const cancellationId = '22222222-2222-4222-8222-222222222222';

    const pending = harness.invoke('llm.chat', {
      cancellationId,
      requestId: 'stream-request',
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'work' }],
      systemPrompt: 'system',
      stream: true,
    });
    await vi.waitFor(() => expect(providerSignal).toBeInstanceOf(AbortSignal));
    await expect(harness.invoke('llm.cancel', { cancellationId })).resolves.toEqual({
      cancelled: true,
    });

    await expect(pending).rejects.toThrow('cancelled by its owning connection');
    expect(providerSignal?.aborted).toBe(true);
  });

  it('cancels a split-runtime GatewayClient completion through the gateway provider boundary', async () => {
    let providerSignal: AbortSignal | undefined;
    const complete = vi.fn<LLMProviderPort['complete']>(async (_context, _purpose, options) => {
      providerSignal = options?.signal;
      return await new Promise((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    });
    const harness = createHarness({
      llmProvider: {
        stream: vi.fn(),
        complete,
      },
    });
    const gatewayClient = createLinkedGatewayClient(harness.invoke);
    const controller = new AbortController();

    const pending = gatewayClient.complete({
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'large analysis' }],
    }, 'background', { signal: controller.signal });
    await vi.waitFor(() => expect(providerSignal).toBeInstanceOf(AbortSignal));
    controller.abort(new Error('workbench response deadline'));

    await expect(pending).rejects.toThrow('workbench response deadline');
    expect(providerSignal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
    gatewayClient.destroy();
  });

  it('zn2iy: cancels a split-runtime GatewayClient embed through the gateway embedding provider boundary', async () => {
    let providerSignal: AbortSignal | undefined;
    const embedBatch = vi.fn(async (
      _texts: string[],
      options?: { signal?: AbortSignal },
    ): Promise<Float32Array[]> => {
      providerSignal = options?.signal;
      return await new Promise<Float32Array[]>((_resolve, reject) => {
        providerSignal?.addEventListener('abort', () => reject(providerSignal?.reason), { once: true });
      });
    });
    const harness = createHarness({
      embeddingService: fromAny({ embed: vi.fn(), embedBatch, dims: 3 }),
    });
    const gatewayClient = createLinkedGatewayClient(harness.invoke);
    const controller = new AbortController();

    const pending = gatewayClient.embedBatch(['analyze this large file'], {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(providerSignal).toBeInstanceOf(AbortSignal));
    controller.abort(new Error('retrieval deadline'));

    await expect(pending).rejects.toThrow('retrieval deadline');
    // The exact upstream embedding provider signal aborts (not merely the local
    // JSON-RPC wrapper), so the provider work tears down after the caller cancels.
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
    expect(embedBatch).toHaveBeenCalledOnce();
    gatewayClient.destroy();
  });

  it('zn2iy: leaves a signal-free (background) embed uncancellable and unaffected', async () => {
    let providerSignal: AbortSignal | undefined | 'unset' = 'unset';
    const embedBatch = vi.fn(async (
      _texts: string[],
      options?: { signal?: AbortSignal },
    ): Promise<Float32Array[]> => {
      providerSignal = options?.signal;
      return [new Float32Array([1, 2, 3])];
    });
    const harness = createHarness({
      embeddingService: fromAny({ embed: vi.fn(), embedBatch, dims: 3 }),
    });

    // A durable background caller omits the signal deliberately; the provider
    // still runs to completion with no cancellation lifetime attached.
    await expect(harness.invoke('llm.embed', { texts: ['durable background'] }))
      .resolves.toEqual({ embeddings: [[1, 2, 3]] });
    expect(embedBatch).toHaveBeenCalledWith(['durable background'], undefined);
    expect(providerSignal).toBeUndefined();
  });

  it('forwards provider first-output observations as content-free requester notifications', async () => {
    const harness = createHarness();
    harness.stream.mockImplementationOnce(async (_context, callbacks) => {
      callbacks?.onFirstOutput?.({
        kind: 'thinking',
        monotonicAtMs: 1_234,
        timestampMs: 5_678,
      });
      return {
        content: 'answer',
        toolCalls: [],
        model: 'mock-model',
        inputTokens: 5,
        outputTokens: 3,
        stopReason: 'stop',
      };
    });

    await harness.invoke('llm.chat', {
      requestId: 'request-provider-output-1',
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      stream: true,
    });

    expect(harness.notifyRequester).toHaveBeenCalledWith('llm.first_output', {
      requestId: 'request-provider-output-1',
      kind: 'thinking',
      monotonicAtMs: 1_234,
      timestampMs: 5_678,
    });
  });

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
      model: '  z-ai/glm-5  ',
      provider: '  OpenRouter  ',
      pin: false,
      messages: [{ role: 'user', content: 'hello' }],
      systemPrompt: 'system',
      maxTokens: 321.9,
      contextWindow: 120_000.8,
      thinkingEnabled: false,
      thinkingEffort: 'xhigh',
      temperature: 0.33,
      topP: 0.77,
      topK: 42.7,
      frequencyPenalty: -0.12,
      repetitionPenalty: 1.03,
    });

    expect(harness.stream).toHaveBeenCalledTimes(1);
    const firstCall = harness.stream.mock.calls[0][0];
    expect(firstCall.modelHint).toEqual({
      model: 'z-ai/glm-5',
      provider: 'openrouter',
      pin: false,
      maxTokens: 321,
      contextWindow: 120_000,
      thinkingEnabled: false,
      thinkingEffort: 'xhigh',
      temperature: 0.33,
      topP: 0.77,
      topK: 42,
      frequencyPenalty: -0.12,
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

  it('mints an opaque exact MCP permit only for a non-shard model tool call', async () => {
    const companionId = '4b90c2e6-0663-4f01-9965-9d228fa848bd';
    const harness = createHarness({ authenticatedCompanionId: companionId });
    harness.stream.mockResolvedValue({
      content: '',
      toolCalls: [{
        id: 'mcp-call-1',
        name: 'mcp',
        input: {
          action: 'call',
          server_id: 'notes',
          tool_name: 'search_notes',
          arguments: { query: 'Example Person' },
        },
      }],
      model: 'mock-model',
      inputTokens: 5,
      outputTokens: 3,
      stopReason: 'tool_use',
    });

    const result = await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      channelId: 'discord:dm:operator',
      messages: [{ role: 'user', content: 'search notes' }],
      systemPrompt: 'system',
      tools: [{ name: 'mcp', description: 'MCP', inputSchema: { type: 'object' } }],
      mcpOutboundSensitivity: 'public',
    });
    const permit = result.toolCalls[0]?.gatewayMcpPermit;
    expect(permit).toMatch(/^[0-9a-f-]{36}$/u);
    expect(harness.mcpInvocationAuthority.consume({
      permit,
      companionId,
      params: {
        action: 'call',
        serverId: 'notes',
        toolName: 'search_notes',
        arguments: { query: 'Example Person' },
      },
    })).toEqual({ outboundSensitivity: 'public' });

    const missingLineage = await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      channelId: 'discord:dm:operator',
      messages: [{ role: 'user', content: 'search notes' }],
      systemPrompt: 'system',
      tools: [{ name: 'mcp', description: 'MCP', inputSchema: { type: 'object' } }],
    });
    expect(missingLineage.toolCalls[0]).not.toHaveProperty('gatewayMcpPermit');

    const shardResult = await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      channelId: 'shard:worker-1',
      messages: [{ role: 'user', content: 'search notes' }],
      systemPrompt: 'system',
      tools: [{ name: 'mcp', description: 'MCP', inputSchema: { type: 'object' } }],
      mcpOutboundSensitivity: 'public',
    });
    expect(shardResult.toolCalls[0]).not.toHaveProperty('gatewayMcpPermit');

    const autonomousResult = await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      channelId: 'discord:dm:operator',
      messages: [{ role: 'user', content: 'search notes' }],
      systemPrompt: 'system',
      tools: [{ name: 'mcp', description: 'MCP', inputSchema: { type: 'object' } }],
      mcpOutboundSensitivity: 'public',
      workSpec: toWorkSpecWireParams(buildLLMWorkSpec({
        purpose: 'extraction',
        durable: true,
        correlation: { callType: 'background', originStage: 'memory.extraction' },
      })),
    });
    expect(autonomousResult.toolCalls[0]).not.toHaveProperty('gatewayMcpPermit');
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

  it('forwards a per-companion model selection slotKey into the provider hint (23pp)', async () => {
    const harness = createHarness();

    await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      slotKey: 'vision-flash',
      messages: [{ role: 'user', content: 'describe the image' }],
      systemPrompt: 'system',
      purpose: 'vision',
    });

    expect(harness.complete).toHaveBeenCalledTimes(1);
    const firstCall = harness.complete.mock.calls[0][0];
    expect(firstCall.modelHint).toEqual({ slotKey: 'vision-flash' });
  });

  it('exposes an unknown model-selection slot as a typed JSON-RPC error (23pp fail-closed)', async () => {
    const { UnknownModelSelectionSlotError } = await import(
      '../../../primitives/llm/model-hint-routing.js'
    );
    const failingComplete = vi.fn(async () => {
      throw new UnknownModelSelectionSlotError('stale-slot', ['primary', 'extraction']);
    });
    const harness = createHarness({
      llmProvider: { complete: failingComplete } as unknown as GatewayMethodRuntime['llmProvider'],
    });

    await expect(harness.invoke('llm.complete', {
      model: '',
      provider: '',
      slotKey: 'stale-slot',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'system',
      purpose: 'chat',
    })).rejects.toMatchObject({
      code: GatewayErrors.UNKNOWN_MODEL_SELECTION_SLOT,
      message: expect.stringContaining('stale-slot'),
      data: { slotKey: 'stale-slot' },
    });
  });

  it('preserves a non-vision vision-lane failure across JSON-RPC before provider dispatch', async () => {
    const { VisionPurposeResolvedNonVisionModelError } = await import(
      '../../../primitives/llm/routing.js'
    );
    const failingComplete = vi.fn(async () => {
      throw new VisionPurposeResolvedNonVisionModelError({
        provider: 'openrouter',
        model: 'vendor/text-only',
        slotKey: 'text-only',
      });
    });
    const harness = createHarness({
      llmProvider: { complete: failingComplete } as unknown as GatewayMethodRuntime['llmProvider'],
    });

    await expect(harness.invoke('llm.complete', {
      model: '',
      provider: '',
      slotKey: 'text-only',
      messages: [{ role: 'user', content: 'describe the image' }],
      systemPrompt: 'system',
      purpose: 'vision',
    })).rejects.toMatchObject({
      code: GatewayErrors.VISION_PURPOSE_RESOLVED_NON_VISION_MODEL,
      message: expect.stringContaining('vision_purpose_resolved_non_vision_model'),
      data: {
        code: 'vision_purpose_resolved_non_vision_model',
        provider: 'openrouter',
        model: 'vendor/text-only',
        slotKey: 'text-only',
      },
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
      chargeSurface: 'externalModelConsult',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      chargeRootRunId: 'root-run-1',
      shardId: 'shard-1',
      workloadType: 'shard',
      workloadId: 'shard-1',
    })).resolves.toEqual({
      embeddings: [[1, 2, 3]],
    });

    // zn2iy: llm.embed now forwards an optional cancellation option; with no
    // caller signal it is undefined (deliberate non-cancellation).
    expect(embeddingService.embedBatchWithUsage).toHaveBeenCalledWith(['first'], undefined);
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
    for (const field of [
      'chargeLane',
      'chargeSurface',
      'chargeEventId',
      'chargeRunId',
      'chargeRootRunId',
      'chargeParentRunId',
    ]) {
      expect(usageEvents[0]?.attribution).not.toHaveProperty(field);
    }
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

// psfn-framework-d8vq.2 — the autonomous accountability guard must enforce on
// the GATEWAY side in the split topology. These tests exercise the RPC/provider
// seam: the LLMWorkSpec now crosses the wire and reaches the serving provider.
describe('registerLLMMethods work-spec accountability seam (psfn-framework-d8vq.2)', () => {
  // A serving-side config minimal for LLMClient construction; the guard fires
  // before any candidate resolution / provider I/O, so no roster is required.
  function makeServingConfig(): SubstrateConfig {
    return {
      primaryModel: 'z-ai/glm-5',
      primaryProvider: 'openrouter',
      primaryMaxTokens: 4096,
      defaultContextWindow: 128_000,
      modelRoster: {
        chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 2048 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [{
          id: 'background',
          rank: 10,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [{ purpose: 'background', primary: true }],
          capabilities: { maxOutputTokens: 2048 },
          tuning: { maxOutputTokens: 2048 },
        }],
      },
    } as unknown as SubstrateConfig;
  }

  const autonomousWireSpec = () => toWorkSpecWireParams(buildLLMWorkSpec({
    purpose: 'extraction',
    durable: true,
    correlation: { callType: 'background', originStage: 'memory.extraction' },
  }));

  it('forwards a parsed work spec into the serving provider complete options', async () => {
    const harness = createHarness();
    const workSpec = autonomousWireSpec();

    await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'extract' }],
      systemPrompt: 'system',
      purpose: 'extraction',
      callType: 'background',
      originStage: 'memory.extraction',
      workSpec,
    });

    expect(harness.complete.mock.calls[0]?.[2]).toEqual({ workSpec });
  });

  it('serves one correlated subagent stream across the real split boundary', async () => {
    const providerStream = vi.fn<LLMProviderPort['stream']>(async () => ({
      content: 'linked stream',
      toolCalls: [],
      model: 'deepseek/deepseek-v3.2',
      inputTokens: 7,
      outputTokens: 3,
      stopReason: 'stop',
    }));
    const usageRecorder = {
      recordUsageEvent: vi.fn(async (_event: ModelUsageEventInput) => undefined),
    };
    const servingClient = new LLMClient(makeServingConfig(), {
      transport: {
        stream: providerStream,
        complete: vi.fn(),
      },
      usageRecorder,
    });
    const harness = createHarness({ llmProvider: servingClient });
    const gatewayClient = createLinkedGatewayClient(harness.invoke);
    const workSpec = buildSubagentWorkSpec({
      correlation: {
        requestId: 'linked-subagent-request',
        turnId: 'linked-parent-turn',
        channelId: 'linked-parent-channel',
      },
    });
    const workerProvider = createSubagentWorkSpecProvider(gatewayClient, workSpec);

    const response = await workerProvider.stream(
      {
        systemPrompt: 'linked system',
        messages: [{ role: 'user', content: 'perform linked work' }],
      },
    );

    expect(response.content).toBe('linked stream');
    expect(providerStream).toHaveBeenCalledTimes(1);
    expect(providerStream.mock.calls[0]?.[0].correlation).toMatchObject({
      requestId: 'linked-subagent-request',
      turnId: 'linked-parent-turn',
      channelId: 'linked-parent-channel',
      callType: 'background',
      originStage: 'subagent.turn',
    });
  });

  it('forwards a parsed work spec into the serving provider stream options', async () => {
    const harness = createHarness();
    const workSpec = autonomousWireSpec();

    await harness.invoke('llm.chat', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'extract' }],
      systemPrompt: 'system',
      purpose: 'extraction',
      callType: 'background',
      originStage: 'memory.extraction',
      workSpec,
    });

    expect(harness.stream.mock.calls[0]?.[2]).toEqual({ workSpec });
  });

  it('leaves legacy non-work-spec calls with no provider options', async () => {
    const harness = createHarness();

    await harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'system',
      purpose: 'background',
    });

    expect(harness.complete.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('fails closed on a malformed work spec before touching the provider', async () => {
    const harness = createHarness();

    await expect(harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'extract' }],
      systemPrompt: 'system',
      purpose: 'extraction',
      workSpec: { purpose: 'not-a-purpose', lane: 'maintenance_reflection', durable: true },
    })).rejects.toMatchObject({ code: GatewayErrors.INVALID_WORK_SPEC });

    expect(harness.complete).not.toHaveBeenCalled();
  });

  it('hard-errors an RPC-transported autonomous call with no serving-side usageRecorder before provider I/O', async () => {
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'should never run',
        model: 'deepseek/deepseek-v3.2',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'stop',
        toolCalls: [],
      })),
    };
    // A real serving LLMClient with NO usageRecorder configured.
    const servingClient = new LLMClient(makeServingConfig(), { transport: fromAny(transport) });
    const harness = createHarness({ llmProvider: servingClient });
    const workSpec = autonomousWireSpec();
    expect(workSpec.lane).toBe('maintenance_reflection');

    await expect(harness.invoke('llm.complete', {
      model: '',
      provider: '',
      messages: [{ role: 'user', content: 'extract' }],
      systemPrompt: 'system',
      purpose: 'extraction',
      callType: 'background',
      originStage: 'memory.extraction',
      workSpec,
    })).rejects.toThrow(/unaccounted autonomous spend/);

    // Fail closed BEFORE provider I/O: the transport is never reached.
    expect(transport.complete).not.toHaveBeenCalled();
  });
});
