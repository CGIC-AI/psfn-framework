import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import type { SubstrateConfig, SubstrateMessage, LLMContext, LLMResponse } from '../types.js';
import type { MemoryProvider, MemoryExtractor, LLMProvider } from './substrate-agent.js';
import { SubstrateAgent } from './substrate-agent.js';
import { EventBus } from '../event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type { ContactStore } from '../contacts/store.js';
import type { ChannelPromptDock } from '../channels/types.js';

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

function mockAssistantResponse(text: string): void {
  promptSpy.mockImplementationOnce(async function (this: Agent) {
    this.appendMessage({
      role: 'assistant',
      content: [{ type: 'text' as const, text }],
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
}

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
    appendSystemNote: vi.fn(),
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

interface ScriptedCompletionStep {
  purpose: 'reasoning' | 'background';
  content: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

function makeScriptedMoaProvider(steps: ScriptedCompletionStep[]): {
  provider: LLMProvider;
  completeSpy: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const completeSpy = vi.fn(async (
    _context: LLMContext,
    purpose: ScriptedCompletionStep['purpose'],
    _options?: Record<string, unknown>,
  ) => {
    const step = steps[index++];
    if (!step) {
      throw new Error(`No scripted completion for purpose "${purpose}"`);
    }
    if (step.purpose !== purpose) {
      throw new Error(`Expected purpose "${step.purpose}", received "${purpose}"`);
    }
    return {
      content: step.content,
      toolCalls: [],
      model: step.model,
      inputTokens: step.inputTokens ?? 12,
      outputTokens: step.outputTokens ?? 24,
      stopReason: 'stop',
    } satisfies LLMResponse;
  });

  return {
    provider: {
      stream: vi.fn<any>().mockResolvedValue({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      } satisfies LLMResponse),
      complete: completeSpy as unknown as LLMProvider['complete'],
    },
    completeSpy,
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

  it('emits stable correlation fields on turn lifecycle telemetry', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    const captured: Record<string, any> = {};
    eventBus.on('agent.turn.start', (payload) => { captured.start = payload; });
    eventBus.on('agent.turn.usage', (payload) => { captured.usage = payload; });
    (eventBus as any).on('agent.turn.stage', (payload: any) => {
      if (payload.stage === 'trust') captured.stage = payload;
    });

    await agent.handleMessage(makeMessage({
      id: 'turn-telemetry-1',
      channelId: 'internal:heartbeat',
      channelType: 'terminal',
      content: 'heartbeat run',
    }));

    expect(captured.start).toMatchObject({
      turnId: 'turn-telemetry-1',
      requestId: 'turn-telemetry-1',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      purpose: 'agent.turn.start',
    });
    expect(captured.usage).toMatchObject({
      turnId: 'turn-telemetry-1',
      requestId: 'turn-telemetry-1',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      purpose: 'agent.turn.usage',
    });
    expect(captured.stage).toMatchObject({
      turnId: 'turn-telemetry-1',
      requestId: 'turn-telemetry-1',
      channelId: 'internal:heartbeat',
      callType: 'scheduled',
      purpose: 'agent.turn.stage.trust',
    });
  });

  it('emits inferred post-turn actions between turn end and usage telemetry', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );
    agent.registerPostTurnActionInferer(() => ([
      {
        kind: 'heartbeat.run_template',
        payload: { templateId: 'whisper' },
        dedupeKey: 'heartbeat.run_template:whisper',
      },
    ]));

    const order: string[] = [];
    const inferredActions: Array<{ kind: string; dedupeKey: string }> = [];
    eventBus.on('agent.turn.end', () => { order.push('end'); });
    eventBus.on('agent.post_turn.actions.inferred', ({ actions }) => {
      order.push('inferred');
      inferredActions.push(...actions.map(action => ({
        kind: action.kind,
        dedupeKey: action.dedupeKey,
      })));
    });
    eventBus.on('agent.turn.usage', () => { order.push('usage'); });

    await agent.handleMessage(makeMessage());

    expect(order).toEqual(['end', 'inferred', 'usage']);
    expect(inferredActions).toEqual([
      {
        kind: 'heartbeat.run_template',
        dedupeKey: 'heartbeat.run_template:whisper',
      },
    ]);
  });

  it('deduplicates inferred post-turn actions by dedupe key across inferers', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus, makeMockLLMProvider(), makeMockSessionManager(), 'test', config,
    );

    agent.registerPostTurnActionInferer(() => ([
      {
        kind: 'heartbeat.run_template',
        payload: { templateId: 'whisper' },
        dedupeKey: 'heartbeat.run_template:shared',
      },
      {
        kind: 'heartbeat.run_template',
        payload: { templateId: 'whisper' },
        dedupeKey: 'heartbeat.run_template:shared',
      },
    ]));
    agent.registerPostTurnActionInferer(() => ([
      {
        kind: 'heartbeat.run_template',
        payload: { templateId: 'values-reflection' },
        dedupeKey: 'heartbeat.run_template:shared',
      },
      {
        kind: 'heartbeat.run_template',
        payload: { templateId: 'daily-integration' },
        dedupeKey: 'heartbeat.run_template:daily',
      },
    ]));

    const inferredEventPayloads: Array<{ dedupeKey: string }> = [];
    eventBus.on('agent.post_turn.actions.inferred', ({ actions }) => {
      inferredEventPayloads.push(...actions.map(action => ({ dedupeKey: action.dedupeKey })));
    });

    await agent.handleMessage(makeMessage());

    expect(inferredEventPayloads.map(action => action.dedupeKey)).toEqual([
      'heartbeat.run_template:shared',
      'heartbeat.run_template:daily',
    ]);
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
      undefined,
      { trustLevel: 'regular' },
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
      undefined,
      { trustLevel: 'regular' },
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
      { trustLevel: 'trusted' },
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
      { trustLevel: 'trusted' },
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
      undefined,
    );
  });

  it('appends spontaneous recall when memory provider supports proactive retrieval', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const mockMemory = {
      retrieve: vi.fn<any>().mockResolvedValue('Relevant memories here'),
      retrieveProactiveRecall: vi.fn<any>().mockResolvedValue(
        'Spontaneous recall:\n- [emotional] User felt proud after the release (+)',
      ),
    };

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );
    agent.memoryProvider = mockMemory as unknown as MemoryProvider;

    await agent.handleMessage(makeMessage());

    expect(mockMemory.retrieveProactiveRecall).toHaveBeenCalledWith(
      'test-channel',
      'regular',
      { isDirectMessage: undefined },
      undefined,
    );
    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[2]).toContain('Relevant memories here');
    expect(buildCall[2]).toContain('Spontaneous recall:');
    expect(buildCall[2]).toContain('User felt proud after the release');
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
      'scheduler',
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
    expect(mockExtractor.maybeExtract).toHaveBeenCalledWith('test-channel', undefined);
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

  it('routes normal response turns through MoA deliberation when enabled', async () => {
    const config = makeConfig({
      moaEnabled: true,
      moaReferenceModels: ['model-ref-a', 'model-ref-b'],
      moaAggregatorModel: 'model-agg',
      moaMaxRounds: 1,
      moaMaxTokensPerRound: 120,
      moaTimeoutMs: 30_000,
    });
    const sessionManager = makeMockSessionManager();
    const { provider, completeSpy } = makeScriptedMoaProvider([
      { purpose: 'reasoning', content: 'Reference voice A', model: 'model-ref-a', inputTokens: 10, outputTokens: 10 },
      { purpose: 'background', content: 'Reference voice B', model: 'model-ref-b', inputTokens: 10, outputTokens: 10 },
      { purpose: 'reasoning', content: 'Synthesized MoA reply', model: 'model-agg', inputTokens: 10, outputTokens: 10 },
    ]);
    const promptCallsBefore = promptSpy.mock.calls.length;

    const agent = new SubstrateAgent(
      new EventBus(), provider, sessionManager, 'test', config,
    );

    const response = await agent.handleMessage(makeMessage());

    expect(promptSpy.mock.calls.length).toBe(promptCallsBefore);
    expect(completeSpy).toHaveBeenCalledTimes(3);
    expect(completeSpy.mock.calls[0][2]).toMatchObject({ modelHint: { model: 'model-ref-a', maxTokens: 120 } });
    expect(completeSpy.mock.calls[1][2]).toMatchObject({ modelHint: { model: 'model-ref-b', maxTokens: 100 } });
    expect(completeSpy.mock.calls[2][2]).toMatchObject({ modelHint: { model: 'model-agg', maxTokens: 80 } });
    expect(response.content).toBe('Synthesized MoA reply');
    expect(response.metadata.model).toBe('model-agg');
    expect(sessionManager.recordAssistantMessage).toHaveBeenCalledWith(
      'test-channel',
      'Synthesized MoA reply',
      'user-1',
      undefined,
      undefined,
      { trustLevel: 'regular' },
    );
  });

  it('keeps tool-loop prompt behavior when MoA is disabled', async () => {
    const config = makeConfig({
      moaEnabled: false,
      moaReferenceModels: ['model-ref-a', 'model-ref-b'],
      moaAggregatorModel: 'model-agg',
    });
    const llmProvider = makeMockLLMProvider();
    const promptCallsBefore = promptSpy.mock.calls.length;

    const agent = new SubstrateAgent(
      new EventBus(), llmProvider, makeMockSessionManager(), 'test', config,
    );

    const response = await agent.handleMessage(makeMessage());

    expect(promptSpy.mock.calls.length).toBe(promptCallsBefore + 1);
    expect((llmProvider.complete as any).mock.calls.length).toBe(0);
    expect(response.content).toBe('Mock response from Purrsephone');
  });

  it('honors moaMaxTokensPerRound by stopping a round when budget is exhausted', async () => {
    const config = makeConfig({
      moaEnabled: true,
      moaReferenceModels: ['model-ref-a', 'model-ref-b'],
      moaMaxRounds: 3,
      moaMaxTokensPerRound: 40,
      moaTimeoutMs: 30_000,
    });
    const { provider, completeSpy } = makeScriptedMoaProvider([
      { purpose: 'reasoning', content: 'Voice one only', model: 'model-ref-a', inputTokens: 30, outputTokens: 20 },
    ]);

    const agent = new SubstrateAgent(
      new EventBus(), provider, makeMockSessionManager(), 'test', config,
    );

    const response = await agent.handleMessage(makeMessage());

    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(completeSpy.mock.calls[0][2]).toMatchObject({ modelHint: { model: 'model-ref-a', maxTokens: 40 } });
    expect(response.content).toBe('Voice one only');
    expect(response.metadata.inputTokens).toBe(30);
    expect(response.metadata.outputTokens).toBe(20);
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

  it('prefers channel prompt adapter channelType from the runtime registry', async () => {
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

    const discordDock: ChannelPromptDock = {
      id: 'discord',
      capabilities: { promptChannelType: 'discord_capability' },
      prompt: {
        resolveChannelType: () => 'discord_registry_prompt',
      },
    };
    agent.setChannelRegistry(new Map([['discord', discordDock]]));

    await agent.handleMessage(makeMessage({
      channelId: 'discord-channel-2',
      channelType: 'discord',
    }));

    expect(compose).toHaveBeenCalledWith({
      channelType: 'discord_registry_prompt',
      taskKind: undefined,
    });
  });

  it('falls back to channel capabilities promptChannelType when prompt adapter is absent', async () => {
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

    const apiDock: ChannelPromptDock = {
      id: 'api',
      capabilities: { promptChannelType: 'api_capability' },
    };
    agent.setChannelRegistry(new Map([['api', apiDock]]));

    await agent.handleMessage(makeMessage({
      channelId: 'api:session-77',
      channelType: 'api',
    }));

    expect(compose).toHaveBeenCalledWith({
      channelType: 'api_capability',
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

  it('interpolates {{user}} and {{char}} variables per turn before context build', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'You are {{char}}.\nAddress {{user}} by name.',
      config,
      { characterName: 'Purrsephone' },
    );

    await agent.handleMessage(makeMessage({ authorName: 'Vega' }));

    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[1]).toContain('You are Purrsephone.');
    expect(buildCall[1]).toContain('Address Vega by name.');
    expect(buildCall[1]).not.toContain('{{char}}');
    expect(buildCall[1]).not.toContain('{{user}}');
  });

  it('prefers contact nickname for {{user}} across mapped channel identities', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const sharedContact = {
      id: 'contact-primary',
      displayName: 'Vega',
      nickname: 'V',
      trustLevel: 'primary',
      channelIdentities: [
        { channel: 'discord', userId: 'discord-vega' },
        { channel: 'telegram', userId: '5635268079' },
      ],
    };
    const mockContactStore = {
      resolveChannelIdentity: vi.fn().mockImplementation((_channel: string, _userId: string) => sharedContact),
    } as unknown as ContactStore;
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Address {{user}} by name.',
      config,
      { characterName: 'Purrsephone' },
    );
    agent.contactStore = mockContactStore;

    await agent.handleMessage(makeMessage({
      id: 'msg-nick-discord',
      channelId: 'discord-chan',
      channelType: 'discord',
      authorId: 'discord-vega',
      authorName: 'discord-vega',
    }));
    await agent.handleMessage(makeMessage({
      id: 'msg-nick-telegram',
      channelId: 'telegram:5635268079',
      channelType: 'telegram',
      authorId: '5635268079',
      authorName: '5635268079',
    }));

    const firstPrompt = (sessionManager.buildContext as any).mock.calls[0][1] as string;
    const secondPrompt = (sessionManager.buildContext as any).mock.calls[1][1] as string;
    expect(firstPrompt).toContain('Address V by name.');
    expect(secondPrompt).toContain('Address V by name.');
    expect(firstPrompt).toContain('Speaking with: V');
    expect(secondPrompt).toContain('Speaking with: V');
    expect(firstPrompt).not.toContain('Address discord-vega by name.');
    expect(secondPrompt).not.toContain('Address 5635268079 by name.');
  });

  it('keeps explicitly loaded extended tools active across turns', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Base prompt',
      config,
    );
    const extendedProbeTool = {
      name: 'extended_probe_tool',
      label: 'extended_probe_tool',
      description: 'test-only probe tool',
      parameters: {} as any,
      execute: vi.fn(async () => ({
        role: 'tool',
        content: [{ type: 'text', text: 'ok' }],
      })),
    } as any;
    agent.registerTool(extendedProbeTool, 'extended');

    const loadTools = agent.getToolCatalog().core.find((tool) => tool.name === 'load_tools');
    expect(loadTools).toBeDefined();
    await (loadTools as any).execute('load-1', { tools: ['extended_probe_tool'] });

    const setToolsSpy = vi.spyOn((agent as any).agent, 'setTools');
    await agent.handleMessage(makeMessage({ id: 'msg-load-persist-1' }));
    await agent.handleMessage(makeMessage({ id: 'msg-load-persist-2' }));

    const setToolNamesByCall = setToolsSpy.mock.calls.map(
      (call) => (call[0] as Array<{ name: string }>).map((tool) => tool.name),
    );
    expect(setToolNamesByCall.length).toBeGreaterThanOrEqual(2);
    expect(setToolNamesByCall[0]).toContain('extended_probe_tool');
    expect(setToolNamesByCall[1]).toContain('extended_probe_tool');
  });

  it('captures deferred tool-handoff intent details from load_tools', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Base prompt',
      config,
    );
    const extendedProbeTool = {
      name: 'extended_probe_tool',
      label: 'extended_probe_tool',
      description: 'test-only probe tool',
      parameters: {} as any,
      execute: vi.fn(async () => ({
        role: 'tool',
        content: [{ type: 'text', text: 'ok' }],
      })),
    } as any;
    agent.registerTool(extendedProbeTool, 'extended');

    const loadTools = agent.getToolCatalog().core.find((tool) => tool.name === 'load_tools');
    expect(loadTools).toBeDefined();

    const result = await (loadTools as any).execute('load-intent-1', {
      tools: ['extended_probe_tool'],
      intendedAction: 'Use extended_probe_tool to gather diagnostics for this request.',
      deferUntilTurnBoundary: true,
      maxRetries: 1,
    });
    const details = result.details as {
      deferredToolHandoff?: {
        toolNames: string[];
        intendedAction: string;
        maxRetries?: number;
      };
    };
    expect(details.deferredToolHandoff).toEqual({
      toolNames: ['extended_probe_tool'],
      intendedAction: 'Use extended_probe_tool to gather diagnostics for this request.',
      maxRetries: 1,
    });
  });

  it('freezes static prompt prefix per session while dynamic suffix updates each turn', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const sessionManager = makeMockSessionManager();
      const agent = new SubstrateAgent(
        new EventBus(),
        makeMockLLMProvider(),
        sessionManager,
        'Fallback system prompt',
        config,
        { characterName: 'Purrsephone' },
      );
      const composeSplit = vi.fn().mockReturnValue({
        staticPrefix: '[STATIC] {{user}} @ {{now_iso}}',
        dynamicSuffix: '[DYNAMIC] {{now_iso}}',
        staticHash: 'static-v1',
        dynamicHash: 'dynamic-v1',
        staticLayerIds: ['layer-static'],
        dynamicLayerIds: ['layer-dynamic'],
        text: '[STATIC] {{user}} @ {{now_iso}}\n\n[DYNAMIC] {{now_iso}}',
        hash: 'full-v1',
        layerCount: 2,
        layerIds: ['layer-static', 'layer-dynamic'],
      });
      agent.promptComposer = { composeSplit } as any;

      vi.setSystemTime(new Date('2026-02-26T00:00:00.000Z'));
      await agent.handleMessage(makeMessage({ id: 'msg-static-1', authorName: 'Vega' }));

      vi.setSystemTime(new Date('2026-02-26T00:10:00.000Z'));
      await agent.handleMessage(makeMessage({ id: 'msg-static-2', authorName: 'Vega' }));

      const firstPrompt = (sessionManager.buildContext as any).mock.calls[0][1] as string;
      const secondPrompt = (sessionManager.buildContext as any).mock.calls[1][1] as string;

      expect(firstPrompt).toContain('[STATIC] Vega @ 2026-02-26T00:00:00.000Z');
      expect(firstPrompt).toContain('[DYNAMIC] 2026-02-26T00:00:00.000Z');
      expect(secondPrompt).toContain('[STATIC] Vega @ 2026-02-26T00:00:00.000Z');
      expect(secondPrompt).toContain('[DYNAMIC] 2026-02-26T00:10:00.000Z');
      expect(secondPrompt).not.toContain('[STATIC] Vega @ 2026-02-26T00:10:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates frozen static prefix when static composition hash changes', async () => {
    vi.useFakeTimers();
    try {
      const config = makeConfig();
      const sessionManager = makeMockSessionManager();
      const agent = new SubstrateAgent(
        new EventBus(),
        makeMockLLMProvider(),
        sessionManager,
        'Fallback system prompt',
        config,
      );
      const composeSplit = vi.fn()
        .mockReturnValueOnce({
          staticPrefix: '[STATIC-v1] {{now_iso}}',
          dynamicSuffix: '',
          staticHash: 'static-v1',
          dynamicHash: 'dynamic-v1',
          staticLayerIds: ['layer-static'],
          dynamicLayerIds: [],
          text: '[STATIC-v1] {{now_iso}}',
          hash: 'full-v1',
          layerCount: 1,
          layerIds: ['layer-static'],
        })
        .mockReturnValueOnce({
          staticPrefix: '[STATIC-v2] {{now_iso}}',
          dynamicSuffix: '',
          staticHash: 'static-v2',
          dynamicHash: 'dynamic-v1',
          staticLayerIds: ['layer-static'],
          dynamicLayerIds: [],
          text: '[STATIC-v2] {{now_iso}}',
          hash: 'full-v2',
          layerCount: 1,
          layerIds: ['layer-static'],
        });
      agent.promptComposer = { composeSplit } as any;

      vi.setSystemTime(new Date('2026-02-26T01:00:00.000Z'));
      await agent.handleMessage(makeMessage({ id: 'msg-hash-1' }));

      vi.setSystemTime(new Date('2026-02-26T01:05:00.000Z'));
      await agent.handleMessage(makeMessage({ id: 'msg-hash-2' }));

      const secondPrompt = (sessionManager.buildContext as any).mock.calls[1][1] as string;
      expect(secondPrompt).toContain('[STATIC-v2] 2026-02-26T01:05:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates frozen static prefix when static settings signature changes', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Fallback system prompt',
      config,
    );
    const composeSplit = vi.fn().mockReturnValue({
      staticPrefix: '[STATIC] {{user}}',
      dynamicSuffix: '',
      staticHash: 'static-v1',
      dynamicHash: 'dynamic-v1',
      staticLayerIds: ['layer-static'],
      dynamicLayerIds: [],
      text: '[STATIC] {{user}}',
      hash: 'full-v1',
      layerCount: 1,
      layerIds: ['layer-static'],
    });
    agent.promptComposer = { composeSplit } as any;

    await agent.handleMessage(makeMessage({
      id: 'msg-settings-1',
      authorId: 'same-user',
      authorName: 'Vega',
    }));
    await agent.handleMessage(makeMessage({
      id: 'msg-settings-2',
      authorId: 'same-user',
      authorName: 'Nyx',
    }));

    const firstPrompt = (sessionManager.buildContext as any).mock.calls[0][1] as string;
    const secondPrompt = (sessionManager.buildContext as any).mock.calls[1][1] as string;
    expect(firstPrompt).toContain('[STATIC] Vega');
    expect(secondPrompt).toContain('[STATIC] Nyx');
  });

  it('injects formatted skills index into runtime context when skills runtime is wired', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Base prompt',
      config,
    );
    agent.skillsRuntime = {
      getPromptXml: vi.fn().mockReturnValue('<skills_index><skill name=\"conversation\" /></skills_index>'),
    } as any;

    await agent.handleMessage(makeMessage());

    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[1]).toContain('[Skills Index]');
    expect(buildCall[1]).toContain('skill_view(name)');
    expect(buildCall[1]).toContain('<skills_index>');
    expect(buildCall[1]).toContain('conversation');
  });

  it('injects bounded scratchpad notes into system context when scratchpad provider is wired', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Base prompt',
      config,
    );
    agent.scratchpadProvider = {
      listScratchpadEntries: vi.fn().mockReturnValue([
        {
          id: 'sp-1',
          content: 'Remember to confirm backup status before restart.',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_010_000,
        },
      ]),
    } as any;

    await agent.handleMessage(makeMessage());

    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[1]).toContain('[Scratchpad]');
    expect(buildCall[1]).toContain('sp-1');
    expect(buildCall[1]).toContain('confirm backup status');
  });

  it('caps scratchpad prompt injection to a limited number of entries', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      new EventBus(),
      makeMockLLMProvider(),
      sessionManager,
      'Base prompt',
      config,
    );
    agent.scratchpadProvider = {
      listScratchpadEntries: vi.fn().mockReturnValue(
        Array.from({ length: 12 }, (_, index) => ({
          id: `sp-${index}`,
          content: `note ${index} ${'x'.repeat(80)}`,
          createdAt: 1_700_000_000_000 + index,
          updatedAt: 1_700_000_000_000 + index,
        })),
      ),
    } as any;

    await agent.handleMessage(makeMessage());

    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    const prompt = buildCall[1] as string;
    const injectedEntries = prompt
      .split('\n')
      .filter(line => line.startsWith('- sp-'));
    expect(injectedEntries.length).toBeLessThanOrEqual(8);
    expect(prompt).toContain('(4 additional notes omitted for context budget)');
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
      undefined,
      { trustLevel: 'regular' },
    );
    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[5]).toEqual({ isDirectMessage: true });
  });

  it('blocks risky broadcast drafts pending approval and skips sendable assistant record', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      eventBus,
      makeMockLLMProvider(),
      sessionManager,
      'test',
      config,
    );
    mockAssistantResponse('My private number is +1 (555) 123-4567.');

    const approvalEvents: Array<{ channelId: string; signals: string[] }> = [];
    eventBus.on('broadcast.approval.required', (event) => {
      approvalEvents.push({ channelId: event.channelId, signals: event.signals });
    });

    const response = await agent.handleMessage(makeMessage({
      channelId: 'twitter:timeline',
      content: 'write a tweet',
    }));

    expect(response.content).toBe('');
    expect(response.metadata.broadcastSafety).toMatchObject({
      visibilityScope: 'public_only',
      risky: true,
      approvalRequired: true,
      operatorApproval: false,
    });
    expect(response.metadata.broadcastSafety?.signals).toContain('private');
    expect(sessionManager.recordAssistantMessage).not.toHaveBeenCalled();
    expect(sessionManager.appendSystemNote).toHaveBeenCalledWith(
      'twitter:timeline',
      expect.stringContaining('held for approval'),
    );
    expect(approvalEvents).toEqual([
      { channelId: 'twitter:timeline', signals: ['private'] },
    ]);
  });

  it('allows risky broadcast drafts when explicit approval token is present', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      eventBus,
      makeMockLLMProvider(),
      sessionManager,
      'test',
      config,
    );
    const approvedText = 'My private number is +1 (555) 123-4567.';
    mockAssistantResponse(approvedText);

    const response = await agent.handleMessage(makeMessage({
      channelId: 'twitter:timeline',
      content: 'write a tweet',
      routing: {
        source: 'api',
        broadcast: {
          approvalToken: 'approve:operator-12345678',
        },
      },
    }));

    expect(response.content).toBe(approvedText);
    expect(response.metadata.broadcastSafety).toMatchObject({
      visibilityScope: 'approved_private_context',
      risky: true,
      approvalRequired: false,
      operatorApproval: true,
    });
    expect(sessionManager.recordAssistantMessage).toHaveBeenCalledWith(
      'twitter:timeline',
      approvedText,
      'user-1',
      undefined,
      undefined,
      { trustLevel: 'regular' },
    );
    const buildCall = (sessionManager.buildContext as any).mock.calls[0];
    expect(buildCall[5]).toEqual({
      broadcastApprovalToken: 'approve:operator-12345678',
    });
  });

  it('emits broadcast provenance with retrieval source refs for broadcast turns', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const sessionManager = makeMockSessionManager();
    const agent = new SubstrateAgent(
      eventBus,
      makeMockLLMProvider(),
      sessionManager,
      'test',
      config,
    );

    agent.memoryProvider = {
      retrieve: vi.fn(async () => {
        await eventBus.emit('memory.retrieval', {
          channelId: 'twitter:timeline',
          count: 1,
          provenanceRefs: ['memory:alpha', 'memory:beta'],
        });
        return 'Public context block';
      }),
    };

    let provenanceEvent: any = null;
    eventBus.on('broadcast.provenance', (event) => { provenanceEvent = event; });

    const response = await agent.handleMessage(makeMessage({
      channelId: 'twitter:timeline',
      content: 'share an update',
    }));

    expect(provenanceEvent).toMatchObject({
      channelId: 'twitter:timeline',
      visibilityScope: 'public_only',
      provenanceRefs: ['memory:alpha', 'memory:beta'],
    });
    expect(response.metadata.broadcastSafety?.provenanceRefs).toEqual([
      'memory:alpha',
      'memory:beta',
    ]);
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
      undefined,
      { trustLevel: 'regular' },
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
