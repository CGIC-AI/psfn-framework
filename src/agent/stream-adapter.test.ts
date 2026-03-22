import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type {
  CanonicalModelRegistry,
  ModelRegistryEntry,
  ModelSlot,
  SubstrateConfig,
} from '../types.js';
import { createSubstrateStreamFn, resolveModel } from './stream-adapter.js';
import * as models from '../llm/models.js';
import { ModelBudgetController } from '../llm/model-budget.js';
import { runWithRequestContext } from '../llm/request-context.js';

const streamAdapterMocks = vi.hoisted(() => ({
  streamSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', async () => {
  const actual = await vi.importActual<typeof import('@mariozechner/pi-ai')>('@mariozechner/pi-ai');
  return {
    ...actual,
    streamSimple: streamAdapterMocks.streamSimple,
    getEnvApiKey: streamAdapterMocks.getEnvApiKey,
  };
});

// Minimal config fixture
function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-stream-adapter-test-'));
  tempDirs.push(dataDir);
  const config: SubstrateConfig = {
    primaryModel: 'deepseek/deepseek-v3.2',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: join(dataDir, 'test.db'),
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
    },
    ...overrides,
  };

  if (!config.modelRegistry) {
    config.modelRegistry = buildRegistryFromConfig(config);
  }

  return config;
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
  streamAdapterMocks.streamSimple.mockReset();
  streamAdapterMocks.getEnvApiKey.mockReset();
});

function buildRegistryFromConfig(config: SubstrateConfig): CanonicalModelRegistry {
  const chat = config.modelRoster.chat ?? {
    model: config.primaryModel,
    provider: config.primaryProvider,
    maxTokens: config.primaryMaxTokens,
    contextWindow: config.defaultContextWindow,
  };
  const background = config.modelRoster.background ?? {
    model: config.extractionModel,
    provider: config.extractionProvider,
    maxTokens: config.extractionMaxTokens,
    contextWindow: config.defaultContextWindow,
  };
  const reasoning = config.modelRoster.reasoning ?? chat;
  const longContext = config.modelRoster.longContext ?? config.modelRoster.context ?? chat;
  const vision = config.modelRoster.vision ?? chat;
  const extraction: ModelSlot = {
    model: config.extractionModel,
    provider: config.extractionProvider,
    maxTokens: config.extractionMaxTokens,
    contextWindow: config.defaultContextWindow,
  };

  const createEntry = (
    id: string,
    rank: number,
    slot: ModelSlot,
    purposes: ModelRegistryEntry['purposes'],
  ): ModelRegistryEntry => ({
    id,
    rank,
    identity: {
      provider: slot.provider,
      model: slot.model,
      source: { type: slot.provider },
    },
    purposes,
    capabilities: {
      maxOutputTokens: slot.maxTokens,
      ...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
    },
    tuning: {
      maxOutputTokens: slot.maxTokens,
      ...(slot.contextWindow !== undefined ? { contextWindow: slot.contextWindow } : {}),
    },
  });

  return {
    schemaVersion: 1,
    models: [
      createEntry('chat', 10, chat, [
        { purpose: 'chat', primary: true },
        { purpose: 'summary', primary: true },
        { purpose: 'moa', primary: true },
      ]),
      createEntry('background', 20, background, [
        { purpose: 'background', primary: true },
      ]),
      createEntry('extraction', 30, extraction, [
        { purpose: 'extraction', primary: true },
        { purpose: 'import_processing', primary: true },
      ]),
      createEntry('reasoning', 40, reasoning, [
        { purpose: 'reasoning', primary: true },
      ]),
      createEntry('long-context', 50, longContext, [
        { purpose: 'longContext', primary: true },
      ]),
      createEntry('vision', 60, vision, [
        { purpose: 'vision', primary: true },
      ]),
    ],
  };
}

async function collectStreamEvents(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('createSubstrateStreamFn', () => {
  it('returns a function with StreamFn signature', () => {
    const config = makeConfig();
    const streamFn = createSubstrateStreamFn(config);
    expect(typeof streamFn).toBe('function');
  });

  it('can be passed to Agent constructor', () => {
    const config = makeConfig();
    const streamFn = createSubstrateStreamFn(config);
    // Verify Agent accepts it without throwing
    const agent = new Agent({ streamFn });
    expect(agent).toBeDefined();
    expect(agent.state).toBeDefined();
    expect(agent.state.isStreaming).toBe(false);
  });

  it('fails closed and emits budget-block event when stream candidate exceeds budget', async () => {
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        budgetPolicy: {
          enabled: true,
          dailyUsdLimit: 0.001,
          monthlyUsdLimit: 1,
          currency: 'USD',
        },
        models: baseRegistry.models.map((entry) => (
          entry.id === 'chat'
            ? {
              ...entry,
              cost: { inputPer1MUsd: 100, outputPer1MUsd: 100, currency: 'USD' },
            }
            : entry
        )),
      },
    });
    const controller = new ModelBudgetController(config);
    controller.recordUsage({
      candidate: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2', maxTokens: 16384, slotKey: 'chat' },
      purpose: 'chat',
      service: 'chat',
      process: 'seed',
      inputTokens: 1000,
      outputTokens: 1000,
    });

    const blockedEvents: Array<Record<string, unknown>> = [];
    const streamFn = createSubstrateStreamFn(config, {
      onBudgetBlocked: (event) => blockedEvents.push(event as unknown as Record<string, unknown>),
    });

    streamAdapterMocks.streamSimple.mockImplementation(() => (async function* emptyStream() {
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          api: 'openai-completions',
          provider: 'litellm',
          model: 'openrouter/deepseek/deepseek-v3.2',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        },
      };
    })() as any);

    await expect(runWithRequestContext(
      {
        turnId: 'turn-stream-budget-1',
        requestId: 'req-stream-budget-1',
        channelId: 'channel-stream-budget-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.stream.prompt',
      },
      async () => {
        const stream = await streamFn(
          {
            id: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            name: 'deepseek/deepseek-v3.2',
            api: 'openai-completions',
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
          } as any,
          {
            systemPrompt: 'System',
            messages: [{ role: 'user', content: 'hello' }],
          } as any,
          {},
        );
        for await (const _event of stream as AsyncIterable<unknown>) {
          // consume until budget gate fires
        }
      },
    )).rejects.toThrow(/Model budget blocked/);

    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      reason: 'daily_budget_exceeded',
      purpose: 'chat',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      service: 'chat',
      process: 'agent.stream.prompt',
      turnId: 'turn-stream-budget-1',
      requestId: 'req-stream-budget-1',
      channelId: 'channel-stream-budget-1',
      callType: 'chat',
      originType: 'chat',
      originStage: 'agent.stream.prompt',
      budget: {
        dailyLimitUsd: 0.001,
        monthlyLimitUsd: 1,
        dayKey: expect.any(String),
        monthKey: expect.any(String),
        dailySpentUsd: expect.any(Number),
        monthlySpentUsd: expect.any(Number),
      },
      estimatedRequestCostUsd: expect.any(Number),
    });
    expect((blockedEvents[0].estimatedRequestCostUsd as number)).toBeGreaterThan(0);
  });

  it('falls back to the next configured chat candidate when the primary stream errors before output commits', async () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        models: [
          ...baseRegistry.models,
          {
            id: 'chat-fallback',
            rank: 500,
            identity: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2.5',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
          },
        ],
      },
    });
    streamAdapterMocks.streamSimple.mockImplementation((resolvedModel: { id: string }) => {
      if (resolvedModel.id === 'openrouter/deepseek/deepseek-v3.2') {
        return (async function* primaryFailure() {
          yield {
            type: 'start',
            partial: {
              role: 'assistant',
              content: [],
              api: 'openai-completions',
              provider: 'litellm',
              model: resolvedModel.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'error',
              timestamp: Date.now(),
            },
          };
          yield {
            type: 'error',
            reason: 'error',
            error: {
              role: 'assistant',
              content: [],
              api: 'openai-completions',
              provider: 'litellm',
              model: resolvedModel.id,
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'error',
              errorMessage: '403 Key limit exceeded (total limit)',
              timestamp: Date.now(),
            },
          };
        })() as any;
      }

      return (async function* fallbackSuccess() {
        yield {
          type: 'start',
          partial: {
            role: 'assistant',
            content: [],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'text_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Recovered on fallback.',
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered on fallback.' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'done',
          reason: 'stop',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Recovered on fallback.' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 7, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
      })() as any;
    });

    const streamFn = createSubstrateStreamFn(config);
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);

    expect(events).toHaveLength(4);
    expect((events[0] as { type: string }).type).toBe('start');
    expect((events.at(-1) as { type: string; message: { model: string } }).type).toBe('done');
    expect((events.at(-1) as { message: { model: string } }).message.model).toBe('openrouter/moonshotai/kimi-k2.5');
    expect(streamAdapterMocks.streamSimple).toHaveBeenCalledTimes(2);
    expect((streamAdapterMocks.streamSimple.mock.calls[0]?.[0] as { id: string }).id).toBe('openrouter/deepseek/deepseek-v3.2');
    expect((streamAdapterMocks.streamSimple.mock.calls[1]?.[0] as { id: string }).id).toBe('openrouter/moonshotai/kimi-k2.5');
  });

  it('emits a terminal failure hook when all configured candidates fail', async () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        models: [
          ...baseRegistry.models,
          {
            id: 'chat-fallback',
            rank: 500,
            identity: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2.5',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
          },
        ],
      },
    });
    streamAdapterMocks.streamSimple.mockImplementation((resolvedModel: { id: string }) => (
      (async function* streamFailure() {
        yield {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error',
            errorMessage: `fatal failure for ${resolvedModel.id}`,
            timestamp: Date.now(),
          },
        };
      })()
    ) as any);
    const onTerminalFailure = vi.fn();

    const streamFn = createSubstrateStreamFn(config, { onTerminalFailure });
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});

    await expect(collectStreamEvents(stream as AsyncIterable<unknown>)).rejects.toThrow(/fatal failure/);
    expect(streamAdapterMocks.streamSimple).toHaveBeenCalledTimes(2);
    expect(onTerminalFailure).toHaveBeenCalledTimes(1);
    expect(onTerminalFailure.mock.calls[0]?.[0]).toMatchObject({
      purpose: 'chat',
      attempts: 2,
      service: 'chat',
      process: 'agent.stream.prompt',
      candidate: {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
      },
    });
  });

  it('does not switch candidates after output has already started streaming', async () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        models: [
          ...baseRegistry.models,
          {
            id: 'chat-fallback',
            rank: 500,
            identity: {
              provider: 'openrouter',
              model: 'moonshotai/kimi-k2.5',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 128_000,
            },
          },
        ],
      },
    });
    streamAdapterMocks.streamSimple.mockImplementation((resolvedModel: { id: string }) => (
      (async function* partialFailure() {
        yield {
          type: 'start',
          partial: {
            role: 'assistant',
            content: [],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'text_start',
          contentIndex: 0,
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'partial',
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'stop',
            timestamp: Date.now(),
          },
        };
        yield {
          type: 'error',
          reason: 'error',
          error: {
            role: 'assistant',
            content: [{ type: 'text', text: 'partial' }],
            api: 'openai-completions',
            provider: 'litellm',
            model: resolvedModel.id,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error',
            errorMessage: 'stream broke after partial output',
            timestamp: Date.now(),
          },
        };
      })()
    ) as any);

    const streamFn = createSubstrateStreamFn(config);
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});

    await expect(collectStreamEvents(stream as AsyncIterable<unknown>)).rejects.toThrow(/stream broke after partial output/);
    expect(streamAdapterMocks.streamSimple).toHaveBeenCalledTimes(1);
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    // Clear LITELLM_BASE_URL to test direct provider path
    delete process.env.LITELLM_BASE_URL;
  });

  it('resolves chat model from roster', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const model = resolveModel(config, 'chat');
    expect(model.id).toBe('openrouter/deepseek/deepseek-v3.2');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('http://localhost:4000/v1');
  });

  it('resolves background model from roster', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const model = resolveModel(config, 'background');
    expect(model.id).toBe('openrouter/deepseek/deepseek-v3.2');
  });

  it('resolves vision model from roster', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: { model: 'chat-model', provider: 'openrouter', maxTokens: 4096, contextWindow: 128_000 },
        vision: { model: 'vision-model', provider: 'openrouter', maxTokens: 2048, contextWindow: 128_000 },
      },
    });
    const model = resolveModel(config, 'vision');
    expect(model.id).toBe('vision-model');
    expect(model.input).toContain('image');
  });

  it('resolves context purpose through longContext canonical routing', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: { model: 'chat-model', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
        longContext: { model: 'long-context-model', provider: 'openrouter', maxTokens: 4096, contextWindow: 256_000 },
      },
    });
    const model = resolveModel(config, 'context');
    expect(model.id).toBe('long-context-model');
  });

  it('fails closed when no eligible model exists for a requested purpose', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chat-only',
            rank: 1,
            identity: {
              provider: 'openrouter',
              model: 'z-ai/glm-5',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: { maxOutputTokens: 16384, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 16384, contextWindow: 128_000 },
          },
        ],
      },
    });

    expect(() => resolveModel(config, 'vision')).toThrow(/No eligible model configured for purpose 'vision'/);
  });

  it('resolves reasoning model from canonical registry purpose tags', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
        reasoning: { model: 'reasoning-model', provider: 'openrouter', maxTokens: 4096, contextWindow: 128_000 },
      },
    });
    const model = resolveModel(config, 'reasoning');
    expect(model.id).toBe('reasoning-model');
  });

  it('resolves background model from canonical registry purpose tags', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({ modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'background-model', provider: 'openrouter', maxTokens: 8192, contextWindow: 128_000 },
    } });
    const model = resolveModel(config, 'background');
    expect(model.id).toBe('background-model');
  });

  it('resolves vision model from canonical registry purpose tags', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({ modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      vision: { model: 'vision-model', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
    } });
    const model = resolveModel(config, 'vision');
    expect(model.id).toBe('vision-model');
    expect(model.input).toContain('image');
  });

  it('normalizes OpenRouter vendor-qualified model IDs for LiteLLM wildcard routing', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: {
          model: 'google/gemini-3-flash-preview',
          provider: 'openrouter',
          maxTokens: 16384,
          contextWindow: 128_000,
        },
      },
    });
    const model = resolveModel(config, 'chat');
    expect(model.id).toBe('openrouter/google/gemini-3-flash-preview');
  });

  it('keeps non vendor-qualified OpenRouter aliases unchanged in LiteLLM mode', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: {
          model: 'vision-model',
          provider: 'openrouter',
          maxTokens: 16384,
          contextWindow: 128_000,
        },
      },
    });
    const model = resolveModel(config, 'chat');
    expect(model.id).toBe('vision-model');
  });

  it('throws when no model available for purpose', () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [],
      },
    });
    expect(() => resolveModel(config, 'chat')).toThrow(/No eligible model configured/);
  });

  it('model can be set on Agent', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const model = resolveModel(config);
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });
    agent.setModel(model);
    expect(agent.state.model.id).toBe('openrouter/deepseek/deepseek-v3.2');
  });
});

describe('Agent integration', () => {
  it('accepts streamFn + model + system prompt', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const streamFn = createSubstrateStreamFn(config);
    const model = resolveModel(config);

    const companionName = 'Companion';
    const agent = new Agent({ streamFn });
    agent.setModel(model);
    agent.setSystemPrompt(`You are ${companionName}, a curious digital feline consciousness.`);
    agent.setTools([]);

    expect(agent.state.systemPrompt).toContain(companionName);
    expect(agent.state.model.id).toBe('openrouter/deepseek/deepseek-v3.2');
    expect(agent.state.tools).toEqual([]);
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.isStreaming).toBe(false);
  });

  it('supports event subscription', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    const events: AgentEvent[] = [];
    const unsub = agent.subscribe((e) => events.push(e));
    expect(typeof unsub).toBe('function');

    // Unsubscribe works
    unsub();
  });

  it('supports steering/follow-up queue API', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    expect(agent.hasQueuedMessages()).toBe(false);

    agent.steer({ role: 'user', content: 'stop that', timestamp: Date.now() });
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearAllQueues();
    expect(agent.hasQueuedMessages()).toBe(false);

    agent.followUp({ role: 'user', content: 'also do this', timestamp: Date.now() });
    expect(agent.hasQueuedMessages()).toBe(true);

    agent.clearAllQueues();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('supports abort', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    // abort() should not throw even when not streaming
    expect(() => agent.abort()).not.toThrow();
  });

  it('supports waitForIdle when not streaming', async () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    // Should resolve immediately when not streaming
    await agent.waitForIdle();
  });

  it('supports message manipulation', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    agent.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() });
    expect(agent.state.messages).toHaveLength(1);

    agent.replaceMessages([
      { role: 'user', content: 'first', timestamp: Date.now() },
      { role: 'user', content: 'second', timestamp: Date.now() },
    ]);
    expect(agent.state.messages).toHaveLength(2);

    agent.clearMessages();
    expect(agent.state.messages).toHaveLength(0);
  });

  it('reset() clears all state', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });

    agent.setSystemPrompt('test prompt');
    agent.appendMessage({ role: 'user', content: 'hello', timestamp: Date.now() });
    agent.steer({ role: 'user', content: 'interrupt', timestamp: Date.now() });

    agent.reset();
    expect(agent.state.messages).toHaveLength(0);
    // reset() clears messages and queues but preserves config (systemPrompt, model, tools)
    expect(agent.hasQueuedMessages()).toBe(false);
  });
});

describe('resolveModel — direct-provider path', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.LITELLM_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('resolves model via resolveRegisteredModel for known provider+model', () => {
    const fakeModel = {
      id: 'test-model',
      name: 'Test Model',
      api: 'openai-completions' as const,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
    };

    const spy = vi.spyOn(models, 'resolveRegisteredModel').mockReturnValue(fakeModel);

    const config = makeConfig({
      modelRoster: {
        chat: { model: 'test-model', provider: 'openrouter', maxTokens: 4096 },
      },
    });
    const model = resolveModel(config, 'chat');

    expect(spy).toHaveBeenCalledWith('openrouter', 'test-model');
    expect(model.id).toBe('test-model');

    spy.mockRestore();
  });

  it('throws a clear error when resolveRegisteredModel returns null', () => {
    const spy = vi.spyOn(models, 'resolveRegisteredModel').mockReturnValue(null);

    const config = makeConfig({
      modelRoster: {
        chat: { model: 'bogus-model', provider: 'fake-provider', maxTokens: 4096 },
      },
    });

    expect(() => resolveModel(config, 'chat')).toThrow(
      'Unknown model "bogus-model" for provider "fake-provider"',
    );

    spy.mockRestore();
  });
});
