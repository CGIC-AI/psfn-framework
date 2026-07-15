import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventBus } from '../../../shared/event-bus.js';
import { SessionManager } from '../../session/manager.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { createTurnId } from '../../turns/id.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { TurnSupportRuntime } from './turn-support-runtime.js';
import { IntrospectionTurnSensitivityDecisions } from '../../../faculties/introspection/turn-sensitivity.js';
import type { BackgroundWorkSupervisor } from '../background-work/supervisor.js';

function flushAsyncWork(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function makeConfig(overrides?: Partial<SubstrateConfig>): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16_384, contextWindow: 1_000 },
    },
    ...overrides,
  };
}

describe('TurnSupportRuntime role-envelope projections', () => {
  let dir: string;
  let store: SessionStore;
  let sessionManager: SessionManager;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turn-support-runtime-'));
    store = new SessionStore(dir);
    sessionManager = new SessionManager(store, makeConfig({ dataDir: dir }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('buildTurnRecord lifts promoted role-envelope refs from stored session previews', () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager,
      backgroundWorkSupervisor: null,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const channelId = 'api:runtime-role-envelope';
    const turnId = createTurnId();
    const requestId = 'runtime-role-envelope-turn';
    const timestamp = new Date('2026-03-17T14:00:00.000Z');

    const userSessionEntryId = sessionManager.recordUserMessage(
      channelId,
      'Please check in tomorrow if I disappear.',
      'user-1',
      'User',
      undefined,
      undefined,
      {
        turnId,
        requestId,
      },
    );
    const assistantSessionEntryId = sessionManager.recordAssistantMessage(
      channelId,
      'Queued a gentle follow-up reminder for tomorrow.',
      undefined,
      undefined,
      undefined,
      {
        turnId,
        requestId,
        roleEnvelopePreview: {
          schemaVersion: 1,
          envelopeId: 'env_runtime_projection_1',
          internalRole: 'outreach_candidate',
          summary: 'Queued a gentle follow-up reminder for tomorrow.',
          sourceStage: 'post_turn_appraisal',
          promotionTarget: 'turn_record_summary',
          promotedRef: 'turn_record_summary:env_runtime_projection_1',
        },
      },
    );

    const record = runtime.buildTurnRecord({
      message: {
        id: requestId,
        channelId,
        channelType: 'api',
        authorId: 'user-1',
        authorName: 'User',
        content: 'Please check in tomorrow if I disappear.',
        timestamp,
      },
      turnId,
      requestId,
      startedAt: timestamp.getTime(),
      completedAt: timestamp.getTime() + 50,
      userSessionEntryId,
      assistantSessionEntryId,
      response: {
        content: 'Queued a gentle follow-up reminder for tomorrow.',
        channelId,
        metadata: {
          model: 'test-model',
          inputTokens: 42,
          outputTokens: 11,
          durationMs: 50,
        },
      },
      turnMessages: [],
      promptMode: 'default',
      promptText: 'System prompt',
      contextMessageCount: 2,
      memoryContextChars: 0,
      trustLevel: 'regular',
      speakerRole: 'user',
      retrievalProvenanceRefs: [],
    });

    expect(record.roleEnvelopeRefs).toEqual(['turn_record_summary:env_runtime_projection_1']);
  });

  it('consumes only a companion-owned current-turn sensitivity decision into durable privacy provenance', () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager,
      backgroundWorkSupervisor: null,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const decisions = new IntrospectionTurnSensitivityDecisions();
    runtime.setIntrospectionTurnSensitivityDecisions(decisions);
    const turnId = createTurnId();
    const requestId = 'runtime-audit-sensitivity-turn';
    decisions.mark({ turnId, requestId, sensitivity: 'non_intimate' });
    const input = {
      message: {
        id: requestId,
        channelId: 'api:public-room',
        channelType: 'api' as const,
        authorId: 'user-1',
        authorName: 'User',
        content: 'Compare these public project plans.',
        timestamp: new Date('2026-07-13T14:00:00.000Z'),
        isDirectMessage: false,
        routing: { channelPrivacy: 'public' as const },
      },
      turnId,
      requestId,
      startedAt: 1_773_669_600_000,
      completedAt: 1_773_669_600_050,
      userSessionEntryId: null,
      assistantSessionEntryId: null,
      response: {
        content: 'I would compare cost and reversibility first.',
        channelId: 'api:public-room',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 10,
          durationMs: 50,
        },
      },
      turnMessages: [],
      promptMode: 'default' as const,
      promptText: 'System prompt',
      contextMessageCount: 1,
      memoryContextChars: 0,
      trustLevel: 'regular' as const,
      speakerRole: 'user' as const,
      retrievalProvenanceRefs: [],
    };

    expect(runtime.buildTurnRecord(input).auditPrivacy).toMatchObject({
      contentMode: 'verbatim_public',
      contentSensitivity: 'non_intimate',
      contentSensitivityActor: { kind: 'companion', turnId, requestId },
    });
    expect(runtime.buildTurnRecord(input).auditPrivacy).toMatchObject({
      contentMode: 'emotional_signal_only',
      contentSensitivity: 'ambiguous',
    });
  });

  it('keeps a reset logical conversation separate from its physical channel', () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager,
      backgroundWorkSupervisor: null,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const sourceChannelId = 'discord:guild:reset-room';
    const reset = sessionManager.resetSourceChannelSession({
      sourceChannelId,
      actor: 'operator',
      reason: 'start a clean logical conversation',
      mode: 'fresh_split',
    });
    const correlation = runtime.buildTurnCorrelation({
      id: 'root-initiation-message',
      channelId: sourceChannelId,
      channelType: 'discord',
      authorId: 'user-1',
      authorName: 'User',
      content: 'new conversation',
      timestamp: new Date('2026-07-14T00:00:00.000Z'),
    }, 'chat', createTurnId(), 'root-initiation-message');

    expect(correlation).toMatchObject({
      sessionId: reset.newLogicalSessionId,
      conversationId: reset.newLogicalSessionId,
      rootInitiationId: 'root-initiation-message',
      channelId: sourceChannelId,
    });
    expect(correlation.sessionId).not.toBe(correlation.channelId);
  });
});

describe('TurnSupportRuntime durable background work delegation', () => {
  it('delegates enqueue and foreground lifecycle to the per-session supervisor', async () => {
    const lease = { id: 'lease-1', logicalSessionId: 'session-a' };
    const enqueue = vi.fn(async () => undefined);
    const beginForeground = vi.fn(() => lease);
    const endForeground = vi.fn();
    const supervisor = { enqueue, beginForeground, endForeground } as unknown as BackgroundWorkSupervisor;
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      backgroundWorkSupervisor: supervisor,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });

    await runtime.enqueuePostTurnBackgroundWork([]);
    const foregroundLease = runtime.beginForegroundBackgroundWork('session-a');
    runtime.endForegroundBackgroundWork(foregroundLease);

    expect(enqueue).toHaveBeenCalledWith([]);
    expect(beginForeground).toHaveBeenCalledWith('session-a');
    expect(endForeground).toHaveBeenCalledWith(lease);
  });

  it('fails closed when durable enqueue is not configured', async () => {
    const runtime = new TurnSupportRuntime({
      eventBus: new EventBus(),
      sessionManager: {} as SessionManager,
      backgroundWorkSupervisor: null,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    await expect(runtime.enqueuePostTurnBackgroundWork([])).rejects.toThrow(
      'Durable background work supervisor is not configured',
    );
  });
});

describe('TurnSupportRuntime intentional no-reply decisions', () => {
  it('records, emits, and consumes a turn-scoped no-reply audit decision', async () => {
    const eventBus = new EventBus();
    const telemetry: Array<Record<string, unknown>> = [];
    eventBus.on('agent.no_reply.intentional', (event) => {
      telemetry.push(event);
    });
    const runtime = new TurnSupportRuntime({
      eventBus,
      sessionManager: {} as SessionManager,
      backgroundWorkSupervisor: null,
      hashPromptText: (text) => `hash:${text.length}`,
      resolveContextWindow: () => 1_000,
    });
    const turnId = createTurnId();
    runtime.setActiveTurnContext(
      {
        turnId,
        requestId: 'request-no-reply',
        channelId: 'api:no-reply',
        callType: 'chat',
        purpose: 'agent.turn',
      },
      null,
      null,
    );

    const decision = runtime.recordIntentionalNoReplyDecision({
      source: 'response_control_tool',
      toolCallId: 'tool-call-1',
      reason: 'user is resting',
    });
    await flushAsyncWork();

    expect(decision).toMatchObject({
      schemaVersion: 1,
      disposition: 'intentional_no_reply',
      source: 'response_control_tool',
      auditId: `no-reply:${turnId}:tool-call-1`,
      turnId,
      requestId: 'request-no-reply',
      channelId: 'api:no-reply',
      toolCallId: 'tool-call-1',
      reason: 'user is resting',
    });
    expect(telemetry).toContainEqual(expect.objectContaining({
      auditId: `no-reply:${turnId}:tool-call-1`,
      turnId,
      requestId: 'request-no-reply',
      channelId: 'api:no-reply',
      purpose: 'agent.no_reply.intentional',
    }));
    expect(runtime.consumeIntentionalNoReplyDecision(turnId)).toEqual(decision);
    expect(runtime.consumeIntentionalNoReplyDecision(turnId)).toBeNull();
  });
});
