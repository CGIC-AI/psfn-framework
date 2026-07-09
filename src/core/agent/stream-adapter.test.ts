import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '../../boundary/pi-agent/index.js';
import type { AgentEvent } from '../../boundary/pi-agent/index.js';
import { validateToolArguments } from '@mariozechner/pi-ai';
import { Type } from '@sinclair/typebox';
import type { CanonicalModelRegistry, LLMContext, LLMResponse, ModelRegistryEntry, ModelSlot, StreamCallbacks } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { createSubstrateStreamFn, resolveModel } from './stream-adapter.js';
import * as models from '../../primitives/llm/models.js';
import { MODEL_USAGE_LEDGER_FILE_NAME, ModelBudgetController } from '../../primitives/llm/model-budget.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';

const streamAdapterMocks = vi.hoisted(() => ({
  transportStream: vi.fn(),
}));

function makeTransport() {
  return {
    stream: streamAdapterMocks.transportStream as unknown as (
      context: LLMContext,
      callbacks?: StreamCallbacks,
    ) => Promise<LLMResponse>,
  };
}

function makeStreamFn(
  config: SubstrateConfig,
  overrides: Partial<Parameters<typeof createSubstrateStreamFn>[1]> = {},
) {
  return createSubstrateStreamFn(config, {
    transport: makeTransport(),
    ...overrides,
  });
}

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
  streamAdapterMocks.transportStream.mockReset();
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
      ...(id === 'vision' ? { supportsVision: true } : {}),
      ...(id === 'reasoning' ? { supportsReasoning: true } : {}),
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
    const streamFn = makeStreamFn(config);
    expect(typeof streamFn).toBe('function');
  });

  it('can be passed to Agent constructor', () => {
    const config = makeConfig();
    const streamFn = makeStreamFn(config);
    // Verify Agent accepts it without throwing
    const agent = new Agent({ streamFn });
    expect(agent).toBeDefined();
    expect(agent.state).toBeDefined();
    expect(agent.state.isStreaming).toBe(false);
  });

  it('fails closed when no transport is injected', () => {
    const config = makeConfig();
    expect(() => createSubstrateStreamFn(
      config,
      {} as Parameters<typeof createSubstrateStreamFn>[1],
    )).toThrow('requires an injected transport');
  });

  it('supports a transport-backed stream contract through the injected transport port', async () => {
    const config = makeConfig();
    const transport = {
      stream: vi.fn(async (_context, callbacks) => {
        callbacks?.onText?.('hello');
        callbacks?.onText?.(' world');
        return {
          content: 'hello world',
          reasoning: 'step by step',
          toolCalls: [
            {
              id: 'call-1',
              name: 'memory_lookup',
              input: { query: 'hello world' },
            },
          ],
          model: 'gateway-model',
          inputTokens: 11,
          outputTokens: 7,
          usageDetails: {
            input: 11,
            output: 7,
            cacheRead: 3,
            cacheWrite: 2,
            totalTokens: 18,
            cost: { total: 0.42 },
          },
          stopReason: 'stop',
        };
      }),
    };
    const streamFn = createSubstrateStreamFn(config, {
      transport,
    });
    const model = resolveModel(config, 'chat');

    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});
    const events = await collectStreamEvents(stream);

    expect(transport.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: 'System',
        modelHint: expect.objectContaining({
          model: 'deepseek/deepseek-v3.2',
          provider: 'openrouter',
          maxTokens: 16384,
        }),
      }),
      expect.objectContaining({
        onText: expect.any(Function),
      }),
    );
    expect(events.map((event: any) => event.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'toolcall_end',
      'done',
    ]);
    const doneEvent = events.at(-1) as { type: string; message: { content: unknown[]; model: string; usage: Record<string, unknown> } };
    expect(doneEvent.type).toBe('done');
    expect(doneEvent.message.model).toBe('gateway-model');
    expect(doneEvent.message.usage).toMatchObject({
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 18,
      cost: { total: 0.42 },
    });
    expect(doneEvent.message.content).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'thinking', thinking: 'step by step' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'memory_lookup',
        arguments: { query: 'hello world' },
      },
    ]);
  });

  it('repairs JSON-stringified array tool arguments before agent validation', async () => {
    const config = makeConfig();
    const transport = {
      stream: vi.fn<any>().mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call-toolset',
            name: 'toolset',
            input: {
              action: 'activate',
              tools: '["north_star"]',
            },
          },
          {
            id: 'call-image-analyze',
            name: 'media',
            input: {
              action: 'analyze',
              input_urls: '["https://images.example.test/source.png"]',
              question: 'What is visible?',
            },
          },
        ],
        model: 'gateway-model',
        inputTokens: 11,
        outputTokens: 7,
        stopReason: 'toolUse',
      }),
    };
    const toolsetTool = {
      name: 'toolset',
      description: 'Activate extended tools.',
      parameters: Type.Object({
        action: Type.Literal('activate'),
        tools: Type.Array(Type.String()),
      }),
    };
    const imageAnalyzeTool = {
      name: 'media',
      description: 'Generate, edit, or analyze media.',
      parameters: Type.Object({
        action: Type.Literal('analyze'),
        input_urls: Type.Array(Type.String()),
        question: Type.Optional(Type.String()),
      }),
    };
    const streamFn = createSubstrateStreamFn(config, { transport });
    const stream = await streamFn(resolveModel(config, 'chat'), {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'activate image analysis' }],
      tools: [toolsetTool, imageAnalyzeTool],
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);
    const doneEvent = events.at(-1) as { type: 'done'; message: { content: Array<{ type: string; name?: string; arguments?: Record<string, unknown> }> } };
    const toolCalls = doneEvent.message.content.filter((entry) => entry.type === 'toolCall');

    expect(toolCalls.find((entry) => entry.name === 'toolset')?.arguments).toEqual({
      action: 'activate',
      tools: ['north_star'],
    });
    expect(toolCalls.find((entry) => entry.name === 'media')?.arguments).toEqual({
      action: 'analyze',
      input_urls: ['https://images.example.test/source.png'],
      question: 'What is visible?',
    });
    expect(validateToolArguments(toolsetTool as any, toolCalls[0] as any)).toEqual({
      action: 'activate',
      tools: ['north_star'],
    });
    expect(validateToolArguments(imageAnalyzeTool as any, toolCalls[1] as any)).toEqual({
      action: 'analyze',
      input_urls: ['https://images.example.test/source.png'],
      question: 'What is visible?',
    });
  });

  it('leaves non-array strings unchanged so schema validation fails closed', async () => {
    const config = makeConfig();
    const transport = {
      stream: vi.fn<any>().mockResolvedValue({
        content: '',
        toolCalls: [
          {
            id: 'call-toolset-invalid',
            name: 'toolset',
            input: {
              action: 'activate',
              tools: 'north_star',
            },
          },
        ],
        model: 'gateway-model',
        inputTokens: 11,
        outputTokens: 7,
        stopReason: 'toolUse',
      }),
    };
    const toolsetTool = {
      name: 'toolset',
      description: 'Activate extended tools.',
      parameters: Type.Object({
        action: Type.Literal('activate'),
        tools: Type.Array(Type.String()),
      }),
    };
    const streamFn = createSubstrateStreamFn(config, { transport });
    const stream = await streamFn(resolveModel(config, 'chat'), {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'activate a tool' }],
      tools: [toolsetTool],
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);
    const doneEvent = events.at(-1) as { type: 'done'; message: { content: Array<{ type: string; arguments?: Record<string, unknown> }> } };
    const toolCall = doneEvent.message.content.find((entry) => entry.type === 'toolCall');

    expect(toolCall?.arguments).toEqual({
      action: 'activate',
      tools: 'north_star',
    });
    expect(() => validateToolArguments(toolsetTool as any, toolCall as any))
      .toThrow('Validation failed for tool "toolset"');
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
    const streamFn = makeStreamFn(config, {
      onBudgetBlocked: (event) => blockedEvents.push(event as unknown as Record<string, unknown>),
    });

    streamAdapterMocks.transportStream.mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      model: 'openrouter/deepseek/deepseek-v3.2',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'stop',
    });

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
        return await collectStreamEvents(stream as AsyncIterable<unknown>);
      },
    )).rejects.toThrow('Model budget blocked');
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

  it('skips preflight token estimation when model budget policy is disabled', async () => {
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        budgetPolicy: {
          enabled: false,
          dailyUsdLimit: 1,
          monthlyUsdLimit: 10,
          currency: 'USD',
        },
      },
    });
    const circular = {} as { self?: unknown };
    circular.self = circular;
    const streamFn = makeStreamFn(config);
    const model = resolveModel(config, 'chat');

    streamAdapterMocks.transportStream.mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      model: 'openrouter/deepseek/deepseek-v3.2',
      inputTokens: 13,
      outputTokens: 7,
      stopReason: 'stop',
    });

    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
      debugOnly: circular,
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);

    expect((events.at(-1) as { type: string }).type).toBe('done');
    const raw = readFileSync(join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as { records: Array<Record<string, unknown>> };
    expect(parsed.records[0]).toMatchObject({
      inputTokens: 13,
      outputTokens: 7,
    });
  });

  it('limits budget preflight token estimation to prompt messages while recording provider usage', async () => {
    const baseConfig = makeConfig();
    const baseRegistry = baseConfig.modelRegistry!;
    const config = makeConfig({
      modelRegistry: {
        ...baseRegistry,
        budgetPolicy: {
          enabled: true,
          dailyUsdLimit: 0.0001,
          monthlyUsdLimit: 1,
          currency: 'USD',
        },
        models: baseRegistry.models.map((entry) => (
          entry.id === 'chat'
            ? {
              ...entry,
              cost: { inputPer1MUsd: 1, outputPer1MUsd: 0.000001, currency: 'USD' },
            }
            : entry
        )),
      },
    });
    const streamFn = makeStreamFn(config);
    const model = resolveModel(config, 'chat');

    streamAdapterMocks.transportStream.mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      model: 'openrouter/deepseek/deepseek-v3.2',
      inputTokens: 321,
      outputTokens: 9,
      stopReason: 'stop',
    });

    const stream = await streamFn(model, {
      systemPrompt: 'S',
      messages: [{ role: 'user', content: 'hello' }],
      debugOnly: 'x'.repeat(20_000),
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);

    expect((events.at(-1) as { type: string }).type).toBe('done');
    const raw = readFileSync(join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as { records: Array<Record<string, unknown>> };
    expect(parsed.records[0]).toMatchObject({
      inputTokens: 321,
      outputTokens: 9,
    });
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
    streamAdapterMocks.transportStream.mockImplementation((context: LLMContext) => {
      const modelId = context.modelHint?.model;
      if (modelId === 'deepseek/deepseek-v3.2') {
        return Promise.reject(new Error('403 Key limit exceeded (total limit)'));
      }

      return Promise.resolve({
        content: 'Recovered on fallback.',
        toolCalls: [],
        model: 'openrouter/moonshotai/kimi-k2.5',
        inputTokens: 7,
        outputTokens: 4,
        stopReason: 'stop',
      });
    });

    const streamFn = makeStreamFn(config);
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
    expect(streamAdapterMocks.transportStream).toHaveBeenCalledTimes(2);
    expect((streamAdapterMocks.transportStream.mock.calls[0]?.[0] as LLMContext).modelHint?.model).toBe('deepseek/deepseek-v3.2');
    expect((streamAdapterMocks.transportStream.mock.calls[1]?.[0] as LLMContext).modelHint?.model).toBe('moonshotai/kimi-k2.5');
  });

  it('falls back to the next configured chat candidate when the primary response has no text', async () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      primaryModel: 'ChatGPTN',
      primaryProvider: 'litellm',
      modelRoster: {
        chat: { model: 'ChatGPTN', provider: 'litellm', maxTokens: 4096, contextWindow: 128_000 },
        background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chatgptn-primary',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'ChatGPTN',
              source: { type: 'litellm' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 4096,
            },
          },
          {
            id: 'openai-nano-fallback',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openai/gpt-5.4-nano',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: false }],
            capabilities: {
              maxOutputTokens: 2048,
              contextWindow: 128_000,
            },
            tuning: {
              maxOutputTokens: 2048,
            },
          },
        ],
      },
    });

    streamAdapterMocks.transportStream.mockImplementation((context: LLMContext) => {
      if (context.modelHint?.model === 'ChatGPTN') {
        return Promise.resolve({
          content: '',
          toolCalls: [],
          model: 'ChatGPTN',
          inputTokens: 11,
          outputTokens: 0,
          stopReason: 'stop',
        });
      }

      return Promise.resolve({
        content: 'Recovered on nano.',
        toolCalls: [],
        model: 'openrouter/openai/gpt-5.4-nano',
        inputTokens: 7,
        outputTokens: 4,
        stopReason: 'stop',
      });
    });

    const streamFn = makeStreamFn(config);
    const model = resolveModel(config, 'chat');
    const events = await runWithRequestContext(
      {
        turnId: 'turn-empty-primary-1',
        requestId: 'req-empty-primary-1',
        channelId: 'channel-empty-primary-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
        purpose: 'agent.turn.prompt',
      },
      async () => {
        const stream = await streamFn(model, {
          systemPrompt: 'System',
          messages: [{ role: 'user', content: 'hello' }],
        } as any, {});
        return await collectStreamEvents(stream as AsyncIterable<unknown>);
      },
    );

    expect((events.at(-1) as { type: string; message: { model: string } }).type).toBe('done');
    expect((events.at(-1) as { message: { model: string } }).message.model).toBe('openrouter/openai/gpt-5.4-nano');
    expect(streamAdapterMocks.transportStream).toHaveBeenCalledTimes(2);
    expect((streamAdapterMocks.transportStream.mock.calls[0]?.[0] as LLMContext).modelHint?.model).toBe('ChatGPTN');
    expect((streamAdapterMocks.transportStream.mock.calls[1]?.[0] as LLMContext).modelHint?.model).toBe('openai/gpt-5.4-nano');
  });

  it('routes tool-side reasoning streams through the reasoning candidate instead of the mounted chat model', async () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: { model: 'chat-model', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
        reasoning: { model: 'reasoning-model', provider: 'openrouter', maxTokens: 4096, contextWindow: 128_000 },
      },
    });

    streamAdapterMocks.transportStream.mockImplementation(async (context: LLMContext) => ({
      content: 'reasoned',
      toolCalls: [],
      model: context.modelHint?.model ? `openrouter/${context.modelHint.model}` : 'openrouter/unknown',
      inputTokens: 5,
      outputTokens: 3,
      stopReason: 'stop',
    }));

    const streamFn = makeStreamFn(config);
    const mountedChatModel = resolveModel(config, 'chat');
    const events = await runWithRequestContext(
      {
        turnId: 'turn-reasoning-stream-1',
        requestId: 'req-reasoning-stream-1',
        channelId: 'channel-reasoning-stream-1',
        callType: 'tool',
        originType: 'tool',
        originStage: 'repl.sandbox.llm_query',
        purpose: 'repl.sandbox.reasoning',
      },
      async () => {
        const stream = await streamFn(mountedChatModel, {
          systemPrompt: 'System',
          messages: [{ role: 'user', content: 'think hard' }],
        } as any, {});
        return await collectStreamEvents(stream as AsyncIterable<unknown>);
      },
    );

    expect((events.at(-1) as { type: string }).type).toBe('done');
    expect(streamAdapterMocks.transportStream).toHaveBeenCalledTimes(1);
    expect((streamAdapterMocks.transportStream.mock.calls[0]?.[0] as LLMContext).modelHint?.model).toBe('reasoning-model');
  });

  it('fails closed for tool-side reasoning streams when no reasoning candidate is configured', async () => {
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
              model: 'chat-only-model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: { maxOutputTokens: 16384, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 16384, contextWindow: 128_000 },
          },
        ],
      },
    });

    const streamFn = makeStreamFn(config);
    const mountedChatModel = resolveModel(config, 'chat');
    await expect(runWithRequestContext(
      {
        turnId: 'turn-reasoning-stream-missing',
        requestId: 'req-reasoning-stream-missing',
        channelId: 'channel-reasoning-stream-missing',
        callType: 'tool',
        originType: 'tool',
        originStage: 'repl.sandbox.llm_query',
        purpose: 'repl.sandbox.reasoning',
      },
      async () => {
        const stream = await streamFn(mountedChatModel, {
          systemPrompt: 'System',
          messages: [{ role: 'user', content: 'think hard' }],
        } as any, {});
        return await collectStreamEvents(stream as AsyncIterable<unknown>);
      },
    )).rejects.toThrow("No eligible model configured for purpose 'reasoning'");
    expect(streamAdapterMocks.transportStream).not.toHaveBeenCalled();
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
    streamAdapterMocks.transportStream.mockImplementation((context: LLMContext) => (
      Promise.reject(new Error(`fatal failure for ${context.modelHint?.model}`))
    ));
    const onTerminalFailure = vi.fn();

    const streamFn = makeStreamFn(config, { onTerminalFailure });
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});

    await expect(collectStreamEvents(stream as AsyncIterable<unknown>)).rejects.toThrow('fatal failure');
    expect(streamAdapterMocks.transportStream).toHaveBeenCalledTimes(2);
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

  it('passes model hints through the injected transport without local API-key resolution', async () => {
    const config = makeConfig({
      litellmBaseUrl: 'http://localhost:4000/v1',
    });

    streamAdapterMocks.transportStream.mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      model: 'openrouter/deepseek/deepseek-v3.2',
      inputTokens: 1,
      outputTokens: 1,
      stopReason: 'stop',
    });

    const streamFn = makeStreamFn(config);
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});
    const events = await collectStreamEvents(stream as AsyncIterable<unknown>);

    expect(events).toHaveLength(4);
    expect((events.at(-1) as { type: string }).type).toBe('done');
    expect((streamAdapterMocks.transportStream.mock.calls[0]?.[0] as LLMContext).systemPrompt).toBe('System');
    expect((streamAdapterMocks.transportStream.mock.calls[0]?.[0] as LLMContext).modelHint).toMatchObject({
      model: 'deepseek/deepseek-v3.2',
      provider: 'openrouter',
      maxTokens: 16384,
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
    streamAdapterMocks.transportStream.mockImplementation(
      async (_context: LLMContext, callbacks?: StreamCallbacks) => {
        callbacks?.onText?.('partial');
        throw new Error('stream broke after partial output');
      },
    );

    const streamFn = makeStreamFn(config);
    const model = resolveModel(config, 'chat');
    const stream = await streamFn(model, {
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'hello' }],
    } as any, {});

    const events: unknown[] = [];
    let terminalError: Error | null = null;
    try {
      for await (const event of stream as AsyncIterable<unknown>) {
        events.push(event);
      }
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
    }

    expect(terminalError?.message).toContain('stream broke after partial output');
    expect(events).toHaveLength(2);
    expect((events[0] as { type: string }).type).toBe('start');
    expect((events[1] as { type: string }).type).toBe('text_start');
    expect(streamAdapterMocks.transportStream).toHaveBeenCalledTimes(1);
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    // Clear LITELLM_BASE_URL unless a test is explicitly exercising LiteLLM routing.
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

  it('resolves OpenRouter-sourced entries through direct OpenRouter endpoint config', () => {
    const config = makeConfig({
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'pi-live-chat',
            rank: 1,
            identity: {
              provider: 'litellm',
              model: 'z-ai/glm-5.2',
              source: {
                type: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
              },
            },
            purposes: [{ purpose: 'chat', primary: true }],
            capabilities: {
              maxOutputTokens: 16384,
              contextWindow: 202_752,
            },
            tuning: {
              maxOutputTokens: 16384,
              contextWindow: 202_752,
            },
          },
        ],
      },
    });

    const model = resolveModel(config, 'chat');
    expect(model.id).toBe('z-ai/glm-5.2');
    expect(model.provider).toBe('openrouter');
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(model.maxTokens).toBe(16384);
    expect(model.contextWindow).toBe(202_752);
  });

  it('fails closed when a configured vision slot targets a text-only model', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({
      modelRoster: {
        chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
        vision: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      },
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
            purposes: [
              { purpose: 'chat', primary: true },
              { purpose: 'vision', primary: true },
            ],
            capabilities: {
              maxOutputTokens: 16384,
              contextWindow: 128_000,
              supportsVision: false,
            },
            tuning: {
              maxOutputTokens: 16384,
              contextWindow: 128_000,
            },
          },
          {
            id: 'extraction',
            rank: 2,
            identity: {
              provider: 'openrouter',
              model: 'deepseek/deepseek-v3.2',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 8192, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 8192, contextWindow: 128_000 },
          },
        ],
      },
    });

    expect(() => resolveModel(config, 'vision')).toThrow(/not configured for vision input/);
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
    const agent = new Agent({ streamFn: makeStreamFn(config) });
    agent.state.model = model;
    expect(agent.state.model.id).toBe('openrouter/deepseek/deepseek-v3.2');
  });
});

describe('Agent integration', () => {
  it('accepts streamFn + model + system prompt', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const streamFn = makeStreamFn(config);
    const model = resolveModel(config);

    const companionName = 'Companion';
    const agent = new Agent({ streamFn });
    agent.state.model = model;
    agent.state.systemPrompt = `You are ${companionName}, a curious digital feline consciousness.`;
    agent.state.tools = [];

    expect(agent.state.systemPrompt).toContain(companionName);
    expect(agent.state.model.id).toBe('openrouter/deepseek/deepseek-v3.2');
    expect(agent.state.tools).toEqual([]);
    expect(agent.state.messages).toEqual([]);
    expect(agent.state.isStreaming).toBe(false);
  });

  it('supports event subscription', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: makeStreamFn(config) });

    const events: AgentEvent[] = [];
    const unsub = agent.subscribe((e) => events.push(e));
    expect(typeof unsub).toBe('function');

    // Unsubscribe works
    unsub();
  });

  it('supports steering/follow-up queue API', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: makeStreamFn(config) });

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
    const agent = new Agent({ streamFn: makeStreamFn(config) });

    // abort() should not throw even when not streaming
    expect(() => agent.abort()).not.toThrow();
  });

  it('supports waitForIdle when not streaming', async () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: makeStreamFn(config) });

    // Should resolve immediately when not streaming
    await agent.waitForIdle();
  });

  it('supports message manipulation', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: makeStreamFn(config) });

    agent.state.messages = [...agent.state.messages, { role: 'user', content: 'hello', timestamp: Date.now() }];
    expect(agent.state.messages).toHaveLength(1);

    agent.state.messages = [
      { role: 'user', content: 'first', timestamp: Date.now() },
      { role: 'user', content: 'second', timestamp: Date.now() },
    ];
    expect(agent.state.messages).toHaveLength(2);

    agent.state.messages = [];
    expect(agent.state.messages).toHaveLength(0);
  });

  it('reset() clears all state', () => {
    const config = makeConfig();
    const agent = new Agent({ streamFn: makeStreamFn(config) });

    agent.state.systemPrompt = 'test prompt';
    agent.state.messages = [...agent.state.messages, { role: 'user', content: 'hello', timestamp: Date.now() }];
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
