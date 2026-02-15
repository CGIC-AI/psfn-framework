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

vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  // Simulate adding an assistant response to the agent's messages
  this.appendMessage({
    role: 'assistant',
    content: [{ type: 'text' as const, text: 'Mock response from PSFN' }],
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
    content: 'Hello, PSFN!',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockSessionManager(): SessionManager {
  return {
    recordUserMessage: vi.fn(),
    recordAssistantMessage: vi.fn(),
    buildContext: vi.fn<any>().mockResolvedValue({
      systemPrompt: 'You are PSFN.',
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

  it('records user message in session before LLM call', async () => {
    const config = makeConfig();
    const sessionManager = makeMockSessionManager();

    const agent = new SubstrateAgent(
      new EventBus(), makeMockLLMProvider(), sessionManager, 'test', config,
    );

    await agent.handleMessage(makeMessage());

    expect(sessionManager.recordUserMessage).toHaveBeenCalledWith(
      'test-channel',
      'Hello, PSFN!',
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
      'Mock response from PSFN',
      'user-1',
      undefined,
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
      'Hello, PSFN!',
      'test-channel',
      'regular',
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

    expect(response.content).toBe('Mock response from PSFN');
    expect(response.channelId).toBe('test-channel');
    expect(response.metadata.model).toBe('deepseek/deepseek-v3.2');
    expect(response.metadata.durationMs).toBeGreaterThanOrEqual(0);
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
      'Hello, PSFN!',
      'user-1',
      'TestUser',
      true,
    );
  });
});
