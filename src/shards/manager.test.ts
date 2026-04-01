import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import { EventBus } from '../event-bus.js';
import { SessionStore } from '../session/store.js';
import { runWithRequestContext } from '../llm/request-context.js';
import { buildSessionMetadataWithTurn } from '../session/turn-provenance.js';
import { buildFocusMemoryScopeQuery } from '../session/focus-knowledge.js';
import { DEFAULT_SHARD_TOOLSET, ShardManager } from './manager.js';
import { createSpawnShardTool } from './tools.js';
import { EXECUTION_PORT_FAMILIES } from './port.js';
import { shardArtifactReturnPort } from './artifact-policy.js';
import type { LLMProvider, MemoryProvider } from '../agent/contracts.js';
import type { SubstrateConfig, LLMResponse } from '../types.js';
import { createTurnId } from '../turns/id.js';

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

function mockLLM(): LLMProvider {
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
    expect(result.gatewayRouting).toEqual({
      schemaVersion: 1,
      companionId: 'companion',
      shard: {
        coreCompanionId: 'companion',
        shardCompanionId: `companion/shards/${result.shardId}`,
        shardId: result.shardId,
      },
    });
    expect(result.lineage).toEqual(result.gatewayRouting.shard);
    expect(manager.portFamily).toBe('shard');
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
    expect(['registering', 'ready']).toContain(active[0].lifecycleState);
    expect(['preparing', 'running']).toContain(active[0].runtimeState);
    expect(active[0].artifactLifecycleState).toBe('pending');
    expect(active[0].health).toBe('healthy');
    expect(active[0].lastHeartbeatAt).toBeGreaterThan(0);

    const result = await pending;
    expect(result.lifecycleState).toBe('offline');
    expect(result.runtimeState).toBe('awaiting_delivery');
    expect(result.artifactLifecycleState).toBe('available');
    expect(result.health).toBe('healthy');
    expect(result.capabilities).toContain('general');
  });

  it('keeps completed shard artifacts resumable until an explicit delivery occurs', async () => {
    mockShardContent = 'delivery-ready output';
    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const result = await manager.spawn({ name: 'delivery', task: 'prepare artifact' });
    expect(result.runtimeState).toBe('awaiting_delivery');
    expect(result.artifactLifecycleState).toBe('available');

    const beforeDelivery = manager.getRuntimeShardView(result.shardId, { transcriptLimit: 10 });
    expect(beforeDelivery?.task.runtimeState).toBe('awaiting_delivery');
    expect(beforeDelivery?.artifacts).toEqual([
      expect.objectContaining({
        kind: 'final_output',
        lifecycleState: 'available',
        content: 'delivery-ready output',
      }),
    ]);
    expect(beforeDelivery?.resume).toEqual(expect.objectContaining({
      mode: 'delivery',
      resumable: true,
      artifactLifecycleState: 'available',
      deliveryPending: true,
    }));

    manager.markArtifactDelivered(result.shardId);

    const afterDelivery = manager.getRuntimeShardView(result.shardId, { transcriptLimit: 10 });
    expect(afterDelivery?.task.runtimeState).toBe('completed');
    expect(afterDelivery?.task.artifactLifecycleState).toBe('delivered');
    expect(afterDelivery?.artifacts[0]).toEqual(expect.objectContaining({
      lifecycleState: 'delivered',
      deliveredAt: expect.any(Number),
    }));
    expect(afterDelivery?.resume).toEqual(expect.objectContaining({
      mode: 'none',
      resumable: false,
      artifactLifecycleState: 'delivered',
      deliveryPending: false,
      deliveredAt: expect.any(Number),
    }));
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

  it('keeps detached long-running shard records visible until artifact delivery resumes', async () => {
    mockShardContent = 'late shard output';
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

    const pending = manager.spawn({ name: 'detached', task: 'long-running task' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const shardId = manager.getActiveShards()[0]?.shardId;
    expect(shardId).toBeDefined();
    await new Promise(resolve => setTimeout(resolve, 60));

    expect(manager.getActiveCount()).toBe(0);
    const detached = manager.getRuntimeShardView(shardId as string, { transcriptLimit: 10 });
    expect(detached?.task.runtimeState).toBe('detached');
    expect(detached?.task.lifecycleState).toBe('offline');
    expect(detached?.task.artifactLifecycleState).toBe('pending');
    expect(detached?.resume.resumable).toBe(false);

    const result = await pending;
    expect(result.runtimeState).toBe('awaiting_delivery');
    expect(result.artifactLifecycleState).toBe('available');
    expect(result.stateReason).toBe('completed');

    const completed = manager.getRuntimeShardView(result.shardId, { transcriptLimit: 10 });
    expect(completed?.task.runtimeState).toBe('awaiting_delivery');
    expect(completed?.task.artifactLifecycleState).toBe('available');
    expect(completed?.resume).toEqual(expect.objectContaining({
      mode: 'delivery',
      resumable: true,
      artifactLifecycleState: 'available',
      deliveryPending: true,
    }));
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
    expect(degraded[0].lifecycleState).toBe('degraded');
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
    expect(recovered[0].lifecycleState).toBe('ready');
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
    const contactLookup = makeTestTool('contact_lookup');
    const repoStatus = makeTestTool('repo_status');
    const repoDiff = makeTestTool('repo_diff');
    const repoCommit = makeTestTool('repo_commit');
    const spawnShard = makeTestTool('spawn_shard');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'nursery' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contactLookup.tool],
        extended: [repoStatus.tool, repoDiff.tool, repoCommit.tool, spawnShard.tool],
      }),
    });

    await manager.spawn({ name: 'toolset-default', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toEqual(expect.arrayContaining(['toolset', ...DEFAULT_SHARD_TOOLSET]));
    expect(injected).not.toContain('repo_commit');
    expect(injected).not.toContain('spawn_shard');
  });

  it('unlocks additional shard tools for apprentice tier', async () => {
    const memory = makeTestTool('memory');
    const contactLookup = makeTestTool('contact_lookup');
    const contactList = makeTestTool('contact_list');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'apprentice' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contactLookup.tool, contactList.tool],
        extended: [],
      }),
    });

    await manager.spawn({ name: 'toolset-apprentice', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toContain('contact_list');
    expect(injected).toContain('memory');
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
    const contactLookup = makeTestTool('contact_lookup');
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
        shardToolsets: { nursery: ['contact_lookup'] },
      },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool, contactLookup.tool],
        extended: [repoStatus.tool],
      }),
    });

    await manager.spawn({ name: 'toolset-customized', task: 'test' });

    const injected = lastSetToolNames();
    expect(injected).toContain('contact_lookup');
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
    const contactLookup = makeTestTool('contact_lookup');
    const repoStatus = makeTestTool('repo_status');
    const repoDiff = makeTestTool('repo_diff');
    const repoCommit = makeTestTool('repo_commit');
    const spawnShard = makeTestTool('spawn_shard');

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
        core: [memory.tool, contactLookup.tool],
        extended: [repoStatus.tool, repoDiff.tool, repoCommit.tool, spawnShard.tool],
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
    expect(injected).toEqual(expect.arrayContaining(['toolset', ...DEFAULT_SHARD_TOOLSET]));
    expect(injected).not.toContain('repo_commit');
    expect(injected).not.toContain('spawn_shard');
  });

  it('stamps shard source provenance on shard memory tools', async () => {
    const memory = makeTestTool('memory');

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: 'apprentice' },
      parentSystemPrompt: 'test',
      toolCatalogProvider: () => ({
        core: [memory.tool],
        extended: [],
      }),
    });

    const result = await manager.spawn({ name: 'provenance', task: 'test' });
    const tools = (setToolsSpy.mock.calls.at(-1)?.[0] as Array<{ name: string; execute: (...args: any[]) => Promise<any> }>);
    const wrappedMemory = tools.find((tool) => tool.name === 'memory');

    await wrappedMemory?.execute('mem-call', { action: 'write', text: 'x', type: 'semantic' });
    await wrappedMemory?.execute('import-call', {
      action: 'import',
      records: [{ text: 'x', type: 'semantic' }],
    });
    await wrappedMemory?.execute('search-call', { action: 'search', query: 'x' });

    expect(memory.execute).toHaveBeenCalledWith(
      'mem-call',
      expect.objectContaining({
        action: 'write',
        __psfnShardSource: `shard:${result.shardId}`,
      }),
      undefined,
    );
    expect(memory.execute).toHaveBeenCalledWith(
      'import-call',
      expect.objectContaining({
        action: 'import',
        __psfnShardSource: `shard:${result.shardId}`,
      }),
      undefined,
    );
    expect(memory.execute).toHaveBeenCalledWith(
      'search-call',
      expect.not.objectContaining({
        __psfnShardSource: expect.any(String),
      }),
      undefined,
    );
  });

  it('denies disallowed shard-to-prime memory sync operations and audits the denial', async () => {
    const memory = makeTestTool('memory');
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
        core: [memory.tool],
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
    expect(memory.execute).not.toHaveBeenCalled();
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

describe('createSpawnShardTool', () => {
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

    const tool = createSpawnShardTool(manager);

    expect(tool.name).toBe('spawn_shard');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('spawn_shard');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
    expect(EXECUTION_PORT_FAMILIES).toEqual(['subagent', 'shard', 'artifact']);
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

    const tool = createSpawnShardTool(manager);
    const result = await tool.execute('call-1', { name: 'test-tool', task: 'do something' });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('Shard "test-tool" completed');
    expect(text).toContain('1 turn(s)');
    expect(text).toContain('0 tokens');  // pi-agent-core doesn't surface token counts
    expect(text).toContain('runtime=awaiting_delivery');
    expect(text).toContain('artifact=available');
    expect(text).toContain('[State reason: completed]');
    expect(text).toContain('[Runtime reason: artifact_ready]');
    expect(text).toContain('tool output');
  });

  it('routes shard results through the artifact return port boundary', async () => {
    const artifactReturnPort = {
      portFamily: 'artifact' as const,
      returnArtifact: vi.fn(shardArtifactReturnPort.returnArtifact),
    };

    const manager = new ShardManager({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test',
    });

    const tool = createSpawnShardTool(manager, artifactReturnPort);
    await tool.execute('call-artifact', { name: 'artifact-boundary', task: 'do thing' });

    expect(artifactReturnPort.returnArtifact).toHaveBeenCalled();
    const delivered = manager.getRuntimeSnapshot({ shardLimit: 10, transcriptLimit: 10 }).recentShards[0];
    expect(delivered.task.runtimeState).toBe('completed');
    expect(delivered.task.artifactLifecycleState).toBe('delivered');
  });

  it('surfaces explicit lifecycle failure diagnostics from shard results', async () => {
    const spawn = vi.fn(async () => ({
      shardId: 'shard-failure',
      name: 'degraded-shard',
      content: 'partial output',
      model: 'mock-model',
      inputTokens: 1,
      outputTokens: 2,
      durationMs: 33,
      turns: 1,
      lifecycleState: 'offline' as const,
      runtimeState: 'awaiting_delivery' as const,
      runtimeStateReason: 'artifact_ready',
      health: 'failed' as const,
      stateReason: 'heartbeat_timeout',
      artifactLifecycleState: 'available' as const,
      artifactAvailableAt: 33,
      failureReason: 'Heartbeat stale for 4200ms exceeded recovery window (4000ms).',
      capabilities: ['general'],
      requiredCapabilities: [],
      lineage: {
        coreCompanionId: 'companion',
        shardCompanionId: 'companion/shards/shard-failure',
        shardId: 'shard-failure',
      },
      gatewayRouting: {
        schemaVersion: 1,
        companionId: 'companion',
        shard: {
          coreCompanionId: 'companion',
          shardCompanionId: 'companion/shards/shard-failure',
          shardId: 'shard-failure',
        },
      },
    }));
    const tool = createSpawnShardTool({ spawn } as unknown as ShardManager);

    const result = await tool.execute('call-failure', {
      name: 'degraded-shard',
      task: 'diagnostic run',
    });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('[State reason: heartbeat_timeout]');
    expect(text).toContain('[Failure reason: Heartbeat stale for 4200ms exceeded recovery window (4000ms).]');
  });

  it('passes source request context into shard spawns', async () => {
    const spawn = vi.fn(async () => ({
      shardId: 'shard-test',
      name: 'ctx',
      content: 'ok',
      model: 'mock-model',
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 1,
      turns: 1,
      lifecycleState: 'offline' as const,
      runtimeState: 'awaiting_delivery' as const,
      runtimeStateReason: 'artifact_ready',
      health: 'healthy' as const,
      stateReason: 'completed',
      artifactLifecycleState: 'available' as const,
      artifactAvailableAt: 1,
      capabilities: ['general'],
      requiredCapabilities: [],
      lineage: {
        coreCompanionId: 'companion',
        shardCompanionId: 'companion/shards/shard-test',
        shardId: 'shard-test',
      },
      gatewayRouting: {
        schemaVersion: 1,
        companionId: 'companion',
        shard: {
          coreCompanionId: 'companion',
          shardCompanionId: 'companion/shards/shard-test',
          shardId: 'shard-test',
        },
      },
    }));
    const tool = createSpawnShardTool({ spawn } as unknown as ShardManager);

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

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
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

    const tool = createSpawnShardTool(manager);
    const result = await tool.execute('call-2', { name: 'fail', task: 'test' });

    const text = result.content.map((c: any) => c.text).join('');
    expect(text).toContain('Shard error');
    expect(result.details?.isError).toBe(true);
  });
});
