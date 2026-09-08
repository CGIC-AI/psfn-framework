import { describe, expect, it } from 'vitest';
import type { ActiveConcern, ActiveConcernVAD } from '../../shared/contracts/intention-contracts.js';
import type { ConcernResolutionAppraisalEvent } from './concern-resolution-appraisal.js';
import {
  applyWeightedThoughtContradictionDampening,
  detectSaidFineContradiction,
} from './weighted-thought-contradiction.js';
import {
  createInMemoryWeightedThoughtBackend,
  createWeightedThoughtStorePort,
} from './weighted-thought-store-port.js';
import {
  createThoughtWeight,
  decayedWeight,
  type WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';

const HOUR = 60 * 60 * 1000;

const CONFIG: WeightedThoughtLifecycleConfig = {
  classes: {
    time_sensitive: { baseWeight: 0.5, halflifeMs: 6 * HOUR },
    standard: { baseWeight: 0.4, halflifeMs: 24 * HOUR },
    trivial: { baseWeight: 0.2, halflifeMs: 72 * HOUR },
  },
  reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 1 },
  accumulatedWeightCap: 3,
  contradictionDampeningFactor: 0.6,
  declineDampeningFactor: 0.5,
  relevanceFloor: 0.05,
};

const T0 = Date.parse('2026-07-02T12:00:00.000Z');

const vad = (valence: number, arousal = 0.4, dominance = 0.1): ActiveConcernVAD => ({
  valence,
  arousal,
  dominance,
});

describe('detectSaidFineContradiction', () => {
  it('fires when resolution valence stays non-positive with no relief', () => {
    expect(detectSaidFineContradiction({
      formationVad: vad(-0.3),
      resolutionVad: vad(-0.4),
    })).toBe(true);
  });

  it('fires when resolution valence is flat-negative equal to formation', () => {
    expect(detectSaidFineContradiction({
      formationVad: vad(-0.2),
      resolutionVad: vad(-0.2),
    })).toBe(true);
  });

  it('does not fire when there was genuine relief (valence rose)', () => {
    expect(detectSaidFineContradiction({
      formationVad: vad(-0.5),
      resolutionVad: vad(-0.1),
    })).toBe(false);
  });

  it('does not fire when resolution valence is positive', () => {
    expect(detectSaidFineContradiction({
      formationVad: vad(0.1),
      resolutionVad: vad(0.3),
    })).toBe(false);
  });

  it('never fabricates a contradiction when either VAD snapshot is absent', () => {
    expect(detectSaidFineContradiction({ resolutionVad: vad(-0.4) })).toBe(false);
    expect(detectSaidFineContradiction({ formationVad: vad(-0.4) })).toBe(false);
    expect(detectSaidFineContradiction({})).toBe(false);
  });

  it('honors a custom valence ceiling', () => {
    // With a ceiling of 0.5, a resolution valence of 0.3 (no relief) still counts.
    expect(detectSaidFineContradiction({
      formationVad: vad(0.4),
      resolutionVad: vad(0.3),
    }, 0.5)).toBe(true);
  });
});

function resolutionEvent(
  concern: ActiveConcern,
  source: ConcernResolutionAppraisalEvent['source'] = 'decision',
): ConcernResolutionAppraisalEvent {
  return {
    concernId: concern.id,
    resolutionGenerationId: concern.resolutionGenerationId!,
    source,
    formationVad: concern.formationVAD!,
    resolutionVad: concern.resolutionVAD!,
    reliefDelta: {
      valence: concern.resolutionVAD!.valence - concern.formationVAD!.valence,
      arousal: concern.resolutionVAD!.arousal - concern.formationVAD!.arousal,
      dominance: concern.resolutionVAD!.dominance - concern.formationVAD!.dominance,
    },
    timestamp: T0,
  };
}

function stubConcern(overrides: Partial<ActiveConcern>): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Morgan seemed stressed earlier',
    priority: 'medium',
    source: 'appraisal',
    status: 'resolved',
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 72 * HOUR).toISOString(),
    salience: 0.5,
    sensitivity: 'normal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    contactId: 'contact-v',
    formationVAD: vad(-0.4),
    resolutionVAD: vad(-0.5),
    resolutionGenerationId: 'gen-1',
    ...overrides,
  } as ActiveConcern;
}

describe('applyWeightedThoughtContradictionDampening (production path)', () => {
  it('dampens the resolving contact\'s active thought (reduced, never zeroed)', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const seeded = createThoughtWeight({
      id: 'care-thought-v',
      content: 'Check in on Morgan',
      source: 'concern',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      emotionalIntensity: 0.8,
      provenance: { concernId: 'concern-1' },
    }, CONFIG, T0);
    await store.save(seeded);

    // Evaluate dampening one hour after creation so decay is in play too.
    const nowMs = T0 + HOUR;
    const concern = stubConcern({});
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => nowMs,
      },
      resolutionEvent(concern),
    );

    expect(result.contradiction).toBe(true);
    expect(result.dampenedThoughtIds).toEqual(['care-thought-v']);

    const persisted = await store.getById('care-thought-v');
    const expectedDecay = decayedWeight(seeded, nowMs);
    // Observable production effect: weight is the decayed weight * factor, not
    // decay alone — and strictly above zero.
    expect(persisted!.accumulatedWeight).toBeCloseTo(expectedDecay * CONFIG.contradictionDampeningFactor, 6);
    expect(persisted!.accumulatedWeight).toBeGreaterThan(0);
    expect(persisted!.accumulatedWeight).toBeLessThan(expectedDecay);
  });

  it('leaves the thought on pure decay when there is no contradiction (relief)', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const seeded = createThoughtWeight({
      id: 'care-thought-v',
      content: 'Check in on Morgan',
      source: 'concern',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      emotionalIntensity: 0.8,
      provenance: { concernId: 'concern-1' },
    }, CONFIG, T0);
    await store.save(seeded);

    const nowMs = T0 + HOUR;
    // Genuine relief: resolution valence rose above formation -> no contradiction.
    const concern = stubConcern({ formationVAD: vad(-0.5), resolutionVAD: vad(0.3) });
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => nowMs,
      },
      resolutionEvent(concern),
    );

    expect(result.contradiction).toBe(false);
    expect(result.dampenedThoughtIds).toEqual([]);
    const persisted = await store.getById('care-thought-v');
    // Untouched: accumulatedWeight is unchanged (decay is applied at read time).
    expect(persisted!.accumulatedWeight).toBeCloseTo(seeded.accumulatedWeight, 6);
  });

  it('never dampens a contact-less (global) thought', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const global = createThoughtWeight({
      id: 'global-thought',
      content: 'Return to project',
      source: 'personal_project',
      thoughtClass: 'standard',
    }, CONFIG, T0);
    await store.save(global);

    const concern = stubConcern({});
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => T0 + HOUR,
      },
      resolutionEvent(concern),
    );

    expect(result.dampenedThoughtIds).toEqual([]);
    const persisted = await store.getById('global-thought');
    expect(persisted!.accumulatedWeight).toBeCloseTo(global.accumulatedWeight, 6);
  });

  it('skips when the resolution generation is superseded', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const seeded = createThoughtWeight({
      id: 'care-thought-v',
      content: 'Check in on Morgan',
      source: 'concern',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      provenance: { concernId: 'concern-1' },
    }, CONFIG, T0);
    await store.save(seeded);

    const concern = stubConcern({ resolutionGenerationId: 'gen-2' });
    const event = resolutionEvent({ ...concern, resolutionGenerationId: 'gen-1' } as ActiveConcern);
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => T0 + HOUR,
      },
      event,
    );

    expect(result.contradiction).toBe(false);
    expect(result.dampenedThoughtIds).toEqual([]);
  });

  it('leaves the contact\'s other active concerns undamped (concern-scoped, 99ugi)', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const contradicted = createThoughtWeight({
      id: 'care-thought-contradicted',
      content: 'Check in on Morgan about the move',
      source: 'concern',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      provenance: { concernId: 'concern-1' },
    }, CONFIG, T0);
    const otherConcern = createThoughtWeight({
      id: 'care-thought-other-concern',
      content: 'Morgan\'s recital is Friday',
      source: 'concern',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      provenance: { concernId: 'concern-2' },
    }, CONFIG, T0);
    const followUp = createThoughtWeight({
      id: 'care-thought-follow-up',
      content: 'Send Morgan the reading list',
      source: 'follow_up',
      thoughtClass: 'standard',
      contactId: 'contact-v',
      provenance: { pendingFollowUpId: 'follow-up-9' },
    }, CONFIG, T0);
    await store.save(contradicted);
    await store.save(otherConcern);
    await store.save(followUp);

    const nowMs = T0 + HOUR;
    const concern = stubConcern({});
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => nowMs,
      },
      resolutionEvent(concern),
    );

    expect(result.contradiction).toBe(true);
    // Only the contradicted concern's own thought is dampened.
    expect(result.dampenedThoughtIds).toEqual(['care-thought-contradicted']);

    const dampened = await store.getById('care-thought-contradicted');
    expect(dampened!.accumulatedWeight).toBeCloseTo(
      decayedWeight(contradicted, nowMs) * CONFIG.contradictionDampeningFactor,
      6,
    );
    // The contact's other live threads keep their full accumulated weight.
    const survivingConcern = await store.getById('care-thought-other-concern');
    expect(survivingConcern!.accumulatedWeight).toBeCloseTo(otherConcern.accumulatedWeight, 6);
    const survivingFollowUp = await store.getById('care-thought-follow-up');
    expect(survivingFollowUp!.accumulatedWeight).toBeCloseTo(followUp.accumulatedWeight, 6);
  });

  it.each(['grooming_stale', 'grooming_cap'] as const)(
    'never damps on an administrative %s resolution (99ugi)',
    async (source) => {
      const backend = createInMemoryWeightedThoughtBackend();
      const store = createWeightedThoughtStorePort(backend);
      const seeded = createThoughtWeight({
        id: 'care-thought-v',
        content: 'Check in on Morgan',
        source: 'concern',
        thoughtClass: 'standard',
        contactId: 'contact-v',
        provenance: { concernId: 'concern-1' },
      }, CONFIG, T0);
      await store.save(seeded);

      // The concern's VAD pair WOULD read as a contradiction; the grooming
      // source is what stops the damping.
      const concern = stubConcern({});
      const result = await applyWeightedThoughtContradictionDampening(
        {
          concernStore: { getById: async () => concern },
          thoughtStore: store,
          lifecycleConfig: CONFIG,
          now: () => T0 + HOUR,
        },
        resolutionEvent(concern, source),
      );

      expect(result.contradiction).toBe(false);
      expect(result.dampenedThoughtIds).toEqual([]);
      const persisted = await store.getById('care-thought-v');
      expect(persisted!.accumulatedWeight).toBeCloseTo(seeded.accumulatedWeight, 6);
    },
  );

  it('never damps a contact thought that tracks no concern at all', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const coLocation = createThoughtWeight({
      id: 'co-location-thought',
      content: 'Ran into Morgan at the studio',
      source: 'co_location',
      thoughtClass: 'trivial',
      contactId: 'contact-v',
      provenance: { coLocationRef: 'arrival-7' },
    }, CONFIG, T0);
    await store.save(coLocation);

    const concern = stubConcern({});
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => T0 + HOUR,
      },
      resolutionEvent(concern),
    );

    expect(result.contradiction).toBe(true);
    expect(result.dampenedThoughtIds).toEqual([]);
    const persisted = await store.getById('co-location-thought');
    expect(persisted!.accumulatedWeight).toBeCloseTo(coLocation.accumulatedWeight, 6);
  });

  it('skips a contact-less concern', async () => {
    const backend = createInMemoryWeightedThoughtBackend();
    const store = createWeightedThoughtStorePort(backend);
    const concern = stubConcern({ contactId: undefined });
    const result = await applyWeightedThoughtContradictionDampening(
      {
        concernStore: { getById: async () => concern },
        thoughtStore: store,
        lifecycleConfig: CONFIG,
        now: () => T0 + HOUR,
      },
      resolutionEvent(concern),
    );
    expect(result.contactId).toBeUndefined();
    expect(result.dampenedThoughtIds).toEqual([]);
  });
});
