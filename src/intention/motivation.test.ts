import { describe, expect, it } from 'vitest';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import { MotivationBridge } from './motivation.js';

function makeEmotionSnapshot(overrides?: Partial<EmotionStateSnapshot>): EmotionStateSnapshot {
  return {
    vad: { valence: 0, arousal: 0, dominance: 0 },
    mood: { valence: 0, arousal: 0, dominance: 0 },
    discrete: {},
    confidence: 0.8,
    ...overrides,
  };
}

describe('MotivationBridge', () => {
  it('uses lower primary-contact thresholds for sustained negative valence', () => {
    const bridge = new MotivationBridge();

    const firstPrimary = bridge.assess({
      sessionId: 'primary-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.3, arousal: 0.1, dominance: -0.1 },
      }),
      isPrimaryContact: true,
    });
    const secondPrimary = bridge.assess({
      sessionId: 'primary-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.31, arousal: 0.05, dominance: -0.1 },
      }),
      isPrimaryContact: true,
    });

    const firstDefault = bridge.assess({
      sessionId: 'default-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.3, arousal: 0.1, dominance: -0.1 },
      }),
      isPrimaryContact: false,
    });
    const secondDefault = bridge.assess({
      sessionId: 'default-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.31, arousal: 0.05, dominance: -0.1 },
      }),
      isPrimaryContact: false,
    });

    expect(firstPrimary.shouldTriggerAppraisal).toBe(false);
    expect(secondPrimary.shouldTriggerAppraisal).toBe(true);
    expect(secondPrimary.signals.map(signal => signal.kind)).toContain('sustained_negative_valence');
    expect(firstDefault.shouldTriggerAppraisal).toBe(false);
    expect(secondDefault.shouldTriggerAppraisal).toBe(false);
  });

  it('detects arousal spikes and large VAD deltas deterministically', () => {
    const bridge = new MotivationBridge();

    bridge.assess({
      sessionId: 'arousal-session',
      currentEmotion: makeEmotionSnapshot({
        vad: { valence: 0, arousal: 0.1, dominance: 0 },
        mood: { valence: 0, arousal: 0.1, dominance: 0 },
      }),
    });

    const second = bridge.assess({
      sessionId: 'arousal-session',
      currentEmotion: makeEmotionSnapshot({
        vad: { valence: 0.1, arousal: 0.7, dominance: 0.2 },
        mood: { valence: 0.1, arousal: 0.6, dominance: 0.1 },
      }),
    });

    expect(second.shouldTriggerAppraisal).toBe(true);
    expect(second.signals.map(signal => signal.kind).sort()).toEqual(['arousal_spike', 'vad_delta']);
    expect(second.metrics.maxEmotionDelta).toBeGreaterThanOrEqual(0.5);
    expect(second.metrics.arousalDelta).toBeGreaterThanOrEqual(0.5);
  });

  it('fails closed below confidence threshold and resets streak counters', () => {
    const bridge = new MotivationBridge({
      defaultThresholds: {
        sustainedNegativeTurns: 2,
      },
    });

    const lowConfidence = bridge.assess({
      sessionId: 'confidence-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.8, arousal: 0, dominance: 0 },
        confidence: 0.05,
      }),
    });
    const firstHighConfidence = bridge.assess({
      sessionId: 'confidence-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.8, arousal: 0, dominance: 0 },
        confidence: 0.8,
      }),
    });
    const secondHighConfidence = bridge.assess({
      sessionId: 'confidence-session',
      currentEmotion: makeEmotionSnapshot({
        mood: { valence: -0.82, arousal: 0, dominance: 0 },
        confidence: 0.8,
      }),
    });

    expect(lowConfidence.shouldTriggerAppraisal).toBe(false);
    expect(lowConfidence.metrics.negativeValenceStreak).toBe(0);
    expect(firstHighConfidence.shouldTriggerAppraisal).toBe(false);
    expect(firstHighConfidence.metrics.negativeValenceStreak).toBe(1);
    expect(secondHighConfidence.shouldTriggerAppraisal).toBe(true);
    expect(secondHighConfidence.signals.map(signal => signal.kind)).toContain('sustained_negative_valence');
  });
});
