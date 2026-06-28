import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import {
  getRunChargeSnapshot,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import { buildFocusMemoryScopeQuery } from '../../core/session/focus-knowledge.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import { DEFAULT_SHARD_TOOLSET, ShardManager } from './manager.js';
import { ShardFoldReviewController } from './fold-review.js';
import { createBoundedSubagentLaunchTool } from './tools.js';
import type { SubagentExecutionPort } from '../../core/agent/substrate-agent/bounded-subagent-contract.js';
import type { LLMProviderPort, MemoryProvider } from '../../core/agent/contracts.js';
import type { ChargePolicyConfig } from '../../system/config/charge-policy-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMResponse } from '../../shared/contracts/runtime.js';
import { createTurnId } from '../../core/turns/id.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

// ── Mock pi-agent-core Agent ──
// We mock Agent.prototype.prompt so it doesn't actually call the LLM.
// Per-test customization via module-level variables.

let mockShardContent = 'shard response';
let mockShardDelayMs = 0;
let mockShardError: Error | null = null;

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  if (mockShardError) throw mockShardError;
  if (mockShardDelayMs > 0) await new Promise(r => setTimeout(r, mockShardDelayMs));
  this.appendMessage({
    role: 'assistant',
    content: [{ type: 'text' as const, text: mockShardContent }],
    api: '' as any,
    provider: '' as any,
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as any,
    timestamp: Date.now(),
  });
});

const setSystemPromptSpy = vi.spyOn(Agent.prototype, 'setSystemPrompt');
const setToolsSpy = vi.spyOn(Agent.prototype, 'setTools');

function restoreDefaultPromptMock(): void {
  promptSpy.mockImplementation(async function (this: Agent) {
    if (mockShardError) throw mockShardError;
    if (mockShardDelayMs > 0) await new Promise(r => setTimeout(r, mockShardDelayMs));
    this.appendMessage({
      role: 'assistant',
      content: [{ type: 'text' as const, text: mockShardContent }],
      api: '' as any,
      provider: '' as any,
      model: '',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop' as any,
      timestamp: Date.now(),
    });
  });
}

function makeTestTool(name: string) {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: `${name} ok` }],
    details: {},
  }));
  return {
    tool: {
      name,
      label: name,
      description: `${name} test tool`,
      parameters: Type.Object({}),
      execute,
    },
    execute,
  };
}

function lastSetToolNames(): string[] {
  const call = setToolsSpy.mock.calls.at(-1);
  if (!call) return [];
  const tools = call[0] as Array<{ name: string }>;
  return tools.map((tool) => tool.name);
}

// ── Fixtures ──

function mockLLM(): LLMProviderPort {
  const response: LLMResponse = {
    content: 'unused',
    toolCalls: [],
    model: 'mock-model',
    inputTokens: 10,
    outputTokens: 20,
    stopReason: 'stop',
  };
  return {
    stream: vi.fn(async () => response),
    complete: vi.fn(async () => response),
  };
}

function mockMemoryProvider(result = ''): MemoryProvider {
  return { retrieve: vi.fn(async () => result) };
}

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 100,
      background: 100,
      maintenance: 0,
      subagent: 100,
      shard: 100,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      analysisWorkbenchExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

const TEST_CONFIG: SubstrateConfig = {
  primaryModel: 'test-model',
  primaryProvider: 'test',
  extractionModel: 'test-model',
  extractionProvider: 'test',
  discordToken: '',
  discordBotId: '',
  characterCardPath: '',
  dataDir: './data',
  databasePath: ':memory:',
  sessionMessageLimit: 30,
  memoryRetrievalLimit: 15,
  extractionInterval: 5,
  primaryMaxTokens: 16384,
  extractionMaxTokens: 8192,
  maintenanceIntervalMs: 300_000,
  defaultContextWindow: 128_000,
  extractionThresholdPct: 30,
  compactionThresholdPct: 70,
  companionId: 'companion-test',
  characterName: 'Companion',
  modelRoster: {
    chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 128_000 },
  },
};

describe('ShardManager', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let eventBus: EventBus;

  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    dir = mkdtempSync(join(tmpdir(), 'psfn-shard-'));
    sessionStore = new SessionStore(dir);
    eventBus = new EventBus();
    // Reset per-test mock state
    mockShardContent = 'shard response';
    mockShardDelayMs = 0;
    mockShardError = null;
    promptSpy.mockClear();
    setSystemPromptSpy.mockClear();
    setToolsSpy.mockClear();
    restoreDefaultPromptMock();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRunChargeRollingWindowForTests();
  });

  it('spawns a shard and returns result', async () => {
    mockShardContent = 'Hello from shard';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({ name: 'test', task: 'Do something' });

    expect(result.name).toBe('test');
    expect(result.content).toBe('Hello from shard');
    expect(result.turns).toBe(1);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.shardId).toMatch(/^shard-/);
    expect(result.lineage).toEqual(expect.objectContaining({
      schemaVersion: 2,
      kind: 'spawn',
      coreCompanionId: 'companion-test',
      shardCompanionId: `companion-test::${result.shardId}`,
      shardId: result.shardId,
      shardChannelId: `shard:${result.shardId}`,
      companionProvenance: {
        parentCompanionId: 'companion-test',
        shardCompanionId: `companion-test::${result.shardId}`,
      },
      sourceMessage: expect.objectContaining({
        id: result.shardId,
        channelId: `shard:${result.shardId}`,
        channelType: 'api',
        authorId: 'companion-test',
        authorName: 'Companion',
        isDirectMessage: false,
      }),
      }));
  });

  it('caps explicit multi-turn shard requests at the shared agent loop ceiling', async () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({
      name: 'deep-shard',
      task: 'inspect until complete',
      maxTurns: 999,
    });

    expect(result.turns).toBe(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN);
    expect(promptSpy).toHaveBeenCalledTimes(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN);
  });

  it('charges bounded subagent launches and nested shard execution with lineage', async () => {
    mockShardContent = 'charged shard response';
    const chargeEvents: Array<Record<string, unknown>> = [];
    eventBus.on('agent.charge', (event) => {
      chargeEvents.push(event as unknown as Record<string, unknown>);
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        chargePolicy: makeChargePolicy(),
      },
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const parentSnapshot = await runWithRequestContext(
      {
        requestId: 'launch-request',
        turnId: 'turn-launch',
        channelId: 'api:launch',
        callType: 'tool',
        purpose: 'shard',
      } as any,
      async () => runWithChargeContext({
        chargePolicy: makeChargePolicy(),
        eventBus,
        lane: 'interactive',
        runId: 'launch-request',
      }, async () => {
        await manager.executeSubagent({
          name: 'launch-charge',
          task: 'Do charged work',
        });
        return getRunChargeSnapshot();
      }),
    );

    expect(chargeEvents.map((event) => event.surface)).toEqual([
      'subagentLaunch',
      'shardLaunch',
    ]);
    expect(chargeEvents[0].spentAfter).toBe(1);
    expect(chargeEvents[1].spentAfter).toBe(8);
    expect(chargeEvents[0].lineage).toEqual(expect.objectContaining({
      runId: 'launch-request',
      rootRunId: 'launch-request',
    }));
    expect(chargeEvents[1].lineage).toEqual(expect.objectContaining({
      runId: expect.stringMatching(/^shard-/),
      parentRunId: 'launch-request',
      rootRunId: 'launch-request',
    }));
    expect(parentSnapshot).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        interactive: 1,
        shard: 8,
      }),
      directSpentByLane: expect.objectContaining({
        interactive: 1,
      }),
      foldedSpentByLane: expect.objectContaining({
        shard: 8,
      }),
      foldBacks: [
        expect.objectContaining({
          disposition: 'folded',
          lineage: expect.objectContaining({
            runId: chargeEvents[1].lineage.runId,
            parentRunId: 'launch-request',
            rootRunId: 'launch-request',
          }),
          spentByLane: expect.objectContaining({
            shard: 8,
          }),
          directSpentByLane: expect.objectContaining({
            shard: 8,
          }),
        }),
      ],
      orphanedChildren: [],
      quotaSpentByLane: expect.objectContaining({
        interactive: 1,
        shard: 8,
      }),
    }));
  });

  it('folds completed shard spend back into the parent without double-counting follow-up spend', async () => {
    mockShardContent = 'fold child charge once';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        chargePolicy: makeChargePolicy(),
      },
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const outcome = await runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      eventBus,
      lane: 'interactive',
      runId: 'parent-run',
    }, async () => {
      await manager.executeSubagent({
        name: 'parent-fold',
        task: 'Charge once',
      });
      const afterFold = getRunChargeSnapshot();
      const followUpCharge = manager.executeSubagent({
        name: 'parent-follow-up',
        task: 'Charge twice',
      });
      const secondResult = await followUpCharge;
      return {
        afterFold,
        afterSecondShard: getRunChargeSnapshot(),
        secondShardId: secondResult.subagentId,
      };
    });

    expect(outcome.afterFold).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        interactive: 1,
        shard: 8,
      }),
    }));
    expect(outcome.afterSecondShard).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        interactive: 2,
        shard: 16,
      }),
      directSpentByLane: expect.objectContaining({
        interactive: 2,
      }),
      foldedSpentByLane: expect.objectContaining({
        shard: 16,
      }),
      foldBacks: [
        expect.objectContaining({
          disposition: 'folded',
          spentByLane: expect.objectContaining({ shard: 8 }),
        }),
        expect.objectContaining({
          disposition: 'folded',
          lineage: expect.objectContaining({ runId: outcome.secondShardId }),
          spentByLane: expect.objectContaining({ shard: 8 }),
        }),
      ],
      quotaSpentByLane: expect.objectContaining({
        interactive: 2,
        shard: 16,
      }),
    }));
  });

  it('keeps failed shard spend visible as orphaned provenance without folding it into the parent', async () => {
    mockShardError = new Error('LLM failed before fold-back');
    const chargeEvents: Array<Record<string, unknown>> = [];
    eventBus.on('agent.charge', (event) => {
      chargeEvents.push(event as unknown as Record<string, unknown>);
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        chargePolicy: makeChargePolicy(),
      },
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const parentSnapshot = await runWithChargeContext({
      chargePolicy: makeChargePolicy(),
      eventBus,
      lane: 'interactive',
      runId: 'parent-run-orphan',
    }, async () => {
      await expect(manager.executeSubagent({
        name: 'failed-child',
        task: 'Charge and fail',
      })).rejects.toThrow('LLM failed before fold-back');
      return getRunChargeSnapshot();
    });

    expect(chargeEvents.map((event) => event.surface)).toEqual([
      'subagentLaunch',
      'shardLaunch',
    ]);
    expect(chargeEvents[0].spentAfter).toBe(1);
    expect(chargeEvents[1].spentAfter).toBe(8);
    expect(parentSnapshot).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        interactive: 1,
      }),
      directSpentByLane: expect.objectContaining({
        interactive: 1,
      }),
      foldedSpentByLane: {},
      foldBacks: [],
      orphanedChildren: [
        expect.objectContaining({
          disposition: 'orphaned',
          lineage: expect.objectContaining({
            runId: chargeEvents[1].lineage.runId,
            parentRunId: 'parent-run-orphan',
            rootRunId: 'parent-run-orphan',
          }),
          spentByLane: expect.objectContaining({
            shard: 8,
          }),
          directSpentByLane: expect.objectContaining({
            shard: 8,
          }),
        }),
      ],
      quotaSpentByLane: expect.objectContaining({
        interactive: 1,
        shard: 8,
      }),
    }));
  });

  it('keeps spawned shard agents on gateway runtime mode when no override is provided', async () => {
    const handleMessageSpy = vi.spyOn(SubstrateAgent.prototype, 'handleMessage').mockImplementationOnce(async function (this: SubstrateAgent) {
      expect((this as any).runtimeMode).toBe('gateway');
      return {
        content: 'gateway runtime response',
        channelId: 'shard:gateway-runtime',
        attachments: [],
        metadata: {
          model: 'mock-model',
          inputTokens: 1,
          outputTokens: 1,
          durationMs: 1,
        },
      } as any;
    });

    try {
      const manager = new ShardManager({
        eventBus,
        llmProvider: mockLLM(),
        sessionStore,
        embeddingService: null,
        memoryProvider: null,
        config: TEST_CONFIG,
        parentSystemPrompt: 'You are a helpful assistant.',
      });

    const result = await manager.spawn({ name: 'gateway-mode', task: 'Do something' });

      expect(result.content).toBe('gateway runtime response');
      expect(handleMessageSpy).toHaveBeenCalledTimes(1);
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it('uses isolated channelId for session entries', async () => {
    mockShardContent = 'isolated response';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'system prompt',
    });

    const result = await manager.spawn({ name: 'iso', task: 'Check isolation' });

    // Shard should have written to shard:<id> channelId
    const channelId = `shard:${result.shardId}`;
    const entries = sessionStore.getRecent(channelId, 10);
    expect(entries.length).toBeGreaterThanOrEqual(2); // user + assistant
    expect(entries[0].role).toBe('user');
    expect(entries[0].content).toBe('Check isolation');
    expect(entries[1].role).toBe('assistant');
    expect(entries[1].content).toBe('isolated response');

    // Parent channel should have no entries
    const parentEntries = sessionStore.getRecent('main-channel', 10);
    expect(parentEntries).toHaveLength(0);
  });

  it('inherits parent system prompt when none specified', async () => {
    const companionPrompt = 'I am Companion.';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: companionPrompt,
    });

    await manager.spawn({ name: 'inherit', task: 'test' });

    // SubstrateAgent calls agent.setSystemPrompt() with the system prompt
    // from buildContext, which includes the base prompt
    expect(setSystemPromptSpy).toHaveBeenCalled();
    const setPromptCall = setSystemPromptSpy.mock.calls[0];
    expect(setPromptCall[0]).toContain(companionPrompt);
  });

  it('uses custom system prompt when provided', async () => {
    const companionPrompt = 'I am Companion.';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: companionPrompt,
    });

    await manager.spawn({
      name: 'custom',
      task: 'test',
      systemPrompt: 'You are a research shard.',
    });

    expect(setSystemPromptSpy).toHaveBeenCalled();
    const setPromptCall = setSystemPromptSpy.mock.calls[0];
    expect(setPromptCall[0]).toContain('You are a research shard.');
    expect(setPromptCall[0]).not.toContain(companionPrompt);
  });

  it('runs concurrent shards in parallel', async () => {
    let concurrentPeak = 0;
    let currentActive = 0;

    // Track concurrency via the prompt mock
    mockShardDelayMs = 50;
    promptSpy.mockImplementation(async function (this: Agent) {
      currentActive++;
      concurrentPeak = Math.max(concurrentPeak, currentActive);
      await new Promise(r => setTimeout(r, 50));
      currentActive--;
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'done' }],
        api: '' as any, provider: '' as any, model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as any, timestamp: Date.now(),
      });
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const results = await Promise.all([
      manager.spawn({ name: 'a', task: 'task a' }),
      manager.spawn({ name: 'b', task: 'task b' }),
      manager.spawn({ name: 'c', task: 'task c' }),
    ]);

    expect(results).toHaveLength(3);
    expect(concurrentPeak).toBeGreaterThanOrEqual(2); // At least some parallelism
  });

  it('enforces max concurrency limit', async () => {
    // Slow prompt mock for this test
    promptSpy.mockImplementation(async function (this: Agent) {
      await new Promise(r => setTimeout(r, 100));
      this.appendMessage({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'done' }],
        api: '' as any, provider: '' as any, model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as any, timestamp: Date.now(),
      });
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      maxConcurrent: 2,
    });

    // Start 2 shards (at limit)
    const p1 = manager.spawn({ name: 'a', task: 'task a' });
    const p2 = manager.spawn({ name: 'b', task: 'task b' });

    // Third should fail immediately
    await expect(
      manager.spawn({ name: 'c', task: 'task c' }),
    ).rejects.toThrow('Shard limit reached');

    // Wait for the first two to complete
    await Promise.all([p1, p2]);

    // Now should work again
    const result = await manager.spawn({ name: 'd', task: 'task d' });
    expect(result.name).toBe('d');
  });

  it('includes usage stats in result', async () => {
    mockShardContent = 'stats test';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const result = await manager.spawn({ name: 'stats', task: 'test' });

    // pi-agent-core doesn't surface token counts — they're 0 from metadata
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('tracks explicit lifecycle and health metadata for active and completed shards', async () => {
    mockShardDelayMs = 40;
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const pending = manager.spawn({ name: 'lifecycle', task: 'check lifecycle metadata' });
    await new Promise(resolve => setTimeout(resolve, 5));

    const active = manager.getActiveShards();
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('lifecycle');
    expect(['registering', 'ready']).toContain(active[0].state);
    expect(active[0].health).toBe('healthy');
    expect(active[0].lastHeartbeatAt).toBeGreaterThan(0);

    const result = await pending;
    expect(result.lifecycleState).toBe('offline');
    expect(result.health).toBe('healthy');
    expect(result.capabilities).toContain('general');
  });

  it('fails closed when required shard capabilities are missing', async () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await expect(
      manager.spawn({
        name: 'missing-capability',
        task: 'test',
        requiredCapabilities: ['wyoming:ha-main'],
      }),
    ).rejects.toThrow('missing required capability');
    expect(manager.getActiveCount()).toBe(0);
  });

  it('evicts stale shards from active routing and frees execution slots', async () => {
    mockShardDelayMs = 120;
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      maxConcurrent: 1,
      heartbeatStaleAfterMs: 20,
      heartbeatDisconnectAfterMs: 30,
    });

    const staleShard = manager.spawn({ name: 'stale', task: 'long-running task' });
    await new Promise(resolve => setTimeout(resolve, 60));

    // Health sweep happens on accessors; stale shard should be evicted from active routing.
    expect(manager.getActiveCount()).toBe(0);
    expect(manager.getActiveShards()).toHaveLength(0);

    await expect(
      manager.spawn({ name: 'replacement', task: 'new task after stale eviction' }),
    ).resolves.toMatchObject({
      name: 'replacement',
      lifecycleState: 'offline',
    });
    await staleShard;
  });

  it('recovers a heartbeat-stale shard when activity resumes before disconnect timeout', async () => {
    mockShardDelayMs = 160;
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      heartbeatStaleAfterMs: 20,
      heartbeatDisconnectAfterMs: 200,
    });

    const pending = manager.spawn({ name: 'recoverable', task: 'long-running task' });
    await new Promise(resolve => setTimeout(resolve, 45));

    const degraded = manager.getActiveShards();
    expect(degraded).toHaveLength(1);
    expect(degraded[0].state).toBe('degraded');
    expect(degraded[0].health).toBe('stale');
    expect(degraded[0].stateReason).toBe('heartbeat_stale');
    expect(degraded[0].failureReason).toContain('No heartbeat observed');

    await eventBus.emit('agent.tool.start', {
      channelId: degraded[0].channelId,
      toolCallId: 'recover-call',
      toolName: 'repo_status',
    });

    const recovered = manager.getActiveShards();
    expect(recovered).toHaveLength(1);
    expect(recovered[0].state).toBe('ready');
    expect(recovered[0].health).toBe('healthy');
    expect(recovered[0].stateReason).toBe('heartbeat_recovered');
    expect(recovered[0].failureReason).toBeUndefined();

    await pending;
  });

  it('wires memory provider for read access', async () => {
    const memory = mockMemoryProvider();
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: memory,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await manager.spawn({ name: 'mem', task: 'test memory' });

    // Memory retrieval should have been called for the shard's channel
    expect(memory.retrieve).toHaveBeenCalled();
  });

  it('injects a shard context pack from the source channel and keeps shard writes isolated', async () => {
    mockShardContent = 'context-packed response';
    const sourceTurnId = createTurnId();
    const sourceChannelId = 'api:parent-session';
    sessionStore.append({
      channelId: sourceChannelId,
      role: 'assistant',
      content: 'Earlier project summary',
      timestamp: Date.now() - 2_000,
    });
    sessionStore.append({
      channelId: sourceChannelId,
      role: 'user',
      content: 'Please check the deployment blockers.',
      authorId: 'user-1',
      authorName: 'PrimaryUser',
      timestamp: Date.now() - 1_000,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: sourceTurnId,
        requestId: 'req-parent-1',
        role: 'user',
      }),
    });
    const sourceEntriesBefore = sessionStore.getRecent(sourceChannelId, 10);
    const memory = mockMemoryProvider('Remember the staging database migration is still pending.');
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: memory,
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'autonomous',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous'],
          allowedChannelTypes: ['api'],
          allowedPurposes: ['shard_context'],
        },
      },
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({
      name: 'context-pack',
      task: 'Summarize the deployment blockers.',
      sourceContext: {
        channelId: sourceChannelId,
        requestId: 'req-parent-1',
        turnId: sourceTurnId,
        embodimentContext: {
          kind: 'embodiment',
          embodimentId: 'display',
          siteId: 'ha-main',
          satelliteId: 'kitchen',
        },
      },
    });

    expect(memory.retrieve).toHaveBeenCalledTimes(1);
    expect(memory.retrieve).toHaveBeenCalledWith(
      'Summarize the deployment blockers.',
      sourceChannelId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(setSystemPromptSpy).toHaveBeenCalled();
    const setPromptCall = setSystemPromptSpy.mock.calls[0];
    expect(setPromptCall).toBeDefined();
    const [setPromptText] = setPromptCall;
    expect(setPromptText).toContain('[Shard context pack]');
    expect(setPromptText).toContain(`Source channel: ${sourceChannelId}`);
    expect(setPromptText).toContain('Source embodiment: display');
    expect(setPromptText).toContain('Companion: Earlier project summary');
    expect(setPromptText).not.toContain('Assistant: Earlier project summary');
    expect(setPromptText).toContain('PrimaryUser: Please check the deployment blockers.');
    expect(setPromptText).toContain('Remember the staging database migration is still pending.');

    const shardEntries = sessionStore.getRecent(`shard:${result.shardId}`, 10);
    expect(shardEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'user',
        content: 'Summarize the deployment blockers.',
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'context-packed response',
      }),
    ]));
    expect(sessionStore.getRecent(sourceChannelId, 10)).toEqual(sourceEntriesBefore);
  });

  it('audits and persists allow decisions for source-to-shard context-pack sync', async () => {
    const sourceTurnId = createTurnId();
    const sourceChannelId = 'api:sync-parent';
    sessionStore.append({
      channelId: sourceChannelId,
      role: 'user',
      content: 'Carry only the last blocker into the shard.',
      authorId: 'user-1',
      authorName: 'PrimaryUser',
      timestamp: Date.now() - 100,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: sourceTurnId,
        requestId: 'req-sync-parent',
        role: 'user',
      }),
    });
    const auditTrail = { append: vi.fn() };
    const syncAuditPath = join(dir, 'audit', 'shard-session-memory-sync-audit.jsonl');
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: mockMemoryProvider('Carry over: deployment is blocked by DNS cutover.'),
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'autonomous',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous'],
          allowedChannelTypes: ['api'],
          allowedPurposes: ['shard_context'],
        },
      },
      parentSystemPrompt: 'test',
      auditTrail,
      shardSessionMemorySyncAuditPath: syncAuditPath,
    });

    await manager.spawn({
      name: 'sync-audit',
      task: 'Extract only blockers.',
      sourceContext: {
        channelId: sourceChannelId,
        requestId: 'req-sync-parent',
        turnId: sourceTurnId,
      },
    });

    const syncAuditCalls = auditTrail.append.mock.calls
      .filter(([event]) => event === 'shard.sync.policy')
      .map(([, details]) => details);
    expect(syncAuditCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: 'context_pack_session',
        decision: 'ALLOW',
        reason: 'allowed_prime_transcript_fact',
      }),
      expect.objectContaining({
        operation: 'context_pack_memory',
        decision: 'ALLOW',
        reason: 'allowed_prime_memory_seed',
      }),
    ]));

    expect(existsSync(syncAuditPath)).toBe(true);
    const persistedEntries = readFileSync(syncAuditPath, 'utf-8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    expect(persistedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: 'context_pack_session', decision: 'ALLOW' }),
      expect.objectContaining({ operation: 'context_pack_memory', decision: 'ALLOW' }),
    ]));
  });

  it('threads active focus scope into shard memory retrieval', async () => {
    const sourceTurnId = createTurnId();
    const sourceChannelId = 'api:scoped-parent';
    const scopeQuery = buildFocusMemoryScopeQuery('Memory Improvement');
    sessionStore.append({
      channelId: sourceChannelId,
      role: 'user',
      content: 'Work the memory improvement project.',
      authorId: 'user-1',
      authorName: 'PrimaryUser',
      timestamp: Date.now() - 100,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: sourceTurnId,
        requestId: 'req-scoped-parent',
        role: 'user',
      }),
    });
    const memory = mockMemoryProvider('Scoped memory block.');
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      sessionManager: {
        getActiveFocusMemoryScopeQuery: vi.fn(() => scopeQuery),
      } as any,
      embeddingService: null,
      memoryProvider: memory,
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'autonomous',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous'],
          allowedChannelTypes: ['api'],
          allowedPurposes: ['shard_context'],
        },
      },
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    await manager.spawn({
      name: 'scoped-memory',
      task: 'Summarize the memory improvement work.',
      sourceContext: {
        channelId: sourceChannelId,
        requestId: 'req-scoped-parent',
        turnId: sourceTurnId,
      },
    });

    expect(memory.retrieve).toHaveBeenCalledWith(
      'Summarize the memory improvement work.',
      sourceChannelId,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scopeQuery,
    );
  });

  it('injects default nursery shard toolset and blocks recursion tools', async () => {
    const memory = makeTestTool('memory');
    const contact = makeTestTool('contact');
    const repoStatus = makeTestTool('repo_status');
    const repoDiff = makeTestTool('repo_diff');
    const repoCommit = makeTestTool('repo_commit');
    const spawnSubagent = makeTestTool('spawn_subagent');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'nursery' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contact.tool],
        extended: [repoStatus.tool, repoDiff.tool, repoCommit.tool, spawnSubagent.tool],
      }),
    });

    await manager.spawn({ name: 'toolset-default', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toEqual(expect.arrayContaining(['tool_search', 'toolset', ...DEFAULT_SHARD_TOOLSET]));
    expect(injected).not.toContain('load_tools');
    expect(injected).not.toContain('repo_commit');
    expect(injected).not.toContain('spawn_subagent');
  });

  it('unlocks additional shard tools for apprentice tier', async () => {
    const memory = makeTestTool('memory');
    const contact = makeTestTool('contact');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'apprentice' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contact.tool],
        extended: [],
      }),
    });

    await manager.spawn({ name: 'toolset-apprentice', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toContain('contact');
    expect(injected).not.toContain('contact_list');
    expect(injected).not.toContain('memory_import_batch');
  });

  it('unlocks full configured catalog for autonomous tier', async () => {
    const memory = makeTestTool('memory');
    const repoCommit = makeTestTool('repo_commit');
    const promptUpdate = makeTestTool('prompt_layer_update');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'autonomous' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool],
        extended: [repoCommit.tool, promptUpdate.tool],
      }),
    });

    await manager.spawn({ name: 'toolset-autonomous', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toEqual(expect.arrayContaining([
      'memory',
      'repo_commit',
      'prompt_layer_update',
    ]));
  });

  it('respects configured shard toolset overrides', async () => {
    const memory = makeTestTool('memory');
    const contact = makeTestTool('contact');
    const repoStatus = makeTestTool('repo_status');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'nursery',
        shardToolsets: { nursery: ['contact'] },
      },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contact.tool],
        extended: [repoStatus.tool],
      }),
    });

    await manager.spawn({ name: 'toolset-customized', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toContain('contact');
    expect(injected).not.toContain('memory');
    expect(injected).not.toContain('repo_status');
  });

  it('keeps shard tool restrictions unchanged when a context pack is active', async () => {
    const sourceTurnId = createTurnId();
    const sourceChannelId = 'api:context-pack-tools';
    sessionStore.append({
      channelId: sourceChannelId,
      role: 'user',
      content: 'Check the repo state before acting.',
      authorId: 'user-1',
      authorName: 'PrimaryUser',
      timestamp: Date.now() - 500,
      metadata: buildSessionMetadataWithTurn(undefined, {
        turnId: sourceTurnId,
        requestId: 'req-context-tools',
        role: 'user',
      }),
    });
    const memory = makeTestTool('memory');
    const contact = makeTestTool('contact');
    const repoStatus = makeTestTool('repo_status');
    const repoDiff = makeTestTool('repo_diff');
    const repoCommit = makeTestTool('repo_commit');
    const spawnSubagent = makeTestTool('spawn_subagent');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: mockMemoryProvider('Parent memory block'),
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'nursery',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['nursery'],
          allowedChannelTypes: ['api'],
          allowedPurposes: ['shard_context'],
        },
      },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contact.tool],
        extended: [repoStatus.tool, repoDiff.tool, repoCommit.tool, spawnSubagent.tool],
      }),
    });

    await manager.spawn({
      name: 'toolset-packed',
      task: 'Audit tool restrictions',
      sourceContext: {
        channelId: sourceChannelId,
        requestId: 'req-context-tools',
        turnId: sourceTurnId,
      },
    });

    const injected = lastSetToolNames();
    expect(injected).toEqual(expect.arrayContaining(['tool_search', 'toolset', ...DEFAULT_SHARD_TOOLSET]));
    expect(injected).not.toContain('load_tools');
    expect(injected).not.toContain('repo_commit');
    expect(injected).not.toContain('spawn_subagent');
  });

  it('stamps shard source provenance on shard memory writes and quarantines imports behind review', async () => {
    const memoryTool = makeTestTool('memory');
    const auditTrail = { append: vi.fn() };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'apprentice' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memoryTool.tool],
        extended: [],
      }),
      auditTrail,
    });

    const result = await manager.spawn({ name: 'provenance', task: 'test' });
    const tools = (setToolsSpy.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>);
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    expect(wrappedMemory).toBeDefined();

    await wrappedMemory?.execute('mem-call', { action: 'write', text: 'x', type: 'semantic' });
    const importResult = await wrappedMemory?.execute('import-call', {
      action: 'import',
      records: [{ text: 'x', type: 'semantic', tags: 'archive' }],
      source: 'backup',
    });

    expect(memoryTool.execute).toHaveBeenCalledWith(
      'mem-call',
      expect.objectContaining({
        action: 'write',
        __psfnShardSource: `shard:${result.shardId}`,
      }),
      undefined,
    );
    expect(memoryTool.execute).toHaveBeenCalledTimes(1);
    expect(importResult).toEqual(expect.objectContaining({
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'text',
          text: expect.stringContaining('pending fold review'),
        }),
      ]),
      details: expect.objectContaining({
        mutationWorkflow: 'fold_review_only',
        reviewState: 'pending',
        blockedCorePromotion: true,
        blockedCorePromotionReason: 'denied_operation',
        directPromotionDecision: {
          allowed: false,
          reason: 'denied_operation',
        },
        foldReview: expect.objectContaining({
          status: 'pending',
          pendingTaggedOutputCount: 1,
          outputs: expect.arrayContaining([
            expect.objectContaining({
              reviewState: 'pending',
              blockedCorePromotion: true,
              blockedCorePromotionReason: 'denied_operation',
              provenance: expect.objectContaining({
                shardId: result.shardId,
                source: 'memory_import_batch',
                sourceToolName: 'memory',
                toolCallId: 'import-call',
              }),
            }),
          ]),
        }),
      }),
    }));
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.sync.policy',
      expect.objectContaining({
        shardId: result.shardId,
        operation: 'memory_import_batch',
        decision: 'DENY',
        reason: 'denied_operation',
      }),
    );
  });

  it('quarantines unified memory import actions behind review instead of calling the memory writer', async () => {
    const memoryTool = makeTestTool('memory');
    const auditTrail = { append: vi.fn() };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'autonomous' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memoryTool.tool],
        extended: [],
      }),
      auditTrail,
    });

    await manager.spawn({ name: 'memory-import', task: 'test' });
    const tools = (setToolsSpy.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>);
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    if (!wrappedMemory) {
      throw new Error('Expected wrapped memory tool to be present');
    }

    const importResult = await wrappedMemory.execute('memory-import-call', {
      action: 'import',
      records: [{ text: 'Unified import', type: 'semantic' }],
    });

    expect(memoryTool.execute).not.toHaveBeenCalled();
    expect(importResult).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        mutationWorkflow: 'fold_review_only',
        reviewState: 'pending',
        blockedCorePromotion: true,
        blockedCorePromotionReason: 'denied_operation',
        directPromotionDecision: {
          allowed: false,
          reason: 'denied_operation',
        },
        foldReview: expect.objectContaining({
          outputs: expect.arrayContaining([
            expect.objectContaining({
              blockedCorePromotionReason: 'denied_operation',
              provenance: expect.objectContaining({
                sourceToolName: 'memory',
                toolCallId: 'memory-import-call',
              }),
            }),
          ]),
        }),
      }),
    }));
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.sync.policy',
      expect.objectContaining({
        operation: 'memory_import_batch',
        decision: 'DENY',
        reason: 'denied_operation',
      }),
    );
  });

  it('persists quarantined shard memory candidates in the fold review controller', async () => {
    const memoryTool = makeTestTool('memory');
    const foldReviewController = new ShardFoldReviewController(
      join(dir, 'state', 'shard-fold-reviews.json'),
    );

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'apprentice' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memoryTool.tool],
        extended: [],
      }),
      foldReviewController,
    });

    const result = await manager.spawn({ name: 'persist-fold-review', task: 'test' });
    const tools = setToolsSpy.mock.calls.at(-1)?.[0] as Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    expect(wrappedMemory).toBeDefined();
    if (!wrappedMemory) {
      throw new Error('Expected wrapped memory tool to be present');
    }

    await wrappedMemory.execute('persist-import-call', {
      action: 'import',
      records: [{
        text: 'Partner needs follow-up after the deploy.',
        type: 'emotional',
        tags: 'relationship,partner',
        sensitivity: 'intimate',
      }],
      source: 'backup',
    });

    const review = await manager.getFoldReview(result.shardId);
    expect(review).toMatchObject({
      shardId: result.shardId,
      reviewState: 'pending',
      memoryItems: [
        expect.objectContaining({
          reviewState: 'pending',
          candidate: expect.objectContaining({
            type: 'emotional',
            sensitivity: 'intimate',
          }),
        }),
      ],
    });
    expect(review?.blockingReasons).toEqual(expect.arrayContaining([
      'staged_shard_memory_pending_merge_review',
      'emotional_or_relational_interpretation_requires_core_review',
    ]));
  });

  it('returns lineage provenance on shard spawns with explicit source context', async () => {
    mockShardContent = 'lineage response';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const result = await manager.spawn({
      name: 'lineage',
      task: 'Trace the fold-back path.',
      sourceContext: {
        channelId: 'api:source-channel',
        requestId: 'req-lineage',
        turnId: 'turn-lineage',
      },
    });

    expect(result.lineage).toEqual(expect.objectContaining({
      schemaVersion: 2,
      kind: 'spawn',
      coreCompanionId: 'companion-test',
      shardCompanionId: expect.stringMatching(/^companion-test::shard-/),
      shardId: result.shardId,
      shardChannelId: `shard:${result.shardId}`,
      companionProvenance: {
        parentCompanionId: 'companion-test',
        shardCompanionId: expect.stringMatching(/^companion-test::shard-/),
      },
      sourceContext: {
        channelId: 'api:source-channel',
        requestId: 'req-lineage',
        turnId: 'turn-lineage',
      },
      sourceMessage: expect.objectContaining({
        id: result.shardId,
        channelId: `shard:${result.shardId}`,
        channelType: 'api',
        authorId: 'companion-test',
        authorName: 'Companion',
        isDirectMessage: false,
      }),
    }));
  });

  it('returns accepted shard artifacts with explicit merge policy and lineage provenance', async () => {
    const handleMessageSpy = vi.spyOn(SubstrateAgent.prototype, 'handleMessage').mockResolvedValueOnce({
      content: 'artifact response',
      channelId: 'shard:result',
      attachments: [{
        url: 'https://images.example.test/fold-back.png',
        contentType: 'image/png',
        name: 'fold-back.png',
        localPath: '/tmp/fold-back.png',
      }],
      metadata: {
        model: 'mock-model',
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 8,
      },
    } as any);

    try {
      const manager = new ShardManager({
        eventBus,
        llmProvider: mockLLM(),
        sessionStore,
        embeddingService: null,
        memoryProvider: null,
        config: TEST_CONFIG,
        parentSystemPrompt: 'test',
      });

      const result = await manager.spawn({ name: 'artifact', task: 'emit an image artifact' });

      expect(result.artifactReturn?.artifacts).toEqual([expect.objectContaining({
        schemaVersion: 1,
        kind: 'attachment',
        mergePolicy: 'review_required',
        artifactId: `artifact-${result.shardId}-1-1`,
        url: 'https://images.example.test/fold-back.png',
        contentType: 'image/png',
        name: 'fold-back.png',
        localPath: '/tmp/fold-back.png',
        provenance: {
          lineage: result.lineage,
          turnIndex: 1,
          turnMessageId: result.shardId,
        },
      })]);
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it('persists review-required shard artifact returns in the fold review controller', async () => {
    const foldReviewController = new ShardFoldReviewController(
      join(dir, 'state', 'shard-fold-reviews.json'),
    );
    const handleMessageSpy = vi.spyOn(SubstrateAgent.prototype, 'handleMessage').mockResolvedValueOnce({
      content: 'artifact response',
      channelId: 'shard:result',
      attachments: [{
        url: 'https://images.example.test/fold-review-artifact.png',
        contentType: 'image/png',
        name: 'fold-review-artifact.png',
      }],
      metadata: {
        model: 'mock-model',
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 8,
      },
    } as any);

    try {
      const manager = new ShardManager({
        eventBus,
        llmProvider: mockLLM(),
        sessionStore,
        embeddingService: null,
        memoryProvider: null,
        config: TEST_CONFIG,
        parentSystemPrompt: 'test',
        foldReviewController,
      });

      const result = await manager.spawn({ name: 'artifact-review', task: 'emit an image artifact' });
      const review = await manager.getFoldReview(result.shardId);

      expect(review).toMatchObject({
        shardId: result.shardId,
        reviewState: 'pending',
        artifactItems: [
          expect.objectContaining({
            reviewState: 'pending',
            artifact: expect.objectContaining({
              artifactId: `artifact-${result.shardId}-1-1`,
              url: 'https://images.example.test/fold-review-artifact.png',
            }),
          }),
        ],
      });
      expect(review?.blockingReasons).toContain('artifact_output_pending_merge_review');
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it('rejects ambiguous shard artifact returns', async () => {
    const handleMessageSpy = vi.spyOn(SubstrateAgent.prototype, 'handleMessage').mockResolvedValueOnce({
      content: 'artifact response',
      channelId: 'shard:result',
      attachments: [{
        url: 'https://images.example.test/fold-back.json',
        contentType: 'application/json',
        name: 'fold-back.json',
      }],
      metadata: {
        model: 'mock-model',
        inputTokens: 3,
        outputTokens: 4,
        durationMs: 8,
      },
    } as any);

    try {
      const manager = new ShardManager({
        eventBus,
        llmProvider: mockLLM(),
        sessionStore,
        embeddingService: null,
        memoryProvider: null,
        config: TEST_CONFIG,
        parentSystemPrompt: 'test',
      });

      await expect(manager.spawn({ name: 'artifact', task: 'emit an ambiguous artifact' }))
        .rejects
        .toThrow('ambiguous');
    } finally {
      handleMessageSpy.mockRestore();
    }
  });

  it('denies disallowed shard-to-prime memory sync operations and audits the denial', async () => {
    const memoryTool = makeTestTool('memory');
    const auditTrail = { append: vi.fn() };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'autonomous' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memoryTool.tool],
        extended: [],
      }),
      auditTrail,
    });

    const result = await manager.spawn({ name: 'policy-deny', task: 'test' });
    const tools = setToolsSpy.mock.calls.at(-1)?.[0] as Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    expect(wrappedMemory).toBeDefined();
    if (!wrappedMemory) {
      throw new Error('Expected wrapped memory tool to be present');
    }

    await expect(
      wrappedMemory.execute('redact-call', { action: 'redact', memory_id: 'mem-1' }),
    ).rejects.toThrow('denied_operation');
    expect(memoryTool.execute).not.toHaveBeenCalled();
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.sync.policy',
      expect.objectContaining({
        shardId: result.shardId,
        operation: 'memory_redact',
        decision: 'DENY',
        reason: 'denied_operation',
      }),
    );
  });

  it('logs shard provenance metadata in audit trail entries', async () => {
    const auditTrail = {
      append: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      auditTrail,
    });

    const result = await manager.spawn({ name: 'audit', task: 'test' });
    await eventBus.emit('agent.tool.start', {
      channelId: `shard:${result.shardId}`,
      toolCallId: 'call-a',
      toolName: 'memory',
    });
    await eventBus.emit('agent.tool.end', {
      channelId: `shard:${result.shardId}`,
      toolCallId: 'call-a',
      toolName: 'memory',
      isError: false,
    });

    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.spawn.start',
      expect.objectContaining({ shardId: result.shardId }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.spawn.end',
      expect.objectContaining({ shardId: result.shardId, status: 'completed' }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.tool.start',
      expect.objectContaining({ shardId: result.shardId, toolName: 'memory' }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'shard.tool.end',
      expect.objectContaining({ shardId: result.shardId, toolName: 'memory', isError: false }),
    );
  });

  it('delegates Wyoming sessions with stable channel continuity', async () => {
    mockShardContent = 'wyoming delegated response';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const result = await manager.delegateSatelliteSession({
      message: {
        id: 'wyoming-msg-conn-kitchen-7',
        channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'status check',
        isDirectMessage: true,
        timestamp: new Date('2026-02-26T12:00:00.000Z'),
      },
      routing: {
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
        turnId: 'wyoming-turn-conn-kitchen-session-kitchen-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-kitchen',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'voice-pe-kitchen',
          companionId: 'companion-test',
        },
      },
    });

    expect(result.shardId).toMatch(/^wyoming-shard-/);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.capabilities).toEqual(expect.arrayContaining([
      'wyoming',
      'wyoming:ha-main',
      'wyoming:ha-main:voice-pe-kitchen',
    ]));
    expect(result.requiredCapabilities).toEqual(expect.arrayContaining([
      'wyoming',
      'wyoming:ha-main',
      'wyoming:ha-main:voice-pe-kitchen',
    ]));
    expect(result.lineage).toEqual(expect.objectContaining({
      schemaVersion: 2,
      kind: 'wyoming',
      coreCompanionId: 'companion-test',
      shardCompanionId: expect.stringMatching(/^companion-test::wyoming-shard-/),
      shardId: result.shardId,
      shardChannelId: 'api:wyoming:ha-main:voice-pe-kitchen',
      companionProvenance: {
        parentCompanionId: 'companion-test',
        shardCompanionId: expect.stringMatching(/^companion-test::wyoming-shard-/),
      },
      sourceMessage: expect.objectContaining({
        id: 'wyoming-msg-conn-kitchen-7',
        channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        isDirectMessage: true,
        timestampMs: new Date('2026-02-26T12:00:00.000Z').getTime(),
      }),
      satelliteRouting: {
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
        turnId: 'wyoming-turn-conn-kitchen-session-kitchen-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-kitchen',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'voice-pe-kitchen',
          companionId: 'companion-test',
        },
      },
    }));
    const delegatedEntries = sessionStore.getRecent('api:wyoming:ha-main:voice-pe-kitchen', 10);
    expect(delegatedEntries).toHaveLength(2);
    expect(delegatedEntries[0]).toMatchObject({
      role: 'user',
      content: 'status check',
    });
    expect(delegatedEntries[1]).toMatchObject({
      role: 'assistant',
      content: result.content,
    });
  });

  it('audits Wyoming delegation start/end with routing identity context', async () => {
    const auditTrail = {
      append: vi.fn(),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      auditTrail,
    });

    await manager.delegateSatelliteSession({
      message: {
        id: 'wyoming-msg-conn-office-3',
        channelId: 'api:wyoming:ha-main:voice-pe-office',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'what time is it',
        isDirectMessage: true,
        timestamp: new Date('2026-02-26T12:00:00.000Z'),
      },
      routing: {
        connectionId: 'conn-office',
        sessionId: 'session-office',
        turnId: 'wyoming-turn-conn-office-session-office-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-office',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'voice-pe-office',
        },
      },
    });

    expect(auditTrail.append).toHaveBeenCalledWith(
      'satellite.shard.delegate.start',
      expect.objectContaining({
        connectionId: 'conn-office',
        sessionId: 'session-office',
        turnId: 'wyoming-turn-conn-office-session-office-1',
        presence: {
          kind: 'satellite',
          siteId: 'ha-main',
          satelliteId: 'voice-pe-office',
        },
      }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'satellite.shard.delegate.end',
      expect.objectContaining({
        status: 'completed',
        connectionId: 'conn-office',
        sessionId: 'session-office',
      }),
    );
  });

  it('seeds canonical embodiment context into Wyoming shard launches', async () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });
    const executeShard = vi.spyOn(manager as any, 'executeShard').mockResolvedValue({
      shardId: 'wyoming-shard-test',
      name: 'wyoming-launch',
      content: 'ok',
      model: 'mock-model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
      turns: 1,
      lifecycleState: 'ready',
      health: 'healthy',
      stateReason: 'completed',
      capabilities: ['wyoming'],
      requiredCapabilities: ['wyoming'],
    });

    await manager.delegateSatelliteSession({
      message: {
        id: 'wyoming-msg-conn-launch-1',
        channelId: 'api:wyoming:ha-main:voice-pe-launch',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'launch the worker',
        isDirectMessage: true,
        timestamp: new Date('2026-02-26T12:00:00.000Z'),
      },
      routing: {
        connectionId: 'conn-launch',
        sessionId: 'session-launch',
        turnId: 'wyoming-turn-conn-launch-session-launch-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-launch',
        presence: {
          kind: 'emanation',
          emanationId: 'voice-node',
          embodimentId: 'display',
          siteId: 'ha-main',
          satelliteId: 'voice-pe-launch',
          companionId: 'companion-test',
        },
      },
    });

    expect(executeShard).toHaveBeenCalledWith(
      expect.any(String),
      'api:wyoming:ha-main:voice-pe-launch',
      expect.objectContaining({
        sourceContext: expect.objectContaining({
          channelId: 'api:wyoming:ha-main:voice-pe-launch',
          requestId: 'wyoming-msg-conn-launch-1',
          turnId: 'wyoming-turn-conn-launch-session-launch-1',
          embodimentContext: {
            companionId: 'companion-test',
            kind: 'embodiment',
            embodimentId: 'display',
            siteId: 'ha-main',
            satelliteId: 'voice-pe-launch',
            isPrimary: true,
          },
        }),
      }),
      expect.objectContaining({
        id: 'wyoming-msg-conn-launch-1',
        channelId: 'api:wyoming:ha-main:voice-pe-launch',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'launch the worker',
        isDirectMessage: true,
      }),
      expect.objectContaining({
        schemaVersion: 2,
        kind: 'wyoming',
        coreCompanionId: 'companion-test',
        shardCompanionId: expect.stringMatching(/^companion-test::wyoming-shard-/),
        sourceMessage: expect.objectContaining({
          id: 'wyoming-msg-conn-launch-1',
          channelId: 'api:wyoming:ha-main:voice-pe-launch',
        }),
        satelliteRouting: expect.objectContaining({
          turnId: 'wyoming-turn-conn-launch-session-launch-1',
        }),
      }),
      expect.objectContaining({
        companionId: expect.stringMatching(/^companion-test::wyoming-shard-/),
      }),
    );
  });

  it('decrements active count even on failure', async () => {
    // Make prompt throw
    mockShardError = new Error('LLM failed');
    promptSpy.mockImplementation(async function (this: Agent) {
      throw new Error('LLM failed');
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await expect(
      manager.spawn({ name: 'fail', task: 'test' }),
    ).rejects.toThrow('LLM failed');

    // Active count should be back to 0
    expect(manager.getActiveCount()).toBe(0);
  });
});

describe('createBoundedSubagentLaunchTool', () => {
  let dir: string;
  let sessionStore: SessionStore;
  let eventBus: EventBus;

  beforeEach(() => {
    process.env.LITELLM_BASE_URL = 'http://localhost:4000/v1';
    dir = mkdtempSync(join(tmpdir(), 'psfn-shard-tool-'));
    sessionStore = new SessionStore(dir);
    eventBus = new EventBus();
    mockShardContent = 'shard response';
    mockShardDelayMs = 0;
    mockShardError = null;
    promptSpy.mockClear();
    setToolsSpy.mockClear();
    restoreDefaultPromptMock();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRunChargeRollingWindowForTests();
  });

  it('returns a valid AgentTool', () => {
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createBoundedSubagentLaunchTool(manager);

    expect(tool.name).toBe('spawn_subagent');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('spawn_subagent');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('formats result content with stats', async () => {
    mockShardContent = 'tool output';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createBoundedSubagentLaunchTool(manager);
    const result = await tool.execute('call-1', { name: 'test-tool', task: 'do something' });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('Bounded subagent "test-tool" completed');
    expect(text).toContain('1 turn(s)');
    expect(text).toContain('0 tokens');  // pi-agent-core doesn't surface token counts
    expect(text).toContain('[State reason: completed]');
    expect(text).toContain('tool output');
  });

  it('surfaces explicit lifecycle failure diagnostics from bounded subagent results', async () => {
    const executeSubagent = vi.fn(async () => ({
      subagentId: 'subagent-failure',
      name: 'degraded-shard',
      content: 'partial output',
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 2,
      durationMs: 33,
      turns: 1,
      lifecycleState: 'offline' as const,
      health: 'failed' as const,
      stateReason: 'heartbeat_timeout',
      failureReason: 'Heartbeat stale for 4200ms exceeded recovery window (4000ms).',
      capabilities: ['general'],
      requiredCapabilities: [],
    }));
    const tool = createBoundedSubagentLaunchTool({ executeSubagent } as unknown as SubagentExecutionPort);

    const result = await tool.execute('call-failure', {
      name: 'degraded-shard',
      task: 'diagnostic run',
    });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('[State reason: heartbeat_timeout]');
    expect(text).toContain('[Failure reason: Heartbeat stale for 4200ms exceeded recovery window (4000ms).]');
  });

  it('passes source request context into bounded subagent launches', async () => {
    const executeSubagent = vi.fn(async () => ({
      subagentId: 'subagent-test',
      name: 'ctx',
      content: 'ok',
      model: 'mock-model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
      turns: 1,
      lifecycleState: 'offline' as const,
      health: 'healthy' as const,
      stateReason: 'completed',
      capabilities: ['general'],
      requiredCapabilities: [],
    }));
    const tool = createBoundedSubagentLaunchTool({ executeSubagent } as unknown as SubagentExecutionPort);

    await runWithRequestContext(
      {
        channelId: 'api:source-context',
        requestId: 'req-source-context',
        turnId: 'turn-source-context',
      },
      async () => {
        await tool.execute('call-context', {
          name: 'ctx',
          task: 'Inspect source context',
        });
      },
    );

    expect(executeSubagent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ctx',
      task: 'Inspect source context',
      sourceContext: {
        channelId: 'api:source-context',
        requestId: 'req-source-context',
        turnId: 'turn-source-context',
      },
    }));
  });

  it('returns error content on failure', async () => {
    promptSpy.mockImplementation(async function () {
      throw new Error('boom');
    });

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createBoundedSubagentLaunchTool(manager);
    const result = await tool.execute('call-2', { name: 'fail', task: 'test' });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('Bounded subagent error');
    expect(result.details?.isError).toBe(true);
  });
});
