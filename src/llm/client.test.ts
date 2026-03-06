import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubstrateConfig } from '../types.js';
import { FallbackRunner } from './fallback.js';
import { createEligibilityGate, EligibilityDeniedError } from '../capabilities/eligibility.js';

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

import { inferCallType, LLMClient, SensitiveImportRoutePolicyError } from './client.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 4096,
    extractionMaxTokens: 2048,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: './data/test.db',
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
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
    expect(model.id).toBe('anthropic/claude-3.7-sonnet');
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
});
