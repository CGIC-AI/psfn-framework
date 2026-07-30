import { describe, expect, it } from 'vitest';
import type { EmotionAppraisalStateSnapshot } from '../emotion/appraisal-state.js';
import {
  createSocialDesireFeltSignalWriter,
  deriveSocialDesireFeltSignal,
} from './social-desire-felt-signal.js';
import {
  createInMemorySocialDesireBackend,
  createSocialDesireStorePort,
  type SocialDesireRelationshipTierSource,
} from './social-desire-store-port.js';
import type { SocialDesireLifecycleConfig } from './social-desire.js';

const T0 = Date.parse('2026-07-30T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const LIFECYCLE: SocialDesireLifecycleConfig = {
  baseGain: 0.15,
  pressureCap: 3,
  actionThreshold: 1,
  pressureFloor: 0.05,
  decay: { warmHalflifeMs: 72 * HOUR, repairHalflifeMs: 96 * HOUR },
  coolingOff: { warmMs: 1 * HOUR, repairMs: 12 * HOUR },
  releaseFactor: 0.25,
  dampeningFactor: 0.5,
  concernReinforcementGain: 0.3,
  maxReinforcedConcernIds: 16,
  tiers: {
    acquaintance: { gainMultiplier: 0.5, tickGapMs: 24 * HOUR },
    friend: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
    family: { gainMultiplier: 1.4, tickGapMs: 4 * HOUR },
    partner: { gainMultiplier: 2, tickGapMs: 2 * HOUR },
    ai_companion: { gainMultiplier: 1, tickGapMs: 8 * HOUR },
  },
};

function appraisalState(overrides: {
  contactId?: string | null;
  valence?: number;
  confidence?: number;
} = {}): EmotionAppraisalStateSnapshot {
  return {
    schemaVersion: 1,
    emotional: {
      vad: { valence: overrides.valence ?? 0.6, arousal: 0.2, dominance: 0 },
      mood: { valence: 0.1, arousal: 0, dominance: 0 },
      discreteEmotions: { warmth: 0.7 },
      confidence: overrides.confidence ?? 0.8,
      telemetry: { status: 'trusted', source: 'classifier_inferred', reasons: [], weight: 1 },
    },
    cognitive: { certaintyLevel: 0.5, topicEngagement: 0.5, processingQuality: 'clear' },
    attention: { activeConcernCount: 0, salientEntityCount: 0, conversationTrajectory: 'deepening' },
    relational: {
      contactId: overrides.contactId === undefined ? 'contact-1' : overrides.contactId,
      trustLevel: 'trusted',
      moodDrift: 0,
    },
  };
}

describe('deriveSocialDesireFeltSignal (psfn-framework-hrmrq.85)', () => {
  it('projects positive valence to a warm signal scaled by confidence', () => {
    const signal = deriveSocialDesireFeltSignal(appraisalState({ valence: 0.5, confidence: 0.8 }), 'ref-1');
    expect(signal).toEqual({
      contactId: 'contact-1',
      orientation: 'warm',
      intensity: 0.4,
      sourceRef: 'ref-1',
    });
  });

  it('projects negative valence to a repair signal', () => {
    const signal = deriveSocialDesireFeltSignal(appraisalState({ valence: -0.9, confidence: 1 }), 'ref-2');
    expect(signal).toMatchObject({ orientation: 'repair', intensity: 0.9 });
  });

  it('produces nothing without a bound contact (internal/group turns)', () => {
    expect(deriveSocialDesireFeltSignal(appraisalState({ contactId: null }), 'ref')).toBeNull();
  });

  it('fails closed to no signal on zero valence or zero confidence', () => {
    expect(deriveSocialDesireFeltSignal(appraisalState({ valence: 0 }), 'ref')).toBeNull();
    expect(deriveSocialDesireFeltSignal(appraisalState({ confidence: 0 }), 'ref')).toBeNull();
  });
});

describe('createSocialDesireFeltSignalWriter', () => {
  const tierSource: SocialDesireRelationshipTierSource = {
    resolveRelationshipTier: async (contactId) => (contactId === 'contact-1' ? 'partner' : null),
  };

  it('accumulates a durable desire through the single documented write entry', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const writer = createSocialDesireFeltSignalWriter({ store, tierSource, lifecycle: LIFECYCLE });

    const result = await writer.record(appraisalState({ valence: 0.5, confidence: 1 }), {
      sourceRef: 'emotion_appraisal:chan:turn-1',
      nowMs: T0,
    });
    expect(result?.outcome).toBe('created');
    const stored = await store.getByContactId('contact-1');
    expect(stored).not.toBeNull();
    expect(stored!.warmPressure).toBeGreaterThan(0);
  });

  it('tier-gates unknown contacts (no record manufactured)', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const writer = createSocialDesireFeltSignalWriter({ store, tierSource, lifecycle: LIFECYCLE });

    const result = await writer.record(
      appraisalState({ contactId: 'stranger-9', valence: 0.9, confidence: 1 }),
      { sourceRef: 'ref', nowMs: T0 },
    );
    expect(result?.outcome).toBe('tier_gated');
    expect(await store.getByContactId('stranger-9')).toBeNull();
  });

  it('returns null (no store I/O) when nothing was felt', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const writer = createSocialDesireFeltSignalWriter({ store, tierSource, lifecycle: LIFECYCLE });
    const result = await writer.record(appraisalState({ valence: 0 }), { sourceRef: 'ref', nowMs: T0 });
    expect(result).toBeNull();
    expect(store.snapshotDesires()).toEqual([]);
  });

  it('replaying the same turn (same nowMs) is absorbed by the tick-gap throttle', async () => {
    const store = createSocialDesireStorePort(createInMemorySocialDesireBackend());
    const writer = createSocialDesireFeltSignalWriter({ store, tierSource, lifecycle: LIFECYCLE });
    const input = { sourceRef: 'emotion_appraisal:chan:turn-1', nowMs: T0 };

    const first = await writer.record(appraisalState({ valence: 0.5, confidence: 1 }), input);
    const replay = await writer.record(appraisalState({ valence: 0.5, confidence: 1 }), input);
    expect(first?.outcome).toBe('created');
    expect(replay?.outcome).toBe('absorbed');
    expect(store.snapshotDesires()).toHaveLength(1);
  });
});
