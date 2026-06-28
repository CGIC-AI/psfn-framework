import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalModelRegistry, ModelRegistryEntry, ModelSlot } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  createEnvCredentialVault,
  envCredential,
} from '../../boundary/custody/credential-vault.js';
import { FallbackRunner } from './fallback.js';
import { createEligibilityGate, EligibilityDeniedError } from '../../system/capabilities/eligibility.js';

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(),
  getModels: vi.fn(),
  getProviders: vi.fn(),
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
  getEnvApiKey: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: mocks.getModel,
  getModels: mocks.getModels,
  getProviders: mocks.getProviders,
  completeSimple: mocks.completeSimple,
  streamSimple: mocks.streamSimple,
  getEnvApiKey: mocks.getEnvApiKey,
}));

import {
  inferCallType,
  LegacyModelHintError,
  LLMClient,
  SensitiveImportRoutePolicyError,
} from './client.js';
import { MODEL_USAGE_LEDGER_FILE_NAME } from './model-budget.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'psfn-llm-client-test-'));
  tempDirs.push(dataDir);
  const config: SubstrateConfig = {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
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
    modelRoster: {
      chat: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      },
      background: {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 2048,
      },
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
        { purpose: 'memory', primary: true },
        { purpose: 'extraction', primary: true },
        { purpose: 'import_processing', primary: true },
      ]),
      createEntry('reasoning', 40, reasoning, [
        { purpose: 'reasoning', primary: true },
      ]),
      createEntry('long-context', 50, longContext, [
        { purpose: 'longContext', primary: true },
      ]),
      createEntry('vision', 60, chat, [
        { purpose: 'vision', primary: true },
      ]),
    ],
  };
}

describe('LLMClient import-processing routing policy', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation(() => [
      {
        id: 'z-ai/glm-5',
        provider: 'openrouter',
        name: 'z-ai/glm-5',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16384,
      },
      {
        id: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        name: 'deepseek/deepseek-v3.2',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
      },
    ]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('throws an auditable strict-policy error when import route is not OpenRouter ZDR', async () => {
    const config = makeConfig({
      importProcessingRouteMode: 'background',
      importProcessingStrictPolicy: true,
    });
    const client = new LLMClient(config);

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process import batch' }],
      },
      'import_processing',
      { disableRetry: true },
    )).rejects.toBeInstanceOf(SensitiveImportRoutePolicyError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('passes OpenRouter ZDR and provider order options for import-processing requests', async () => {
    const config = makeConfig({
      importProcessingRouteMode: 'openrouter_zdr',
      openRouterProviderOrder: ['parasail', 'openai'],
    });
    const client = new LLMClient(config);

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      model: 'openrouter:background/model',
      usage: { input: 11, output: 7 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process import batch' }],
      },
      'import_processing',
      { disableRetry: true },
    );

    expect(response.content).toBe('ok');
    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

    const requestOptions = mocks.completeSimple.mock.calls[0][2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(2048);
    expect(requestOptions.zdr).toBe(true);
    expect(requestOptions.provider).toEqual({ order: ['parasail', 'openai'] });
  });

  it('keeps local import-processing endpoint routes distinct from LiteLLM proxy routing', async () => {
    const previousApiKey = process.env.IMPORT_PROCESSING_LOCAL_API_KEY;
    process.env.IMPORT_PROCESSING_LOCAL_API_KEY = 'local-endpoint-key';

    try {
      const config = makeConfig({
        importProcessingRouteMode: 'local_endpoint',
        importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
        importProcessingLocalModel: 'qwen2.5-coder:14b',
      });
      const client = new LLMClient(config, {
        litellmBaseUrl: 'http://litellm.test/v1',
      });

      mocks.completeSimple.mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
        model: 'qwen2.5-coder:14b',
        usage: { input: 11, output: 7 },
        stopReason: 'stop',
      });

      const response = await client.complete(
        {
          systemPrompt: 'System',
          messages: [{ role: 'user', content: 'Process import batch locally' }],
        },
        'import_processing',
        { disableRetry: true },
      );

      expect(response.content).toBe('ok');
      expect(mocks.completeSimple).toHaveBeenCalledTimes(1);

      const model = mocks.completeSimple.mock.calls[0][0] as {
        baseUrl: string;
        provider: string;
        name: string;
      };
      const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };

      expect(model.baseUrl).toBe('http://localhost:11434/v1');
      expect(model.provider).toBe('local_endpoint');
      expect(model.name).toBe('qwen2.5-coder:14b (via local endpoint)');
      expect(requestOptions.apiKey).toBe('local-endpoint-key');
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.IMPORT_PROCESSING_LOCAL_API_KEY;
      } else {
        process.env.IMPORT_PROCESSING_LOCAL_API_KEY = previousApiKey;
      }
    }
  });
});

describe('LLMClient provider observability', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoning: true,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockImplementation((provider: string) => [
      {
        id: 'z-ai/glm-5',
        provider,
        name: 'z-ai/glm-5',
        api: 'openai-completions',
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8192,
        reasoning: true,
      },
    ]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('attaches provider observability and reasoning to streaming responses', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield { type: 'thinking_delta', delta: 'trace' };
      yield { type: 'text_delta', delta: 'hello' };
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 11, output: 7 },
          content: [{ type: 'text', text: 'hello' }],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(response.reasoning).toBe('trace');
    expect(response.providerObservability).toMatchObject({
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
      },
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: 'System prompt' },
        { role: 'user', source: 'message', content: 'Hi' },
      ],
    });
  });

  it('attaches provider observability and reasoning to completion responses', async () => {
    const client = new LLMClient(makeConfig());
    mocks.completeSimple.mockResolvedValue({
      model: 'z-ai/glm-5',
      usage: { input: 13, output: 5 },
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'chain' },
        { type: 'text', text: 'done' },
      ],
    });

    const response = await client.complete({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Hi' }],
    }, 'summary', { disableRetry: true });

    expect(response.reasoning).toBe('chain');
    expect(response.providerObservability).toMatchObject({
      routeKind: 'registered_model',
      requestedProvider: 'openrouter',
      backendApi: 'openai-completions',
      systemRole: {
        transport: 'openai_developer',
      },
      providerWireMessages: [
        { role: 'developer', source: 'system_prompt', content: 'System prompt' },
        { role: 'user', source: 'message', content: 'Hi' },
      ],
    });
  });

  it('moves system context into provider system prompt observability instead of chat history', async () => {
    const client = new LLMClient(makeConfig());
    mocks.completeSimple.mockResolvedValue({
      model: 'z-ai/glm-5',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
      content: [{ type: 'text', text: 'done' }],
    });

    const response = await client.complete({
      systemPrompt: 'System prompt',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'system', content: '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.' },
        { role: 'assistant', content: 'I can keep that in mind.' },
      ],
    }, 'summary', { disableRetry: true });

    expect(response.providerObservability).toMatchObject({
      providerWireMessages: [
        {
          role: 'developer',
          source: 'system_prompt',
          content: [
            'System prompt',
            '<session_context>',
            '[SYSTEM: Quiet Planner] Queue a private follow-up reminder.',
            '</session_context>',
          ].join('\n\n'),
        },
        { role: 'user', source: 'message', content: 'Hi' },
        { role: 'assistant', source: 'message', content: expect.stringContaining('I can keep that in mind.') },
      ],
    });
    expect(response.providerObservability?.providerWireMessages.some(message => message.role === 'assistant'
      && message.content.includes('Queue a private follow-up reminder.'))).toBe(false);
  });

  it('preserves structured assistant and tool-result history when streaming through the transport path', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        reason: 'stop',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 17, output: 9 },
          content: [{ type: 'text', text: 'continued' }],
        },
      };
    });

    await client.stream({
      systemPrompt: 'System prompt',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'trace' },
            { type: 'text', text: 'hello' },
          ],
          api: 'openai-completions',
          provider: 'openrouter',
          model: 'openrouter/moonshotai/kimi-k2.5',
          usage: {
            input: 11,
            output: 7,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 18,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 1000,
        } as any,
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'lookup',
          content: [{ type: 'text', text: 'done' }],
          isError: false,
          timestamp: 1001,
        } as any,
        { role: 'user', content: 'continue' } as any,
      ],
    });

    const piContext = mocks.streamSimple.mock.calls[0]?.[1] as { messages: any[] };
    expect(piContext.messages[0]).toMatchObject({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'trace',
        },
        {
          type: 'text',
          text: 'hello',
        },
      ],
    });
    expect(piContext.messages[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'lookup',
      isError: false,
      content: [
        {
          type: 'text',
          text: 'done',
        },
      ],
    });
    expect(piContext.messages[2]).toMatchObject({
      role: 'user',
      content: 'continue',
    });
  });

  it('prefers final done-message tool call arguments over streamed toolcall_end payloads', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-1',
          name: 'memory_write',
          arguments: {
            text: ': 561-09-3458\n+name: Marilyn Mack\nitemsOneDigit:  {',
          },
        },
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 17, output: 9 },
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'memory_write',
              arguments: {
                text: 'matrix-secret-2026-04-10T05-02-16-083Z',
                type: 'semantic',
                sensitivity: 'personal',
              },
            },
          ],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Store the secret' }],
    });

    expect(response.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'memory_write',
        input: {
          text: 'matrix-secret-2026-04-10T05-02-16-083Z',
          type: 'semantic',
          sensitivity: 'personal',
        },
      },
    ]);
  });

  it('drops duplicate streamed tool calls when the final done message contains only one tool call', async () => {
    const client = new LLMClient(makeConfig());
    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-2',
          name: 'values_update',
          arguments: {
            version: 9,
            value: 'matrix-value-updated-1',
            context: 'live shakedown revision',
          },
        },
      };
      yield {
        type: 'toolcall_end',
        toolCall: {
          id: 'call-3',
          name: 'values_update',
          arguments: {
            version: 9,
            value: 'matrix-value-updated-1',
            context: 'live shakedown revision',
          },
        },
      };
      yield {
        type: 'done',
        reason: 'toolUse',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 20, output: 11 },
          content: [
            {
              type: 'toolCall',
              id: 'call-2',
              name: 'values_update',
              arguments: {
                version: 9,
                value: 'matrix-value-updated-1',
                context: 'live shakedown revision',
              },
            },
          ],
        },
      };
    });

    const response = await client.stream({
      systemPrompt: 'System prompt',
      messages: [{ role: 'user', content: 'Update the values journal' }],
    });

    expect(response.toolCalls).toEqual([
      {
        id: 'call-2',
        name: 'values_update',
        input: {
          version: 9,
          value: 'matrix-value-updated-1',
          context: 'live shakedown revision',
        },
      },
    ]);
  });
});

describe('LLMClient prompt caching', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: modelId,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
      reasoning: true,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('routes prompt-cached completions through openai-responses and exposes engaged observability', async () => {
    const client = new LLMClient(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
              promptCacheStrategy: 'openai_responses',
            },
            tuning: {
              maxOutputTokens: 4096,
              promptCacheRetention: 'long',
              promptCacheScope: 'channel',
            },
          },
        ],
      },
    }), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cached ok' }],
      model: 'summary/cached',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Hi' }],
        correlation: {
          requestId: 'req-cache-1',
          channelId: 'discord:cache-channel',
          callType: 'summary',
          originType: 'summary',
          originStage: 'agent.summary',
          purpose: 'summary',
        },
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; api: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { cacheRetention?: string; sessionId?: string };
    expect(model.id).toBe('openrouter/summary/cached');
    expect(model.api).toBe('openai-responses');
    expect(requestOptions).toMatchObject({
      cacheRetention: 'long',
      sessionId: 'discord:cache-channel',
    });
    expect(response.providerObservability).toMatchObject({
      backendApi: 'openai-responses',
      promptCaching: {
        configured: true,
        engaged: true,
        strategy: 'openai_responses',
        retention: 'long',
        scope: 'channel',
        sessionId: 'discord:cache-channel',
      },
    });
  });

  it('fails closed on cache engagement when a channel-scoped cache key cannot be derived', async () => {
    const client = new LLMClient(makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'summary-cache',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'summary/cached',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 128_000,
              supportsPromptCaching: true,
              promptCacheStrategy: 'openai_responses',
            },
            tuning: {
              maxOutputTokens: 4096,
              promptCacheRetention: 'long',
              promptCacheScope: 'channel',
            },
          },
        ],
      },
    }), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cached ok' }],
      model: 'summary/cached',
      usage: { input: 9, output: 4 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System prompt',
        messages: [{ role: 'user', content: 'Hi' }],
        correlation: {
          requestId: 'req-cache-2',
          callType: 'summary',
          originType: 'summary',
          originStage: 'agent.summary',
          purpose: 'summary',
        },
      },
      'summary',
      { disableRetry: true },
    );

    const model = mocks.completeSimple.mock.calls[0][0] as { api: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { cacheRetention?: string; sessionId?: string };
    expect(model.api).toBe('openai-responses');
    expect(requestOptions.cacheRetention).toBeUndefined();
    expect(requestOptions.sessionId).toBeUndefined();
    expect(response.providerObservability).toMatchObject({
      promptCaching: {
        configured: true,
        engaged: false,
        strategy: 'openai_responses',
        retention: 'long',
        scope: 'channel',
        reason: 'missing_channel_id',
      },
    });
  });
});
describe('LLMClient completion model hints', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('prioritizes explicit model hints for completion routing', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'hinted response' }],
      model: 'anthropic/claude-3.7-sonnet',
      usage: { input: 18, output: 9 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { model: 'anthropic/claude-3.7-sonnet' },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/anthropic/claude-3.7-sonnet');
  });

  it('honors max-token model hints even without explicit model overrides', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'token cap response' }],
      model: 'z-ai/glm-5',
      usage: { input: 10, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { maxTokens: 77 },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(77);
  });

  it('caps hinted-model output at the registry entry maxOutputTokens', async () => {
    const config = makeConfig();
    config.modelRegistry!.models.push({
      id: 'claude-opus-3',
      rank: 200,
      identity: {
        provider: 'anthropic',
        model: 'anthropic/claude-3-opus-20240229',
        source: { type: 'litellm' },
      },
      purposes: [{ purpose: 'moa', primary: false }],
      capabilities: { maxOutputTokens: 4096, contextWindow: 200_000 },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'capped response' }],
      model: 'anthropic/claude-3-opus-20240229',
      usage: { input: 12, output: 4 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: '',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: {
          provider: 'anthropic',
          model: 'anthropic/claude-3-opus-20240229',
          pin: true,
        },
      },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(4096);
  });

  it('fails closed when modelHint.model references a legacy slot key', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'should not run' }],
      model: 'z-ai/glm-5',
      usage: { input: 5, output: 2 },
      stopReason: 'stop',
    });

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: { model: 'chat' },
      },
    )).rejects.toBeInstanceOf(LegacyModelHintError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });

  it('uses provider-configured LiteLLM routing when runtime options do not override it', async () => {
    process.env.CUSTOM_LITELLM_KEY = 'provider-key';
    const client = new LLMClient(makeConfig({
      litellmBaseUrl: 'http://provider-config.test/v1',
      litellmApiKeyRef: envCredential('CUSTOM_LITELLM_KEY'),
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'chat',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { baseUrl: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(model.baseUrl).toBe('http://provider-config.test/v1');
    expect(requestOptions.apiKey).toBe('provider-key');
    delete process.env.CUSTOM_LITELLM_KEY;
  });

  it('uses the credential vault for provider-configured LiteLLM routing', async () => {
    const client = new LLMClient(makeConfig({
      litellmBaseUrl: 'http://provider-config.test/v1',
      litellmApiKeyRef: envCredential('CUSTOM_LITELLM_KEY'),
      credentialVault: createEnvCredentialVault({
        CUSTOM_LITELLM_KEY: 'vault-provider-key',
      }),
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'chat',
      { disableRetry: true },
    );

    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(requestOptions.apiKey).toBe('vault-provider-key');
  });

  it('normalizes openrouter model ids for LiteLLM-backed routing', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'provider-config response' }],
      model: 'openrouter/z-ai/glm-5',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/z-ai/glm-5');
  });

  it('preserves OpenRouter model ids for direct OpenRouter endpoint routing', async () => {
    const client = new LLMClient(makeConfig({
      openRouterApiBaseUrl: 'https://openrouter.ai/api/v1',
      credentialVault: createEnvCredentialVault({
        OPENROUTER_API_KEY: 'vault-openrouter-key',
      }),
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chat-direct-openrouter',
            rank: 10,
            identity: {
              provider: 'litellm',
              model: 'moonshotai/kimi-k2.6',
              source: {
                type: 'openrouter',
                baseUrl: 'https://openrouter.ai/api/v1',
              },
            },
            purposes: [{ purpose: 'summary', primary: true }],
            capabilities: {
              maxOutputTokens: 8192,
              contextWindow: 262_144,
            },
            tuning: {
              maxOutputTokens: 8192,
              contextWindow: 262_144,
            },
          },
        ],
      },
    }));
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'direct openrouter response' }],
      model: 'moonshotai/kimi-k2.6',
      usage: { input: 12, output: 6 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'summary',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; baseUrl: string; provider: string };
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { apiKey: string };
    expect(model.id).toBe('moonshotai/kimi-k2.6');
    expect(model.provider).toBe('openrouter');
    expect(model.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(requestOptions.apiKey).toBe('vault-openrouter-key');
  });

  it('pins explicit model hints to a single candidate when requested', () => {
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
    const client = new LLMClient(config, 'http://litellm.test/v1');

    const candidates = (client as any).resolveCandidates('chat', {
      model: 'moonshotai/kimi-k2.5',
      provider: 'openrouter',
      pin: true,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2.5',
      }),
    ]);
  });
});

describe('LLMClient model knob plumbing', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('applies configured registry tuning knobs to stream request options (smoke)', async () => {
    const config = makeConfig();
    const registry = config.modelRegistry!;
    config.modelRegistry = {
      ...registry,
      models: registry.models.map((entry) => (
        entry.id === 'chat'
          ? {
            ...entry,
            tuning: {
              ...(entry.tuning ?? {}),
              maxOutputTokens: 1337,
              contextWindow: 222_000,
              thinkingEnabled: true,
              thinkingEffort: 'high',
              temperature: 0.42,
              topP: 0.88,
              topK: 24,
              frequencyPenalty: -0.15,
              repetitionPenalty: 1.07,
            },
          }
          : entry
      )),
    };
    const client = new LLMClient(config, 'http://litellm.test/v1');

    mocks.streamSimple.mockImplementation(() => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: { input: 9, output: 5 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(response.content).toBe('ok');
    const requestOptions = mocks.streamSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions).toMatchObject({
      maxTokens: 1337,
      contextWindow: 222_000,
      reasoning: 'high',
      temperature: 0.42,
      topP: 0.88,
      topK: 24,
      frequencyPenalty: -0.15,
      repetitionPenalty: 1.07,
    });
  });

  it('filters unsupported sampling knobs for non-passthrough providers deterministically', async () => {
    const config = makeConfig();
    const registry = config.modelRegistry!;
    config.modelRegistry = {
      ...registry,
      models: registry.models.map((entry) => (
        entry.id === 'chat'
          ? {
            ...entry,
            identity: {
              ...entry.identity,
              provider: 'anthropic',
              model: 'claude-sonnet-4-5',
              source: { type: 'anthropic' },
            },
            tuning: {
              ...(entry.tuning ?? {}),
              maxOutputTokens: 1024,
              thinkingEnabled: true,
              thinkingEffort: 'medium',
              temperature: 0.31,
              topP: 0.9,
              topK: 40,
              frequencyPenalty: 0.2,
              repetitionPenalty: 1.1,
            },
          }
          : entry
      )),
    };
    mocks.getProviders.mockReturnValue(['openrouter', 'anthropic']);
    mocks.getModels.mockImplementation((provider: string) => (
      provider === 'anthropic'
        ? [{
          id: 'claude-sonnet-4-5',
          provider: 'anthropic',
          name: 'claude-sonnet-4-5',
          api: 'anthropic-messages',
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        }]
        : []
    ));

    const client = new LLMClient(config);

    mocks.streamSimple.mockImplementation(() => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: 'claude-sonnet-4-5',
          usage: { input: 7, output: 4 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const requestOptions = mocks.streamSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(1024);
    expect(requestOptions.temperature).toBe(0.31);
    expect(requestOptions.reasoning).toBe('medium');
    expect(requestOptions).not.toHaveProperty('topP');
    expect(requestOptions).not.toHaveProperty('topK');
    expect(requestOptions).not.toHaveProperty('frequencyPenalty');
    expect(requestOptions).not.toHaveProperty('repetitionPenalty');
  });

  it('maps model-hint thinking disable to no reasoning option even when effort is set', async () => {
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'z-ai/glm-5',
      usage: { input: 5, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
      },
      'reasoning',
      {
        disableRetry: true,
        modelHint: {
          thinkingEnabled: false,
          thinkingEffort: 'high',
          maxTokens: 99,
        },
      },
    );

    const requestOptions = mocks.completeSimple.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(requestOptions.maxTokens).toBe(99);
    expect(requestOptions).not.toHaveProperty('reasoning');
  });
});

describe('LLMClient context routing', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('routes legacy context completions to longContext primary before fallbacks', async () => {
    const client = new LLMClient(makeConfig({
      modelRoster: {
        chat: {
          model: 'chat-model',
          provider: 'openrouter',
          maxTokens: 4096,
          contextWindow: 128_000,
        },
        background: {
          model: 'background-model',
          provider: 'openrouter',
          maxTokens: 2048,
          contextWindow: 64_000,
        },
        longContext: {
          model: 'long-context-model',
          provider: 'openrouter',
          maxTokens: 8192,
          contextWindow: 256_000,
        },
      },
    }), 'http://litellm.test/v1');

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'context response' }],
      model: 'long-context-model',
      usage: { input: 14, output: 7 },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Use long context' }],
      },
      'context',
      { disableRetry: true },
    );

    expect(response.content).toBe('context response');
    const model = mocks.completeSimple.mock.calls[0]?.[0] as { id: string };
    expect(model.id).toBe('long-context-model');
  });
});

describe('LLMClient eligibility gate', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('denies background completions when required capability token is missing', async () => {
    const gate = createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      eligibilityGate: gate,
    });

    await expect(client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Process memories' }],
      },
      'background',
      { disableRetry: true },
    )).rejects.toBeInstanceOf(EligibilityDeniedError);

    expect(mocks.completeSimple).not.toHaveBeenCalled();
  });
});

describe('LLMClient correlation metadata', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('infers stable call types from purpose and channel', () => {
    expect(inferCallType('chat')).toBe('chat');
    expect(inferCallType('reasoning')).toBe('tool');
    expect(inferCallType('summary')).toBe('summary');
    expect(inferCallType('memory')).toBe('memory');
    expect(inferCallType('extraction')).toBe('memory');
    expect(inferCallType('context')).toBe('background');
    expect(inferCallType('background', 'internal:heartbeat')).toBe('scheduled');
    expect(inferCallType('background', 'discord:general')).toBe('background');
  });

  it('passes normalized correlation metadata to fallback execution', async () => {
    const runSpy = vi.spyOn(FallbackRunner.prototype, 'run');
    const client = new LLMClient(makeConfig(), 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      model: 'z-ai/glm-5',
      usage: { input: 2, output: 1 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Reply' }],
        correlation: {
          turnId: 'turn-1',
          requestId: 'req-1',
          channelId: 'internal:heartbeat',
          callType: 'scheduled',
          originType: 'scheduled',
          originStage: 'health.check',
          toolCallId: 'tool-call-1',
          purpose: 'health.check',
        },
      },
      'background',
      { disableRetry: true },
    );

    const correlation = runSpy.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(correlation).toMatchObject({
      turnId: 'turn-1',
      requestId: 'req-1',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      originType: 'scheduled',
      originStage: 'health.check',
      toolCallId: 'tool-call-1',
      purpose: 'health.check',
    });

    runSpy.mockRestore();
  });

  it('routes memory completions through the dedicated memory-purpose candidate', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'chat',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'chat/model',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'chat', primary: true },
              { purpose: 'summary', primary: true },
              { purpose: 'moa', primary: true },
            ],
            capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 4096 },
          },
          {
            id: 'background',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'memory',
            rank: 15,
            identity: {
              provider: 'openrouter',
              model: 'memory/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'memory', primary: true }],
            capabilities: { maxOutputTokens: 1536, contextWindow: 96_000 },
            tuning: { maxOutputTokens: 1536, contextWindow: 96_000 },
          },
          {
            id: 'extraction',
            rank: 30,
            identity: {
              provider: 'openrouter',
              model: 'extract/model',
              source: { type: 'openrouter' },
            },
            purposes: [
              { purpose: 'extraction', primary: true },
              { purpose: 'import_processing', primary: true },
            ],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'reasoning',
            rank: 40,
            identity: {
              provider: 'openrouter',
              model: 'reason/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'reasoning', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'long-context',
            rank: 50,
            identity: {
              provider: 'openrouter',
              model: 'long/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'longContext', primary: true }],
            capabilities: { maxOutputTokens: 4096, contextWindow: 256_000 },
            tuning: { maxOutputTokens: 4096, contextWindow: 256_000 },
          },
          {
            id: 'vision',
            rank: 60,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'memory ok' }],
      model: 'openrouter:memory/model',
      usage: { input: 8, output: 5 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Refresh context' }],
        correlation: {
          channelId: 'internal:heartbeat',
        },
      },
      'memory',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string };
    expect(model.id).toBe('openrouter/memory/model');
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(1536);

    const raw = readFileSync(join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; records: Array<Record<string, unknown>> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      purpose: 'memory',
      service: 'memory',
      process: 'memory',
      inputTokens: 8,
      outputTokens: 5,
    });
  });

  it('preserves image input when a background completion is hinted through litellm to a vision-capable routed model', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'openrouter/google/gemini-3-flash-preview',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 1_048_576,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'cat' }],
      model: 'openrouter/google/gemini-3-flash-preview',
      usage: { input: 12, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', data: 'YmFzZTY0', mimeType: 'image/jpeg' },
          ],
        }] as any,
        modelHint: {
          model: 'openrouter/google/gemini-3-flash-preview',
          provider: 'litellm',
          maxTokens: 4096,
        },
      } as any,
      'background',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; input: string[] };
    expect(model.id).toBe('openrouter/google/gemini-3-flash-preview');
    expect(model.input).toContain('image');
  });

  it('routes vision completions through the configured vision-purpose candidate', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 1024, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 1024 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 4096,
              contextWindow: 1_048_576,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 4096 },
          },
        ],
      },
    });
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'visible image summary' }],
      model: 'openrouter/vision/model',
      usage: { input: 12, output: 3 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Describe this image.' }],
      },
      'vision',
      { disableRetry: true },
    );

    expect(mocks.completeSimple).toHaveBeenCalledTimes(1);
    const model = mocks.completeSimple.mock.calls[0][0] as { id: string; input: string[] };
    expect(model.id).toBe('openrouter/vision/model');
    expect(model.input).toContain('image');
    const requestOptions = mocks.completeSimple.mock.calls[0][2] as { maxTokens: number };
    expect(requestOptions.maxTokens).toBe(1024);
  });
});

describe('LLMClient model budget gates and usage metering', () => {
  beforeEach(() => {
    mocks.getModel.mockReset();
    mocks.getModels.mockReset();
    mocks.getProviders.mockReset();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
    mocks.getEnvApiKey.mockReset();

    mocks.getModel.mockImplementation((provider: string, modelId: string) => ({
      id: `${provider}:${modelId}`,
      provider,
      name: modelId,
      api: 'openai-completions',
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8192,
    }));
    mocks.getProviders.mockReturnValue(['openrouter']);
    mocks.getModels.mockReturnValue([]);
    mocks.getEnvApiKey.mockReturnValue(undefined);
  });

  it('normalizes OpenRouter streaming usage accounting into provider cost telemetry', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });

    mocks.streamSimple.mockImplementation(async function* () {
      yield {
        type: 'done',
        message: {
          model: 'z-ai/glm-5',
          usage: {
            completion_tokens: 2,
            completion_tokens_details: { reasoning_tokens: 1 },
            cost: 0.95,
            cost_details: { upstream_inference_cost: 19 },
            prompt_tokens: 194,
            prompt_tokens_details: {
              cached_tokens: 7,
              cache_write_tokens: 11,
            },
            total_tokens: 196,
          },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    });

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-openrouter-usage-1',
        requestId: 'req-openrouter-usage-1',
        channelId: 'channel-openrouter-usage-1',
        callType: 'chat',
      },
    });

    expect(response).toMatchObject({
      inputTokens: 194,
      outputTokens: 2,
      providerObservability: {
        routeKind: 'configured_litellm_proxy',
        backendBaseUrl: 'http://litellm.test/v1',
      },
      usageDetails: {
        input: 194,
        output: 2,
        cacheRead: 7,
        cacheWrite: 11,
        totalTokens: 196,
        cost: { total: 0.95 },
      },
    });
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 194,
      outputTokens: 2,
      cacheReadTokens: 7,
      cacheWriteTokens: 11,
      totalTokens: 196,
      providerCostUsd: 0.95,
      costSource: 'provider',
      metadata: expect.objectContaining({
        routeKind: 'configured_litellm_proxy',
        backendProvider: 'litellm',
        backendBaseUrl: 'http://litellm.test/v1',
        providerCost: { total: 0.95 },
        rawUsage: expect.objectContaining({
          cost: 0.95,
          cost_details: { upstream_inference_cost: 19 },
        }),
      }),
    }));
  });

  it('normalizes OpenRouter completion usage accounting into provider cost telemetry', async () => {
    const usageRecorder = { recordUsageEvent: vi.fn(async () => undefined) };
    const client = new LLMClient(makeConfig(), {
      litellmBaseUrl: 'http://litellm.test/v1',
      usageRecorder,
    });

    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: {
        prompt_tokens: 25,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 3 },
        total_tokens: 30,
        cost: 0.123,
      },
      stopReason: 'stop',
    });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    expect(response).toMatchObject({
      inputTokens: 25,
      outputTokens: 5,
      usageDetails: {
        input: 25,
        output: 5,
        cacheRead: 3,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { total: 0.123 },
      },
    });
    expect(usageRecorder.recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      callKind: 'completion',
      inputTokens: 25,
      outputTokens: 5,
      cacheReadTokens: 3,
      totalTokens: 30,
      providerCostUsd: 0.123,
      costSource: 'provider',
      metadata: expect.objectContaining({
        routeKind: 'configured_litellm_proxy',
        backendProvider: 'litellm',
        backendBaseUrl: 'http://litellm.test/v1',
      }),
    }));
  });

  it('skips budget-blocked primary candidate and falls back to secondary chat candidate', async () => {
    const config = makeConfig();
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 0.001,
        monthlyUsdLimit: 1,
        currency: 'USD',
      },
      models: [
        ...baseRegistry.models.map((entry) => (
          entry.id === 'chat'
            ? {
              ...entry,
              cost: { inputPer1MUsd: 100, outputPer1MUsd: 100, currency: 'USD' },
            }
            : entry
        )),
        {
          id: 'chat-fallback',
          rank: 500,
          identity: {
            provider: 'openrouter',
            model: 'openai/gpt-4.1-mini',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: false },
          ],
          capabilities: {
            maxOutputTokens: 2048,
            contextWindow: 128_000,
          },
          tuning: {
            maxOutputTokens: 2048,
          },
          cost: {
            inputPer1MUsd: 0.01,
            outputPer1MUsd: 0.01,
            currency: 'USD',
          },
        },
      ],
    };
    const blockedEvents: Array<Record<string, unknown>> = [];
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      onBudgetBlocked: (event) => blockedEvents.push(event as unknown as Record<string, unknown>),
    });

    mocks.streamSimple.mockImplementation((model: { id: string }) => (async function* streamOk() {
      yield {
        type: 'done',
        message: {
          model: model.id,
          usage: { input: 5, output: 3 },
          content: [{ type: 'text', text: 'ok' }],
        },
        reason: 'stop',
      };
    })());

    const response = await client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Hello there' }],
      correlation: {
        turnId: 'turn-budget-1',
        requestId: 'req-budget-1',
        channelId: 'channel-budget-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    expect(response.content).toBe('ok');
    expect(mocks.streamSimple).toHaveBeenCalledTimes(1);
    const selectedModel = mocks.streamSimple.mock.calls[0]?.[0] as { id: string };
    expect(selectedModel.id).toBe('openrouter/openai/gpt-4.1-mini');
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0]).toMatchObject({
      reason: 'daily_budget_exceeded',
      purpose: 'chat',
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      service: 'chat',
      process: 'agent.turn.prompt',
      turnId: 'turn-budget-1',
      requestId: 'req-budget-1',
      channelId: 'channel-budget-1',
      callType: 'chat',
      originType: 'chat',
      originStage: 'agent.turn.prompt',
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

  it('persists usage ledger records after successful completion call', async () => {
    const config = makeConfig();
    const client = new LLMClient(config, 'http://litellm.test/v1');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 13, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    const raw = readFileSync(join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as { schemaVersion: number; records: Array<Record<string, unknown>> };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      purpose: 'background',
      service: 'background',
      inputTokens: 13,
      outputTokens: 7,
    });
  });

  it('skips preflight token estimation when model budget policy is disabled', async () => {
    const config = makeConfig();
    const baseRegistry = config.modelRegistry!;
    config.modelRegistry = {
      ...baseRegistry,
      budgetPolicy: {
        enabled: false,
        dailyUsdLimit: 1,
        monthlyUsdLimit: 10,
        currency: 'USD',
      },
    };
    const client = new LLMClient(config, 'http://litellm.test/v1');
    const estimateSpy = vi.spyOn(client as any, 'estimateBudgetInputTokens');
    mocks.completeSimple.mockResolvedValue({
      content: [{ type: 'text', text: 'done' }],
      model: 'deepseek/deepseek-v3.2',
      usage: { input: 13, output: 7 },
      stopReason: 'stop',
    });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
      { disableRetry: true },
    );

    expect(estimateSpy).not.toHaveBeenCalled();
    const raw = readFileSync(join(config.dataDir, MODEL_USAGE_LEDGER_FILE_NAME), 'utf-8');
    const parsed = JSON.parse(raw) as { records: Array<Record<string, unknown>> };
    expect(parsed.records[0]).toMatchObject({
      inputTokens: 13,
      outputTokens: 7,
    });
  });

  it('routes completion through injected transport without calling direct provider transport', async () => {
    const config = makeConfig();
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'gateway-result',
        model: 'z-ai/glm-5',
        inputTokens: 9,
        outputTokens: 4,
        stopReason: 'stop',
        toolCalls: [],
      })),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const response = await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Summarize this quickly' }],
      },
      'background',
    );

    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(transport.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'deepseek/deepseek-v3.2',
          provider: 'openrouter',
          pin: true,
          maxTokens: 2048,
        }),
      }),
      'background',
    );
    expect(response).toMatchObject({
      content: 'gateway-result',
      model: 'z-ai/glm-5',
      inputTokens: 9,
      outputTokens: 4,
    });
  });

  it('caps vision completion output tokens before routing through injected transport', async () => {
    const config = makeConfig({
      modelRegistry: {
        schemaVersion: 1,
        models: [
          {
            id: 'background',
            rank: 10,
            identity: {
              provider: 'openrouter',
              model: 'background/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 2048, contextWindow: 64_000 },
            tuning: { maxOutputTokens: 2048 },
          },
          {
            id: 'vision',
            rank: 20,
            identity: {
              provider: 'openrouter',
              model: 'vision/model',
              source: { type: 'openrouter' },
            },
            purposes: [{ purpose: 'vision', primary: true }],
            capabilities: {
              maxOutputTokens: 262_142,
              contextWindow: 262_144,
              supportsVision: true,
            },
            tuning: { maxOutputTokens: 262_142 },
          },
        ],
      },
    });
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async () => ({
        content: 'gateway-vision-result',
        model: 'vision/model',
        inputTokens: 1200,
        outputTokens: 8,
        stopReason: 'stop',
        toolCalls: [],
      })),
    };
    const client = new LLMClient(config, { transport: transport as any });

    await client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Describe this image' }],
      },
      'vision',
    );

    expect(mocks.completeSimple).not.toHaveBeenCalled();
    expect(transport.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'vision/model',
          provider: 'openrouter',
          pin: true,
          maxTokens: 1024,
        }),
      }),
      'vision',
    );
  });

  it('routes streaming through injected transport without calling direct provider transport', async () => {
    const config = makeConfig();
    const callbacks = {
      onDone: vi.fn(),
      onError: vi.fn(),
    };
    const transport = {
      stream: vi.fn(async () => ({
        content: 'gateway-stream-result',
        model: 'z-ai/glm-5',
        inputTokens: 11,
        outputTokens: 6,
        stopReason: 'stop',
        toolCalls: [],
      })),
      complete: vi.fn(),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const response = await client.stream(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Stream this reply' }],
      },
      callbacks,
    );

    expect(mocks.streamSimple).not.toHaveBeenCalled();
    expect(transport.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        modelHint: expect.objectContaining({
          model: 'z-ai/glm-5',
          provider: 'openrouter',
          pin: true,
          maxTokens: 4096,
        }),
      }),
      callbacks,
    );
    expect(callbacks.onDone).toHaveBeenCalledWith(expect.objectContaining({
      content: 'gateway-stream-result',
      model: 'z-ai/glm-5',
    }));
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      content: 'gateway-stream-result',
      model: 'z-ai/glm-5',
      inputTokens: 11,
      outputTokens: 6,
    });
  });

  it('prioritizes queued foreground chat ahead of queued background work on constrained routes', async () => {
    const config = makeConfig();
    const order: string[] = [];
    const firstBackground = createDeferred<{
      content: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      toolCalls: [];
    }>();
    const foregroundRelease = createDeferred<{
      content: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      toolCalls: [];
    }>();
    const transport = {
      stream: vi.fn(async (context: { correlation?: { requestId?: string } }) => {
        order.push(`stream:${context.correlation?.requestId ?? 'unknown'}`);
        return await foregroundRelease.promise;
      }),
      complete: vi.fn(async (
        context: { correlation?: { requestId?: string } },
        purpose: string,
      ) => {
        order.push(`complete:${purpose}:${context.correlation?.requestId ?? 'unknown'}`);
        if (context.correlation?.requestId === 'bg-1') {
          return await firstBackground.promise;
        }
        return {
          content: `${purpose}-result`,
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 4,
          outputTokens: 2,
          stopReason: 'stop',
          toolCalls: [],
        };
      }),
    };
    const client = new LLMClient(config, {
      litellmBaseUrl: 'http://litellm.test/v1',
      transport: transport as any,
    });

    const backgroundOnePromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Background 1' }],
        correlation: {
          requestId: 'bg-1',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );
    await vi.waitFor(() => expect(transport.complete).toHaveBeenCalledTimes(1));

    const backgroundTwoPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Background 2' }],
        correlation: {
          requestId: 'bg-2',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );
    const foregroundPromise = client.stream({
      systemPrompt: 'System',
      messages: [{ role: 'user', content: 'Foreground chat' }],
      correlation: {
        requestId: 'chat-1',
        callType: 'chat',
        originType: 'chat',
        originStage: 'agent.turn.prompt',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport.complete).toHaveBeenCalledTimes(1);
    expect(transport.stream).not.toHaveBeenCalled();

    firstBackground.resolve({
      content: 'background-1-result',
      model: 'deepseek/deepseek-v3.2',
      inputTokens: 6,
      outputTokens: 2,
      stopReason: 'stop',
      toolCalls: [],
    });

    await vi.waitFor(() => expect(transport.stream).toHaveBeenCalledTimes(1));
    expect(transport.complete).toHaveBeenCalledTimes(1);

    foregroundRelease.resolve({
      content: 'foreground-result',
      model: 'z-ai/glm-5',
      inputTokens: 5,
      outputTokens: 3,
      stopReason: 'stop',
      toolCalls: [],
    });

    await expect(foregroundPromise).resolves.toMatchObject({
      content: 'foreground-result',
      model: 'z-ai/glm-5',
    });
    await vi.waitFor(() => expect(transport.complete).toHaveBeenCalledTimes(2));
    await expect(backgroundTwoPromise).resolves.toMatchObject({
      content: 'background-result',
      model: 'deepseek/deepseek-v3.2',
    });
    await expect(backgroundOnePromise).resolves.toMatchObject({
      content: 'background-1-result',
      model: 'deepseek/deepseek-v3.2',
    });

    expect(order).toEqual([
      'complete:background:bg-1',
      'stream:chat-1',
      'complete:background:bg-2',
    ]);
  });

  it('does not serialize direct registered-model calls when no shared route is in play', async () => {
    const config = makeConfig();
    const secondStarted = createDeferred<void>();
    const firstRelease = createDeferred<{
      content: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      toolCalls: [];
    }>();
    const transport = {
      stream: vi.fn(),
      complete: vi.fn(async (context: { correlation?: { requestId?: string } }) => {
        if (context.correlation?.requestId === 'direct-1') {
          return await firstRelease.promise;
        }
        secondStarted.resolve();
        return {
          content: 'direct-2-result',
          model: 'deepseek/deepseek-v3.2',
          inputTokens: 2,
          outputTokens: 1,
          stopReason: 'stop',
          toolCalls: [],
        };
      }),
    };
    const client = new LLMClient(config, { transport: transport as any });

    const firstPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Direct 1' }],
        correlation: {
          requestId: 'direct-1',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );
    await vi.waitFor(() => expect(transport.complete).toHaveBeenCalledTimes(1));

    const secondPromise = client.complete(
      {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'Direct 2' }],
        correlation: {
          requestId: 'direct-2',
          callType: 'background',
          originType: 'background',
          originStage: 'agent.background.turn',
        },
      },
      'background',
    );

    await expect(secondStarted.promise).resolves.toBeUndefined();
    firstRelease.resolve({
      content: 'direct-1-result',
      model: 'deepseek/deepseek-v3.2',
      inputTokens: 2,
      outputTokens: 1,
      stopReason: 'stop',
      toolCalls: [],
    });

    await expect(firstPromise).resolves.toMatchObject({ content: 'direct-1-result' });
    await expect(secondPromise).resolves.toMatchObject({ content: 'direct-2-result' });
    expect(transport.complete).toHaveBeenCalledTimes(2);
  });
});
