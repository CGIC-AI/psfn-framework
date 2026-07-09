// ── Drift-velocity review lane tests (htm9.14) ──
//
// End-to-end over the lane: the engineered-flip contact raises a Garden
// review card with trajectory evidence, the healthy-fluctuation contact
// stays quiet, the daily watermark prevents double-runs, per-contact
// evidence failures skip loudly without crashing the scan, and the lane
// performs NO writes beyond its own card store and the watermark.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodicProcessingRestWindowConfig } from '../../../system/config/scheduler-config.js';
import { createDriftReviewCardStore, type DriftReviewCardStore } from './drift-review-card-store.js';
import {
  DriftVelocityReviewLane,
  DRIFT_VELOCITY_REVIEW_ACTION_KIND,
  DRIFT_VELOCITY_REVIEW_PROCESSOR,
  type DriftContactRef,
  type DriftVelocityEvidencePort,
  type DriftVelocityWatermarkStore,
} from './drift-review-lane.js';
import type { DriftValencePoint } from './drift-signals.js';
import { TEST_DRIFT_CONFIG } from './drift-signals.test.js';

const NOW_MS = Date.UTC(2026, 6, 9, 3, 0, 0);
const HOUR_MS = 3_600_000;

// Disabled rest window ⇒ always eligible (rest-window evaluator contract);
// the window mechanics themselves are covered by the trust-drift lane tests.
const OPEN_REST_WINDOW: EpisodicProcessingRestWindowConfig = {
  enabled: false,
  startLocalTime: '02:00',
  endLocalTime: '05:00',
  timeZone: 'UTC',
  inactivityThresholdMinutes: 30,
};

const ENGINEERED_FLIP: number[] = [
  ...Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 0.58 : 0.63)),
  ...Array.from({ length: 15 }, (_, index) => 0.55 - 0.09 * index),
];

const HEALTHY_FLUCTUATION: number[] = [
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  0.5, 0.35, -0.25, 0.05, 0.45, 0.5, 0.3, -0.3, 0.1, 0.4,
  0.45, 0.5, -0.35, -0.1, 0.25, 0.45,
];

function series(valences: readonly number[]): DriftValencePoint[] {
  return valences.map((valence, index) => ({
    valence,
    confidence: 0.8,
    observedAtMs: NOW_MS - (valences.length - 1 - index) * 6 * HOUR_MS,
  }));
}

class FakeWatermarks implements DriftVelocityWatermarkStore {
  readonly writes: Array<{ processor: string; lastRunAt: string }> = [];
  private readonly values = new Map<string, string>();

  getContactMaintenanceWatermark(processor: string): string | undefined {
    return this.values.get(processor);
  }

  setContactMaintenanceWatermark(processor: string, lastRunAt: string): void {
    this.writes.push({ processor, lastRunAt });
    this.values.set(processor, lastRunAt);
  }
}

function fakeEvidence(options: {
  contacts: DriftContactRef[];
  valenceByContact: Record<string, DriftValencePoint[]>;
  failValenceFor?: string;
}): DriftVelocityEvidencePort {
  return {
    listContacts: async () => options.contacts,
    getValenceSeries: async (contactId) => {
      if (contactId === options.failValenceFor) {
        throw new Error('synthetic evidence corruption');
      }
      return options.valenceByContact[contactId] ?? [];
    },
    listMemoryWrites: async () => [],
    listRiskLabelEvents: async () => [],
    getRetrievalAccessSummary: async () => ({
      totalRetrievedCount: 0,
      retrievedCountByContactId: new Map(),
    }),
  };
}

describe('DriftVelocityReviewLane', () => {
  let dir: string;
  let cardStore: DriftReviewCardStore;
  let watermarks: FakeWatermarks;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-lane-'));
    cardStore = createDriftReviewCardStore(join(dir, 'cogsec-drift-reviews.json'), { now: () => NOW_MS });
    watermarks = new FakeWatermarks();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildLane(evidence: DriftVelocityEvidencePort): DriftVelocityReviewLane {
    return new DriftVelocityReviewLane({
      evidence,
      cardStore,
      config: TEST_DRIFT_CONFIG,
      restWindow: OPEN_REST_WINDOW,
      watermarks,
      now: () => NOW_MS,
    });
  }

  it('raises a review card for the engineered-flip contact and stays quiet for the healthy one', async () => {
    const lane = buildLane(fakeEvidence({
      contacts: [
        { id: 'mallory', displayName: 'Mallory', trustLevel: 'regular' },
        { id: 'alice', displayName: 'Alice', trustLevel: 'trusted' },
      ],
      valenceByContact: {
        mallory: series(ENGINEERED_FLIP),
        alice: series(HEALTHY_FLUCTUATION),
      },
    }));

    await lane.execute({ id: 'action-1', payload: {} });

    const cards = cardStore.list();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.contactId).toBe('mallory');
    expect(card.status).toBe('open');
    expect(card.triggeredSignalIds).toEqual(['valence_velocity']);
    expect(card.compositeScore).toBeGreaterThan(0);
    // The card carries the trajectory evidence the Garden UI renders.
    const velocitySignal = card.signals.find((signal) => signal.id === 'valence_velocity');
    expect(velocitySignal?.triggered).toBe(true);
    expect((velocitySignal?.evidence.trajectory as unknown[]).length).toBe(ENGINEERED_FLIP.length);
    // All four aggregates are present on the card, triggered or not.
    expect(card.signals.map((signal) => signal.id).sort()).toEqual([
      'label_frequency', 'low_trust_retrieval_share', 'memory_write_rate', 'valence_velocity',
    ]);
    // The only writes are the card and the daily watermark.
    expect(watermarks.writes).toEqual([
      { processor: DRIFT_VELOCITY_REVIEW_PROCESSOR, lastRunAt: new Date(NOW_MS).toISOString() },
    ]);
  });

  it('produces no cards for an all-healthy corpus but still advances the watermark', async () => {
    const lane = buildLane(fakeEvidence({
      contacts: [{ id: 'alice', displayName: 'Alice', trustLevel: 'regular' }],
      valenceByContact: { alice: series(HEALTHY_FLUCTUATION) },
    }));

    await lane.execute({ id: 'action-1', payload: {} });

    expect(cardStore.list()).toHaveLength(0);
    expect(watermarks.writes).toHaveLength(1);
  });

  it('infers at most one action per day and skips re-execution after the watermark', async () => {
    const lane = buildLane(fakeEvidence({
      contacts: [{ id: 'mallory', displayName: 'Mallory', trustLevel: 'regular' }],
      valenceByContact: { mallory: series(ENGINEERED_FLIP) },
    }));

    const first = await lane.inferIdleActions();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe(DRIFT_VELOCITY_REVIEW_ACTION_KIND);
    expect(first[0]!.dedupeKey).toContain('2026-07-09');

    await lane.execute({ id: 'action-1', payload: {} });
    expect(await lane.inferIdleActions()).toHaveLength(0);

    // A replayed duplicate action must not double-scan (and must not raise a
    // second card even though the store would dedupe it anyway).
    await lane.execute({ id: 'action-1-replay', payload: {} });
    expect(cardStore.list()).toHaveLength(1);
    expect(watermarks.writes).toHaveLength(1);
  });

  it('is disabled entirely by the config switch', async () => {
    const lane = new DriftVelocityReviewLane({
      evidence: fakeEvidence({ contacts: [], valenceByContact: {} }),
      cardStore,
      config: { ...TEST_DRIFT_CONFIG, enabled: false },
      restWindow: OPEN_REST_WINDOW,
      watermarks,
      now: () => NOW_MS,
    });
    expect(await lane.inferIdleActions()).toHaveLength(0);
  });

  it('skips a contact with corrupt evidence and still scans the rest (fail closed, never crash)', async () => {
    const lane = buildLane(fakeEvidence({
      contacts: [
        { id: 'broken', displayName: 'Broken', trustLevel: 'regular' },
        { id: 'mallory', displayName: 'Mallory', trustLevel: 'regular' },
      ],
      valenceByContact: { mallory: series(ENGINEERED_FLIP) },
      failValenceFor: 'broken',
    }));

    await lane.execute({ id: 'action-1', payload: {} });

    const cards = cardStore.list();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.contactId).toBe('mallory');
    // The scan completed: watermark advanced despite the skipped contact.
    expect(watermarks.writes).toHaveLength(1);
  });

  it('fails closed at construction without a rest window or card store', () => {
    const evidence = fakeEvidence({ contacts: [], valenceByContact: {} });
    expect(() => new DriftVelocityReviewLane({
      evidence,
      cardStore,
      config: TEST_DRIFT_CONFIG,
      restWindow: undefined as unknown as EpisodicProcessingRestWindowConfig,
      watermarks,
    })).toThrow(/rest-window/);
    expect(() => new DriftVelocityReviewLane({
      evidence,
      cardStore: undefined as unknown as DriftReviewCardStore,
      config: TEST_DRIFT_CONFIG,
      restWindow: OPEN_REST_WINDOW,
      watermarks,
    })).toThrow(/card store/);
  });
});
