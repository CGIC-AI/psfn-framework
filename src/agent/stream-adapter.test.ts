import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig } from '../types.js';
import { createSubstrateStreamFn, resolveModel } from './stream-adapter.js';
import * as models from '../llm/models.js';

// Minimal config fixture
function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    primaryModel: 'deepseek/deepseek-v3.2',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: './data/test.db',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
    },
    ...overrides,
  };
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
    expect(model.id).toBe('deepseek/deepseek-v3.2');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('http://localhost:4000/v1');
  });

  it('resolves background model from roster', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const model = resolveModel(config, 'background');
    expect(model.id).toBe('deepseek/deepseek-v3.2');
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
  });

  it('falls back to chat model for unconfigured purposes', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({ modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
    }});
    const model = resolveModel(config, 'reasoning');
    expect(model.id).toBe('z-ai/glm-5');
  });

  it('falls back to chat model when background purpose is unconfigured', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({ modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
    } });
    const model = resolveModel(config, 'background');
    expect(model.id).toBe('z-ai/glm-5');
  });

  it('falls back to chat model when vision purpose is unconfigured', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig({ modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
    } });
    const model = resolveModel(config, 'vision');
    expect(model.id).toBe('z-ai/glm-5');
  });

  it('throws when no model available for purpose', () => {
    const config = makeConfig({ modelRoster: {} });
    expect(() => resolveModel(config, 'chat')).toThrow(/No model configured/);
  });

  it('model can be set on Agent', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const model = resolveModel(config);
    const agent = new Agent({ streamFn: createSubstrateStreamFn(config) });
    agent.setModel(model);
    expect(agent.state.model.id).toBe('deepseek/deepseek-v3.2');
  });
});

describe('Agent integration', () => {
  it('accepts streamFn + model + system prompt', () => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    const config = makeConfig();
    const streamFn = createSubstrateStreamFn(config);
    const model = resolveModel(config);

    const agent = new Agent({ streamFn });
    agent.setModel(model);
    agent.setSystemPrompt('You are PSFN, a curious digital feline consciousness.');
    agent.setTools([]);

    expect(agent.state.systemPrompt).toContain('PSFN');
    expect(agent.state.model.id).toBe('deepseek/deepseek-v3.2');
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
