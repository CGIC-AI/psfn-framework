import { describe, expect, it } from 'vitest';
import type { ActiveConcern } from '../intention/concerns.js';
import type { InternalState } from './state.js';
import {
  buildMetacognitivePersonaHint,
  formatMetacognitiveNotesContextBlock,
  MetacognitiveMonitor,
  serializeMetacognitiveFlags,
} from './metacognition.js';

function makeConcern(overrides?: Partial<ActiveConcern>): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Confirm rollback owner and escalation plan',
    priority: 'high',
    source: 'agent',
    createdAt: '2026-03-01T10:00:00.000Z',
    expiresAt: '2026-03-03T10:00:00.000Z',
    ...overrides,
  };
}

function makeInternalState(overrides?: Partial<InternalState>): InternalState {
  return {
    emotional: {
      vad: { valence: 0.45, arousal: 0.82, dominance: 0.2 },
      mood: { valence: 0.38, arousal: 0.64, dominance: 0.1 },
      discreteEmotions: { joy: 0.7, trust: 0.6 },
      confidence: 0.75,
      ...(overrides?.emotional ?? {}),
    },
    cognitive: {
      certaintyLevel: 0.22,
      topicEngagement: 0.8,
      processingQuality: 'deliberate',
      ...(overrides?.cognitive ?? {}),
    },
    attention: {
      activeConcerns: [makeConcern()],
      salientEntities: ['rollback', 'owner'],
      conversationTrajectory: 'deepening',
      ...(overrides?.attention ?? {}),
    },
    relational: {
      contactId: 'contact-123',
      trustLevel: 'trusted',
      baselineValence: 0.2,
      moodDrift: 0.1,
      recentInteractionFrequency: 0.7,
      lastSeenDeltaSeconds: 1200,
      ...(overrides?.relational ?? {}),
    },
  };
}

describe('MetacognitiveMonitor', () => {
  it('detects deterministic multi-signal flags with confidence and evidence', () => {
    const monitor = new MetacognitiveMonitor();
    const input = {
      internalState: makeInternalState(),
      recentResponses: [
        'The migration status update is complete and stable.',
        'The migration status update is complete and stable.',
      ],
      latestResponse: 'The migration status update is complete and stable.',
      toolCallCount: 3,
      contradictoryMemorySignalCount: 2,
      supportingMemoryCount: 0,
    } as const;

    const first = monitor.detectFlags(input);
    const second = monitor.detectFlags(input);

    expect(first.map(flag => flag.flag)).toEqual([
      'uncertainty',
      'avoidance',
      'high_engagement',
      'repetition',
      'confabulation_risk',
    ]);
    for (const flag of first) {
      expect(flag.confidence).toBeGreaterThan(0);
      expect(flag.confidence).toBeLessThanOrEqual(1);
      expect(flag.evidence.length).toBeGreaterThan(0);
    }
    expect(serializeMetacognitiveFlags(first)).toBe(serializeMetacognitiveFlags(second));
  });

  it('suppresses confabulation risk when supporting memories are present', () => {
    const monitor = new MetacognitiveMonitor();
    const flags = monitor.detectFlags({
      internalState: makeInternalState({
        cognitive: { certaintyLevel: 0.9, topicEngagement: 0.6, processingQuality: 'fluent' },
      }),
      recentResponses: ['I can confirm the deployment details now.'],
      latestResponse: 'The deployment completed successfully and all checks passed.',
      toolCallCount: 0,
      contradictoryMemorySignalCount: 0,
      supportingMemoryCount: 2,
    });

    expect(flags.find(flag => flag.flag === 'confabulation_risk')).toBeUndefined();
  });

  it('fails closed for invalid monitor input payloads', () => {
    const monitor = new MetacognitiveMonitor();
    expect(() => monitor.detectFlags({
      internalState: makeInternalState(),
      recentResponses: [],
      latestResponse: 'The deployment succeeded.',
      toolCallCount: 1,
      contradictoryMemorySignalCount: -1,
      supportingMemoryCount: 0,
    })).toThrow('contradictoryMemorySignalCount');
  });

  it('formats minimal context and persona hints from detected flags', () => {
    const monitor = new MetacognitiveMonitor();
    const flags = monitor.detectFlags({
      internalState: makeInternalState({
        cognitive: { certaintyLevel: 0.05, topicEngagement: 0.8, processingQuality: 'deliberate' },
      }),
      recentResponses: ['Completely unrelated small talk.'],
      latestResponse: 'The migration is complete and all checks passed.',
      toolCallCount: 0,
      contradictoryMemorySignalCount: 2,
      supportingMemoryCount: 0,
    });

    const contextBlock = formatMetacognitiveNotesContextBlock(flags, {
      minConfidence: 0.4,
      maxFlags: 2,
    });
    expect(contextBlock).toContain('[Metacognitive Notes]');
    expect(contextBlock.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(2);

    const personaHint = buildMetacognitivePersonaHint(flags);
    expect(personaHint).toContain('[Metacognitive Persona Guidance]');
    expect(personaHint).toContain('acknowledge uncertainty');
  });
});
