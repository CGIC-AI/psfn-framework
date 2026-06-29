import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import type { LLMProviderPort as LLMProvider } from '../../core/agent/contracts.js';
import { SUBAGENT_WORKER_LANE } from '../../core/agent/worker-lanes.js';
import type {
  CanonicalModelRegistry,
  LLMResponse,
  ModelRegistryEntry,
  ModelSlot,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { SubagentFaculty } from './faculty.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import { resetCompletionHandoffDedupeForTests } from '../../core/agent/completion-handoff.js';

let mockSubagentContent = 'subagent response';
let mockSubagentError: Error | null = null;
let mockSubagentDelayMs = 0;

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  if (mockSubagentError) throw mockSubagentError;
  if (mockSubagentDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, mockSubagentDelayMs));
  }
  this.appendMessage({
    role: 'assistant',
    content: [{ type: 'text' as const, text: mockSubagentContent }],
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

function createEntry(
  id: string,
  rank: number,
  slot: ModelSlot,
  purposes: ModelRegistryEntry['purposes'],
): ModelRegistryEntry {
  return {
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
  };
}

function buildTestRegistry(chat: ModelSlot, background: ModelSlot): CanonicalModelRegistry {
  return {
    schemaVersion: 1,
    models: [
      createEntry('chat', 10, chat, [{ purpose: 'chat', primary: true }]),
      createEntry('background', 20, background, [{ purpose: 'background', primary: true }]),
    ],
  };
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

const CHAT_SLOT: ModelSlot = {
  model: 'deepseek/deepseek-v3.2',
  provider: 'openrouter',
  maxTokens: 16384,
  contextWindow: 128_000,
};

const BACKGROUND_SLOT: ModelSlot = {
  model: 'deepseek/deepseek-v3.2',
  provider: 'openrouter',
  maxTokens: 8192,
  contextWindow: 128_000,
};

const TEST_CONFIG: SubstrateConfig = {
  primaryModel: 'deepseek/deepseek-v3.2',
  primaryProvider: 'openrouter',
  extractionModel: 'deepseek/deepseek-v3.2',
  extractionProvider: 'openrouter',
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
  companionId: 'companion',
  characterName: 'Companion',
  modelRoster: {
    chat: CHAT_SLOT,
    background: BACKGROUND_SLOT,
  },
  modelRegistry: buildTestRegistry(CHAT_SLOT, BACKGROUND_SLOT),
};

describe('SubagentFaculty', () => {
  let root: string;
  let eventBus: EventBus;
  let sessionStore: SessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psfn-subagent-'));
    eventBus = new EventBus();
    sessionStore = new SessionStore(root);
    mockSubagentContent = 'subagent response';
    mockSubagentError = null;
    mockSubagentDelayMs = 0;
    promptSpy.mockClear();
    resetCompletionHandoffDedupeForTests();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('executes bounded subagent tasks with an independent registry and lifecycle', async () => {
    mockSubagentContent = 'task completed';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'inspect',
      task: 'inspect runtime state',
    });

    expect(result.subagentId).toMatch(/^subagent-/);
    expect(result.workerLane).toBe('subagent');
    expect(result.lifecycleState).toBe('completed');
    expect(result.content).toBe('task completed');
    expect(faculty.getActiveCount()).toBe(0);
    expect(faculty.getRecentTasks(1)).toEqual([
      expect.objectContaining({
        subagentId: result.subagentId,
        lifecycleState: 'completed',
        channelId: `subagent:${result.subagentId}`,
        workerLane: 'subagent',
      }),
    ]);

    const entries = sessionStore.getRecent(`subagent:${result.subagentId}`, 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      role: 'system',
      authorId: 'system:subagent-task',
      authorName: 'SubagentTask',
    });
    expect(parseEntryMetadata(entries[0] ?? {})).toMatchObject({
      turn: { speakerRole: 'system' },
    });
    expect(entries[0]?.content).toBe('[SYSTEM: SubagentTask] inspect runtime state');
    expect(entries[1]?.content).toBe('task completed');
  });

  it('caps explicit multi-turn subagent requests at the shared agent loop ceiling', async () => {
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'deep-inspect',
      task: 'inspect until complete',
      maxTurns: 999,
    });

    expect(result.turns).toBe(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN);
    expect(promptSpy).toHaveBeenCalledTimes(AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN);
  });

  it('exposes operator-visible runtime snapshots with transcripts, artifacts, and resume state', async () => {
    mockSubagentContent = 'task completed';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'snapshot',
      task: 'capture runtime state',
    });

    const snapshot = faculty.getRuntimeSnapshot({ transcriptLimit: 10 });
    expect(snapshot.activeCount).toBe(0);
    expect(snapshot.recentTasks).toHaveLength(1);

    const [taskView] = snapshot.recentTasks;
    expect(taskView).toMatchObject({
      task: expect.objectContaining({
        subagentId: result.subagentId,
        lifecycleState: 'completed',
        workerLane: 'subagent',
      }),
      transcriptMessageCount: 2,
      transcriptTruncated: false,
      resume: {
        channelId: `subagent:${result.subagentId}`,
        lifecycleState: 'completed',
        resumable: false,
        transcriptAvailable: true,
        transcriptMessageCount: 2,
        transcriptTruncated: false,
        lastActivityAt: expect.any(Number),
        lastMessageId: expect.any(Number),
      },
    });
    expect(taskView.transcript).toHaveLength(2);
    expect(taskView.transcript[0]).toMatchObject({
      role: 'system',
      authorId: 'system:subagent-task',
      authorName: 'SubagentTask',
    });
    expect(taskView.transcript[0]?.content).toBe('[SYSTEM: SubagentTask] capture runtime state');
    expect(taskView.transcript[1]?.content).toBe('task completed');
    expect(taskView.artifacts).toEqual([
      expect.objectContaining({
        kind: 'final_output',
        content: 'task completed',
      }),
    ]);
  });

  it('supports bounded spawn, follow-up message delivery, wait, and status detail lookup', async () => {
    mockSubagentContent = 'interactive result';
    mockSubagentDelayMs = 20;
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const task = await faculty.spawn({
      name: 'inspect',
      task: 'inspect runtime state',
    });
    expect(task.lifecycleState).toBe('queued');

    await faculty.message(task.subagentId, 'look at uncommitted changes first');
    const result = await faculty.wait(task.subagentId);

    expect(result.lifecycleState).toBe('completed');
    expect(result.content).toBe('interactive result');

    const detail = faculty.getRuntimeTaskDetail(task.subagentId, { transcriptLimit: 10 });
    expect(detail?.result).toMatchObject({
      subagentId: task.subagentId,
      lifecycleState: 'completed',
    });
    expect(detail?.view.task.lifecycleState).toBe('completed');
    const followUpEntry = detail?.view.transcript.find(entry => entry.content.includes('look at uncommitted changes first'));
    expect(followUpEntry).toMatchObject({
      role: 'system',
      authorId: 'system:subagent-control',
      authorName: 'SubagentControl',
    });
    expect(faculty.getResult(task.subagentId)).toMatchObject({
      subagentId: task.subagentId,
      lifecycleState: 'completed',
    });
  });

  it('emits a replay-guarded completion handoff to the parent companion context', async () => {
    mockSubagentContent = 'handoff result with implementation details';
    const events: unknown[] = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event);
    });
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'handoff',
      task: 'inspect completion handoff behavior',
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-parent',
        turnId: 'turn-parent',
        originatingBeadId: 'PSFNLIVE-hlh0',
      },
    });
    const replay = await faculty.wait(result.subagentId);

    const entries = sessionStore.getRecent('api:parent', 10);
    expect(replay.subagentId).toBe(result.subagentId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      role: 'system',
      authorId: 'system:completion-handoff',
      authorName: 'CompletionHandoff',
    });
    expect(parseEntryMetadata(entries[0] ?? {})).toMatchObject({
      type: 'completion_handoff',
      status: 'completed',
      partialResult: false,
    });
    expect(entries[0]?.content).toContain('"source": "subagent"');
    expect(entries[0]?.content).toContain(`"subagentId": "${result.subagentId}"`);
    expect(entries[0]?.content).toContain('"originatingBeadId": "PSFNLIVE-hlh0"');
    expect(entries[0]?.content).toContain('policy_gated_companion_authored');
    expect(entries[0]?.content).toContain('not partner-authored speech');
    expect(events).toHaveLength(1);
  });

  it('cancels active bounded workers without crossing into shard semantics', async () => {
    mockSubagentContent = 'late result';
    mockSubagentDelayMs = 50;
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const task = await faculty.spawn({
      name: 'cancel-me',
      task: 'hold position',
    });

    const cancelled = await faculty.cancel(task.subagentId, 'operator_cancelled');

    expect(cancelled.lifecycleState).toBe('cancelled');
    expect(cancelled.stateReason).toBe('cancel_requested');
    expect(cancelled.failureReason).toBe('operator_cancelled');
    expect(faculty.getActiveCount()).toBe(0);
    expect(faculty.getRecentTasks(1)[0]).toMatchObject({
      subagentId: task.subagentId,
      lifecycleState: 'cancelled',
      workerLane: 'subagent',
    });
  });

  it('emits blocked handoff when subagent spawn policy rejects required capabilities', async () => {
    const events: unknown[] = [];
    eventBus.on('agent.completion_handoff', event => {
      events.push(event);
    });
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    await expect(faculty.execute({
      name: 'blocked',
      task: 'requires unavailable capability',
      capabilities: ['general'],
      requiredCapabilities: ['missing-capability'],
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-blocked',
        turnId: 'turn-blocked',
      },
    })).rejects.toThrow('missing required capability');

    const entries = sessionStore.getRecent('api:parent', 10);
    expect(entries).toHaveLength(1);
    expect(parseEntryMetadata(entries[0] ?? {})).toMatchObject({
      type: 'completion_handoff',
      status: 'blocked',
      partialResult: false,
    });
    expect(entries[0]?.content).toContain('"reason": "missing_capabilities"');
    expect(entries[0]?.content).toContain('policy_gated_companion_authored');
    expect(events).toHaveLength(1);
  });

  it('delegates Wyoming sessions through subagent lifecycle without shard ids', async () => {
    mockSubagentContent = 'wyoming delegated response';
    const auditTrail = {
      append: vi.fn(),
    };
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
      auditTrail,
    });

    const result = await faculty.delegateWyomingSession({
      message: {
        id: 'wyoming-msg-1',
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
        turnId: 'wyoming-turn-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-kitchen',
      },
    });

    expect(result.subagentId).toMatch(/^subagent-/);
    const recentTask = faculty.getRecentTasks(1)[0];
    expect(recentTask).toMatchObject({
      subagentId: result.subagentId,
      channelId: 'api:wyoming:ha-main:voice-pe-kitchen',
      lifecycleState: 'completed',
      workerLane: 'subagent',
      capabilities: ['wyoming', 'wyoming:ha-main', 'wyoming:ha-main:voice-pe-kitchen'],
    });

    const delegatedEntries = sessionStore.getRecent('api:wyoming:ha-main:voice-pe-kitchen', 10);
    const visibleTranscriptEntries = delegatedEntries.filter(entry => !isCompletionHandoffEntry(entry));
    const handoffEntries = delegatedEntries.filter(isCompletionHandoffEntry);
    expect(visibleTranscriptEntries).toHaveLength(2);
    expect(visibleTranscriptEntries[0]).toMatchObject({
      role: 'user',
      authorId: 'wyoming-user:owner',
      authorName: 'Wyoming Voice User',
    });
    expect(parseEntryMetadata(visibleTranscriptEntries[0] ?? {})).toMatchObject({
      turn: { speakerRole: 'user' },
    });
    expect(visibleTranscriptEntries[0]?.content).toBe('status check');
    expect(visibleTranscriptEntries[1]?.content).toBe('wyoming delegated response');
    expect(handoffEntries).toHaveLength(1);
    expect(handoffEntries[0]?.content).toContain('"source": "subagent"');
    expect(handoffEntries[0]?.content).toContain('policy_gated_companion_authored');
    expect(result.gatewayRouting).toEqual({
      schemaVersion: 1,
      companionId: 'companion',
      subagentAddress: {
        executionPort: 'subagent',
        workerId: result.subagentId,
        lane: SUBAGENT_WORKER_LANE,
      },
    });
    expect(result.lineage).toBeUndefined();
    expect(auditTrail.append).toHaveBeenCalledWith(
      'wyoming.subagent.delegate.start',
      expect.objectContaining({
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
        turnId: 'wyoming-turn-1',
      }),
    );
    expect(auditTrail.append).toHaveBeenCalledWith(
      'wyoming.subagent.delegate.end',
      expect.objectContaining({
        subagentId: result.subagentId,
        status: 'completed',
        companionId: 'companion',
        connectionId: 'conn-kitchen',
        sessionId: 'session-kitchen',
      }),
    );
  });

  it('preserves shard lineage separately from subagent addressing for nested Wyoming delegation', async () => {
    mockSubagentContent = 'nested delegated response';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.delegateWyomingSession({
      message: {
        id: 'wyoming-msg-nested',
        channelId: 'api:wyoming:ha-main:voice-pe-den',
        channelType: 'api',
        authorId: 'wyoming-user:owner',
        authorName: 'Wyoming Voice User',
        content: 'follow up',
        isDirectMessage: true,
        timestamp: new Date('2026-02-26T12:00:00.000Z'),
        routing: {
          gateway: {
            schemaVersion: 1,
            companionId: 'companion-alpha',
            shard: {
              coreCompanionId: 'companion-alpha',
              shardCompanionId: 'companion-alpha/shards/shard-parent',
              shardId: 'shard-parent',
              parentShardId: 'shard-grandparent',
            },
            subagentAddress: {
              executionPort: 'subagent',
              workerId: 'worker-7',
              lane: 'subagent',
            },
          },
        },
      },
      routing: {
        connectionId: 'conn-nested',
        sessionId: 'session-nested',
        turnId: 'wyoming-turn-nested-1',
        siteId: 'ha-main',
        satelliteId: 'voice-pe-den',
      },
    });

    expect(result.gatewayRouting.companionId).toBe('companion-alpha');
    expect(result.lineage).toEqual({
      coreCompanionId: 'companion-alpha',
      shardCompanionId: 'companion-alpha/shards/shard-parent',
      shardId: 'shard-parent',
      creationMode: 'fresh',
      parentShardId: 'shard-grandparent',
    });
    expect(result.gatewayRouting.subagentAddress).toEqual({
      executionPort: 'subagent',
      workerId: result.subagentId,
      lane: SUBAGENT_WORKER_LANE,
    });
  });

  it('fails closed when the task-focused worker model slot is unavailable', async () => {
    const chatOnlyConfig: SubstrateConfig = {
      ...TEST_CONFIG,
      modelRoster: {
        chat: CHAT_SLOT,
      },
      modelRegistry: {
        schemaVersion: 1,
        models: [
          createEntry('chat', 10, CHAT_SLOT, [{ purpose: 'chat', primary: true }]),
        ],
      },
    };
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: chatOnlyConfig,
      parentSystemPrompt: 'test prompt',
    });

    await expect(faculty.execute({
      name: 'inspect',
      task: 'inspect runtime state',
    })).rejects.toThrow(/No eligible model configured for purpose 'background'/);
  });
});
