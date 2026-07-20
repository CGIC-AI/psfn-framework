import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CompletionNoticeBuffer } from '../../core/agent/completion-notices.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, type AgentTool } from '../../boundary/pi-agent/index.js';
import { resolveInstalledAgentTurnTools } from '../../boundary/pi-agent/agent-loop-patch.js';
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
import {
  buildSubagentWorkSpec,
  createSubagentWorkSpecProvider,
  SUBAGENT_WORK_SPEC_PURPOSE,
} from './work-spec.js';
import { assertWorkSpecLaneParity } from '../../primitives/llm/work-spec.js';
import { resolveAutonomousModelCallLane } from '../../primitives/llm/model-call-lane.js';
import { COMPANION_PRIVATE_BACKGROUND_PURPOSE } from '../../shared/contracts/runtime.js';
import { AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN } from '../../core/agent/turn-limits.js';
import { resetCompletionHandoffDedupeForTests } from '../../core/agent/completion-handoff.js';
import type { CompletionHandoffRecord } from '../../shared/contracts/completion-handoff.js';
import {
  withCapabilityRequirement,
  type CapabilityRequirementInput,
} from '../../system/capabilities/requirements.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';

let mockSubagentContent = 'subagent response';
let mockSubagentError: Error | null = null;
let mockSubagentDelayMs = 0;
let mockFirstPromptTools: AgentTool<any>[] = [];

const promptSpy = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
  mockFirstPromptTools = [...resolveInstalledAgentTurnTools(this)];
  if (mockSubagentError) throw mockSubagentError;
  if (mockSubagentDelayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, mockSubagentDelayMs));
  }
  this.state.messages.push({
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

function makeCatalogTool(name: string, requirement: CapabilityRequirementInput) {
  const execute = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: `${name} ok` }],
    details: { toolName: name },
  }));
  const tool = withCapabilityRequirement({
    name,
    description: `${name} test tool`,
    parameters: {},
    execute,
  } as AgentTool<any>, requirement);
  return { tool, execute };
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
  companionId: '11111111-1111-4111-8111-111111111111',
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
    mockFirstPromptTools = [];
    promptSpy.mockClear();
    resetCompletionHandoffDedupeForTests();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // Wiring proof (bead zet.7): an operator-set subagentMaxConcurrent in the
  // owner file reaches the live concurrency cap. Composition passes the full
  // SubstrateConfig as deps.config, and the spawn() concurrency_limit block is
  // covered by the existing behavior tests against the same resolved field.
  it('resolves the concurrency cap from owner-file settings (zet.7)', () => {
    const base = {
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      parentSystemPrompt: 'test prompt',
    };

    const fromSettings = new SubagentFaculty({
      ...base,
      config: { ...TEST_CONFIG, subagentMaxConcurrent: 3 },
    });
    expect(fromSettings.maxConcurrentTasks).toBe(3);

    const explicitOverride = new SubagentFaculty({
      ...base,
      config: { ...TEST_CONFIG, subagentMaxConcurrent: 9 },
      maxConcurrent: 2,
    });
    expect(explicitOverride.maxConcurrentTasks).toBe(2);

    // Compiled default preserved exactly when the setting is absent.
    const compiledDefault = new SubagentFaculty({ ...base, config: TEST_CONFIG });
    expect(compiledDefault.maxConcurrentTasks).toBe(8);
  });

  it('executes bounded subagent tasks with an independent registry and lifecycle', async () => {
    mockSubagentContent = 'task completed';
    const lifecycleEvents: Array<{
      handoff: CompletionHandoffRecord;
      targetChannelId?: string;
      noticeBuffered: boolean;
    }> = [];
    eventBus.on('agent.completion_handoff', event => {
      lifecycleEvents.push(event);
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
      name: 'inspect',
      task: 'inspect runtime state',
      workSpec: buildSubagentWorkSpec(),
    });

    expect(result.subagentId).toMatch(/^subagent-/);
    expect(result.workerLane).toBe('subagent');
    expect(result.lifecycleState).toBe('completed');
    expect(result.outcome).toBe('completed');
    expect(result.partial).toBeUndefined();
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
    expect(lifecycleEvents.map(event => event.handoff.status))
      .toEqual(['started', 'progress', 'completed']);
    expect(lifecycleEvents.every(event => (
      event.targetChannelId === undefined && event.noticeBuffered === false
    ))).toBe(true);
  });

  it('preserves a completed result when its terminal lifecycle sink rejects', async () => {
    eventBus.guard('agent.completion_handoff', event => {
      if (event.handoff.status === 'completed') {
        throw new Error('terminal lifecycle sink unavailable');
      }
      return true;
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
      name: 'terminal-handoff-failure',
      task: 'finish despite notification infrastructure failure',
      workSpec: buildSubagentWorkSpec(),
    });

    expect(result.outcome).toBe('completed');
    expect(faculty.getActiveCount()).toBe(0);
  });

  it('spawns a subagent whose context correlation carries companion_private (d8vq.4)', async () => {
    // The spawn gate (assertWorkSpecLaneParity) must reconcile — not throw
    // non-retryably — for a work spec built from a companion_private context.
    mockSubagentContent = 'private task completed';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const workSpec = buildSubagentWorkSpec({
      correlation: { telemetryVisibility: 'companion_private', channelId: 'api:parent' },
    });

    const task = await faculty.spawn({ name: 'private-inspect', task: 'inspect privately', workSpec });
    expect(task.subagentId).toMatch(/^subagent-/);

    const result = await faculty.wait(task.subagentId);
    expect(result.outcome).toBe('completed');
    expect(result.workerLane).toBe('subagent');
    expect(result.content).toBe('private task completed');
  });

  it.each<{
    tier: CapabilityTier;
    callable: string[];
  }>([
    {
      tier: 'nursery',
      callable: ['core_identity_read', 'extended_git_read'],
    },
    {
      tier: 'apprentice',
      callable: [
        'core_identity_read',
        'core_issue_write',
        'extended_git_read',
        'extended_world_read',
      ],
    },
    {
      tier: 'autonomous',
      callable: [
        'core_identity_read',
        'core_issue_write',
        'extended_git_read',
        'extended_world_read',
        'extended_companion_notify',
      ],
    },
  ])('assembles the full non-recursive catalog on the first $tier turn and capability-gates calls', async ({
    tier,
    callable,
  }) => {
    const definitions = [
      { scope: 'core' as const, name: 'core_identity_read', requirement: 'identity.read' as const },
      { scope: 'core' as const, name: 'core_issue_write', requirement: 'issue.write' as const },
      { scope: 'extended' as const, name: 'extended_git_read', requirement: 'git.read' as const },
      { scope: 'extended' as const, name: 'extended_world_read', requirement: 'world.read' as const },
      { scope: 'extended' as const, name: 'extended_companion_notify', requirement: 'external.companion' as const },
    ].map(definition => ({
      ...definition,
      ...makeCatalogTool(definition.name, definition.requirement),
    }));
    const blockedRecursive = makeCatalogTool('subagent', 'identity.read');
    const auditTrail = { append: vi.fn() };
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: { ...TEST_CONFIG, capabilityTier: tier },
      parentSystemPrompt: 'test prompt',
      toolCatalogProvider: () => ({
        core: [
          ...definitions.filter(definition => definition.scope === 'core').map(definition => definition.tool),
          blockedRecursive.tool,
        ],
        extended: definitions
          .filter(definition => definition.scope === 'extended')
          .map(definition => definition.tool),
      }),
      auditTrail,
    });

    await faculty.execute({ name: `${tier}-catalog`, task: 'exercise the first-turn catalog', workSpec: buildSubagentWorkSpec() });

    const catalogNames = definitions.map(definition => definition.name);
    const firstTurnTools = new Map(
      mockFirstPromptTools
        .filter(tool => catalogNames.includes(tool.name))
        .map(tool => [tool.name, tool] as const),
    );
    expect([...firstTurnTools.keys()]).toEqual(expect.arrayContaining(catalogNames));
    expect(mockFirstPromptTools.map(tool => tool.name)).not.toContain('subagent');
    expect(auditTrail.append).toHaveBeenCalledWith('subagent.tools.injected', expect.objectContaining({
      tier,
      tools: catalogNames,
    }));

    for (const definition of definitions) {
      const result = await firstTurnTools.get(definition.name)!.execute(`call-${definition.name}`, {});
      const authorized = callable.includes(definition.name);
      expect((result.details as { capabilityDenied?: boolean }).capabilityDenied === true)
        .toBe(!authorized);
      expect(definition.execute).toHaveBeenCalledTimes(authorized ? 1 : 0);
    }
    expect(blockedRecursive.execute).not.toHaveBeenCalled();
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
      workSpec: buildSubagentWorkSpec(),
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
      workSpec: buildSubagentWorkSpec(),
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
      workSpec: buildSubagentWorkSpec(),
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
    const completionNotices = new CompletionNoticeBuffer();
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      completionNotices,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    const result = await faculty.execute({
      name: 'handoff',
      task: 'inspect completion handoff behavior',
      workSpec: buildSubagentWorkSpec(),
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-parent',
        turnId: 'turn-parent',
        originatingBeadId: 'PSFNLIVE-hlh0',
      },
    });
    const replay = await faculty.wait(result.subagentId);

    expect(replay.subagentId).toBe(result.subagentId);
    // Handoffs never write session entries; the parent transcript stays clean.
    expect(sessionStore.getRecent('api:parent', 10)).toHaveLength(0);
    const notices = completionNotices.peek('api:parent');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: 'completed' });
    expect(events.map(event => (event as { handoff: CompletionHandoffRecord }).handoff.status))
      .toEqual(['started', 'progress', 'completed']);
    expect(events.at(-1)).toMatchObject({
      noticeBuffered: true,
      handoff: expect.objectContaining({
        source: 'subagent',
        task: expect.objectContaining({ subagentId: result.subagentId }),
        origin: expect.objectContaining({ originatingBeadId: 'PSFNLIVE-hlh0' }),
        privacy: expect.objectContaining({
          partnerNotification: 'policy_gated_companion_authored',
        }),
      }),
    });
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
      workSpec: buildSubagentWorkSpec(),
    });

    const cancelled = await faculty.cancel(task.subagentId, 'operator_cancelled');

    expect(cancelled.lifecycleState).toBe('cancelled');
    expect(cancelled.outcome).toBe('cancelled');
    expect(cancelled.partial).toBeDefined();
    expect(cancelled.partial?.remainingBudget.remainingTurns).toBeGreaterThanOrEqual(0);
    expect(cancelled.stateReason).toBe('cancel_requested');
    expect(cancelled.failureReason).toBe('operator_cancelled');
    expect(faculty.getActiveCount()).toBe(0);
    expect(faculty.getRecentTasks(1)[0]).toMatchObject({
      subagentId: task.subagentId,
      lifecycleState: 'cancelled',
      workerLane: 'subagent',
    });
  });

  // mmo9.7.7 (P1 regression): a cancel that aborts an in-flight turn — surfacing
  // as a throw from handleMessage — must preserve the accumulated partial. The
  // catch path reads the hoisted accumulators, so tokens/turns and the last
  // completed turn's checkpoint survive rather than being zeroed.
  it('preserves the accumulated partial when cancel aborts an in-flight turn', async () => {
    const handoffs: Array<{ handoff: CompletionHandoffRecord }> = [];
    eventBus.on('agent.completion_handoff', event => {
      handoffs.push(event);
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

    let subagentId = '';
    promptSpy
      // Turn 0 completes normally with real usage + content.
      .mockImplementationOnce(async function (this: Agent) {
        this.state.messages.push({
          role: 'assistant',
          content: [{ type: 'text' as const, text: 'turn one output' }],
          api: '' as any,
          provider: '' as any,
          model: 'turn-0-model',
          usage: {
            input: 10,
            output: 42,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 52,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop' as any,
          timestamp: Date.now(),
        });
      })
      // Turn 1 is in-flight when the cancel lands, then aborts (throws).
      .mockImplementationOnce(async function (this: Agent) {
        void faculty.cancel(subagentId, 'operator_cancelled');
        throw new Error('aborted mid-turn');
      });

    const task = await faculty.spawn({
      name: 'cancel-mid-turn',
      task: 'run several turns',
      maxTurns: 3,
      workSpec: buildSubagentWorkSpec(),
    });
    subagentId = task.subagentId;
    const result = await faculty.wait(task.subagentId);

    expect(result.outcome).toBe('cancelled');
    // The completed turn's work is preserved, not discarded (the bug reported 0).
    expect(result.turns).toBe(1);
    expect(result.content).toBe('turn one output');
    expect(result.outputTokens).toBe(42);
    expect(result.inputTokens).toBe(10);
    // The completed turn's model is retained (the zeroing bug reported '').
    expect(result.model).not.toBe('');
    expect(result.partial?.latestCheckpoint).toMatchObject({
      content: 'turn one output',
      turnsCompleted: 1,
    });
    expect(result.partial?.latestCheckpoint.model).not.toBe('');
    expect(result.partial?.remainingBudget.remainingTurns).toBe(2);
    expect(handoffs.at(-1)?.handoff).toMatchObject({
      status: 'cancelled',
      result: { partial: true },
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
      workSpec: buildSubagentWorkSpec(),
      capabilities: ['general'],
      requiredCapabilities: ['missing-capability'],
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-blocked',
        turnId: 'turn-blocked',
      },
    })).rejects.toThrow('missing required capability');

    // Blocked handoffs are event-bus records only; no transcript writes.
    expect(sessionStore.getRecent('api:parent', 10)).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      handoff: expect.objectContaining({
        status: 'blocked',
        blocker: expect.objectContaining({ reason: 'missing_capabilities' }),
      }),
    });
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
    // Handoffs no longer appear in the delegated transcript.
    expect(handoffEntries).toHaveLength(0);
    expect(result.gatewayRouting).toEqual({
      schemaVersion: 1,
      companionId: '11111111-1111-4111-8111-111111111111',
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
        companionId: '11111111-1111-4111-8111-111111111111',
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
            companionId: '11111111-1111-4111-8111-111111111111',
            shard: {
              coreCompanionId: '11111111-1111-4111-8111-111111111111',
              shardCompanionId: '11111111-1111-4111-8111-111111111111/shards/shard-parent',
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

    expect(result.gatewayRouting.companionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.lineage).toEqual({
      coreCompanionId: '11111111-1111-4111-8111-111111111111',
      shardCompanionId: '11111111-1111-4111-8111-111111111111/shards/shard-parent',
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
      workSpec: buildSubagentWorkSpec(),
    })).rejects.toThrow(/No eligible model configured for purpose 'background'/);
  });

  // mmo9.7.7: a bounded run that throws mid-execution reports the honest
  // `blocked` outcome (never masquerading as completed) with a partial record.
  it('reports a blocked outcome with a partial record when execution throws', async () => {
    mockSubagentError = new Error('worker crashed');
    const handoffs: Array<{ handoff: CompletionHandoffRecord }> = [];
    eventBus.on('agent.completion_handoff', event => {
      handoffs.push(event);
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

    const task = await faculty.spawn({
      name: 'crasher',
      task: 'do work that fails',
      maxTurns: 3,
      workSpec: buildSubagentWorkSpec(),
      sourceContext: {
        channelId: 'api:parent',
        requestId: 'msg-crasher',
      },
    });
    const result = await faculty.wait(task.subagentId);

    expect(result.lifecycleState).toBe('failed');
    expect(result.outcome).toBe('blocked');
    expect(result.failureReason).toContain('worker crashed');
    expect(result.partial).toBeDefined();
    expect(result.partial?.latestCheckpoint).toMatchObject({
      content: '',
      turnsCompleted: 0,
      model: '',
    });
    // No turns ran, so the full turn budget remains.
    expect(result.partial?.remainingBudget.remainingTurns).toBe(3);
    expect(handoffs.map(event => event.handoff.status)).toEqual(['started', 'blocked']);

    // execute() surfaces the honest non-completed outcome as a throw.
    await expect(faculty.execute({
      name: 'crasher-2',
      task: 'fail again',
      workSpec: buildSubagentWorkSpec(),
    })).rejects.toThrow(/blocked/);
  });

  // mmo9.7.7: a multi-turn run curtailed by a declared work-spec deadline reports
  // `budget_limited` with remaining budget + the latest checkpoint, so a caller
  // can resume or account for the work done.
  it('reports budget_limited with remaining budget and a checkpoint when the deadline is crossed', async () => {
    mockSubagentContent = 'partial progress';
    mockSubagentDelayMs = 25;
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
      name: 'budgeted',
      task: 'work until the budget runs out',
      maxTurns: 5,
      workSpec: buildSubagentWorkSpec({ deadlineMs: 5 }),
    });
    const result = await faculty.wait(task.subagentId);

    expect(result.lifecycleState).toBe('failed');
    expect(result.outcome).toBe('budget_limited');
    expect(result.failureReason).toContain('deadline');
    // Curtailed after the first turn, well before the 5-turn ceiling.
    expect(result.turns).toBe(1);
    expect(result.content).toBe('partial progress');
    expect(result.partial).toBeDefined();
    expect(result.partial?.remainingBudget.remainingTurns).toBe(4);
    expect(result.partial?.remainingBudget.remainingDeadlineMs).toBeLessThanOrEqual(0);
    expect(result.partial?.latestCheckpoint).toMatchObject({
      content: 'partial progress',
      turnsCompleted: 1,
    });
  });

  // mmo9.7.7: an output-token ceiling curtails a multi-turn run the same way.
  it('reports budget_limited when the output-token ceiling is reached', async () => {
    mockSubagentContent = 'token-heavy output';
    const faculty = new SubagentFaculty({
      eventBus,
      llmProvider: mockLLM(),
      sessionStore,
      embeddingService: null,
      memoryProvider: null,
      config: TEST_CONFIG,
      parentSystemPrompt: 'test prompt',
    });

    // The mocked worker turn accumulates 0 output tokens, so a ceiling of 0 is
    // reached immediately (>= comparison) — deterministic without real usage.
    const task = await faculty.spawn({
      name: 'token-budgeted',
      task: 'emit until the token budget runs out',
      maxTurns: 4,
      workSpec: buildSubagentWorkSpec({ maxOutputTokens: 0 }),
    });
    const result = await faculty.wait(task.subagentId);

    expect(result.outcome).toBe('budget_limited');
    expect(result.failureReason).toContain('output-token');
    expect(result.partial?.remainingBudget.remainingOutputTokens).toBe(0);
    expect(result.partial?.remainingBudget.remainingTurns).toBe(3);
  });
});

describe('subagent work spec seam (mmo9.7.7)', () => {
  it('builds a background work spec whose declared lane reconciles with the resolver', () => {
    const spec = buildSubagentWorkSpec();
    expect(spec.purpose).toBe(SUBAGENT_WORK_SPEC_PURPOSE);
    expect(spec.durable).toBe(false);
    // Fails closed (throws) if the declared lane drifts from the single resolver.
    expect(() => assertWorkSpecLaneParity(spec)).not.toThrow();

    const seeded = buildSubagentWorkSpec({
      correlation: { channelId: 'api:parent', requestId: 'req-1' },
      deadlineMs: 1000,
      maxOutputTokens: 4096,
    });
    expect(seeded.deadlineMs).toBe(1000);
    expect(seeded.maxOutputTokens).toBe(4096);
    expect(seeded.correlation?.channelId).toBe('api:parent');
    expect(() => assertWorkSpecLaneParity(seeded)).not.toThrow();
  });

  it('collapses a companion_private context correlation to a background-safe spec (d8vq.4)', () => {
    // Regression: a context correlation carrying companion_private telemetry
    // visibility drives the single lane resolver's private short-circuit, which
    // would override a stamped originStage. The builder adopts the canonical
    // collapsed telemetry shape so the stored correlation agrees with that
    // short-circuit and the spawn gate reconciles instead of throwing.
    const spec = buildSubagentWorkSpec({
      correlation: { telemetryVisibility: 'companion_private', channelId: 'api:parent', requestId: 'req-1' },
    });
    expect(spec.purpose).toBe(SUBAGENT_WORK_SPEC_PURPOSE);
    expect(spec.correlation?.telemetryVisibility).toBe('companion_private');
    // Origin/purpose are collapsed to the canonical background-safe value, not the
    // subagent 'subagent.turn' stamp (which the private short-circuit would drop).
    expect(spec.correlation?.callType).toBe('background');
    expect(spec.correlation?.originStage).toBe(COMPANION_PRIVATE_BACKGROUND_PURPOSE);
    expect(spec.correlation?.purpose).toBe(COMPANION_PRIVATE_BACKGROUND_PURPOSE);
    // Parity holds by construction — the spawn gate never throws.
    expect(() => assertWorkSpecLaneParity(spec)).not.toThrow();
    // The declared lane is invariant to the private short-circuit: deriving from
    // the stored correlation with the private flag stripped lands on the same lane.
    const { telemetryVisibility: _dropped, ...withoutPrivate } = spec.correlation ?? {};
    expect(resolveAutonomousModelCallLane(spec.purpose, withoutPrivate)).toBe(spec.lane);
  });

  it('threads the work spec onto stream calls that carry no spec of their own', async () => {
    const spec = buildSubagentWorkSpec();
    const response: LLMResponse = {
      content: 'x',
      toolCalls: [],
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    };
    const inner: LLMProvider = {
      stream: vi.fn(async () => response),
      complete: vi.fn(async () => response),
    };
    const wrapped = createSubagentWorkSpecProvider(inner, spec);

    await wrapped.stream({ messages: [] } as any);
    expect(inner.stream).toHaveBeenCalledWith(
      { messages: [] },
      undefined,
      expect.objectContaining({ workSpec: spec }),
    );

    // An already-declared stream spec is never overridden.
    const otherSpec = buildSubagentWorkSpec({ correlation: { channelId: 'api:other' } });
    await wrapped.stream({ messages: [] } as any, undefined, { workSpec: otherSpec });
    expect(inner.stream).toHaveBeenLastCalledWith(
      { messages: [] },
      undefined,
      expect.objectContaining({ workSpec: otherSpec }),
    );
  });

  it('threads the spec onto complete calls only when the purpose matches', async () => {
    const spec = buildSubagentWorkSpec();
    const response: LLMResponse = {
      content: 'x',
      toolCalls: [],
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    };
    const inner: LLMProvider = {
      stream: vi.fn(async () => response),
      complete: vi.fn(async () => response),
    };
    const wrapped = createSubagentWorkSpecProvider(inner, spec);

    // Purpose matches the spec (background) → attributed.
    await wrapped.complete({ messages: [] } as any, 'background');
    expect(inner.complete).toHaveBeenLastCalledWith(
      { messages: [] },
      'background',
      expect.objectContaining({ workSpec: spec }),
    );

    // Purpose differs → never mis-attributed (fail closed): no workSpec injected.
    await wrapped.complete({ messages: [] } as any, 'memory');
    const memoryCallOptions = (inner.complete as any).mock.calls.at(-1)?.[2];
    expect(memoryCallOptions?.workSpec).toBeUndefined();
  });
});
