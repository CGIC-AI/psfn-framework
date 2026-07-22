import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompletionNoticeBuffer } from '../../core/agent/completion-notices.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent, type AgentTool } from '../../boundary/pi-agent/index.js';
import { Type } from '@sinclair/typebox';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import {
  getRunChargeSnapshot,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import { buildSessionMetadataWithTurn } from '../../core/session/turn-provenance.js';
import { buildFocusMemoryScopeQuery } from '../../core/session/focus-knowledge.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { resolveInstalledAgentTurnTools } from '../../boundary/pi-agent/agent-loop-patch.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import {
  DEFAULT_SHARD_TOOLSET,
  ShardExecutionError,
  ShardManager,
  type ShardManagerDeps,
} from './manager.js';
import { ShardFoldReviewController } from './fold-review.js';
import type { LLMProviderPort, MemoryProvider } from '../../core/agent/contracts.js';
import type { ChargePolicyConfig } from '../../system/config/charge-policy-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { LLMResponse } from '../../shared/contracts/runtime.js';
import { createTurnId } from '../../core/turns/id.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import { resetCompletionHandoffDedupeForTests } from '../../core/agent/completion-handoff.js';
import type { CompletionHandoffRecord } from '../../shared/contracts/completion-handoff.js';
import { createCompressionGuidelineEvolution } from '../../core/session/compression-guideline-evolution.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import {
  resolveCompressionFailureLogPath,
  resolveCompressionGuidelinePath,
} from '../../persistence/layout.js';
import type { PostgresShardSchemaLifecycle } from '../../persistence/postgres/shard-schema-lifecycle.js';
import type { PostgresShardSchemaBinding } from '../../persistence/postgres/shard-schema-lifecycle.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import { CAPABILITY_TIER_DEFAULTS } from '../../system/capabilities/tiers.js';

// ── Mock pi-agent-core Agent ──
// We mock Agent.prototype.prompt so it doesn't actually call the LLM.
// Per-test customization via module-level variables.

let mockShardContent = 'shard response';
let mockShardContents: string[] = [];
let mockShardDelayMs = 0;
let mockShardError: Error | null = null;
let mockParentCapabilitySnapshot: CapabilityGrantSnapshot;
const snapshotParentCapabilityGrant = vi.fn(
  (): CapabilityGrantSnapshot => mockParentCapabilitySnapshot,
);

function createTestShardManager(
  deps: Omit<ShardManagerDeps, 'snapshotParentCapabilityGrant'>,
): ShardManager {
  return new ShardManager({
    ...deps,
    snapshotParentCapabilityGrant,
  });
}

function nextMockShardContent(): string {
  return mockShardContents.shift() ?? mockShardContent;
}

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  recordAgentRunConfig(this);
  if (mockShardError) throw mockShardError;
  if (mockShardDelayMs > 0) await new Promise(r => setTimeout(r, mockShardDelayMs));
  this.state.messages.push({
    role: 'assistant',
    content: [{ type: 'text' as const, text: nextMockShardContent() }],
    api: '' as any,
    provider: '' as any,
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as any,
    timestamp: Date.now(),
  });
});

// pi-agent-core 0.73 removed Agent.setSystemPrompt()/setTools(). The production
// prompt loop now resolves tools from the exact async turn owner, so this test
// double must consume that same resolver instead of mutable Agent state.
type AgentRunConfig = {
  agent: Agent;
  systemPrompt: string;
  tools: readonly AgentTool<any>[];
};
const agentRunConfigs: AgentRunConfig[] = [];
function recordAgentRunConfig(agent: Agent): AgentRunConfig {
  const config = {
    agent,
    systemPrompt: agent.state.systemPrompt,
    tools: resolveInstalledAgentTurnTools(agent),
  };
  agentRunConfigs.push(config);
  return config;
}

function restoreDefaultPromptMock(): void {
  promptSpy.mockImplementation(async function (this: Agent) {
    recordAgentRunConfig(this);
    if (mockShardError) throw mockShardError;
    if (mockShardDelayMs > 0) await new Promise(r => setTimeout(r, mockShardDelayMs));
    this.state.messages.push({
      role: 'assistant',
      content: [{ type: 'text' as const, text: nextMockShardContent() }],
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
  const config = agentRunConfigs.at(-1);
  if (!config) return [];
  return config.tools.map((tool) => tool.name);
}

function parseEntryMetadata(entry: { metadata?: string | null | undefined }): Record<string, unknown> {
  return JSON.parse(String(entry.metadata ?? '{}')) as Record<string, unknown>;
}

function isCompletionHandoffEntry(entry: { metadata?: string | null | undefined }): boolean {
  try {
    return parseEntryMetadata(entry).type === 'completion_handoff';
  } catch {
    return false;
  }
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
  return {
    getActiveMemoryContext: vi.fn(request => ({
      key: `test:${request.channelId}`,
      subjectKey: request.canonicalContactId ?? request.channelId,
      channelId: request.channelId,
      trustLevel: request.trustLevel ?? 'regular',
      channelVisibility: 'private',
      visibilityScope: 'non_broadcast',
      contextBlock: result,
      contextChars: result.length,
      selectedMemoryIds: [],
      generatedAt: Date.now(),
      lastRefreshStartedAt: Date.now(),
      lastRefreshCompletedAt: Date.now(),
      refreshStatus: 'ready',
      versionPointer: 'test-memory-context',
    })),
    refreshActiveMemoryContext: vi.fn(async () => null),
    retrieve: vi.fn(async () => result),
  };
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
  companionId: '11111111-1111-4111-8111-111111111111',
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
    dir = mkdtempSync(join(tmpdir(), 'psfn-worker-'));
    sessionStore = new SessionStore(dir);
    eventBus = new EventBus();
    // Reset per-test mock state
    mockShardContent = 'shard response';
    mockShardContents = [];
    mockShardDelayMs = 0;
    mockShardError = null;
    mockParentCapabilitySnapshot = Object.freeze({
      tier: 'autonomous',
      customTokens: Object.freeze([]),
      grantedTokens: Object.freeze([...CAPABILITY_TIER_DEFAULTS.autonomous]),
    });
    snapshotParentCapabilityGrant.mockClear();
    promptSpy.mockClear();
    agentRunConfigs.length = 0;
    restoreDefaultPromptMock();
    resetCompletionHandoffDedupeForTests();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    resetRunChargeRollingWindowForTests();
  });

  // Wiring proof (bead zet.7): operator-set shard concurrency/heartbeat
  // settings in the owner file reach the live resolved limits. Composition
  // passes the full SubstrateConfig as deps.config; spawn-blocking and stale
  // eviction against these same resolved fields are covered by the existing
  // behavior tests ("enforces concurrency limit", stale-eviction test).
  it('resolves concurrency and heartbeat limits from owner-file settings (zet.7)', () => {
    const base = {
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      parentSystemPrompt: 'test',
    };

    const fromSettings = createTestShardManager({
      ...base,
      config: {
        ...TEST_CONFIG,
        shardMaxConcurrent: 2,
        shardHeartbeatStaleAfterMs: 30_000,
        shardHeartbeatDisconnectAfterMs: 90_000,
      },
    });
    expect(fromSettings.maxConcurrentShards).toBe(2);
    expect(fromSettings.heartbeatStaleThresholdMs).toBe(30_000);
    expect(fromSettings.heartbeatDisconnectThresholdMs).toBe(90_000);

    // Explicit deps override wins over the owner-file value.
    const explicitOverride = createTestShardManager({
      ...base,
      config: { ...TEST_CONFIG, shardMaxConcurrent: 9 },
      maxConcurrent: 1,
    });
    expect(explicitOverride.maxConcurrentShards).toBe(1);

    // Compiled defaults preserved exactly when the settings are absent:
    // maxConcurrent 5, stale 60s, disconnect = stale x 3.
    const compiledDefault = createTestShardManager({
      ...base,
      config: TEST_CONFIG,
    });
    expect(compiledDefault.maxConcurrentShards).toBe(5);
    expect(compiledDefault.heartbeatStaleThresholdMs).toBe(60_000);
    expect(compiledDefault.heartbeatDisconnectThresholdMs).toBe(180_000);
  });

  it('uses the shard-owned compaction trajectory to capture confusion and review once', async () => {
    const shardConfig: SubstrateConfig = {
      ...TEST_CONFIG,
      dataDir: dir,
      defaultContextWindow: 1_000,
      modelRoster: {
        chat: { model: 'test-model', provider: 'test', maxTokens: 512, contextWindow: 1_000 },
      },
    };
    const complete = vi.fn<LLMProviderPort['complete']>(async (_context, _purpose, options) => ({
      content: options?.correlation?.purpose === 'session.compression_guideline.update'
        ? '{"updatedGuideline":"Preserve task lineage and the active thread explicitly."}'
        : 'Summary of the pre-shard trajectory.',
      toolCalls: [],
      model: 'test-model',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'end_turn',
    }));
    const llmProvider: LLMProviderPort = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'end_turn',
      })),
      complete,
    };
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'autonomous',
      getGrantedTokens: () => new Set(['memory.write'] as const),
      has: token => token === 'memory.write',
    }));
    const trajectorySeeder = new SessionManager(sessionStore, shardConfig, eventBus);
    let seeded = false;
    eventBus.on('agent.turn.start', ({ message }) => {
      if (seeded || !message.channelId.startsWith('shard:')) return;
      seeded = true;
      for (let index = 0; index < 12; index += 1) {
        trajectorySeeder.recordUserMessage(
          message.channelId,
          `Original shard evidence ${index} ${'A'.repeat(400)}`,
          'user-1',
          'User',
        );
        trajectorySeeder.recordAssistantMessage(
          message.channelId,
          `Shard analysis ${index} ${'B'.repeat(400)}`,
        );
      }
    });
    mockShardContents = [
      'Initial shard answer.',
      'Which thread are we on?',
      'Could you remind me what we were discussing?',
    ];
    const manager = createTestShardManager({
      eventBus,
      llmProvider,
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: shardConfig,
      parentSystemPrompt: 'Test shard prompt',
      compressionGuidelineEvolution: createCompressionGuidelineEvolution({
        eligibilityGate,
        llmProvider,
      }),
    });

    await manager.spawn({
      name: 'trajectory-review',
      task: 'Carry a long analysis thread.',
      maxTurns: 3,
    });

    const failures = readFileSync(resolveCompressionFailureLogPath(dir), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { channelId: string; originalContext: string });
    expect(failures).toHaveLength(2);
    expect(failures.every(failure => failure.channelId.startsWith('shard:'))).toBe(true);
    expect(failures[0]?.originalContext).toContain('Original shard evidence');
    expect(JSON.parse(readFileSync(resolveCompressionGuidelinePath(dir), 'utf8'))).toMatchObject({
      version: 2,
      guideline: 'Preserve task lineage and the active thread explicitly.',
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls.filter(
      ([, , options]) => options?.correlation?.purpose === 'session.compaction.summary',
    )).toHaveLength(1);
    expect(complete.mock.calls.filter(
      ([, , options]) => options?.correlation?.purpose === 'session.compression_guideline.update',
    )).toHaveLength(1);
  }, 60_000);

  it('spawns a shard and returns result', async () => {
    mockShardContent = 'Hello from shard';
    const lifecycleEvents: Array<{
      handoff: CompletionHandoffRecord;
      targetChannelId?: string;
      noticeBuffered: boolean;
    }> = [];
    eventBus.on('agent.completion_handoff', event => {
      lifecycleEvents.push(event);
    });
    const manager = createTestShardManager({
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
    expect(result.outcome).toBe('completed');
    expect(result.completionHandoff).toEqual({ status: 'delivered' });
    expect(lifecycleEvents.map(event => event.handoff.status))
      .toEqual(['started', 'progress', 'completed']);
    expect(lifecycleEvents.every(event => (
      event.targetChannelId === undefined && event.noticeBuffered === false
    ))).toBe(true);
    expect(result.lineage).toEqual(expect.objectContaining({
      schemaVersion: 2,
      kind: 'spawn',
      coreCompanionId: '11111111-1111-4111-8111-111111111111',
      shardCompanionId: `11111111-1111-4111-8111-111111111111::${result.shardId}`,
      shardId: result.shardId,
      shardChannelId: `shard:${result.shardId}`,
      companionProvenance: {
        parentCompanionId: '11111111-1111-4111-8111-111111111111',
        shardCompanionId: `11111111-1111-4111-8111-111111111111::${result.shardId}`,
      },
      sourceMessage: expect.objectContaining({
        id: result.shardId,
        channelId: `shard:${result.shardId}`,
        channelType: 'api',
        authorId: '11111111-1111-4111-8111-111111111111',
        authorName: 'Companion',
        isDirectMessage: false,
      }),
      }));
  });


  it('prepares and cleans one lineage-bound Postgres schema for a multi-companion shard', async () => {
    const binding: PostgresShardSchemaBinding = {
      parentCompanionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      parentSchema: 'companion_alpha',
      shardId: 'derived-by-test',
      schema: 'companion_alpha_shard_0123456789012345678901234567890123456789',
      role: 'psfn_companion_alpha_shard_test',
    };
    const derive: PostgresShardSchemaLifecycle['derive'] = vi.fn((
      _parentCompanionId,
      _parentSchema,
      shardId,
    ) => ({
      ...binding,
      shardId,
    }));
    const prepare: PostgresShardSchemaLifecycle['prepare'] = vi.fn(async () => undefined);
    const cleanup: PostgresShardSchemaLifecycle['cleanup'] = vi.fn(async () => ({
      schema: binding.schema,
      role: binding.role,
      droppedObjectCount: 3,
      dropped: true,
    }));
    const lifecycle: PostgresShardSchemaLifecycle = {
      derive,
      prepare,
      cleanup,
      openPool: () => {
        throw new Error('Shard pool creation is outside this manager lifecycle test');
      },
      migrate: async () => undefined,
      backup: async () => {
        throw new Error('Shard backup is outside this manager lifecycle test');
      },
      restore: async () => undefined,
    };
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        multiCompanion: true,
        postgresSchema: 'companion_alpha',
      },
      parentSystemPrompt: 'You are a helpful assistant.',
      shardPostgresLifecycle: lifecycle,
    });

    const result = await manager.spawn({ name: 'postgres-bound', task: 'Use isolated state' });

    expect(derive).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      'companion_alpha',
      result.shardId,
    );
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({
      shardId: result.shardId,
      schema: binding.schema,
    }));
    expect(cleanup).toHaveBeenCalledWith(expect.objectContaining({
      shardId: result.shardId,
      schema: binding.schema,
    }));
  });

  it('releases shard state when the started lifecycle handoff cannot be accepted', async () => {
    eventBus.guard('agent.completion_handoff', () => {
      throw new Error('lifecycle sink unavailable');
    });
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    await expect(manager.spawn({ name: 'handoff-failure', task: 'Do something' }))
      .rejects.toThrow('lifecycle sink unavailable');
    expect(manager.getActiveCount()).toBe(0);
    expect(manager.getActiveShards()).toHaveLength(0);
  });

  it('reports terminal lifecycle delivery failure without falsifying a completed shard result', async () => {
    eventBus.guard('agent.completion_handoff', event => {
      if (event.handoff.status === 'completed') {
        throw new Error('terminal lifecycle sink unavailable');
      }
      return true;
    });
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({
      name: 'terminal-handoff-failure',
      task: 'finish despite notification infrastructure failure',
    });

    expect(result.outcome).toBe('completed');
    expect(result.completionHandoff).toEqual({
      status: 'failed',
      error: 'completion handoff failed: terminal lifecycle sink unavailable',
    });
    expect(manager.getActiveCount()).toBe(0);
  });

  it('reports failed execution and failed terminal lifecycle delivery on the shard error', async () => {
    mockShardError = new Error('worker execution failed');
    eventBus.guard('agent.completion_handoff', event => {
      if (event.handoff.status === 'failed') {
        throw new Error('terminal lifecycle sink unavailable');
      }
      return true;
    });
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const error = await manager.spawn({
      name: 'failed-terminal-handoff',
      task: 'fail honestly despite notification infrastructure failure',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ShardExecutionError);
    expect((error as ShardExecutionError).result).toMatchObject({
      outcome: 'failed',
      failureReason: 'worker execution failed',
      completionHandoff: {
        status: 'failed',
        error: 'completion handoff failed: terminal lifecycle sink unavailable',
      },
    });
    expect(manager.getActiveCount()).toBe(0);
  });

  it('keeps the structured ShardExecutionError when cleanup also fails', async () => {
    // The execution failure already carries the truthful outcome and terminal
    // lifecycle-delivery status. A failing shard-Postgres cleanup must not bury
    // that structure inside an AggregateError — the thrown error stays the
    // ShardExecutionError with cleanup failures recorded as suppressed context.
    mockShardError = new Error('worker execution failed');
    const cleanupFailure = new Error('shard postgres schema drop failed');
    const binding: PostgresShardSchemaBinding = {
      parentCompanionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      parentSchema: 'companion_alpha',
      shardId: 'derived-by-test',
      schema: 'companion_alpha_shard_cleanupfailure',
      role: 'psfn_companion_alpha_shard_test',
    };
    const lifecycle: PostgresShardSchemaLifecycle = {
      derive: vi.fn(() => binding),
      prepare: vi.fn(async () => binding),
      cleanup: vi.fn(async () => {
        throw cleanupFailure;
      }),
      openPool: () => {
        throw new Error('Shard pool creation is outside this manager lifecycle test');
      },
      migrate: async () => undefined,
      backup: async () => {
        throw new Error('Shard backup is outside this manager lifecycle test');
      },
      restore: async () => undefined,
    };
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        multiCompanion: true,
        postgresSchema: 'companion_alpha',
      },
      parentSystemPrompt: 'You are a helpful assistant.',
      shardPostgresLifecycle: lifecycle,
    });

    const error = await manager.spawn({
      name: 'cleanup-failure-after-execution-failure',
      task: 'fail, then fail cleanup without losing the structured result',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ShardExecutionError);
    expect((error as ShardExecutionError).result).toMatchObject({
      outcome: 'failed',
      failureReason: 'worker execution failed',
    });
    expect(
      (error as ShardExecutionError & { suppressed?: unknown[] }).suppressed,
    ).toEqual([cleanupFailure]);
    expect(manager.getActiveCount()).toBe(0);
  });

  it('rejects multi-companion shard construction without a Postgres lifecycle', () => {
    expect(() => createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        multiCompanion: true,
        postgresSchema: 'companion_alpha',
      },
      parentSystemPrompt: 'test',
    })).toThrow('requires a Postgres shard schema lifecycle');
  });

  it('emits a structured completion handoff for shard results with source context', async () => {
    mockShardContent = 'Shard found the answer.';
    const events: unknown[] = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event);
    });
    const completionNotices = new CompletionNoticeBuffer();
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      completionNotices,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'You are a helpful assistant.',
    });

    const result = await manager.spawn({
      name: 'handoff-shard',
      task: 'Do something',
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-parent',
        turnId: 'turn-parent',
      },
    });

    // Handoffs never write session entries; they surface as one compact
    // buffered notice plus the structured event-bus record.
    expect(sessionStore.getRecent('api:parent', 10)).toHaveLength(0);
    const notices = completionNotices.peek('api:parent');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      status: 'completed',
      summary: 'Shard found the answer.',
    });
    expect(events.map(event => (event as { handoff: CompletionHandoffRecord }).handoff.status))
      .toEqual(['started', 'progress', 'completed']);
    expect(events.at(-1)).toMatchObject({
      noticeBuffered: true,
      handoff: expect.objectContaining({
        source: 'shard',
        task: expect.objectContaining({ shardId: result.shardId }),
        privacy: expect.objectContaining({
          partnerNotification: 'companion_mediated_only',
        }),
      }),
    });
  });

  it('caps explicit multi-turn shard requests at the shared agent loop ceiling', async () => {
    const manager = createTestShardManager({
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

  it('charges shard execution with lineage', async () => {
    mockShardContent = 'charged shard response';
    const chargeEvents: Array<Record<string, unknown>> = [];
    eventBus.on('agent.charge', (event) => {
      chargeEvents.push(event as unknown as Record<string, unknown>);
    });

    const manager = createTestShardManager({
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
        await manager.spawn({
          name: 'launch-charge',
          task: 'Do charged work',
        });
        return getRunChargeSnapshot();
      }),
    );

    expect(chargeEvents.map((event) => event.surface)).toEqual(['shardLaunch']);
    expect(chargeEvents[0].spentAfter).toBe(8);
    expect(chargeEvents[0].lineage).toEqual(expect.objectContaining({
      runId: expect.stringMatching(/^shard-/),
      parentRunId: 'launch-request',
      rootRunId: 'launch-request',
    }));
    expect(parentSnapshot).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        shard: 8,
      }),
      directSpentByLane: {},
      foldedSpentByLane: expect.objectContaining({
        shard: 8,
      }),
      foldBacks: [
        expect.objectContaining({
          disposition: 'folded',
          lineage: expect.objectContaining({
            runId: chargeEvents[0].lineage.runId,
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
        shard: 8,
      }),
    }));
  });

  it('folds completed shard spend back into the parent without double-counting follow-up spend', async () => {
    mockShardContent = 'fold child charge once';
    const manager = createTestShardManager({
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
      await manager.spawn({
        name: 'parent-fold',
        task: 'Charge once',
      });
      const afterFold = getRunChargeSnapshot();
      const followUpCharge = manager.spawn({
        name: 'parent-follow-up',
        task: 'Charge twice',
      });
      const secondResult = await followUpCharge;
      return {
        afterFold,
        afterSecondShard: getRunChargeSnapshot(),
        secondShardId: secondResult.shardId,
      };
    });

    expect(outcome.afterFold).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        shard: 8,
      }),
    }));
    expect(outcome.afterSecondShard).toEqual(expect.objectContaining({
      spentByLane: expect.objectContaining({
        shard: 16,
      }),
      directSpentByLane: {},
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

    const manager = createTestShardManager({
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
      await expect(manager.spawn({
        name: 'failed-child',
        task: 'Charge and fail',
      })).rejects.toThrow('LLM failed before fold-back');
      return getRunChargeSnapshot();
    });

    expect(chargeEvents.map((event) => event.surface)).toEqual(['shardLaunch']);
    expect(chargeEvents[0].spentAfter).toBe(8);
    expect(parentSnapshot).toEqual(expect.objectContaining({
      spentByLane: {},
      directSpentByLane: {},
      foldedSpentByLane: {},
      foldBacks: [],
      orphanedChildren: [
        expect.objectContaining({
          disposition: 'orphaned',
          lineage: expect.objectContaining({
            runId: chargeEvents[0].lineage.runId,
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
      const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
    expect(agentRunConfigs.length).toBeGreaterThan(0);
    const setPromptCall = [agentRunConfigs[0]!.systemPrompt];
    expect(setPromptCall[0]).toContain(companionPrompt);
  });

  it('uses custom system prompt when provided', async () => {
    const companionPrompt = 'I am Companion.';
    const manager = createTestShardManager({
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

    expect(agentRunConfigs.length).toBeGreaterThan(0);
    const setPromptCall = [agentRunConfigs[0]!.systemPrompt];
    expect(setPromptCall[0]).toContain('You are a research shard.');
    expect(setPromptCall[0]).not.toContain(companionPrompt);
  });

  it('runs concurrent shards in parallel', async () => {
    let concurrentPeak = 0;
    let currentActive = 0;

    // Track concurrency via the prompt mock
    mockShardDelayMs = 50;
    promptSpy.mockImplementation(async function (this: Agent) {
      recordAgentRunConfig(this);
      currentActive++;
      concurrentPeak = Math.max(concurrentPeak, currentActive);
      await new Promise(r => setTimeout(r, 50));
      currentActive--;
      this.state.messages.push({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'done' }],
        api: '' as any, provider: '' as any, model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as any, timestamp: Date.now(),
      });
    });

    const manager = createTestShardManager({
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
      recordAgentRunConfig(this);
      await new Promise(r => setTimeout(r, 100));
      this.state.messages.push({
        role: 'assistant',
        content: [{ type: 'text' as const, text: 'done' }],
        api: '' as any, provider: '' as any, model: '',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop' as any, timestamp: Date.now(),
      });
    });

    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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

  it('exposes only the exact parent live directory and routes direct chat through the shard ingress', async () => {
    mockShardDelayMs = 80;
    mockShardContent = 'bounded shard reply';
    const parentSessionManager = new SessionManager(sessionStore, TEST_CONFIG, eventBus);
    parentSessionManager.intakeScreening = {
      mode: 'enforce',
      screenSync: vi.fn((text: string) => ({
        action: text.includes('Bearer')
          ? 'sanitize'
          : 'pass',
        report: {
          sanitizedText: text.replace(/Bearer\s+\S+/gu, '[REDACTED:credential]'),
          scannerErrors: [],
          riskLabels: text.includes('Bearer')
            ? ['secrets/credential_material']
            : [],
        },
      } as any)),
    };
    const deliverOrdinaryIcp = vi.fn(async (
      request: import('../../shared/contracts/shard-parent-icp.js').ShardParentIcpEnvelope,
    ) => ({
      ...request,
      direction: 'parent_to_shard' as const,
      content: 'Parent guidance for the live shard',
    }));
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      sessionManager: parentSessionManager,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      shardParentIcpDelivery: { deliverOrdinaryIcp },
    });
    const parentCompanionId = createCompanionId('11111111-1111-4111-8111-111111111111');
    const pending = manager.spawn({
      name: 'research shard',
      task: 'Use Bearer eyJprivate against a private partner record',
      maxTurns: 2,
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    const directory = manager.shardDirectory.listShards(parentCompanionId);
    expect(directory).toHaveLength(1);
    expect(directory[0]).toMatchObject({
      label: 'research shard',
      purpose: 'Task details withheld',
    });
    const shardId = directory[0]!.shardId;
    expect(manager.shardDirectory.ownerOfLiveShard(shardId)).toBe(parentCompanionId);
    expect(() => manager.shardDirectory.listShards(
      createCompanionId('22222222-2222-4222-8222-222222222222'),
    )).toThrow(/parent binding denied/u);
    await expect(manager.shardParentIcp.sendShardParentIcp(
      shardId,
      'I need parent guidance',
    )).resolves.toBe('Parent guidance for the live shard');
    expect(deliverOrdinaryIcp).toHaveBeenCalledTimes(1);
    expect(deliverOrdinaryIcp).toHaveBeenCalledWith({
      schemaVersion: 1,
      routingCompanionId: parentCompanionId,
      lineage: { parentCompanionId, shardId },
      direction: 'shard_to_parent',
      content: 'I need parent guidance',
    });
    await expect(manager.shardParentIcp.sendShardParentIcp('foreign-shard', 'do not route'))
      .rejects.toThrow(/unavailable or foreign/u);

    const attachment = {
      attachmentId: '11111111-1111-4111-8111-111111111111',
      disposition: 'created' as const,
      deviceActor: {
        kind: 'hub_device' as const,
        principal: { companionId: parentCompanionId },
        connectionId: 'connection-1',
      },
      actor: {
        kind: 'human' as const,
        principalId: 'human-1',
        companionId: parentCompanionId,
        providerSubject: { provider: 'discord' as const, subjectId: '123456789012345678' },
        contact: { bindingId: 'binding-1', contactId: 'contact-1', bindingVersion: 1 },
        operator: { grantId: 'grant-1', role: 'member' as const, grantVersion: 1 },
        session: { recordId: 'session-1', authorityGeneration: 1, globalAuthEpoch: 1 },
      },
      channel: { source: 'server' as const, id: 'hub-device:test', companionId: parentCompanionId },
    } as any;
    const response = await manager.shardDirectory.sendShardChat({
      parentCompanionId,
      shardId,
      requestId: 'direct-1',
      content: 'Report your bounded finding',
      attachment,
    });
    expect(response).toMatchObject({
      content: 'bounded shard reply',
      attribution: { parentCompanionId, shardId },
    });
    expect(response.channelId).toBe(`shard:${shardId}:human`);
    expect(deliverOrdinaryIcp).toHaveBeenCalledTimes(1);
    expect(manager.shardDirectory.readShardChatHistory(parentCompanionId, shardId)).toMatchObject([
      { role: 'user', content: 'Report your bounded finding', attribution: { shardId } },
      { role: 'assistant', content: 'bounded shard reply', attribution: { shardId } },
    ]);
    expect(() => manager.shardDirectory.readShardChatHistory(
      createCompanionId('22222222-2222-4222-8222-222222222222'),
      shardId,
    )).toThrow(/parent binding denied/u);

    await pending;
    expect(manager.shardDirectory.ownerOfLiveShard(shardId)).toBeUndefined();
    expect(() => manager.shardDirectory.readShardChatHistory(parentCompanionId, shardId))
      .toThrow(/unavailable/u);
    await expect(manager.shardParentIcp.sendShardParentIcp(shardId, 'stale delivery'))
      .rejects.toThrow(/unavailable or foreign/u);
  });

  it('drops a parent response when the exact shard generation ends while the exchange is pending', async () => {
    mockShardDelayMs = 300;
    let releaseResponse!: (
      response: import('../../shared/contracts/shard-parent-icp.js').ShardParentIcpEnvelope,
    ) => void;
    const responsePending = new Promise<
      import('../../shared/contracts/shard-parent-icp.js').ShardParentIcpEnvelope
    >((resolve) => {
      releaseResponse = resolve;
    });
    let requestEnvelope:
      | import('../../shared/contracts/shard-parent-icp.js').ShardParentIcpEnvelope
      | undefined;
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
      shardParentIcpDelivery: {
        deliverOrdinaryIcp: async (request) => {
          requestEnvelope = request;
          return await responsePending;
        },
      },
    });
    const shardRun = manager.spawn({ name: 'short lived', task: 'Finish shortly' });
    await vi.waitFor(() => expect(manager.getActiveShards()).toHaveLength(1));
    const shardId = manager.getActiveShards()[0]!.id;
    const exchange = manager.shardParentIcp.sendShardParentIcp(shardId, 'Question');

    await shardRun;
    expect(requestEnvelope).toBeDefined();
    releaseResponse({
      ...requestEnvelope!,
      direction: 'parent_to_shard',
      content: 'Late parent response',
    });
    await expect(exchange).rejects.toThrow(/generation is no longer live/u);
  });

  it('fails closed when shard-parent ICP has no policy-governed ordinary ingress', async () => {
    mockShardDelayMs = 40;
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });
    const pending = manager.spawn({ name: 'bounded', task: 'Bounded work' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const [shard] = manager.getActiveShards();
    expect(shard).toBeDefined();
    await expect(manager.shardParentIcp.sendShardParentIcp(shard!.id, 'status'))
      .rejects.toThrow(/no policy-governed ordinary ICP ingress/u);
    await pending;
  });

  it('fails closed when required shard capabilities are missing', async () => {
    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: memory,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    await manager.spawn({ name: 'mem', task: 'test memory' });

    // Shard turn execution should read the active memory context for its channel.
    expect(memory.getActiveMemoryContext).toHaveBeenCalled();
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
    const manager = createTestShardManager({
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
      {
        channelId: sourceChannelId,
        messageText: 'Summarize the deployment blockers.',
        taskKind: 'analysis',
      },
      undefined,
      undefined,
    );
    expect(agentRunConfigs.length).toBeGreaterThan(0);
    const setPromptCall = [agentRunConfigs[0]!.systemPrompt];
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
    const sourceEntriesAfter = sessionStore.getRecent(sourceChannelId, 10);
    // Handoffs are never session-persisted: the source channel transcript is
    // untouched by shard completion.
    expect(sourceEntriesAfter).toEqual(sourceEntriesBefore);
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
    const manager = createTestShardManager({
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

  it('threads deterministic task context and active focus scope into shard memory retrieval', async () => {
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
    const manager = createTestShardManager({
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
      {
        channelId: sourceChannelId,
        messageText: 'Summarize the memory improvement work.',
        taskKind: 'analysis',
      },
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

    const manager = createTestShardManager({
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

    const manager = createTestShardManager({
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

    const manager = createTestShardManager({
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

    const manager = createTestShardManager({
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

    const manager = createTestShardManager({
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

  it('keeps mocked prompt tool snapshots bound to each concurrent shard turn', async () => {
    const alphaTool = makeTestTool('alpha_tool');
    const betaTool = makeTestTool('beta_tool');
    let releaseAlpha!: () => void;
    let markAlphaEntered!: () => void;
    let markBetaEntered!: () => void;
    const alphaRelease = new Promise<void>((resolve) => {
      releaseAlpha = resolve;
    });
    const alphaEntered = new Promise<void>((resolve) => {
      markAlphaEntered = resolve;
    });
    const betaEntered = new Promise<void>((resolve) => {
      markBetaEntered = resolve;
    });

    promptSpy.mockImplementation(async function (this: Agent) {
      const config = recordAgentRunConfig(this);
      const toolNames = config.tools.map(tool => tool.name);
      if (toolNames.includes('alpha_tool')) {
        markAlphaEntered();
        await alphaRelease;
      } else if (toolNames.includes('beta_tool')) {
        markBetaEntered();
      }
      this.state.messages.push({
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

    const alphaManager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'nursery',
        shardToolsets: { nursery: ['alpha_tool'] },
      },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({ core: [alphaTool.tool], extended: [] }),
    });
    const betaManager = createTestShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: {
        ...TEST_CONFIG,
        capabilityTier: 'nursery',
        shardToolsets: { nursery: ['beta_tool'] },
      },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({ core: [betaTool.tool], extended: [] }),
    });

    const alphaRun = alphaManager.spawn({ name: 'alpha-turn', task: 'test' });
    await alphaEntered;
    const betaRun = betaManager.spawn({ name: 'beta-turn', task: 'test' });
    await betaEntered;
    await betaRun;
    releaseAlpha();
    await alphaRun;

    const alphaConfig = agentRunConfigs.find(config => (
      config.tools.some(tool => tool.name === 'alpha_tool')
    ));
    const betaConfig = agentRunConfigs.find(config => (
      config.tools.some(tool => tool.name === 'beta_tool')
    ));
    const alphaToolNames = alphaConfig?.tools.map(tool => tool.name) ?? [];
    const betaToolNames = betaConfig?.tools.map(tool => tool.name) ?? [];
    expect(alphaToolNames).toContain('alpha_tool');
    expect(alphaToolNames).not.toContain('beta_tool');
    expect(betaToolNames).toContain('beta_tool');
    expect(betaToolNames).not.toContain('alpha_tool');
    expect(() => resolveInstalledAgentTurnTools(alphaConfig!.agent)).toThrow(
      'Turn-owned tools are unavailable outside their exact async owner',
    );
    expect(() => resolveInstalledAgentTurnTools(betaConfig!.agent)).toThrow(
      'Turn-owned tools are unavailable outside their exact async owner',
    );
  });

  it('stages shard memory writes with both companion identities without calling the core writer', async () => {
    const memoryTool = makeTestTool('memory');
    const foldReviewController = new ShardFoldReviewController(
      join(dir, 'state', 'shard-fold-reviews.json'),
    );

    const manager = createTestShardManager({
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

    const result = await manager.spawn({ name: 'memory-write-review', task: 'test' });
    const tools = agentRunConfigs.at(-1)?.tools as Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;
    const wrappedMemory = tools.find(tool => tool.name === 'memory');
    if (!wrappedMemory) {
      throw new Error('Expected wrapped memory tool to be present');
    }

    const writeResult = await wrappedMemory.execute('memory-write-call', {
      action: 'write',
      text: 'Partner needs follow-up after the deploy.',
      type: 'emotional',
      tags: 'relationship,partner',
      sensitivity: 'intimate',
    });

    expect(memoryTool.execute).not.toHaveBeenCalled();
    expect(writeResult).toEqual(expect.objectContaining({
      details: expect.objectContaining({
        mutationWorkflow: 'fold_review_only',
        reviewState: 'pending',
        blockedCorePromotion: true,
        foldReview: expect.objectContaining({
          outputs: expect.arrayContaining([
            expect.objectContaining({
              source: 'memory_write',
              provenance: expect.objectContaining({
                coreCompanionId: '11111111-1111-4111-8111-111111111111',
                shardCompanionId: `11111111-1111-4111-8111-111111111111::${result.shardId}`,
                shardId: result.shardId,
                source: 'memory_write',
                sourceToolName: 'memory',
                toolCallId: 'memory-write-call',
              }),
            }),
          ]),
        }),
      }),
    }));

    const review = await manager.getFoldReview(result.shardId);
    expect(review).toMatchObject({
      lineage: {
        coreCompanionId: '11111111-1111-4111-8111-111111111111',
        shardCompanionId: `11111111-1111-4111-8111-111111111111::${result.shardId}`,
      },
      memoryItems: [
        expect.objectContaining({
          output: expect.objectContaining({
            source: 'memory_write',
            provenance: expect.objectContaining({
              coreCompanionId: '11111111-1111-4111-8111-111111111111',
              shardCompanionId: `11111111-1111-4111-8111-111111111111::${result.shardId}`,
            }),
          }),
        }),
      ],
    });
  });

  it('quarantines imports behind review with shard provenance', async () => {
    const memoryTool = makeTestTool('memory');
    const auditTrail = { append: vi.fn() };

    const manager = createTestShardManager({
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
    const tools = (agentRunConfigs.at(-1)?.tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>);
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    expect(wrappedMemory).toBeDefined();

    const importResult = await wrappedMemory?.execute('import-call', {
      action: 'import',
      records: [{ text: 'x', type: 'semantic', tags: 'archive' }],
      source: 'backup',
    });

    expect(memoryTool.execute).not.toHaveBeenCalled();
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

    const manager = createTestShardManager({
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
    const tools = (agentRunConfigs.at(-1)?.tools as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>);
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

    const manager = createTestShardManager({
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
    const tools = agentRunConfigs.at(-1)?.tools as Array<{
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
    const manager = createTestShardManager({
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
      coreCompanionId: '11111111-1111-4111-8111-111111111111',
      shardCompanionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::shard-/),
      shardId: result.shardId,
      shardChannelId: `shard:${result.shardId}`,
      companionProvenance: {
        parentCompanionId: '11111111-1111-4111-8111-111111111111',
        shardCompanionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::shard-/),
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
        authorId: '11111111-1111-4111-8111-111111111111',
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
      const manager = createTestShardManager({
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
    const lifecycleEvents: Array<{
      handoff: CompletionHandoffRecord;
      targetChannelId?: string;
      noticeBuffered: boolean;
    }> = [];
    eventBus.on('agent.completion_handoff', event => {
      lifecycleEvents.push(event);
    });
    let foldAttempts = 0;
    eventBus.guard('agent.completion_handoff', event => {
      if (event.handoff.status === 'folded_back') {
        foldAttempts += 1;
        if (foldAttempts === 1) {
          throw new Error('folded-back lifecycle sink unavailable');
        }
      }
      return true;
    });

    try {
      const manager = createTestShardManager({
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
      await expect(manager.resolveFoldReview({
        shardId: result.shardId,
        decision: 'approve',
        actor: 'operator',
      })).rejects.toThrow('folded-back lifecycle sink unavailable');
      const approved = await manager.resolveFoldReview({
        shardId: result.shardId,
        decision: 'approve',
        actor: 'operator',
      });

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
      expect(approved?.reviewState).toBe('approved');
      expect(lifecycleEvents.at(-1)).toMatchObject({
        noticeBuffered: false,
        handoff: {
          source: 'shard',
          status: 'folded_back',
          task: { shardId: result.shardId },
        },
      });
      expect(lifecycleEvents.at(-1)?.targetChannelId).toBeUndefined();
      await manager.resolveFoldReview({
        shardId: result.shardId,
        decision: 'approve',
        actor: 'operator',
      });
      expect(lifecycleEvents.filter(event => event.handoff.status === 'folded_back'))
        .toHaveLength(1);
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
      const manager = createTestShardManager({
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

  it('denies destructive memory sync at the derived capability gate before fold policy', async () => {
    const memoryTool = makeTestTool('memory');
    const auditTrail = { append: vi.fn() };

    const manager = createTestShardManager({
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
    const tools = agentRunConfigs.at(-1)?.tools as Array<{
      name: string;
      execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>;
    }>;
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');
    expect(wrappedMemory).toBeDefined();
    if (!wrappedMemory) {
      throw new Error('Expected wrapped memory tool to be present');
    }

    const denial = await wrappedMemory.execute(
      'redact-call',
      { action: 'redact', memory_id: 'mem-1' },
    ) as {
      content: Array<{ text: string }>;
      details: { capabilityDenied: boolean; missingTokens: string[]; tier: string };
    };
    expect(memoryTool.execute).not.toHaveBeenCalled();
    expect(denial).toEqual(expect.objectContaining({
      content: [expect.objectContaining({
        text: expect.stringContaining('requires memory.delete'),
      })],
      details: {
        capabilityDenied: true,
        missingTokens: ['memory.delete'],
        tier: 'custom',
        isError: true,
      },
    }));
    expect(auditTrail.append).not.toHaveBeenCalledWith(
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

    const manager = createTestShardManager({
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
      outcome: 'success',
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
    const manager = createTestShardManager({
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
          companionId: '11111111-1111-4111-8111-111111111111',
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
      coreCompanionId: '11111111-1111-4111-8111-111111111111',
      shardCompanionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::wyoming-shard-/),
      shardId: result.shardId,
      shardChannelId: 'api:wyoming:ha-main:voice-pe-kitchen',
      companionProvenance: {
        parentCompanionId: '11111111-1111-4111-8111-111111111111',
        shardCompanionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::wyoming-shard-/),
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
          companionId: '11111111-1111-4111-8111-111111111111',
        },
      },
    }));
    const delegatedEntries = sessionStore.getRecent('api:wyoming:ha-main:voice-pe-kitchen', 10);
    const visibleTranscriptEntries = delegatedEntries.filter(entry => !isCompletionHandoffEntry(entry));
    const handoffEntries = delegatedEntries.filter(isCompletionHandoffEntry);
    expect(visibleTranscriptEntries).toHaveLength(2);
    expect(visibleTranscriptEntries[0]).toMatchObject({
      role: 'user',
      content: 'status check',
    });
    expect(visibleTranscriptEntries[1]).toMatchObject({
      role: 'assistant',
      content: result.content,
    });
    // Handoffs are event-bus + notice-buffer only; no session entries.
    expect(handoffEntries).toHaveLength(0);
  });


  it('audits Wyoming delegation start/end with routing identity context', async () => {
    const auditTrail = {
      append: vi.fn(),
    };

    const manager = createTestShardManager({
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
    const manager = createTestShardManager({
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
          companionId: '11111111-1111-4111-8111-111111111111',
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
            companionId: '11111111-1111-4111-8111-111111111111',
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
        coreCompanionId: '11111111-1111-4111-8111-111111111111',
        shardCompanionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::wyoming-shard-/),
        sourceMessage: expect.objectContaining({
          id: 'wyoming-msg-conn-launch-1',
          channelId: 'api:wyoming:ha-main:voice-pe-launch',
        }),
        satelliteRouting: expect.objectContaining({
          turnId: 'wyoming-turn-conn-launch-session-launch-1',
        }),
      }),
      expect.objectContaining({
        companionId: expect.stringMatching(/^11111111-1111-4111-8111-111111111111::wyoming-shard-/),
      }),
      expect.objectContaining({
        parent: expect.objectContaining({
          companionId: '11111111-1111-4111-8111-111111111111',
          tier: 'autonomous',
        }),
        access: expect.objectContaining({
          grantDigest: expect.any(String),
          ownerVersion: expect.any(String),
        }),
      }),
      null,
    );
  });

  it('decrements active count even on failure', async () => {
    // Make prompt throw
    mockShardError = new Error('LLM failed');
    promptSpy.mockImplementation(async function (this: Agent) {
      throw new Error('LLM failed');
    });

    const manager = createTestShardManager({
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
        name: 'fail',
        task: 'test',
        sourceContext: {
          channelId: 'api:parent',
          requestId: 'msg-failure',
          turnId: 'turn-failure',
        },
      }),
    ).rejects.toThrow('LLM failed');

    // Active count should be back to 0
    expect(manager.getActiveCount()).toBe(0);
    // Failure handoffs stay off the transcript entirely.
    expect(sessionStore.getRecent('api:parent', 10)).toHaveLength(0);
  });
});
