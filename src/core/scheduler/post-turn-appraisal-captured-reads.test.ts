import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import { Scheduler } from './scheduler.js';
import { wirePostTurnRuntime } from './post-turn-runtime.js';
import { IntentionAppraisal } from '../intention/appraisal.js';
import { InternalStateComputer } from '../self-model/state.js';
import {
  CapturedSessionReads,
  assertNoCapturedSessionOwner,
  type CapturedSessionReadOperations,
} from '../session/manager/captured-session-owner.js';
import type { PostTurnActionInferer } from '../agent/substrate-agent.js';
import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { SessionEntry } from '../session/types.js';

// Regression for psfn-framework-pmqm: on a persistent single channel (e.g. an
// API principal reusing one session), the post-turn intention appraisal fires
// from a post-turn inferer that runs inside the turn's admitted captured-owner
// scope. It used SessionManager.getRecentMessages, which the read-attribution
// guard rejects while a turn is admitted, so the turn returned 200 but the
// appraisal was silently dropped with an "appraisal dispatch failed" WARN. The
// fix reads the transcript through the turn's owner-bound CapturedSessionReads.
//
// This test reproduces the shape with the REAL guard primitives: a real
// CapturedSessionReads and the real assertNoCapturedSessionOwner over a shared
// manager identity, driven inside CapturedSessionReads.run so the admitted-turn
// ALS scope is genuinely active. It does not special-case any principal string.

const OWNER_CHANNEL = 'api:persistent-principal';

function makeEmotionSnapshot(): EmotionStateSnapshot {
  return {
    vad: { valence: -0.2, arousal: 0.1, dominance: -0.05 },
    mood: { valence: -0.15, arousal: 0.08, dominance: -0.03 },
    discrete: {},
    confidence: 0.6,
  };
}

function makeInternalState() {
  return new InternalStateComputer().computeState({
    emotionState: makeEmotionSnapshot(),
    activeConcerns: [],
    pendingFollowUps: [],
    careReminders: [],
    trustLevel: 'regular',
    sessionMetrics: {
      userMessageText: 'current user line',
      responseText: 'current assistant reply',
      toolCallCount: 0,
      recentTurnCount: 2,
      lastSeenDeltaSeconds: 30,
    },
  });
}

describe('post-turn intention appraisal on a persistent channel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the transcript via owner-bound CapturedSessionReads while the turn is admitted', async () => {
    const evaluateSpy = vi
      .spyOn(IntentionAppraisal.prototype, 'evaluate')
      .mockResolvedValue([]);

    // Shared manager identity: the same object keys both the real ALS guard
    // (assertNoCapturedSessionOwner) and the real CapturedSessionReads scope.
    const manager = {};
    const owner = { logicalSessionId: OWNER_CHANNEL, sourceChannelId: OWNER_CHANNEL };

    const nowMs = Date.parse('2026-07-28T12:00:00.000Z');
    const seededEntries: SessionEntry[] = [
      {
        id: 1,
        role: 'user',
        content: 'earlier user line',
        timestamp: nowMs - 60_000,
        authorId: 'user-a',
        authorName: 'User',
        channelId: OWNER_CHANNEL,
      } as unknown as SessionEntry,
      {
        id: 2,
        role: 'assistant',
        content: 'earlier assistant line',
        timestamp: nowMs - 55_000,
      } as unknown as SessionEntry,
    ];

    const capturedGetRecentMessages = vi.fn((_limit?: number) => seededEntries);
    const unusedOperation = () => {
      throw new Error('operation not expected in this appraisal path');
    };
    const operations = {
      getRecentMessages: capturedGetRecentMessages,
      buildContext: unusedOperation,
      captureTurnSessionContext: unusedOperation,
      getRecentMessagesAtOrBefore: unusedOperation,
      getRoleEnvelopeRefsForEntries: unusedOperation,
      scheduleAutoCompactionBetweenTurns: unusedOperation,
      captureAutoCompactionRecentEntries: unusedOperation,
      hasPendingAutoCompaction: unusedOperation,
      getActiveFocusMemoryScopeQuery: unusedOperation,
      getRecentConversationSpeakers: unusedOperation,
      resolveConversationScope: unusedOperation,
      reconcileSessionChannelFromDisk: unusedOperation,
    } as unknown as CapturedSessionReadOperations;
    const capturedSessionReads = new CapturedSessionReads(
      manager,
      owner,
      operations,
      (channelId: string) => ({
        owner: { logicalSessionId: channelId, sourceChannelId: channelId },
        operations,
      }),
    );

    // Faithful stand-in for the guarded mutable read: it fails closed under an
    // admitted turn exactly like SessionManager.getRecentMessages does.
    const guardedGetRecentMessages = vi.fn((_channelId: string, _limit?: number) => {
      assertNoCapturedSessionOwner(manager, 'SessionManager.getRecentMessages');
      return [] as SessionEntry[];
    });
    const sessionManager = {
      resolveSessionChannelId: (channelId: string) => channelId,
      getRecentMessages: guardedGetRecentMessages,
    };

    let capturedInferer: PostTurnActionInferer | undefined;
    const agentLoop = {
      handleMessage: vi.fn(),
      followUp: vi.fn(),
      waitForIdle: vi.fn(),
      registerPostTurnActionInferer: (inferer: PostTurnActionInferer) => {
        capturedInferer = inferer;
        return () => {};
      },
    };
    const postTurnActions = {
      registerHandler: vi.fn(() => () => {}),
      listQueued: vi.fn().mockReturnValue([]),
      getStatus: vi.fn(),
    };

    wirePostTurnRuntime({
      scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 50, heartbeatIntervalMs: 1_000 }),
      agentLoop: agentLoop as never,
      sender: { send: vi.fn() } as never,
      templateRuntime: { runDeferredTemplate: vi.fn() },
      runtimeOptions: {
        eventBus: new EventBus(),
        postTurnActions: postTurnActions as never,
        llmProvider: { stream: vi.fn(), complete: vi.fn() } as never,
        sessionManager: sessionManager as never,
        intentionAppraisalEnabled: true,
      },
    });

    expect(capturedInferer).toBeDefined();

    const message = {
      id: 'msg-current',
      channelId: OWNER_CHANNEL,
      channelType: 'api',
      content: 'current user line',
      timestamp: new Date(nowMs),
    } as unknown as SubstrateMessage;
    const response = {
      content: 'current assistant reply',
      metadata: { internalState: makeInternalState() },
    } as unknown as AgentResponse;

    // Drive the inferer inside the admitted-turn scope, where the guarded read
    // MUST throw and the owner-bound read MUST succeed.
    await capturedSessionReads.run(async () => {
      expect(() => sessionManager.getRecentMessages(OWNER_CHANNEL, 12)).toThrow(
        /admitted turn/,
      );
      await capturedInferer!({
        message,
        response,
        turnMessages: [],
        turnId: 'turn-current' as never,
        completedAt: nowMs,
        capturedSessionReads,
      });
    });

    // The appraisal is a detached task; wait for it to reach evaluate.
    await vi.waitFor(() => expect(evaluateSpy).toHaveBeenCalledTimes(1));

    // It read through the owner-bound facade, not the guarded mutable API.
    expect(capturedGetRecentMessages).toHaveBeenCalledWith(12);
    expect(guardedGetRecentMessages).toHaveBeenCalledTimes(1); // only our direct assertion above

    const appraisalInput = evaluateSpy.mock.calls[0]![0];
    const transcriptContents = appraisalInput.recentMessages.map((entry) => entry.content);
    expect(transcriptContents).toContain('earlier user line');
    expect(transcriptContents).toContain('current user line');
    expect(transcriptContents).toContain('current assistant reply');
    expect(appraisalInput.sessionId).toBe(OWNER_CHANNEL);
  });
});
