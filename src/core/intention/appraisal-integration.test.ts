import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fromAny } from '@total-typescript/shoehorn';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import { wireReflectionRuntime } from '../../app/startup/composition/parity.js';
import { wirePostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { InternalStateComputer } from '../self-model/state.js';
import type { AgentResponse, InferredPostTurnAction, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { CapturedSessionReads } from '../session/manager/captured-session-owner.js';
import type { SessionEntry } from '../session/types.js';
import { INTENTION_OUTBOUND_MESSAGE_ACTION_KIND } from './appraisal.js';
import type { OutreachOutboxAppendInput, OutreachOutboxRecord } from './outreach-outbox.js';
import { MAX_NEAR_TERM_FOLLOW_UP_HORIZON_MS } from '../../system/config/scheduler-config.js';

// Post-turn inferers run inside the turn's admitted captured-owner scope, so the
// intention post-turn appraisal reads its transcript through the turn's
// owner-bound CapturedSessionReads (psfn-framework-pmqm) rather than the guarded
// SessionManager.getRecentMessages. Production always threads a real
// CapturedSessionReads; these integration tests exercise the inferer directly,
// so they supply the same owner-bound read facade. The double returns no prior
// entries, matching each test's `sessionManager.getRecentMessages` mock, so the
// appraisal transcript is built from the current turn alone.
function makeCapturedSessionReads(
  recentEntries: readonly SessionEntry[] = [],
): CapturedSessionReads {
  return {
    getRecentMessages: (_limit?: number): SessionEntry[] => [...recentEntries],
  } as unknown as CapturedSessionReads;
}

function makeMessage(): SubstrateMessage {
  return {
    id: 'msg-intention-runtime-1',
    channelId: 'api:test',
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Can you check in with me tomorrow?',
    timestamp: new Date(),
  };
}

function makeInternalState(overrides?: {
  vad?: { valence: number; arousal: number; dominance: number };
  mood?: { valence: number; arousal: number; dominance: number };
}): ReturnType<InternalStateComputer['computeState']> {
  return new InternalStateComputer().computeState({
    emotionState: {
      vad: overrides?.vad ?? { valence: -0.2, arousal: 0.3, dominance: -0.1 },
      mood: overrides?.mood ?? { valence: -0.15, arousal: 0.25, dominance: -0.05 },
      discrete: { concern: 0.7 },
      confidence: 0.8,
    },
    activeConcerns: [{
      id: 'concern-runtime-1',
      text: 'Follow up soon',
      priority: 'high',
      source: 'agent',
      createdAt: '2026-03-01T00:00:00.000Z',
      expiresAt: '2026-03-02T00:00:00.000Z',
      contactId: 'contact-primary',
    }],
    trustLevel: 'primary',
    contactId: 'contact-primary',
    sessionMetrics: {
      userMessageText: 'Can you check in with me tomorrow?',
      responseText: 'Absolutely, I can follow up.',
      toolCallCount: 0,
      recentTurnCount: 4,
      lastSeenDeltaSeconds: 60,
    },
  });
}

function makeResponse(internalState = makeInternalState()): AgentResponse {
  return {
    channelId: 'api:test',
    content: 'Absolutely, I can follow up.',
    metadata: {
      model: 'chat-model',
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 12,
      internalState,
    },
  };
}

function makeOutboundAction(
  payload: Record<string, unknown>,
): InferredPostTurnAction {
  return {
    id: 'outbound-action-1',
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    payload,
    dedupeKey: 'intention.outbound_message:weighted-thought:thought-1:content-hash',
    channelId: 'primary-dm',
    sourceMessageId: 'source-message-1',
    inferredAt: Date.now(),
  };
}

function makePendingFollowUp() {
  const now = Date.now();
  return {
    id: 'pending-follow-up-1',
    content: 'Check in about the doctor call.',
    priority: 'high' as const,
    timing: 'scheduled' as const,
    createdAt: new Date(now - 60_000).toISOString(),
    dueAt: new Date(now + 60_000).toISOString(),
    channelId: 'primary-dm',
    channelType: 'discord' as const,
    authorId: 'system:intention',
    authorName: 'Whisper',
  };
}

function registerOutboundHandlerHarness(options: {
  pendingFollowUp?: ReturnType<typeof makePendingFollowUp> & { activatedAt?: string };
  activeConcernIds?: string[];
  dispatchResult?: { outcome: 'sent' } | { outcome: 'blocked'; reason: string; retryAfterMs?: number };
  dispatchError?: Error;
  terminalRecord?: OutreachOutboxRecord;
  verifyPersonalProjectLive?: (projectId: string) => Promise<boolean>;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-outbound-'));
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus, {
    tickIntervalMs: 50,
    heartbeatIntervalMs: 1_000,
  });
  const postTurnActions = {
    registerHandler: vi.fn().mockReturnValue(() => {}),
    listQueued: vi.fn().mockReturnValue([]),
    getStatus: vi.fn(),
  };
  const dispatch = options.dispatchError
    ? vi.fn().mockRejectedValue(options.dispatchError)
    : vi.fn().mockResolvedValue(options.dispatchResult ?? { outcome: 'sent' });
  const outboxRecords: OutreachOutboxAppendInput[] = [];
  const getTerminal = vi.fn().mockReturnValue(options.terminalRecord);
  const sessionAudit = vi.fn();
  const sessionAssistant = vi.fn();
  const onIntentionFollowUpActivated = vi.fn();
  const pendingFollowUpStore = {
    enqueue: vi.fn(),
    peek: vi.fn().mockResolvedValue(options.pendingFollowUp ?? null),
    dequeue: vi.fn(),
    quarantine: vi.fn(),
    list: vi.fn(),
    listQuarantined: vi.fn(),
  };

  const getActiveConcerns = vi.fn(
    () => (options.activeConcernIds ?? []).map(id => ({ id })),
  );

  void wireReflectionRuntime(
    { registerTool: vi.fn() },
    scheduler,
    fromAny({
      handleMessage: vi.fn(),
      followUp: vi.fn(),
      waitForIdle: vi.fn(),
      registerPostTurnActionInferer: vi.fn().mockReturnValue(() => {}),
    }),
    { send: vi.fn() },
    tempDir,
    undefined,
    {
      eventBus,
      postTurnActions: fromAny(postTurnActions),
      llmProvider: fromAny({ stream: vi.fn(), complete: vi.fn() }),
      proactiveOutbound: { dispatch },
      outreachOutbox: {
        append: vi.fn((record: OutreachOutboxAppendInput) => {
          outboxRecords.push(record);
          return { version: 1, recordedAt: Date.now(), ...record };
        }),
        hasTerminal: vi.fn((dedupeKey: string) => Boolean(options.terminalRecord && options.terminalRecord.dedupeKey === dedupeKey)),
        getTerminal,
        getIcpDeliveredCompletion: vi.fn(() => undefined),
        listRecent: vi.fn(() => []),
      },
      sessionManager: fromAny({
        resolveSessionChannelId: (channelId: string) => channelId,
        getRecentMessages: vi.fn().mockReturnValue([]),
        recordSystemMessage: sessionAudit,
        recordAssistantMessage: sessionAssistant,
      }),
      pendingFollowUpStore: fromAny(pendingFollowUpStore),
      intentionFollowUpHorizonMs: MAX_NEAR_TERM_FOLLOW_UP_HORIZON_MS,
      routeLongHorizonFollowUp: vi.fn(async () => 'scheduled:intention:test'),
      onIntentionFollowUpActivated,
      getActiveConcerns,
      ...(options.verifyPersonalProjectLive
        ? { verifyPersonalProjectLive: options.verifyPersonalProjectLive }
        : {}),
    },
  );

  const outboundRegistration = postTurnActions.registerHandler.mock.calls.find(
    call => call[0] === INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  );
  const handler = outboundRegistration?.[1] as ((action: InferredPostTurnAction) => Promise<{ detail?: string } | void>) | undefined;
  if (!handler) {
    rmSync(tempDir, { recursive: true, force: true });
    throw new Error('Outbound handler was not registered');
  }

  return {
    handler,
    dispatch,
    getTerminal,
    outboxRecords,
    sessionAudit,
    sessionAssistant,
    onIntentionFollowUpActivated,
    pendingFollowUpStore,
    getActiveConcerns,
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

describe('intention appraisal runtime integration', () => {
  it('hydrates a serialized pre-change project nudge with project-only precedence and records its sent outcome', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-legacy-project-outreach-'));
    const persistencePath = join(tempDir, 'post-turn-actions.queue.json');
    const verifyPersonalProjectLive = vi.fn(async (projectId: string) => projectId === 'project-live');
    const outboundHarness = registerOutboundHandlerHarness({ verifyPersonalProjectLive });

    writeFileSync(persistencePath, JSON.stringify({
      version: 1,
      entries: [{
        action: {
          id: 'legacy-project-outreach',
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          payload: {
            channelId: 'primary-dm',
            channelType: 'discord',
            content: 'I want to get back to my story.',
            reason: 'weighted_thought:standard',
            personalProjectId: 'project-live',
            concernIds: ['stale-concern'],
            pendingFollowUpId: 'stale-follow-up',
          },
          dedupeKey: 'intention.outbound_message:weighted-thought:legacy-project',
          channelId: 'primary-dm',
          sourceMessageId: 'accepted-weighted-thought',
          inferredAt: 1_699_999_999_000,
          maxRetries: 0,
        },
        attempt: 0,
        nextRunAt: 1_700_000_000_000,
        maxRetries: 0,
      }],
    }), 'utf-8');

    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      runtime.registerHandler(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND, outboundHarness.handler);

      const migratedQueue = JSON.parse(readFileSync(persistencePath, 'utf-8')) as {
        version: number;
        entries: Array<{
          actionPayloadVersion: number;
          action: { payload: Record<string, unknown> };
          demandStartedAt: number;
          coverageThroughInferredAt: number;
          coalescedCount: number;
          retryableFailureCount: number;
        }>;
      };
      expect(migratedQueue.version).toBe(2);
      expect(migratedQueue.entries[0]?.actionPayloadVersion).toBe(2);
      expect(migratedQueue.entries[0]).toMatchObject({
        demandStartedAt: 1_699_999_999_000,
        coverageThroughInferredAt: 1_699_999_999_000,
        coalescedCount: 0,
        retryableFailureCount: 0,
      });
      expect(migratedQueue.entries[0]?.action.payload).toMatchObject({
        personalProjectId: 'project-live',
      });
      expect(migratedQueue.entries[0]?.action.payload.concernIds).toBeUndefined();
      expect(migratedQueue.entries[0]?.action.payload.pendingFollowUpId).toBeUndefined();

      await scheduler.tick();

      expect(verifyPersonalProjectLive).toHaveBeenCalledWith('project-live');
      expect(outboundHarness.dispatch).toHaveBeenCalledOnce();
      expect(outboundHarness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'sent']);
      expect(outboundHarness.sessionAudit).toHaveBeenCalledWith(
        'primary-dm',
        expect.stringContaining('sent: sent'),
        'system:outreach-outbox',
        'Outreach Outbox',
        true,
        undefined,
        expect.objectContaining({ requestId: 'legacy-project-outreach' }),
      );
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 0,
        failures: { failedCount: 0 },
        completions: {
          completedCount: 1,
          recentCompletions: [expect.objectContaining({
            actionId: 'legacy-project-outreach',
            detail: 'sent',
          })],
        },
      });
    } finally {
      outboundHarness.cleanup();
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not expose a migrated legacy nudge when its canonical rewrite cannot be persisted', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-legacy-project-rewrite-failure-'));
    const persistencePath = join(tempDir, 'post-turn-actions.queue.json');
    writeFileSync(persistencePath, JSON.stringify({
      version: 1,
      entries: [{
        action: {
          id: 'legacy-project-rewrite-failure',
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          payload: {
            channelId: 'primary-dm',
            channelType: 'discord',
            content: 'This must wait for a durable migration.',
            personalProjectId: 'project-live',
            concernIds: ['stale-concern'],
          },
          dedupeKey: 'intention.outbound_message:weighted-thought:rewrite-failure',
          channelId: 'primary-dm',
          sourceMessageId: 'accepted-weighted-thought',
          inferredAt: 1_700_000_000_000,
          maxRetries: 0,
        },
        attempt: 0,
        nextRunAt: 1_700_000_000_001,
        maxRetries: 0,
      }],
    }), 'utf-8');
    chmodSync(tempDir, 0o500);

    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });

      expect(runtime.listQueued()).toEqual([]);
      expect(runtime.getStatus()).toMatchObject({
        persistence: {
          loadState: 'loaded',
          loadedEntries: 0,
          lastLoadError: expect.stringContaining('durably migrate'),
          lastPersistError: expect.any(String),
        },
      });
      expect(JSON.parse(readFileSync(persistencePath, 'utf-8'))).toMatchObject({
        version: 1,
        entries: [expect.objectContaining({
          action: expect.objectContaining({ id: 'legacy-project-rewrite-failure' }),
        })],
      });
    } finally {
      chmodSync(tempDir, 0o700);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each<{
    label: string;
    actionPayloadVersion?: number;
    crossedSource: Record<string, unknown>;
  }>([
    {
      label: 'current project and live-thread provenance',
      actionPayloadVersion: 2,
      crossedSource: {},
    },
    {
      label: 'legacy social-desire crossing',
      crossedSource: {
        socialDesire: {
          contactId: 'contact-primary',
          consentId: '11111111-1111-4111-8111-111111111111',
          orientation: 'warm',
        },
      },
    },
    {
      label: 'legacy appraisal crossing',
      crossedSource: {
        appraisalFollowUp: {
          channelId: 'primary-dm',
          canonicalContactKey: 'contact-primary',
        },
      },
    },
    {
      label: 'legacy unknown-initiator crossing',
      crossedSource: {
        futureInitiator: { id: 'unknown-source' },
      },
    },
  ])('does not migrate or dispatch $label', async ({ actionPayloadVersion, crossedSource }) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-forged-project-outreach-'));
    const persistencePath = join(tempDir, 'post-turn-actions.queue.json');
    const verifyPersonalProjectLive = vi.fn().mockResolvedValue(true);
    const outboundHarness = registerOutboundHandlerHarness({ verifyPersonalProjectLive });

    writeFileSync(persistencePath, JSON.stringify({
      version: 1,
      entries: [{
        ...(actionPayloadVersion !== undefined ? { actionPayloadVersion } : {}),
        action: {
          id: 'forged-project-outreach',
          kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
          payload: {
            channelId: 'primary-dm',
            channelType: 'discord',
            content: 'This crossed payload must not dispatch.',
            personalProjectId: 'project-live',
            concernIds: ['crossed-concern'],
            pendingFollowUpId: 'crossed-follow-up',
            ...crossedSource,
          },
          dedupeKey: 'intention.outbound_message:forged-project',
          channelId: 'primary-dm',
          sourceMessageId: 'forged-source-message',
          inferredAt: 1_700_000_000_000,
          maxRetries: 0,
        },
        attempt: 0,
        nextRunAt: 1_700_000_000_001,
        maxRetries: 0,
      }],
    }), 'utf-8');

    try {
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const runtime = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
        intervalMs: 1,
        persistencePath,
      });
      runtime.registerHandler(INTENTION_OUTBOUND_MESSAGE_ACTION_KIND, outboundHarness.handler);

      const hydratedQueue = JSON.parse(readFileSync(persistencePath, 'utf-8')) as {
        version: number;
        entries: Array<{
          actionPayloadVersion: number;
          action: { payload: Record<string, unknown> };
        }>;
      };
      expect(hydratedQueue.version).toBe(2);
      expect(hydratedQueue.entries[0]?.actionPayloadVersion).toBe(2);
      expect(hydratedQueue.entries[0]?.action.payload).toMatchObject({
        personalProjectId: 'project-live',
        concernIds: ['crossed-concern'],
        pendingFollowUpId: 'crossed-follow-up',
        ...crossedSource,
      });

      await scheduler.tick();

      expect(verifyPersonalProjectLive).not.toHaveBeenCalled();
      expect(outboundHarness.dispatch).not.toHaveBeenCalled();
      expect(outboundHarness.outboxRecords).toEqual([]);
      expect(outboundHarness.sessionAudit).not.toHaveBeenCalled();
      expect(runtime.getStatus()).toMatchObject({
        queueDepth: 0,
        completions: { completedCount: 0 },
        failures: {
          failedCount: 1,
          recentFailures: [expect.objectContaining({
            actionId: 'forged-project-outreach',
            reason: 'retries_exhausted',
            error: expect.stringContaining('payload is missing required fields'),
          })],
        },
      });
    } finally {
      outboundHarness.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('dispatches an explicit concern check-in without requiring social-desire provenance', async () => {
    const harness = registerOutboundHandlerHarness({
      activeConcernIds: ['concern-scheduled-event'],
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'I was thinking about the event tonight. How are you feeling about it?',
        reason: 'Active concern about a scheduled event tonight; check in before it starts.',
        concernIds: ['concern-scheduled-event'],
        appraisalFollowUp: {
          channelId: 'primary-dm',
          canonicalContactKey: 'contact-primary',
        },
      }));

      expect(result).toEqual({ detail: 'sent' });
      expect(harness.dispatch).toHaveBeenCalledWith({
        actionId: 'outbound-action-1',
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'I was thinking about the event tonight. How are you feeling about it?',
        reason: 'Active concern about a scheduled event tonight; check in before it starts.',
      });
      expect(harness.getActiveConcerns).toHaveBeenCalledWith({
        channelId: 'primary-dm',
        canonicalContactKey: 'contact-primary',
      });
      expect(harness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'sent']);
    } finally {
      harness.cleanup();
    }
  });

  it('treats an explicit appraisal follow-up as an independent proactive initiator', async () => {
    const harness = registerOutboundHandlerHarness({});
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'You crossed my mind. How has your evening been?',
        reason: 'I genuinely want to reconnect after a quiet stretch.',
        appraisalFollowUp: {
          channelId: 'primary-dm',
          canonicalContactKey: 'contact-primary',
        },
      }));

      expect(result).toEqual({ detail: 'sent' });
      expect(harness.dispatch).toHaveBeenCalledOnce();
      expect(harness.getActiveConcerns).not.toHaveBeenCalled();
      expect(harness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'sent']);
    } finally {
      harness.cleanup();
    }
  });

  it('blocks stale outbound actions when their linked concern has been cleared', async () => {
    const harness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: [],
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['cleared-concern-1'],
      }));

      expect(result).toEqual({ detail: 'blocked:stale_concern' });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.sessionAssistant).not.toHaveBeenCalled();
      expect(harness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'blocked']);
      expect(harness.outboxRecords[1]).toMatchObject({
        reason: 'stale_concern',
        dedupeKey: 'intention.outbound_message:weighted-thought:thought-1:content-hash',
      });
      expect(harness.sessionAudit).toHaveBeenCalledWith(
        'primary-dm',
        expect.stringContaining('blocked: stale_concern'),
        'system:outreach-outbox',
        'Outreach Outbox',
        true,
        undefined,
        expect.objectContaining({
          requestId: 'outbound-action-1',
          sourceMessageId: 'source-message-1',
        }),
      );
      expect(harness.onIntentionFollowUpActivated).not.toHaveBeenCalled();
      expect(harness.pendingFollowUpStore.dequeue).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it('does not activate pending follow-ups after successful external outbound sends', async () => {
    const harness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: ['active-concern-1'],
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['active-concern-1'],
      }));

      expect(result).toEqual({ detail: 'sent' });
      expect(harness.dispatch).toHaveBeenCalledTimes(1);
      expect(harness.dispatch).toHaveBeenCalledWith({
        actionId: 'outbound-action-1',
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
      });
      expect(harness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'sent']);
      expect(harness.sessionAssistant).toHaveBeenCalledWith(
        'primary-dm',
        'Remember to call the doctor.',
        undefined,
        true,
        undefined,
        expect.objectContaining({
          sourceMessageId: 'source-message-1',
          metadata: expect.stringContaining('"type":"proactive_outbound_message"'),
          roleEnvelopePreview: expect.objectContaining({
            internalRole: 'outreach_candidate',
            promotionTarget: 'turn_record_summary',
          }),
        }),
      );
      expect(harness.onIntentionFollowUpActivated).not.toHaveBeenCalled();
      expect(harness.pendingFollowUpStore.dequeue).not.toHaveBeenCalled();
    } finally {
      harness.cleanup();
    }
  });

  it('skips replayed outbound actions when terminal outbox history exists', async () => {
    const terminalRecord: OutreachOutboxRecord = {
      version: 1,
      phase: 'sent',
      actionId: 'outbound-action-1',
      dedupeKey: 'intention.outbound_message:weighted-thought:thought-1:content-hash',
      channelId: 'primary-dm',
      channelType: 'discord',
      sourceMessageId: 'source-message-1',
      recordedAt: 1_700_000_000_000,
    };
    const harness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: ['active-concern-1'],
      terminalRecord,
    });
    try {
      const result = await harness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['active-concern-1'],
      }));

      expect(result).toEqual({ detail: 'skipped:terminal_dedupe:sent' });
      expect(harness.dispatch).not.toHaveBeenCalled();
      expect(harness.sessionAssistant).not.toHaveBeenCalled();
      expect(harness.outboxRecords).toEqual([
        expect.objectContaining({
          phase: 'skipped',
          metadata: expect.objectContaining({
            skippedReason: 'terminal_dedupe_replay',
            terminalPhase: 'sent',
          }),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it('records blocked and failed terminal outbound history without bypassing dispatcher policy', async () => {
    const blockedHarness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: ['active-concern-1'],
      dispatchResult: { outcome: 'blocked', reason: 'channel_not_approved_for_primary' },
    });
    try {
      const result = await blockedHarness.handler(makeOutboundAction({
        channelId: 'unapproved-channel',
        channelType: 'discord',
        content: 'I wanted to check in about the private medical concern.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['active-concern-1'],
        appraisalFollowUp: {
          channelId: 'primary-dm',
          canonicalContactKey: 'contact-primary',
        },
      }));

      expect(result).toEqual({ detail: 'blocked:channel_not_approved_for_primary' });
      expect(blockedHarness.dispatch).toHaveBeenCalledTimes(1);
      expect(blockedHarness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'blocked']);
      expect(blockedHarness.outboxRecords[1]).toMatchObject({
        reason: 'channel_not_approved_for_primary',
      });
    } finally {
      blockedHarness.cleanup();
    }

    const failure = new Error('gateway unavailable');
    const failedHarness = registerOutboundHandlerHarness({
      pendingFollowUp: makePendingFollowUp(),
      activeConcernIds: ['active-concern-1'],
      dispatchError: failure,
    });
    try {
      await expect(failedHarness.handler(makeOutboundAction({
        channelId: 'primary-dm',
        channelType: 'discord',
        content: 'Remember to call the doctor.',
        pendingFollowUpId: 'pending-follow-up-1',
        concernIds: ['active-concern-1'],
      }))).rejects.toThrow('gateway unavailable');
      expect(failedHarness.outboxRecords.map(record => record.phase)).toEqual(['queued', 'failed']);
      expect(failedHarness.outboxRecords[1]).toMatchObject({
        error: 'Error: gateway unavailable',
      });
    } finally {
      failedHarness.cleanup();
    }
  });

  it('dispatches follow-up actions asynchronously through post-turn runtime', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'Proactive check-in requested by user.',
              timing: 'soon',
              followUp: {
                content: 'Quick follow-up: how are you doing today?',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      void wireReflectionRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: fromAny(llmProvider),
          sessionManager: fromAny({
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          }),
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      const message = makeMessage();
      const response = makeResponse();
      const inferred = await inferer(fromAny({
        message,
        response,
        turnMessages: [],
        turnId: fromAny('turn-intention-1'),
        completedAt: Date.now(),
        capturedSessionReads: makeCapturedSessionReads(),
      }));
      expect(inferred).toEqual([]);

      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(llmProvider.complete.mock.calls[0]?.[1]).toBe('background');
      const promptPayload = JSON.parse(
        String(llmProvider.complete.mock.calls[0]?.[0]?.messages?.[0]?.content ?? '{}'),
      ) as { internalState?: unknown };
      expect(promptPayload.internalState).toBeDefined();
      expect(agentLoop.waitForIdle).not.toHaveBeenCalled();

      await scheduler.tick();
      expect(agentLoop.followUp).not.toHaveBeenCalled();

      nowSpy.mockReturnValue(1_700_000_700_001);
      await scheduler.tick();
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'api:test',
        channelType: 'api',
        content: 'Quick follow-up: how are you doing today?',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('reopens pending follow-ups immediately on internal background turns', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-internal-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_400_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'Background check should surface the pending reminder now.',
              timing: 'soon',
              followUp: {
                content: 'Quick follow-up: how are you doing today?',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      void wireReflectionRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: fromAny(llmProvider),
          sessionManager: fromAny({
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          }),
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      await inferer(fromAny({
        message: {
          ...makeMessage(),
          id: 'msg-intention-runtime-internal-1',
          channelId: 'internal:reflection:whisper',
          channelType: 'terminal',
        },
        response: makeResponse(),
        turnMessages: [],
        turnId: fromAny('turn-intention-internal-1'),
        completedAt: Date.now(),
        capturedSessionReads: makeCapturedSessionReads(),
      }));

      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        channelId: 'internal:reflection:whisper',
        channelType: 'terminal',
        content: 'Quick follow-up: how are you doing today?',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('defers intention follow-up execution until dueAt timestamp', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-scheduled-'));
    const nowSpy = vi.spyOn(Date, 'now');

    try {
      nowSpy.mockReturnValue(1_700_000_500_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'high',
              reason: 'User asked for later check-in.',
              timing: 'scheduled',
              dueAt: 1_700_000_500_300,
              followUp: {
                content: 'Scheduled follow-up: checking in now.',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 48,
          outputTokens: 31,
          stopReason: 'stop',
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      void wireReflectionRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: fromAny(llmProvider),
          sessionManager: fromAny({
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          }),
          getActiveConcerns: () => [{
            title: 'Follow up soon',
            dueAt: Date.now() + 1_000,
            status: 'active',
          }],
          emotionState: {
            getState: () => ({
              vad: { valence: -0.2, arousal: 0.3, dominance: -0.1 },
              mood: { valence: -0.15, arousal: 0.25, dominance: -0.05 },
              discrete: { concern: 0.7 },
              confidence: 0.8,
            }),
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      await inferer(fromAny({
        message: makeMessage(),
        response: makeResponse(),
        turnMessages: [],
        turnId: fromAny('turn-intention-scheduled-1'),
        completedAt: Date.now(),
        capturedSessionReads: makeCapturedSessionReads(),
      }));

      await new Promise(resolve => setTimeout(resolve, 60));
      await Promise.resolve();
      await Promise.resolve();

      nowSpy.mockReturnValue(1_700_000_500_250);
      await scheduler.tick();
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      for (let offset = 0; offset < 5 && agentLoop.followUp.mock.calls.length === 0; offset += 1) {
        nowSpy.mockReturnValue(1_700_000_500_360 + (offset * 60));
        await scheduler.tick();
        await Promise.resolve();
      }
      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Scheduled follow-up: checking in now.',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('forces appraisal on sustained primary-contact negative mood without immediate foreground hijack', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'psfn-intention-motivation-'));
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_700_000_500_000);
      const eventBus = new EventBus();
      const scheduler = new Scheduler(eventBus, {
        tickIntervalMs: 50,
        heartbeatIntervalMs: 1_000,
      });
      const inferers: PostTurnActionInferer[] = [];
      const agentLoop = {
        handleMessage: vi.fn().mockResolvedValue({ content: 'ok' }),
        followUp: vi.fn(),
        waitForIdle: vi.fn().mockResolvedValue(undefined),
        registerPostTurnActionInferer: vi.fn((inferer: PostTurnActionInferer) => {
          inferers.push(inferer);
          return () => {};
        }),
      };
      const sender = {
        send: vi.fn().mockResolvedValue(undefined),
      };
      const llmProvider = {
        stream: vi.fn(),
        complete: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            decisions: [{
              type: 'followUp',
              priority: 'medium',
              reason: 'Sustained negative mood requires a proactive check-in.',
              timing: 'soon',
              followUp: {
                content: 'Checking in because your mood has stayed low.',
              },
            }],
          }),
          model: 'background-model',
          toolCalls: [],
          inputTokens: 44,
          outputTokens: 29,
          stopReason: 'stop',
        }),
      };
      const emotionSnapshots = [{
        vad: { valence: -0.2, arousal: 0.1, dominance: -0.1 },
        mood: { valence: -0.28, arousal: 0.05, dominance: -0.1 },
        discrete: { sadness: 0.6 },
        confidence: 0.9,
      }, {
        vad: { valence: -0.22, arousal: 0.09, dominance: -0.1 },
        mood: { valence: -0.29, arousal: 0.04, dominance: -0.1 },
        discrete: { sadness: 0.62 },
        confidence: 0.9,
      }];
      let emotionIndex = 0;
      const emotionState = {
        getState: vi.fn(() => {
          const snapshot = emotionSnapshots[Math.min(emotionIndex, emotionSnapshots.length - 1)];
          emotionIndex += 1;
          return snapshot;
        }),
      };

      const postTurnActions = wirePostTurnActionRuntime({
        eventBus,
        scheduler,
        agentLoop,
        intervalMs: 1,
      });

      void wireReflectionRuntime(
        { registerTool: vi.fn() },
        scheduler,
        agentLoop,
        sender,
        tempDir,
        undefined,
        {
          eventBus,
          postTurnActions,
          llmProvider: fromAny(llmProvider),
          sessionManager: fromAny({
            resolveSessionChannelId: (channelId: string) => channelId,
            getRecentMessages: vi.fn().mockReturnValue([]),
          }),
          emotionState,
          contactStore: {
            getById: () => ({ trustLevel: 'primary' }),
            getEmotionalTimeSeries: () => [],
          },
        },
      );

      expect(inferers).toHaveLength(1);
      const inferer = inferers[0]!;
      const firstMessage = {
        ...makeMessage(),
        id: 'msg-intention-motivation-1',
        content: 'I am feeling a bit off.',
      };
      const secondMessage = {
        ...makeMessage(),
        id: 'msg-intention-motivation-2',
        content: 'Still feeling the same low mood.',
      };
      const firstResponse = makeResponse(makeInternalState({
        vad: { valence: -0.2, arousal: 0.1, dominance: -0.1 },
        mood: { valence: -0.28, arousal: 0.05, dominance: -0.1 },
      }));
      const secondResponse = makeResponse(makeInternalState({
        vad: { valence: -0.22, arousal: 0.09, dominance: -0.1 },
        mood: { valence: -0.29, arousal: 0.04, dominance: -0.1 },
      }));

      await inferer(fromAny({
        message: firstMessage,
        response: firstResponse,
        turnMessages: [],
        canonicalContactKey: 'contact-primary',
        turnId: fromAny('turn-intention-motivation-1'),
        completedAt: Date.now(),
        capturedSessionReads: makeCapturedSessionReads(),
      }));
      await Promise.resolve();
      await Promise.resolve();
      await scheduler.tick();

      expect(llmProvider.complete).toHaveBeenCalledTimes(0);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      await inferer(fromAny({
        message: secondMessage,
        response: secondResponse,
        turnMessages: [],
        canonicalContactKey: 'contact-primary',
        turnId: fromAny('turn-intention-motivation-2'),
        completedAt: Date.now(),
        capturedSessionReads: makeCapturedSessionReads(),
      }));
      await new Promise(resolve => setTimeout(resolve, 60));
      for (let index = 0; index < 3; index += 1) {
        await Promise.resolve();
        await scheduler.tick();
      }

      expect(llmProvider.complete).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledTimes(0);

      nowSpy.mockReturnValue(1_700_000_800_001);
      await scheduler.tick();

      expect(agentLoop.followUp).toHaveBeenCalledTimes(1);
      expect(agentLoop.followUp).toHaveBeenCalledWith(expect.objectContaining({
        content: 'Checking in because your mood has stayed low.',
      }));
    } finally {
      nowSpy.mockRestore();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
