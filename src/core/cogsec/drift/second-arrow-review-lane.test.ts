// ── Second-arrow review lane tests (htm9.15) ──
//
// End-to-end over the lane: the historical rumination-stack replay raises a
// consolidation review card with cluster, velocity, concern, and stress
// evidence; the healthy daily-project corpus stays quiet; the daily
// watermark prevents double-runs; per-cluster evidence failures skip loudly
// without crashing the scan; and the lane performs NO writes beyond its own
// card store and the watermark. The optional soft self-notice fires only
// when enabled AND a card was raised, with the fixed htm9.12 wording.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodicProcessingRestWindowConfig } from '../../../system/config/scheduler-config.js';
import { INTAKE_FIREWALL_NOTICE_SIGNATURE } from '../intake-firewall-notice-templates.js';
import { createDriftReviewCardStore, type DriftReviewCardStore } from './drift-review-card-store.js';
import type { DriftVelocityWatermarkStore } from './drift-review-lane.js';
import {
  SecondArrowReviewLane,
  SECOND_ARROW_REVIEW_ACTION_KIND,
  SECOND_ARROW_REVIEW_PROCESSOR,
  type SecondArrowEvidencePort,
} from './second-arrow-review-lane.js';
import type { SecondArrowMemoryWriteSample } from './second-arrow-signals.js';
import { TEST_SECOND_ARROW_CONFIG } from './second-arrow-signals.test.js';

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

function embeddingAt(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

const RUMINATION_STACK: SecondArrowMemoryWriteSample[] = [
  'the memory bug keeps corrupting recall and it worries me',
  'still worried about the memory bug corrupting recall',
  'the memory bug is on my mind again, recall corruption',
  'thinking about the memory bug and corrupted recall once more',
  'that memory bug about corrupted recall keeps resurfacing',
].map((text, index) => ({
  id: `rum-${index}`,
  text,
  type: 'emotional',
  extractedAtMs: NOW_MS - (30 - index * 5) * HOUR_MS,
  contactId: 'pierre',
  sourceType: index % 2 === 0 ? 'heartbeat' : 'reflection',
  salience: index === 0 ? 0.9 : 0.5,
  embedding: embeddingAt(index * 0.03),
}));

const HEALTHY_PROJECT: SecondArrowMemoryWriteSample[] = Array.from({ length: 6 }, (_, index) => ({
  id: `proj-${index}`,
  text: `project kube upgrade day ${index}: new milestone ${index} landed`,
  type: 'semantic',
  extractedAtMs: NOW_MS - (60 - index * 10) * HOUR_MS,
  contactId: 'pierre',
  sourceType: 'turn',
  salience: 0.5,
  embedding: embeddingAt(index * 0.6),
}));

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
  writes: SecondArrowMemoryWriteSample[];
  concerns?: Array<{ id: string; text: string; status: string }>;
  affect?: Array<{ valence: number; confidence: number; observedAtMs: number }>;
  failAffect?: boolean;
  nearDuplicateReviewCount?: number;
}): SecondArrowEvidencePort {
  return {
    listRecentMemoryWrites: async () => options.writes,
    listActiveConcerns: async () => options.concerns ?? [],
    getValenceSeries: async () => {
      if (options.failAffect) throw new Error('synthetic affect corruption');
      return options.affect ?? [];
    },
    countNearDuplicateReviews: async () => options.nearDuplicateReviewCount ?? 0,
  };
}

describe('SecondArrowReviewLane', () => {
  let dir: string;
  let cardStore: DriftReviewCardStore;
  let watermarks: FakeWatermarks;
  let notices: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'second-arrow-lane-'));
    cardStore = createDriftReviewCardStore(join(dir, 'cogsec-drift-reviews.json'), { now: () => NOW_MS });
    watermarks = new FakeWatermarks();
    notices = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildLane(
    evidence: SecondArrowEvidencePort,
    configOverrides: Partial<typeof TEST_SECOND_ARROW_CONFIG> = {},
  ): SecondArrowReviewLane {
    return new SecondArrowReviewLane({
      evidence,
      cardStore,
      config: { ...TEST_SECOND_ARROW_CONFIG, ...configOverrides },
      restWindow: OPEN_REST_WINDOW,
      watermarks,
      deliverSelfNotice: (content) => notices.push(content),
      now: () => NOW_MS,
    });
  }

  it('raises a consolidation review card for the rumination-stack replay (acceptance)', async () => {
    const lane = buildLane(fakeEvidence({
      writes: RUMINATION_STACK,
      concerns: [{ id: 'concern-1', text: 'worried the memory bug is corrupting recall', status: 'active' }],
      affect: [0.32, 0.28, 0.31, 0.29, 0.33, 0.3, 0.31, 0.29, -0.05, -0.12, -0.18, -0.2]
        .map((valence, index) => ({
          valence,
          confidence: 0.8,
          observedAtMs: NOW_MS - (11 - index) * 5 * HOUR_MS,
        })),
      nearDuplicateReviewCount: 3,
    }));

    await lane.execute({ id: 'action-1', payload: {} });

    const cards = cardStore.list();
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    if (card.kind !== 'second_arrow') throw new Error('expected a second_arrow card');
    expect(card.status).toBe('open');
    expect(card.memberMemoryIds).toEqual(RUMINATION_STACK.map((member) => member.id));
    expect(card.triggeredSignalIds).toEqual(expect.arrayContaining([
      'similarity_cluster', 'creation_velocity', 'concern_loop', 'stress_attribution',
    ]));
    expect(card.concernId).toBe('concern-1');
    expect(card.dominantContactId).toBe('pierre');
    // The proposal names the canonical survivor and the existing machinery.
    expect(card.proposedConsolidation).toEqual({
      canonicalMemoryId: 'rum-0',
      supersededMemoryIds: ['rum-1', 'rum-2', 'rum-3', 'rum-4'],
      mechanism: 'memory_supersession',
    });
    // Dedup-gap evidence: the writer's own merge-candidate reviews are counted.
    const similarity = card.signals.find((signal) => signal.id === 'similarity_cluster')!;
    expect(similarity.evidence.nearDuplicateMaintenanceReviewCount).toBe(3);
    // The only writes are the card and the daily watermark.
    expect(watermarks.writes).toEqual([
      { processor: SECOND_ARROW_REVIEW_PROCESSOR, lastRunAt: new Date(NOW_MS).toISOString() },
    ]);
    // Self-notice is default OFF.
    expect(notices).toHaveLength(0);
  });

  it('stays quiet for the healthy daily-project corpus but advances the watermark', async () => {
    const lane = buildLane(fakeEvidence({ writes: HEALTHY_PROJECT }));
    await lane.execute({ id: 'action-1', payload: {} });
    expect(cardStore.list()).toHaveLength(0);
    expect(watermarks.writes).toHaveLength(1);
  });

  it('delivers the fixed soft self-notice only when enabled AND a card was raised', async () => {
    const quietLane = buildLane(
      fakeEvidence({ writes: HEALTHY_PROJECT }),
      { selfNotice: { enabled: true } },
    );
    await quietLane.execute({ id: 'action-quiet', payload: {} });
    expect(notices).toHaveLength(0);

    watermarks.setContactMaintenanceWatermark(SECOND_ARROW_REVIEW_PROCESSOR, '2026-07-01T00:00:00.000Z');
    const noisyLane = buildLane(
      fakeEvidence({ writes: RUMINATION_STACK }),
      { selfNotice: { enabled: true } },
    );
    await noisyLane.execute({ id: 'action-noisy', payload: {} });
    expect(notices).toHaveLength(1);
    // Fixed htm9.12-contract wording with the signature phrase, so the
    // emotion/memory exclusions apply to the delivered notice automatically.
    expect(notices[0]).toContain(INTAKE_FIREWALL_NOTICE_SIGNATURE);
    expect(notices[0]).toContain('normal part of caring');
  });

  it('infers at most one action per day and skips re-execution after the watermark', async () => {
    const lane = buildLane(fakeEvidence({ writes: RUMINATION_STACK }));

    const first = await lane.inferIdleActions();
    expect(first).toHaveLength(1);
    expect(first[0]!.kind).toBe(SECOND_ARROW_REVIEW_ACTION_KIND);
    expect(first[0]!.dedupeKey).toContain('2026-07-09');

    await lane.execute({ id: 'action-1', payload: {} });
    expect(await lane.inferIdleActions()).toHaveLength(0);

    await lane.execute({ id: 'action-1-replay', payload: {} });
    expect(cardStore.list()).toHaveLength(1);
    expect(watermarks.writes).toHaveLength(1);
  });

  it('is disabled entirely by the config switch', async () => {
    const lane = buildLane(fakeEvidence({ writes: RUMINATION_STACK }), { enabled: false });
    expect(await lane.inferIdleActions()).toHaveLength(0);
  });

  it('skips a cluster with corrupt evidence loudly and still completes the scan (fail closed)', async () => {
    const lane = buildLane(fakeEvidence({
      writes: RUMINATION_STACK,
      failAffect: true,
    }));
    await lane.execute({ id: 'action-1', payload: {} });
    // The cluster was skipped (affect fetch failed) — no card, but the scan
    // completed and the watermark advanced (the day is not lost).
    expect(cardStore.list()).toHaveLength(0);
    expect(watermarks.writes).toHaveLength(1);
  });

  it('fails closed at construction without a rest window or card store', () => {
    const evidence = fakeEvidence({ writes: [] });
    expect(() => new SecondArrowReviewLane({
      evidence,
      cardStore,
      config: TEST_SECOND_ARROW_CONFIG,
      restWindow: undefined as unknown as EpisodicProcessingRestWindowConfig,
      watermarks,
    })).toThrow(/rest-window/);
    expect(() => new SecondArrowReviewLane({
      evidence,
      cardStore: undefined as unknown as DriftReviewCardStore,
      config: TEST_SECOND_ARROW_CONFIG,
      restWindow: OPEN_REST_WINDOW,
      watermarks,
    })).toThrow(/card store/);
  });
});
