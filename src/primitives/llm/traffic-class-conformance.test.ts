import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  Model,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type {
  CompletionPurpose,
  ContextMessage,
  CorrelationMetadata,
  LLMContext,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { LLMClient } from './client.js';
import type { ProviderRuntime } from './provider-runtime.js';
import { createOpenAICompatibleEndpointModel } from './models.js';

/**
 * Bead psfn-framework-shjzt.4 — traffic-class conformance.
 *
 * Every LLM traffic class (interactive streaming, non-streamed/background
 * completions, summarization, extraction, import processing, vision, explicit
 * model override, candidate fallback) is driven against ONE injected
 * {@link ProviderRuntime}. The {@link LLMClient} is constructed without a
 * transport, so its only provider-dispatch path is the injected runtime — the
 * same boundary the gateway composition injects. The harness then asserts each
 * call resolved through that single runtime with the expected
 * candidate/provider/model/control-knob identity, covering both the generic
 * external-router endpoint and direct (OpenRouter + built-in/faux) modes.
 */

const SHARED_ROUTER_API_KEY_ENV = 'PSFN_TRAFFIC_CONF_ROUTER_KEY';
const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

interface RecordedDispatch {
  method: 'complete' | 'stream';
  model: Model<Api>;
  context: PiContext;
  options: SimpleStreamOptions | undefined;
}

interface RecordingRuntimeBehavior {
  /**
   * Optional override for the next dispatch. When set, the runtime throws or
   * yields a controlled stream instead of the canned success response. The
   * override is consumed by the first dispatch that observes it.
   */
  completeImpl?: (model: Model<Api>, options: SimpleStreamOptions | undefined) => Promise<AssistantMessage> | AssistantMessage;
  streamImpl?: (
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
  ) => AsyncIterable<AssistantMessageEvent>;
  /** Invoke the wire-payload capture hook with this payload before settling. */
  emitPayload?: unknown;
}

class RecordingProviderRuntime implements ProviderRuntime {
  /** Unique identity so tests can prove every dispatch used the same instance. */
  readonly instance = Symbol('recording-runtime');
  readonly completeCalls: RecordedDispatch[] = [];
  readonly streamCalls: RecordedDispatch[] = [];
  readonly getModelsCalls: string[] = [];
  private readonly registered: ReadonlyMap<string, readonly Model<Api>[]>;
  private behavior: RecordingRuntimeBehavior = {};

  constructor(registered: ReadonlyMap<string, readonly Model<Api>[]>) {
    this.registered = registered;
  }

  setBehavior(behavior: RecordingRuntimeBehavior): void {
    this.behavior = behavior;
  }

  reset(): void {
    this.completeCalls.length = 0;
    this.streamCalls.length = 0;
    this.getModelsCalls.length = 0;
    this.behavior = {};
  }

  async complete(
    model: Model<Api>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessage> {
    this.completeCalls.push({ method: 'complete', model, context, options });
    const behavior = this.behavior;
    await invokePayloadHook(options, model, behavior.emitPayload);
    if (behavior.completeImpl) {
      return behavior.completeImpl(model, options);
    }
    return cannedAssistantMessage(model);
  }

  stream(
    model: Model<Api>,
    context: PiContext,
    options?: SimpleStreamOptions,
  ): AsyncIterable<AssistantMessageEvent> {
    this.streamCalls.push({ method: 'stream', model, context, options });
    // Snapshot behavior at dispatch time but do not reset it: a candidate-level
    // fallback dispatches through this same runtime and must observe the same
    // controlled behavior to model a coherent provider sequence.
    const behavior = this.behavior;
    return recordingStream(model, options, behavior);
  }

  getProviders(): readonly string[] {
    return [...this.registered.keys()];
  }

  getModels(provider: string): readonly Model<Api>[] {
    this.getModelsCalls.push(provider);
    return this.registered.get(provider.trim().toLowerCase()) ?? [];
  }

  getAuth(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  resolveProviderApiKey(): undefined {
    return undefined;
  }
}

function cannedAssistantMessage(model: Model<Api>, text = 'ok'): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: String(model.id),
    usage: {
      input: 11,
      output: 7,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 0,
  };
}

async function invokePayloadHook(
  options: SimpleStreamOptions | undefined,
  model: Model<Api>,
  emitPayload: unknown,
): Promise<void> {
  if (emitPayload === undefined) return;
  const onPayload = options?.onPayload as
    | ((payload: unknown, payloadModel: Model<Api>) => unknown | Promise<unknown>)
    | undefined;
  if (typeof onPayload !== 'function') return;
  await onPayload(emitPayload, model);
}

async function* recordingStream(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  behavior: RecordingRuntimeBehavior,
): AsyncGenerator<AssistantMessageEvent> {
  if (behavior.streamImpl) {
    yield* behavior.streamImpl(model, options);
    return;
  }
  const partial = cannedAssistantMessage(model, '');
  yield { type: 'start', partial };
  yield {
    type: 'text_delta',
    contentIndex: 0,
    delta: 'hello',
    partial: cannedAssistantMessage(model, 'hello'),
  };
  await invokePayloadHook(options, model, behavior.emitPayload);
  yield {
    type: 'done',
    reason: 'stop',
    message: cannedAssistantMessage(model, 'hello'),
  };
}

function buildRegisteredCatalog(): Map<string, readonly Model<Api>[]> {
  // Direct built-in/faux provider: a deterministic registered model resolved
  // through runtime.getModels (the only path that exercises the runtime's model
  // registry, not a configured endpoint URL).
  const fauxModel = createOpenAICompatibleEndpointModel({
    baseUrl: 'https://faux.example.test/v1',
    modelId: 'faux-extract',
    provider: 'faux',
    routeLabel: 'faux',
    maxTokens: 2048,
    contextWindow: 32_000,
    api: 'openai-completions',
  });
  return new Map([['faux', [fauxModel]]]);
}

function makeConformanceConfig(): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-traffic-conf-'));
  tempDirs.push(dataDir);
  const config: SubstrateConfig = {
    primaryModel: 'openrouter/exacto-model',
    primaryProvider: 'shared-router',
    extractionModel: 'faux-extract',
    extractionProvider: 'faux',
    primaryMaxTokens: 8192,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    // No within-candidate retries: deterministic candidate-level fallback.
    retryMaxAttempts: 0,
    retryBaseDelayMs: 0,
    importProcessingRouteMode: 'openrouter_zdr',
    providerRegistry: {
      schemaVersion: 1,
      providers: [
        {
          id: 'shared-router',
          type: 'generic_openai',
          enabled: true,
          label: 'Shared router',
          apiBaseUrl: 'https://router.example.test/v1',
          apiKeyRef: { kind: 'env', envName: SHARED_ROUTER_API_KEY_ENV },
        },
      ],
    },
    modelRegistry: {
      schemaVersion: 1,
      // Registry-wide prompt-caching policy so cache fields reach the runtime.
      promptCaching: { enabled: true, retention: 'short', scope: 'channel' },
      models: [
        {
          id: 'exacto-chat',
          rank: 10,
          apiKind: 'openai-responses',
          identity: {
            provider: 'shared-router',
            model: 'openrouter/exacto-model',
            source: { type: 'configured' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 8192,
            contextWindow: 128_000,
            supportsReasoning: true,
            supportsPromptCaching: true,
            promptCacheStrategy: 'openai_responses',
          },
          tuning: { maxOutputTokens: 8192, contextWindow: 128_000, thinkingEnabled: true },
          routing: { providerOrder: ['parasail', 'openai'] },
          cost: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
        },
        {
          id: 'chat-fallback',
          rank: 20,
          apiKind: 'openai-completions',
          identity: {
            provider: 'shared-router',
            model: 'fallback-model',
            source: { type: 'configured' },
          },
          purposes: [{ purpose: 'chat', primary: false }],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
        {
          id: 'nitro-background',
          rank: 30,
          apiKind: 'openai-completions',
          identity: {
            provider: 'shared-router',
            model: 'nitro-model',
            source: { type: 'configured' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'summary', primary: false },
          ],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000, supportsReasoning: true },
          // Explicit reasoning-off for the Nitro route (no incidental proxy default).
          tuning: { maxOutputTokens: 4096, thinkingEnabled: false },
        },
        {
          id: 'or-summary',
          rank: 40,
          apiKind: 'openai-completions',
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
          },
          purposes: [{ purpose: 'summary', primary: true }],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
          routing: { zdrOnly: true, providerOrder: ['parasail'] },
        },
        {
          id: 'or-import',
          rank: 50,
          apiKind: 'openai-completions',
          identity: {
            provider: 'openrouter',
            model: 'z-ai/glm-5',
            source: { type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
          },
          purposes: [{ purpose: 'import_processing', primary: true }],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
          routing: { zdrOnly: true, providerOrder: ['parasail', 'openai'] },
        },
        {
          id: 'faux-extract-entry',
          rank: 60,
          identity: {
            provider: 'faux',
            model: 'faux-extract',
            source: { type: 'faux' },
          },
          purposes: [{ purpose: 'extraction', primary: true }],
          capabilities: { maxOutputTokens: 2048, contextWindow: 32_000 },
          tuning: { maxOutputTokens: 2048 },
        },
        {
          id: 'vision-entry',
          rank: 70,
          apiKind: 'openai-completions',
          identity: {
            provider: 'shared-router',
            model: 'vision-model',
            source: { type: 'configured' },
          },
          purposes: [{ purpose: 'vision', primary: true }],
          capabilities: {
            maxOutputTokens: 2048,
            contextWindow: 128_000,
            supportsVision: true,
          },
          tuning: { maxOutputTokens: 2048 },
        },
      ],
    },
  };
  return config;
}

const tempDirs: string[] = [];

const savedEnv: NodeJS.ProcessEnv = { ...process.env };

function makeContext(overrides: Partial<LLMContext> = {}): LLMContext {
  const messages: ContextMessage[] = overrides.messages ?? [
    { role: 'user', content: 'hello' },
  ];
  const correlation: CorrelationMetadata = {
    companionId: 'companion-1',
    channelId: 'discord:general',
    channelType: 'discord',
    callType: 'chat',
    requestId: 'request-1',
    turnId: 'turn-1',
    ...overrides.correlation,
  };
  return {
    systemPrompt: 'System',
    messages,
    correlation,
    ...overrides,
  };
}

function makeHarness(): { client: LLMClient; runtime: RecordingProviderRuntime } {
  const runtime = new RecordingProviderRuntime(buildRegisteredCatalog());
  const client = new LLMClient(makeConformanceConfig(), { runtime });
  return { client, runtime };
}

beforeEach(() => {
  process.env[SHARED_ROUTER_API_KEY_ENV] = 'router-secret';
  process.env[OPENROUTER_API_KEY_ENV] = 'openrouter-secret';
});

afterEach(() => {
  for (const key of [SHARED_ROUTER_API_KEY_ENV, OPENROUTER_API_KEY_ENV]) {
    if (key in savedEnv) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('LLM traffic-class conformance through one injected pi-ai runtime', () => {
  it('routes interactive streaming and non-streamed completions through the same runtime instance', async () => {
    const { client, runtime } = makeHarness();

    const streamResponse = await client.stream(makeContext(), {
      onText: () => {},
    });
    expect(streamResponse.content).toBe('hello');
    expect(runtime.streamCalls).toHaveLength(1);

    const completeResponse = await client.complete(makeContext(), 'background', { disableRetry: true });
    expect(completeResponse.content).toBe('ok');
    expect(runtime.completeCalls).toHaveLength(1);

    // Both traffic classes dispatched through the one injected runtime.
    expect(runtime.streamCalls[0]).toBeDefined();
    expect(runtime.completeCalls[0]).toBeDefined();
    expect(runtime.streamCalls[0]!.model.provider).toBe('shared-router');
    expect(runtime.completeCalls[0]!.model.provider).toBe('shared-router');
  });

  it('resolves identical candidate/provider/model/control-knob identity for streaming and completion', async () => {
    const { client, runtime } = makeHarness();
    const context = makeContext();
    const exactoHint = { provider: 'shared-router', model: 'openrouter/exacto-model', pin: true };

    await client.stream(context);
    // Non-streamed `chat` completions deliberately route to the background lane,
    // so pin the same exacto candidate to compare paths on identical selection.
    await client.complete(context, 'chat', { disableRetry: true, modelHint: exactoHint });

    const streamModel = runtime.streamCalls[0]!.model;
    const completeModel = runtime.completeCalls[0]!.model;
    expect(completeModel.id).toBe(streamModel.id);
    expect(completeModel.provider).toBe(streamModel.provider);
    expect(completeModel.api).toBe(streamModel.api);
    expect(completeModel.baseUrl).toBe(streamModel.baseUrl);
    expect(completeModel.maxTokens).toBe(streamModel.maxTokens);

    const streamOptions = runtime.streamCalls[0]!.options as Record<string, unknown>;
    const completeOptions = runtime.completeCalls[0]!.options as Record<string, unknown>;
    // Same control knobs reach the runtime for both paths.
    expect(streamOptions.maxTokens).toBe(completeOptions.maxTokens);
    // exacto route carries its reasoning level on both paths.
    expect(streamOptions.reasoning).toBe('medium');
    expect(completeOptions.reasoning).toBe('medium');
  });

  const COMPLETION_PURPOSES: Array<{ purpose: CompletionPurpose; model: string; provider: string }> = [
    { purpose: 'background', model: 'nitro-model', provider: 'shared-router' },
    { purpose: 'summary', model: 'z-ai/glm-5', provider: 'openrouter' },
    { purpose: 'extraction', model: 'faux-extract', provider: 'faux' },
    { purpose: 'import_processing', model: 'z-ai/glm-5', provider: 'openrouter' },
    { purpose: 'vision', model: 'vision-model', provider: 'shared-router' },
  ];

  it.each(COMPLETION_PURPOSES)(
    'routes $purpose completion through the injected runtime on the selected candidate',
    async ({ purpose, model, provider }) => {
      const { client, runtime } = makeHarness();
      await client.complete(makeContext(), purpose, { disableRetry: true });
      expect(runtime.completeCalls).toHaveLength(1);
      const dispatch = runtime.completeCalls[0]!;
      expect(dispatch.model.provider).toBe(provider);
      expect(dispatch.model.id).toBe(model);
    },
  );

  it('external-router: carries the exacto wire id, reasoning on, and prompt-cache fields', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'chat', {
      disableRetry: true,
      modelHint: { provider: 'shared-router', model: 'openrouter/exacto-model', pin: true },
    });

    const dispatch = runtime.completeCalls[0]!;
    expect(dispatch.model.id).toBe('openrouter/exacto-model');
    expect(dispatch.model.api).toBe('openai-responses');
    expect(dispatch.model.baseUrl).toBe('https://router.example.test/v1');
    const options = dispatch.options as Record<string, unknown>;
    expect(options.reasoning).toBe('medium');
    // Prompt-cache engagement (companion-scoped session affinity).
    expect(options.cacheRetention).toBe('short');
    expect(typeof options.sessionId).toBe('string');
    expect(String(options.sessionId).startsWith('psfnpc-')).toBe(true);
    // OpenRouter-specific routing prefs (ZDR/provider order) are attached only
    // for direct openrouter candidates; the generic shared-router endpoint
    // forwards the wire model id instead. Those prefs are covered by the
    // direct-openrouter conformance cases below.
    expect(options.provider).toBeUndefined();
    expect(options.zdr).toBeUndefined();
  });

  it('external-router: carries the nitro wire id with reasoning disabled', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'background', { disableRetry: true });

    const dispatch = runtime.completeCalls[0]!;
    expect(dispatch.model.id).toBe('nitro-model');
    expect(dispatch.model.api).toBe('openai-completions');
    const options = dispatch.options as Record<string, unknown>;
    // thinkingEnabled:false → no reasoning level reaches the runtime.
    expect(options.reasoning).toBeUndefined();
  });

  it('direct openrouter: carries ZDR and provider ordering', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'summary', { disableRetry: true });

    const dispatch = runtime.completeCalls[0]!;
    expect(dispatch.model.provider).toBe('openrouter');
    expect(dispatch.model.baseUrl).toBe('https://openrouter.ai/api/v1');
    const options = dispatch.options as Record<string, unknown>;
    expect(options.zdr).toBe(true);
    expect(options.provider).toEqual({ order: ['parasail'] });
  });

  it('import processing: OpenRouter ZDR route passes the strict policy through the runtime', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'import_processing', { disableRetry: true });
    expect(runtime.completeCalls).toHaveLength(1);
    const options = runtime.completeCalls[0]!.options as Record<string, unknown>;
    expect(options.zdr).toBe(true);
    expect(options.provider).toEqual({ order: ['parasail', 'openai'] });
  });

  it('direct built-in/faux provider: resolves the registered model through the runtime registry', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'extraction', { disableRetry: true });

    // The faux provider has no configured endpoint URL and no LiteLLM base URL,
    // so model resolution MUST go through runtime.getModels (the registry path).
    expect(runtime.getModelsCalls).toContain('faux');
    const dispatch = runtime.completeCalls[0]!;
    expect(dispatch.model.id).toBe('faux-extract');
    expect(dispatch.model.provider).toBe('faux');
    // Same runtime instance owns both registry lookup and dispatch.
    expect(runtime.completeCalls[0]).toBeDefined();
  });

  it('attaches the wire-payload capture hook on every dispatch and preserves the captured payload', async () => {
    const { client, runtime } = makeHarness();
    runtime.setBehavior({
      emitPayload: { model: 'openrouter/exacto-model', tools: [{ name: 'a' }], messages: [] },
    });

    const response = await client.complete(makeContext(), 'chat', {
      disableRetry: true,
      modelHint: { provider: 'shared-router', model: 'openrouter/exacto-model', pin: true },
    });

    const options = runtime.completeCalls[0]!.options as { onPayload?: unknown };
    expect(typeof options.onPayload).toBe('function');
    // The runtime-invoked payload is captured into the response observability.
    expect(response.providerObservability?.capturedWirePayload).toMatchObject({
      api: 'openai-responses',
      model: 'openrouter/exacto-model',
      toolCount: 1,
      body: { model: 'openrouter/exacto-model', tools: [{ name: 'a' }], messages: [] },
    });
  });

  it('fires the first-output notification from the streaming boundary', async () => {
    const { client, runtime } = makeHarness();
    const onFirstOutput = vi.fn();
    const onText = vi.fn();

    await client.stream(makeContext(), { onFirstOutput, onText });

    expect(runtime.streamCalls).toHaveLength(1);
    expect(onFirstOutput).toHaveBeenCalledTimes(1);
    expect(onFirstOutput.mock.calls[0]?.[0]).toMatchObject({ kind: 'text' });
    expect(onText).toHaveBeenCalledWith('hello');
  });

  it('threads tools into the runtime context for both streaming and completion', async () => {
    const { client, runtime } = makeHarness();
    const tools = [
      {
        name: 'memory_lookup',
        description: 'Search memory.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
    ];

    await client.stream(makeContext({ tools }));
    await client.complete(makeContext({ tools }), 'background', { disableRetry: true });

    expect(runtime.streamCalls[0]!.context.tools).toHaveLength(1);
    expect(runtime.streamCalls[0]!.context.tools?.[0]?.name).toBe('memory_lookup');
    expect(runtime.completeCalls[0]!.context.tools).toHaveLength(1);
  });

  it('explicit model override pins the requested provider/model through the runtime', async () => {
    const { client, runtime } = makeHarness();
    await client.complete(makeContext(), 'background', {
      disableRetry: true,
      modelHint: { provider: 'shared-router', model: 'fallback-model', pin: true },
    });

    expect(runtime.completeCalls).toHaveLength(1);
    expect(runtime.completeCalls[0]!.model.id).toBe('fallback-model');
    expect(runtime.completeCalls[0]!.model.provider).toBe('shared-router');
  });

  it('falls back to the next candidate on a retryable 5xx through the same runtime', async () => {
    const { client, runtime } = makeHarness();
    let dispatched = 0;
    runtime.setBehavior({
      completeImpl: (model) => {
        dispatched += 1;
        if (model.id === 'z-ai/glm-5') {
          throw Object.assign(new Error('upstream 503 service unavailable'), { status: 503 });
        }
        return Promise.resolve(cannedAssistantMessage(model, 'recovered'));
      },
    });

    // summary lane has two candidates (openrouter primary, shared-router fallback).
    const response = await client.complete(makeContext(), 'summary', { disableRetry: true });

    expect(runtime.completeCalls).toHaveLength(2);
    expect(runtime.completeCalls[0]!.model.id).toBe('z-ai/glm-5');
    expect(runtime.completeCalls[1]!.model.id).toBe('nitro-model');
    expect(dispatched).toBe(2);
    expect(response.content).toBe('recovered');
  });

  it('surfaces a non-retryable 4xx without candidate fallback', async () => {
    const { client, runtime } = makeHarness();
    runtime.setBehavior({
      completeImpl: () => {
        throw Object.assign(new Error('upstream 400 prompt is too long'), { status: 400 });
      },
    });

    await expect(
      client.complete(makeContext(), 'summary', { disableRetry: true }),
    ).rejects.toThrow('prompt is too long');

    // context_overflow is non-retryable: the primary candidate is the only dispatch.
    expect(runtime.completeCalls).toHaveLength(1);
    expect(runtime.completeCalls[0]!.model.id).toBe('z-ai/glm-5');
  });

  it('treats equivalent 429 rate-limit errors as retryable across candidates', async () => {
    const { client, runtime } = makeHarness();
    let dispatched = 0;
    runtime.setBehavior({
      completeImpl: (model) => {
        dispatched += 1;
        if (model.id === 'z-ai/glm-5') {
          throw Object.assign(new Error('429 too many requests'), { status: 429 });
        }
        return Promise.resolve(cannedAssistantMessage(model, 'recovered'));
      },
    });

    const response = await client.complete(makeContext(), 'summary', { disableRetry: true });

    expect(runtime.completeCalls.map((call) => call.model.id)).toEqual([
      'z-ai/glm-5',
      'nitro-model',
    ]);
    expect(response.content).toBe('recovered');
    expect(dispatched).toBe(2);
  });

  it('aborts the in-flight stream through the runtime signal', async () => {
    const { client, runtime } = makeHarness();
    const controller = new AbortController();
    runtime.setBehavior({
      streamImpl: (model, options) => {
        return (async function* abortedStream() {
          yield { type: 'start', partial: cannedAssistantMessage(model, '') };
          controller.abort(new Error('barge-in'));
          // Emulate the provider honoring the abort signal mid-generation.
          if (options?.signal?.aborted) {
            throw new Error('LLM provider request aborted');
          }
          yield { type: 'done', reason: 'stop', message: cannedAssistantMessage(model) };
        })();
      },
    });

    await expect(
      client.stream(makeContext(), undefined, { signal: controller.signal }),
    ).rejects.toThrow();
    // The abort signal reached the runtime boundary and tore down the single
    // in-flight dispatch (abort is non-retryable: no candidate fallback).
    expect(runtime.streamCalls).toHaveLength(1);
    expect(runtime.streamCalls[0]!.options?.signal?.aborted).toBe(true);
  });

  it('preserves the captured wire payload on streamed responses too', async () => {
    const { client, runtime } = makeHarness();
    runtime.setBehavior({
      emitPayload: { model: 'openrouter/exacto-model', tools: [], messages: [] },
    });

    const response = await client.stream(makeContext());

    const options = runtime.streamCalls[0]!.options as { onPayload?: unknown };
    expect(typeof options.onPayload).toBe('function');
    expect(response.providerObservability?.capturedWirePayload).toMatchObject({
      api: 'openai-responses',
      model: 'openrouter/exacto-model',
      toolCount: 0,
    });
  });
});
