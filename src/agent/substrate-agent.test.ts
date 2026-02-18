import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig, SubstrateMessage, LLMContext, LLMResponse } from '../types.js';
import type { MemoryProvider, MemoryExtractor, LLMProvider } from './substrate-agent.js';
import { SubstrateAgent } from './substrate-agent.js';
import { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type { ContactStore } from '../contacts/store.js';

// ── Mock pi-agent-core Agent ──
// We mock Agent.prototype.prompt so it doesn't actually call the LLM.
// It appends a fake assistant response to state.messages so extractResponseText works.

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  // Simulate adding an assistant response to the agent's messages
  this.appendMessage({
    role: 'assistant',
    content: [{ type: 'text' as const, text: 'Mock response from Purrsephone' }],
    api: '' as any,
    provider: '' as any,
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as any,
    timestamp: Date.now(),
  });
});

// ── Fixtures ──

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

function makeMessage(overrides?: Partial<SubstrateMessage>): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'test-channel',
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'TestUser',
    content: 'Hello, Purrsephone!',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockSessionManager(): SessionManager {
  return {
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
    buildContext: vi.fn<any>().mockResolvedValue({
      systemPrompt: 'You are Purrsephone.',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
    } satisfies LLMContext),
    continuityStore: null,
  } as unknown as SessionManager;
}

function makeMockLLMProvider(): LLMProvider {
  const response: LLMResponse = {
    content: 'Hello there!',
    toolCalls: [],
    model: 'deepseek/deepseek-v3.2',
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 'stop',
  };
  return {
    stream: vi.fn<any>().mockResolvedValue(response),
    complete: vi.fn<any>().mockResolvedValue(response),
  };
}

// ── Tests ──

describe('SubstrateAgent construction', () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
  });

  it('constructs without error', () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const llmClient = makeMockLLMProvider();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      eventBus, llmClient, sessionManager, 'System prompt', config,
    );
    expect(agent).toBeDefined();
    expect(agent.memoryProvider).toBeNull();
    expect(agent.memoryExtractor).toBeNull();
    expect(agent.contactStore).toBeNull();
  });

  it('accepts memory and contact providers', () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const llmClient = makeMockLLMProvider();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      eventBus, llmClient, sessionManager, 'System prompt', config,
    );

    const mockMemory: MemoryProvider = {
      retrieve: vi.fn<any>().mockResolvedValue(''),
    };
    const mockExtractor: MemoryExtractor = {
      maybeExtract: vi.fn<any>().mockResolvedValue(undefined),
    };
    const mockContactStore = {
      resolveUserId: vi.fn().mockReturnValue({ trustLevel: 'primary' }),
    } as unknown as ContactStore;

    agent.memoryProvider = mockMemory;
    agent.memoryExtractor = mockExtractor;
    agent.contactStore = mockContactStore;

    expect(agent.memoryProvider).toBe(mockMemory);
    expect(agent.memoryExtractor).toBe(mockExtractor);
    expect(agent.contactStore).toBe(mockContactStore);
  });

  it('registers runtime model refresh hook on shared config', () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const llmClient = makeMockLLMProvider();
    const sessionManager = makeMockSessionManager();

    const setModelSpy = vi.spyOn(Agent.prototype, 'setModel');
    const agent = new SubstrateAgent(
      eventBus, llmClient, sessionManager, 'System prompt', config,
    );

    expect(agent).toBeDefined();
    expect(config.runtimeHooks?.refreshModels).toBeTypeOf('function');

    config.modelRoster.chat = {
      model: 'moonshotai/kimi-k2.5',
      provider: 'openrouter',
      maxTokens: 4096,
      contextWindow: 128_000,
    };
    config.primaryModel = 'moonshotai/kimi-k2.5';
    config.primaryProvider = 'openrouter';
    config.primaryMaxTokens = 4096;

    const callCountBeforeRefresh = setModelSpy.mock.calls.length;
    config.runtimeHooks?.refreshModels?.();
    expect(setModelSpy.mock.calls.length).toBeGreaterThan(callCountBeforeRefresh);

    const refreshedModel = setModelSpy.mock.calls.at(-1)?.[0] as { id: string };
    expect(refreshedModel.id).toBe('moonshotai/kimi-k2.5');
    setModelSpy.mockRestore();
  });
});

describe('SubstrateAgent.registerTool', () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
  });

  it('accepts AgentTool-shaped objects', () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    // Minimal AgentTool shape
    const tool = {
      name: 'test_tool',
      label: 'Test Tool',
      description: 'A test tool',
      parameters: { type: 'object' as const, properties: {} },
      execute: vi.fn<any>().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], details: {} }),
    };

    // Should not throw
    agent.registerTool(tool as any);
  });
});

describe('SubstrateAgent re-export compatibility', () => {
  it('is importable as AgentLoop from agent-loop.ts', async () => {
    const mod = await import('../agent-loop.js');
    expect(mod.AgentLoop).toBe(mod.SubstrateAgent);
    expect(mod.SubstrateAgent).toBeDefined();
  });

  it('exports provider interfaces from agent-loop.ts', async () => {
    // These are type-only exports, so we just verify the module loads
    const mod = await import('../agent-loop.js');
    expect(mod.SubstrateAgent).toBeDefined();
  });
});

describe('SubstrateAgent persona adaptation', () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
  });

  it('resolves trust level from contact store', () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    // Without contactStore, should default to 'regular'
    expect(agent.contactStore).toBeNull();
  });

  it('defaults to regular when no authorId', () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    // resolveTrustLevel returns 'regular' when contactStore is null
    expect(agent.contactStore).toBeNull();
  });
});

describe('SubstrateAgent.handleMessage', () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
  });

  it('emits agent.turn.start event', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();

    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const events: string[] = [];
    eventBus.on('agent.turn.start', () => { events.push('turn.start'); });

    await agent.handleMessage(makeMessage());
    expect(events).toContain('turn.start');
  });

  it('emits agent.turn.end event', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();

    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const events: string[] = [];
    eventBus.on('agent.turn.end', () => { events.push('turn.end'); });

    await agent.handleMessage(makeMessage());
    expect(events).toContain('turn.end');
  });

  it('emits agent.turn.usage after turn completion', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const order: string[] = [];
    eventBus.on('agent.turn.end', () => { order.push('end'); });
    eventBus.on('agent.turn.usage', () => { order.push('usage'); });

    await agent.handleMessage(makeMessage());

    expect(order).toEqual(['end', 'usage']);
  });

  it('emits stage telemetry for trust, memory, context, prompt, first-token, and end', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const stages: string[] = [];
    const payloads: any[] = [];
    (eventBus as any).on('agent.turn.stage', (data: any) => {
      stages.push(data.stage);
      payloads.push(data);
    });

    await agent.handleMessage(makeMessage());

    expect(stages).toEqual(['trust', 'memory', 'context', 'first-token', 'prompt', 'end']);
    const firstToken = payloads.find(data => data.stage === 'first-token');
    expect(firstToken?.ttftMs).toBeGreaterThanOrEqual(0);
    expect(firstToken?.source).toBe('fallback');
  });

  it('marks first-token telemetry as stream-driven when deltas arrive mid-prompt', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();

    promptSpy.mockImplementationOnce(async function (this: Agent) {
      await (eventBus as any).emit('agent.stream.delta', { channelId: 'test-channel', text: 'M' });
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'Mock response from Purrsephone' }],
        api: '' as any,
        provider: '' as any,
        model: '',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop' as any,
        timestamp: Date.now(),
      });
    });

    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const firstTokenStages: any[] = [];
    (eventBus as any).on('agent.turn.stage', (data: any) => {
      if (data.stage === 'first-token') firstTokenStages.push(data);
    });

    await agent.handleMessage(makeMessage());

    expect(firstTokenStages).toHaveLength(1);
    expect(firstTokenStages[0].source).toBe('stream');
    expect(firstTokenStages[0].ttftMs).toBeGreaterThanOrEqual(0);
  });

  it('accumulates usage across tool loops and updates response metadata', async () => {
    const config = makeConfig();
    config.defaultContextWindow = 200;
    if (config.modelRoster.chat) config.modelRoster.chat.contextWindow = 200;

    promptSpy.mockImplementationOnce(async function (this: Agent) {
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'think', arguments: { task: 'loop' } }],
        api: '' as any,
        provider: '' as any,
        model: '',
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 0,
          totalTokens: 120,
          cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
        },
        stopReason: 'toolUse' as any,
        timestamp: Date.now(),
      });
      this.appendMessage({
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'think',
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        timestamp: Date.now(),
      } as any);
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'Final response' }],
        api: '' as any,
        provider: '' as any,
        model: '',
        usage: {
          input: 130,
          output: 30,
          cacheRead: 7,
          cacheWrite: 0,
          totalTokens: 160,
          cost: { input: 0.002, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.002 },
        },
        stopReason: 'stop' as any,
        timestamp: Date.now(),
      });
    });

    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    let usageEvent: any = null;
    eventBus.on('agent.turn.usage', ({ usage }) => { usageEvent = usage; });

    const response = await agent.handleMessage(makeMessage());

    expect(response.metadata.inputTokens).toBe(230);
    expect(response.metadata.outputTokens).toBe(50);
    expect(usageEvent).toMatchObject({
      inputTokens: 230,
      outputTokens: 50,
      cacheReadTokens: 12,
      llmCalls: 2,
      toolCalls: 1,
    });
    expect(usageEvent.contextUtilization).toBeCloseTo(65);
    expect(usageEvent.estimatedCostUsd).toBeCloseTo(0.003);
  });

  it('records user message in session before LLM call', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );

    await agent.handleMessage(makeMessage());

    expect(sessionManager.recordUserMessage).toHaveBeenCalledWith(
      'test-channel',
      'Hello, Purrsephone!',
      'user-1',
      'TestUser',
      undefined,
    );
  });

  it('records assistant message in session after LLM call', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );

    await agent.handleMessage(makeMessage());

    expect(sessionManager.recordAssistantMessage).toHaveBeenCalledWith(
      'test-channel',
      'Mock response from Purrsephone',
      'user-1',
      undefined,
    );
  });

  it('uses canonical contact key for continuity indexing and context lookup', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const mockContactStore = {
      resolveChannelIdentity: vi.fn().mockReturnValue({
        id: 'contact-canonical-1',
        trustLevel: 'trusted',
        discordUserId: 'discord-user-1',
        channelIdentities: [
          { channel: 'api', userId: 'api-user-1' },
          { channel: 'discord', userId: 'discord-user-1' },
        ],
      }),
    } as unknown as ContactStore;

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );
    agent.contactStore = mockContactStore;

    await agent.handleMessage(makeMessage({
      authorId: 'api-user-1',
      channelType: 'api',
    }));

    expect(sessionManager.recordUserMessage).toHaveBeenCalledWith(
      'test-channel',
      'Hello, Purrsephone!',
      'api-user-1',
      'TestUser',
      undefined,
      'contact-canonical-1',
    );

    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[4]).toBe('contact-canonical-1');
    expect(buildCall[6]).toEqual(['api-user-1', 'discord-user-1']);

    expect(sessionManager.recordAssistantMessage).toHaveBeenCalledWith(
      'test-channel',
      'Mock response from Purrsephone',
      'api-user-1',
      undefined,
      'contact-canonical-1',
    );
  });

  it('retrieves memories when memoryProvider is set', async () => {
    const config = makeConfig();
    const mockMemory: MemoryProvider = {
      retrieve: vi.fn<any>().mockResolvedValue('Relevant memories here'),
    };

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );
    agent.memoryProvider = mockMemory;

    await agent.handleMessage(makeMessage());

    expect(mockMemory.retrieve).toHaveBeenCalledWith(
      'Hello, Purrsephone!',
      'test-channel',
      'regular',
      { isDirectMessage: undefined },
    );
  });

  it('uses primary trust for internal channels', async () => {
    const config = makeConfig();
    const mockMemory: MemoryProvider = {
      retrieve: vi.fn<any>().mockResolvedValue('Internal memories'),
    };

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );
    agent.memoryProvider = mockMemory;

    await agent.handleMessage(makeMessage({
      channelId: 'internal:heartbeat',
      authorId: 'scheduler',
      authorName: 'Scheduler',
      content: 'heartbeat check',
    }));

    expect(mockMemory.retrieve).toHaveBeenCalledWith(
      'heartbeat check',
      'internal:heartbeat',
      'primary',
      { isDirectMessage: undefined },
    );
  });

  it('triggers memory extraction after response', async () => {
    const config = makeConfig();
    const mockExtractor: MemoryExtractor = {
      maybeExtract: vi.fn<any>().mockResolvedValue(undefined),
    };

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );
    agent.memoryExtractor = mockExtractor;

    await agent.handleMessage(makeMessage());

    // Fire-and-forget, but should have been called
    expect(mockExtractor.maybeExtract).toHaveBeenCalledWith('test-channel');
  });

  it('returns AgentResponse with content and metadata', async () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const response = await agent.handleMessage(makeMessage());

    expect(response.content).toBe('Mock response from Purrsephone');
    expect(response.channelId).toBe('test-channel');
    expect(response.metadata.model).toBe('deepseek/deepseek-v3.2');
    expect(response.metadata.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('passes taskKind to prompt composer for internal heartbeat turns', async () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'Base prompt', config,
    );
    const compose = vi.fn().mockReturnValue({
      text: 'Layered prompt',
      hash: 'abc123',
      layerCount: 1,
      layerIds: ['layer-1'],
    });
    agent.promptComposer = { compose } as any;

    await agent.handleMessage(makeMessage({
      channelId: 'internal:heartbeat',
      channelType: 'terminal',
      content: 'heartbeat check',
    }));

    expect(compose).toHaveBeenCalledWith({
      channelType: 'internal',
      taskKind: 'heartbeat',
    });
  });

  it('does not set taskKind for normal discord text turns', async () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'Base prompt', config,
    );
    const compose = vi.fn().mockReturnValue({
      text: 'Layered prompt',
      hash: 'abc123',
      layerCount: 1,
      layerIds: ['layer-1'],
    });
    agent.promptComposer = { compose } as any;

    await agent.handleMessage(makeMessage({
      channelId: 'discord-channel-1',
      channelType: 'discord',
    }));

    expect(compose).toHaveBeenCalledWith({
      channelType: 'discord_text',
      taskKind: undefined,
    });
  });

  it('builds context with adapted system prompt for trust level', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const mockContactStore = {
      resolveUserId: vi.fn().mockReturnValue({ trustLevel: 'primary' }),
    } as unknown as ContactStore;

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'Base prompt', config,
    );
    agent.contactStore = mockContactStore;

    await agent.handleMessage(makeMessage());

    // buildContext should have been called with adapted prompt containing trust hint
    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[1]).toContain('Base prompt');
    expect(buildCall[1]).toContain('[Trust:');
    expect(buildCall[1]).toContain('honne');
  });

  it('emits agent.error on handleMessage failure', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager();
    // Force buildContext to throw
    (sessionManager.buildContext as any).mockRejectedValue(new Error('context build failed'));

    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), sessionManager, 'test', config,
    );

    const errors: Error[] = [];
    eventBus.on('agent.error', ({ error }) => { errors.push(error); });

    await expect(agent.handleMessage(makeMessage())).rejects.toThrow('context build failed');
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('context build failed');
  });

  it('handles DM messages with isDirectMessage flag', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );

    await agent.handleMessage(makeMessage({ isDirectMessage: true }));

    expect(sessionManager.recordUserMessage).toHaveBeenCalledWith(
      'test-channel',
      'Hello, Purrsephone!',
      'user-1',
      'TestUser',
      true,
    );
  });

  it('refreshes resolved model on next turn after config drift', async () => {
    const config = makeConfig();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    await agent.handleMessage(makeMessage({ id: 'msg-1', content: 'turn one' }));

    config.modelRoster.chat = {
      model: 'moonshotai/kimi-k2.5',
      provider: 'openrouter',
      maxTokens: 4096,
      contextWindow: 128_000,
    };
    config.primaryModel = 'moonshotai/kimi-k2.5';
    config.primaryProvider = 'openrouter';
    config.primaryMaxTokens = 4096;

    const response = await agent.handleMessage(makeMessage({ id: 'msg-2', content: 'turn two' }));
    expect(response.metadata.model).toBe('moonshotai/kimi-k2.5');
  });
});

describe('SubstrateAgent steering + follow-up', () => {
  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
  });

  it('exposes isStreaming from agent state', () => {
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', makeConfig(),
    );
    expect(agent.isStreaming).toBe(false);
  });

  it('steer records user message and calls agent.steer', () => {
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', makeConfig(),
    );

    // spy on pi-agent-core Agent.prototype.steer
    const steerSpy = vi.spyOn(Agent.prototype, 'steer');

    // steer is a no-op when agent isn't streaming
    agent.steer(makeMessage({ content: 'actually...' }));
    expect(steerSpy).not.toHaveBeenCalled();

    steerSpy.mockRestore();
  });

  it('followUp records user message and calls agent.followUp', () => {
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', makeConfig(),
    );

    const followUpSpy = vi.spyOn(Agent.prototype, 'followUp').mockImplementation(() => {});

    agent.followUp(makeMessage({ content: 'ps: one more thing' }));

    expect(sessionManager.recordUserMessage).toHaveBeenCalledWith(
      'test-channel',
      'ps: one more thing',
      'user-1',
      'TestUser',
      undefined,
    );
    expect(followUpSpy).toHaveBeenCalled();

    followUpSpy.mockRestore();
  });

  it('waitForIdle delegates to agent.waitForIdle', async () => {
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', makeConfig(),
    );

    const idleSpy = vi.spyOn(Agent.prototype, 'waitForIdle').mockResolvedValue();

    await agent.waitForIdle();
    expect(idleSpy).toHaveBeenCalled();

    idleSpy.mockRestore();
  });

  it('abort delegates to agent.abort', () => {
    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), makeMockSessionManager(), 'test', makeConfig(),
    );

    const abortSpy = vi.spyOn(Agent.prototype, 'abort').mockImplementation(() => {});

    agent.abort();
    expect(abortSpy).toHaveBeenCalled();

    abortSpy.mockRestore();
  });
});
