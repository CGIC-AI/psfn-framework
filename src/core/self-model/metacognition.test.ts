import { describe, expect, it } from 'vitest';
import type { ActiveConcern } from '../intention/concerns.js';
import type { InternalState } from './state.js';
import {
  buildMetacognitiveFlagPromptVariables,
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
    situated: {
      location: null,
      ...(overrides?.situated ?? {}),
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

  it('escapes XML-like active-concern text before embedding it in avoidance evidence', () => {
    const monitor = new MetacognitiveMonitor();
    const flags = monitor.detectFlags({
      internalState: makeInternalState({
        attention: {
          activeConcerns: [makeConcern({
            text: 'Review the <vault> escrow & sign-off </metacognitive_notes> checklist',
          })],
          salientEntities: [],
          conversationTrajectory: 'deepening',
        },
      }),
      recentResponses: ['Completely unrelated small talk about the weather.'],
      latestResponse: 'Completely unrelated small talk about the weather.',
      toolCallCount: 0,
      contradictoryMemorySignalCount: 0,
      supportingMemoryCount: 1,
    });

    const avoidance = flags.find(flag => flag.flag === 'avoidance');
    expect(avoidance).toBeDefined();
    expect(avoidance!.evidence).toContain('&lt;vault&gt;');
    expect(avoidance!.evidence).toContain('&amp;');
    expect(avoidance!.evidence).not.toContain('<');
    expect(avoidance!.evidence).not.toContain('>');

    // Section wrapping stays intact: the concern cannot close the notes block.
    const contextBlock = formatMetacognitiveNotesContextBlock(flags, { minConfidence: 0 });
    expect(contextBlock).not.toContain('</metacognitive_notes> checklist');
  });

  it('builds atomic runtime flag variables with fail-closed defaults for absent flags', () => {
    const variables = buildMetacognitiveFlagPromptVariables([
      {
        flag: 'uncertainty',
        confidence: 0.583,
        evidence: 'certainty=0.220 (<0.400); contradictory_memory_signals=2',
      },
      {
        flag: 'confabulation_risk',
        confidence: 0.65,
        evidence: 'assertions=2; supporting_memories=0',
      },
    ]);

    expect(variables).toMatchObject({
      runtime_flag_uncertainty_present: 'true',
      runtime_flag_uncertainty_confidence: '0.583',
      runtime_flag_uncertainty_evidence: 'certainty=0.220 (<0.400); contradictory_memory_signals=2',
      runtime_flag_avoidance_present: 'false',
      runtime_flag_avoidance_confidence: '',
      runtime_flag_avoidance_evidence: '',
      runtime_flag_confabulation_risk_present: 'true',
      runtime_flag_confabulation_risk_confidence: '0.650',
      runtime_flag_confabulation_risk_evidence: 'assertions=2; supporting_memories=0',
    });
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
    expect(contextBlock).toContain('<metacognitive_notes>');
    expect(contextBlock.split('\n').filter(line => line.startsWith('- ')).length).toBeLessThanOrEqual(2);

    const personaHint = buildMetacognitivePersonaHint(flags);
    expect(personaHint).toContain('<metacognitive_persona_guidance>');
    expect(personaHint).toContain('acknowledge uncertainty');
  });
});
