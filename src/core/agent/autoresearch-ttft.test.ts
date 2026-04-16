import { describe, it, vi, beforeEach, afterEach } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import { SubstrateAgent } from './substrate-agent.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type { LLMProviderPort, LLMResponse } from './substrate-agent.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';

const TEST_SYSTEM_PROMPT = 'You are Companion.';
const TEST_ASSISTANT_RESPONSE = 'Mock response from Companion';

function makeConfig(): SubstrateConfig {
  return {
    companionId: 'test-companion',
    companionName: 'Companion',
    primaryProvider: 'openrouter',
    primaryMaxTokens: 1024,
    defaultContextWindow: 128_000,
    dataDir: '/tmp/psfn-autoresearch-data',
    modelRoster: {
      chat: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2', maxTokens: 1024, contextWindow: 128_000 },
    },
    modelRegistry: {
      version: 1,
      models: [
        {
          id: 'deepseek-v3.2',
          identity: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
          rank: 1,
          purposes: [{ purpose: 'chat', primary: true }],
          capabilities: { contextWindow: 128_000, maxOutputTokens: 1024 },
        },
      ],
    },
    credentialVault: { get: () => 'fake-key' },
    capabilityTier: 'standard',
    responseStyleOverrides: {},
    openRouterProviderOrder: [],
    observationMaskingWindow: 0,
    compactionThresholdPct: 80,
    continuityMessageLimit: 0,
    defaultTrustLevel: 'regular',
    channels: {},
    skills: {},
    scheduler: {},
    trustPolicy: {},
    runtimeHooks: {},
  } as unknown as SubstrateConfig;
}

function makeMessage(overrides?: Partial<SubstrateMessage>): SubstrateMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2)}`,
    channelId: 'test-channel',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Hello there',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeMockSessionManager(): SessionManager {
  return {
    recordUserMessage: vi.fn().mockReturnValue(101),
    recordToolObservation: vi.fn().mockReturnValue(102),
    recordAssistantMessage: vi.fn().mockReturnValue(102),
    recordSystemMessage: vi.fn().mockReturnValue(103),
    recordTurn: vi.fn(),
    appendSystemNote: vi.fn(),
    awaitPendingAutoCompaction: vi.fn().mockResolvedValue(undefined),
    scheduleAutoCompactionBetweenTurns: vi.fn().mockResolvedValue(undefined),
    buildContext: vi.fn().mockResolvedValue({
      systemPrompt: TEST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
    getRecentMessages: vi.fn().mockReturnValue([]),
    getRoleEnvelopeRefsForEntries: vi.fn().mockReturnValue([]),
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
    getActiveFocusMemoryScopeQuery: vi.fn().mockReturnValue(null),
    setActiveContextSession: vi.fn(),
    getActiveContextSession: vi.fn().mockReturnValue(null),
    continuityStore: null,
  } as unknown as SessionManager;
}

function makeMockLLMProvider(): LLMProviderPort {
  const response: LLMResponse = {
    content: TEST_ASSISTANT_RESPONSE,
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

describe('TTFT benchmark', () => {
  let promptSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
      // Simulate immediate assistant response append so extractResponseText works
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'text' as const, text: TEST_ASSISTANT_RESPONSE }],
        api: '',
        provider: '',
        model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as any,
        timestamp: Date.now(),
      });
    });
  });

  afterEach(() => {
    promptSpy.mockRestore();
  });

  it('measures median handleMessage latency', async () => {
    const config = makeConfig();
    const eventBus = new EventBus();
    const agent = new SubstrateAgent(
      eventBus,
      makeMockLLMProvider(),
      makeMockSessionManager(),
      TEST_SYSTEM_PROMPT,
      config,
    );

    const WARMUP = 20;
    const RUNS = 100;
    const times: number[] = [];

    // Warmup
    for (let i = 0; i < WARMUP; i++) {
      await agent.handleMessage(makeMessage());
    }

    // Measured runs
    for (let i = 0; i < RUNS; i++) {
      const start = performance.now();
      await agent.handleMessage(makeMessage());
      const end = performance.now();
      times.push(end - start);
    }

    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const p90 = times[Math.floor(times.length * 0.9)];
    const min = times[0];

    // eslint-disable-next-line no-console
    console.log(`METRIC median_turn_ms=${median.toFixed(3)}`);
    // eslint-disable-next-line no-console
    console.log(`METRIC p90_turn_ms=${p90.toFixed(3)}`);
    // eslint-disable-next-line no-console
    console.log(`METRIC min_turn_ms=${min.toFixed(3)}`);
  });
});
