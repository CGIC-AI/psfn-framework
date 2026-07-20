import { describe, expect, it } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { ActiveConcern } from './concerns.js';
import {
  buildConcernResolutionAppraisalEvent,
  computeConcernReliefDelta,
  emitConcernResolutionAppraisal,
} from './concern-resolution-appraisal.js';

function concernFixture(overrides: Partial<ActiveConcern> = {}): ActiveConcern {
  return {
    id: 'concern-1',
    text: 'Follow up on the migration rollback',
    priority: 'medium',
    source: 'agent',
    status: 'resolved',
    createdAt: '2026-06-29T10:00:00.000Z',
    expiresAt: '2026-06-30T10:00:00.000Z',
    salience: 0.5,
    sensitivity: 'personal',
    owner: 'companion',
    evidenceRefs: [],
    resolutionEvidenceRefs: [],
    resolvedAt: '2026-06-29T12:00:00.000Z',
    formationVAD: { valence: -0.4, arousal: 0.6, dominance: -0.2 },
    resolutionVAD: { valence: 0.3, arousal: 0.1, dominance: 0.2 },
    ...overrides,
  };
}

describe('computeConcernReliefDelta', () => {
  it('is the component-wise resolution − formation difference', () => {
    const delta = computeConcernReliefDelta(
      { valence: -0.4, arousal: 0.6, dominance: -0.2 },
      { valence: 0.3, arousal: 0.1, dominance: 0.2 },
    );
    expect(delta.valence).toBeCloseTo(0.7, 10);
    expect(delta.arousal).toBeCloseTo(-0.5, 10);
    expect(delta.dominance).toBeCloseTo(0.4, 10);
  });

  it('preserves a negative valence delta (anticlimax) without forcing a sign', () => {
    const delta = computeConcernReliefDelta(
      { valence: 0.5, arousal: 0.2, dominance: 0.1 },
      { valence: -0.1, arousal: 0.2, dominance: 0.1 },
    );
    expect(delta.valence).toBeCloseTo(-0.6, 10);
    expect(delta.arousal).toBeCloseTo(0, 10);
    expect(delta.dominance).toBeCloseTo(0, 10);
  });
});

describe('buildConcernResolutionAppraisalEvent', () => {
  it('builds a payload carrying both snapshots and the relief delta', () => {
    const event = buildConcernResolutionAppraisalEvent({
      concern: concernFixture(),
      source: 'decision',
      now: () => 1_700_000_000_000,
    });
    expect(event).not.toBeNull();
    expect(event).toMatchObject({
      concernId: 'concern-1',
      source: 'decision',
      formationVad: { valence: -0.4, arousal: 0.6, dominance: -0.2 },
      resolutionVad: { valence: 0.3, arousal: 0.1, dominance: 0.2 },
      resolvedAt: '2026-06-29T12:00:00.000Z',
      timestamp: 1_700_000_000_000,
    });
    expect(event?.reliefDelta.valence).toBeCloseTo(0.7, 10);
  });

  it('returns null when the formation snapshot is missing (no fabrication)', () => {
    const concern = concernFixture();
    delete concern.formationVAD;
    expect(
      buildConcernResolutionAppraisalEvent({ concern, source: 'decision' }),
    ).toBeNull();
  });

  it('returns null when no resolution snapshot was captured', () => {
    const concern = concernFixture();
    delete concern.resolutionVAD;
    expect(
      buildConcernResolutionAppraisalEvent({ concern, source: 'grooming_stale' }),
    ).toBeNull();
  });
});

describe('emitConcernResolutionAppraisal', () => {
  it('emits the resolution appraisal event with the correct delta', async () => {
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.on('intention.concern.resolution_appraisal', event => events.push(event));

    const emitted = await emitConcernResolutionAppraisal(eventBus, {
      concern: concernFixture(),
      source: 'grooming_cap',
      now: () => 42,
    });

    expect(emitted).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      concernId: 'concern-1',
      source: 'grooming_cap',
      reliefDelta: { valence: expect.closeTo(0.7, 10) },
      timestamp: 42,
    });
  });

  it('is a no-op when the arc is incomplete', async () => {
    const eventBus = new EventBus();
    const events: unknown[] = [];
    eventBus.on('intention.concern.resolution_appraisal', event => events.push(event));
    const concern = concernFixture();
    delete concern.resolutionVAD;

    const emitted = await emitConcernResolutionAppraisal(eventBus, {
      concern,
      source: 'decision',
    });

    expect(emitted).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('is a no-op without an event bus', async () => {
    const emitted = await emitConcernResolutionAppraisal(null, {
      concern: concernFixture(),
      source: 'decision',
    });
    expect(emitted).toBe(false);
  });
});
