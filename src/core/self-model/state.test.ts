import { describe, expect, it } from 'vitest';
import type { ActiveConcern } from '../intention/concerns.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import {
  buildInternalStateSnapshotRef,
  InternalStateComputer,
  serializeInternalState,
} from './state.js';

function makeConcern(overrides?: Partial<ActiveConcern>): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Follow up on release rollback risk',
    priority: 'medium',
    source: 'agent',
    createdAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2026-03-03T10:00:00.000Z',
    ...overrides,
  };
}

function makePendingFollowUp(overrides?: Partial<PendingFollowUp>): PendingFollowUp {
  return {
    id: 'follow-up-1',
    content: 'Check in tomorrow afternoon if they are still overwhelmed.',
    priority: 'medium',
    timing: 'scheduled',
    createdAt: '2026-03-01T10:00:00.000Z',
    dueAt: '2026-03-02T10:00:00.000Z',
    channelId: 'api:test',
    channelType: 'api',
    authorId: 'system:intention',
    authorName: 'Whisper',
    ...overrides,
  };
}

describe('InternalStateComputer', () => {
  it('computes deterministic state from emotion, concern, relational, and turn metrics', () => {
    const computer = new InternalStateComputer();
    const state = computer.computeState({
      emotionState: {
        vad: { valence: 0.42, arousal: 0.3, dominance: 0.1 },
        mood: { valence: 0.2, arousal: 0.1, dominance: -0.05 },
        discrete: { joy: 0.7, anger: 0.1 },
        confidence: 0.82,
      },
      activeConcerns: [
        makeConcern({ id: 'concern-medium', priority: 'medium' }),
        makeConcern({
          id: 'concern-high',
          priority: 'high',
          createdAt: '2026-03-01T09:00:00.000Z',
          expiresAt: '2026-03-02T09:00:00.000Z',
        }),
      ],
      pendingFollowUps: [
        makePendingFollowUp(),
      ],
      trustLevel: 'trusted',
      contactId: 'contact-123',
      contactEmotionalSnapshot: {
        baselineValence: 0.3,
        moodValence: 0.35,
        moodDrift: 0.05,
        moodSamples: 9,
      },
      sessionMetrics: {
        userMessageText: 'Can you help me plan the rollback checklist?',
        responseText: 'Yes. I will map the rollback checklist and risk owners now.',
        toolCallCount: 2,
        recentTurnCount: 6,
        lastSeenDeltaSeconds: 1800,
      },
    });

    expect(Object.keys(state.emotional.discreteEmotions)).toEqual(['anger', 'joy']);
    expect(state.attention.activeConcerns.map(concern => concern.id)).toEqual([
      'concern-high',
      'concern-medium',
    ]);
    expect(state.attention.pendingFollowUps?.map(followUp => followUp.id)).toEqual(['follow-up-1']);
    expect(state.attention.conversationTrajectory).toBe('deepening');
    expect(state.cognitive.processingQuality).toBe('deliberate');
    expect(state.relational).toMatchObject({
      contactId: 'contact-123',
      trustLevel: 'trusted',
      baselineValence: 0.3,
      moodDrift: 0.05,
      recentInteractionFrequency: 0.5,
      lastSeenDeltaSeconds: 1800,
    });
  });

  it('produces stable serialization and snapshot ref regardless of input ordering', () => {
    const computer = new InternalStateComputer();
    const first = computer.computeState({
      emotionState: {
        vad: { valence: 0.1, arousal: -0.1, dominance: 0.2 },
        mood: { valence: 0.05, arousal: -0.05, dominance: 0.1 },
        discrete: { joy: 0.3, fear: 0.4 },
        confidence: 0.6,
      },
      activeConcerns: [
        makeConcern({ id: 'b', priority: 'low' }),
        makeConcern({ id: 'a', priority: 'high' }),
      ],
      pendingFollowUps: [
        makePendingFollowUp({ id: 'follow-up-b' }),
        makePendingFollowUp({ id: 'follow-up-a', dueAt: '2026-03-01T09:30:00.000Z' }),
      ],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'Switching gears, what about backups?',
        responseText: 'I can outline backup checks.',
        toolCallCount: 0,
        recentTurnCount: 2,
      },
    });
    const second = computer.computeState({
      emotionState: {
        vad: { valence: 0.1, arousal: -0.1, dominance: 0.2 },
        mood: { valence: 0.05, arousal: -0.05, dominance: 0.1 },
        discrete: { fear: 0.4, joy: 0.3 },
        confidence: 0.6,
      },
      activeConcerns: [
        makeConcern({ id: 'a', priority: 'high' }),
        makeConcern({ id: 'b', priority: 'low' }),
      ],
      pendingFollowUps: [
        makePendingFollowUp({ id: 'follow-up-a', dueAt: '2026-03-01T09:30:00.000Z' }),
        makePendingFollowUp({ id: 'follow-up-b' }),
      ],
      trustLevel: 'regular',
      sessionMetrics: {
        userMessageText: 'Switching gears, what about backups?',
        responseText: 'I can outline backup checks.',
        toolCallCount: 0,
        recentTurnCount: 2,
      },
    });

    expect(serializeInternalState(first)).toBe(serializeInternalState(second));
    expect(buildInternalStateSnapshotRef(first)).toBe(buildInternalStateSnapshotRef(second));
  });

  it('fails closed for invalid emotion payloads', () => {
    const computer = new InternalStateComputer();
    expect(() => computer.computeState({
      emotionState: {
        vad: { valence: 0, arousal: 0, dominance: 0 },
        mood: { valence: 0, arousal: 0, dominance: 0 },
        discrete: {},
        confidence: 1.5,
      },
      activeConcerns: [],
      pendingFollowUps: [],
      trustLevel: 'public',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 0,
      },
    })).toThrow('emotionState.confidence');
  });

  it('fails closed for invalid concern timestamps', () => {
    const computer = new InternalStateComputer();
    expect(() => computer.computeState({
      emotionState: {
        vad: { valence: 0, arousal: 0, dominance: 0 },
        mood: { valence: 0, arousal: 0, dominance: 0 },
        discrete: {},
        confidence: 0.4,
      },
      activeConcerns: [
        makeConcern({ createdAt: 'not-a-date' }),
      ],
      pendingFollowUps: [],
      trustLevel: 'public',
      sessionMetrics: {
        userMessageText: 'hello',
        responseText: 'hi',
        toolCallCount: 0,
        recentTurnCount: 0,
      },
    })).toThrow('createdAt');
  });
});
