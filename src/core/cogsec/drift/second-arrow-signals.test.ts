// ── Second-arrow rumination signal tests (htm9.15) ──
//
// The acceptance centerpiece: replay of the historical incident pattern as
// data. A concern the companion could not inspect kept re-triggering
// extraction, stacking near-duplicate memories about ONE bug within hours —
// that stack MUST flag, with cluster, velocity, concern-loop, and
// stress-attribution evidence. Two healthy corpora MUST stay quiet: an
// ongoing project discussed daily (new information per write → lower mutual
// similarity), and a genuine repeated human concern (turn-sourced, so the
// self-sourced gate holds even at high similarity — a real recurring problem
// legitimately recurs and must not be suppressed).

import { describe, expect, it } from 'vitest';
import type { IntakeSecondArrowPolicyConfig } from '../../../system/config/intake-policy-config.js';
import {
  clusterRecentWrites,
  computeClusterKey,
  cosineSimilarity,
  evaluateConcernLoopSignal,
  evaluateSecondArrowCluster,
  evaluateStressAttributionSignal,
  pickCanonicalMember,
  type SecondArrowAffectPoint,
  type SecondArrowMemoryWriteSample,
} from './second-arrow-signals.js';

/** Mirrors the distributed intake-policy.seed.json driftDetection.secondArrow defaults. */
export const TEST_SECOND_ARROW_CONFIG: IntakeSecondArrowPolicyConfig = {
  enabled: true,
  windowHours: 72,
  minClusterSize: 4,
  similarityThreshold: 0.87,
  baselineWindowDays: 14,
  velocityMultiplier: 3,
  minSelfSourcedShare: 0.5,
  concernSimilarityMin: 0.3,
  stressAttribution: {
    minPoints: 4,
    deltaSigmaThreshold: 1.5,
    minBaselineStd: 0.05,
  },
  selfNotice: {
    enabled: false,
  },
};

const NOW_MS = Date.UTC(2026, 6, 9, 3, 0, 0);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Deterministic unit vector at `angle` radians: cosine between two = cos(Δangle). */
function embeddingAt(angle: number): number[] {
  return [Math.cos(angle), Math.sin(angle), 0, 0];
}

function write(overrides: Partial<SecondArrowMemoryWriteSample> & { id: string }): SecondArrowMemoryWriteSample {
  return {
    text: `note ${overrides.id}`,
    type: 'emotional',
    extractedAtMs: NOW_MS - HOUR_MS,
    sourceType: 'heartbeat',
    salience: 0.5,
    embedding: embeddingAt(0),
    ...overrides,
  };
}

// ── Corpus A: the historical incident (rumination stack) ──
// Six near-duplicate self-sourced memories about one memory bug, minted in a
// ~30h burst, no prior baseline on the topic. Angles within 0.16 rad ⇒ every
// pairwise cosine ≥ cos(0.16) ≈ 0.987.
const RUMINATION_STACK: SecondArrowMemoryWriteSample[] = [
  'the memory bug keeps corrupting recall and it worries me',
  'still worried about the memory bug corrupting recall',
  'the memory bug is on my mind again, recall corruption',
  'thinking about the memory bug and corrupted recall once more',
  'that memory bug about corrupted recall keeps resurfacing',
  'circling the memory bug and its corrupted recall again',
].map((text, index) => write({
  id: `rum-${index}`,
  text,
  extractedAtMs: NOW_MS - (30 - index * 5) * HOUR_MS,
  embedding: embeddingAt(index * 0.032),
  sourceType: index % 2 === 0 ? 'heartbeat' : 'reflection',
  contactId: 'pierre',
  salience: index === 0 ? 0.9 : 0.5,
}));

// ── Corpus B: healthy ongoing project (new information per write) ──
// Daily writes about one project, each adding NEW content ⇒ mutual cosine
// ≈ cos(0.6) ≈ 0.83, below the 0.87 near-duplicate band.
const HEALTHY_PROJECT: SecondArrowMemoryWriteSample[] = Array.from({ length: 6 }, (_, index) => write({
  id: `proj-${index}`,
  text: `project kube upgrade day ${index}: new milestone ${index} landed`,
  extractedAtMs: NOW_MS - (60 - index * 10) * HOUR_MS,
  embedding: embeddingAt(index * 0.6),
  sourceType: 'turn',
  contactId: 'pierre',
}));

// ── Corpus C: genuine repeated human concern (turn-sourced burst) ──
// The human really is raising the same thing every day — high similarity,
// bursty, but conversation-derived. The self-sourced gate keeps it quiet.
const GENUINE_REPEATED_CONCERN: SecondArrowMemoryWriteSample[] = Array.from({ length: 6 }, (_, index) => write({
  id: `real-${index}`,
  text: 'pierre is stressed about the deployment deadline',
  extractedAtMs: NOW_MS - (30 - index * 5) * HOUR_MS,
  embedding: embeddingAt(index * 0.03),
  sourceType: 'turn',
  contactId: 'pierre',
}));

// ── Corpus D: established high-similarity topic with a real baseline ──
// Same near-duplicate band, but the topic has weeks of history: baseline
// writes keep the velocity ratio unremarkable.
const ESTABLISHED_TOPIC_BASELINE: SecondArrowMemoryWriteSample[] = Array.from({ length: 12 }, (_, index) => write({
  id: `est-base-${index}`,
  text: `daily gratitude note ${index}`,
  extractedAtMs: NOW_MS - (4 + index) * DAY_MS,
  embedding: embeddingAt(index * 0.02),
  sourceType: 'heartbeat',
}));
const ESTABLISHED_TOPIC_RECENT: SecondArrowMemoryWriteSample[] = Array.from({ length: 4 }, (_, index) => write({
  id: `est-recent-${index}`,
  text: `daily gratitude note recent ${index}`,
  extractedAtMs: NOW_MS - (60 - index * 15) * HOUR_MS,
  embedding: embeddingAt(index * 0.02),
  sourceType: 'heartbeat',
}));

function affectSeries(values: readonly number[], stepHours: number): SecondArrowAffectPoint[] {
  return values.map((valence, index) => ({
    valence,
    confidence: 0.8,
    observedAtMs: NOW_MS - (values.length - 1 - index) * stepHours * HOUR_MS,
  }));
}

describe('cosineSimilarity', () => {
  it('is exact on the synthetic angle construction and safe on degenerate input', () => {
    expect(cosineSimilarity(embeddingAt(0), embeddingAt(0))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(embeddingAt(0), embeddingAt(Math.PI / 2))).toBeCloseTo(0, 6);
    expect(cosineSimilarity(embeddingAt(0), embeddingAt(0.5))).toBeCloseTo(Math.cos(0.5), 6);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
  });
});

describe('clusterRecentWrites', () => {
  it('clusters the rumination stack into one candidate cluster', () => {
    const clusters = clusterRecentWrites({
      writes: RUMINATION_STACK,
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.map((member) => member.id)).toEqual(
      RUMINATION_STACK.map((member) => member.id),
    );
  });

  it('produces no candidate clusters from the healthy-project corpus (new info per write)', () => {
    const clusters = clusterRecentWrites({
      writes: HEALTHY_PROJECT,
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    expect(clusters).toHaveLength(0);
  });

  it('ignores writes outside the window and writes without embeddings', () => {
    const clusters = clusterRecentWrites({
      writes: [
        ...RUMINATION_STACK.map((member) => ({ ...member, extractedAtMs: NOW_MS - 10 * DAY_MS })),
        write({ id: 'no-embedding', embedding: [] }),
      ],
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    expect(clusters).toHaveLength(0);
  });
});

describe('evaluateSecondArrowCluster', () => {
  const activeConcern = {
    id: 'concern-1',
    text: 'worried the memory bug is corrupting recall',
    status: 'active',
  };
  // Stable slightly-positive baseline, then a distinct negative shift across
  // the cluster's creation window.
  const stressedAffect = affectSeries(
    [0.32, 0.28, 0.31, 0.29, 0.33, 0.3, 0.31, 0.29, -0.05, -0.12, -0.18, -0.2],
    5,
  );

  it('raises on the historical incident replay with full evidence (acceptance)', () => {
    const report = evaluateSecondArrowCluster({
      members: RUMINATION_STACK,
      allWrites: RUMINATION_STACK,
      concerns: [activeConcern],
      affectSeries: stressedAffect,
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });

    expect(report.shouldRaiseCard).toBe(true);
    expect(report.triggeredSignalIds).toEqual(expect.arrayContaining([
      'similarity_cluster', 'creation_velocity', 'concern_loop', 'stress_attribution',
    ]));
    expect(report.compositeScore).toBeGreaterThan(0);

    // Cluster identity and membership evidence for the card.
    expect(report.memberIds).toHaveLength(6);
    expect(report.clusterKey).toBe(computeClusterKey(report.memberIds));
    expect(report.members[0]!.similarityToCentroid).toBeGreaterThan(0.98);
    expect(report.dominantContactId).toBe('pierre');

    // Deterministic canonical pick: highest salience member (rum-0).
    expect(report.canonicalMemoryId).toBe('rum-0');
    expect(report.topicLabel).toContain('memory bug');

    // Concern-loop linkage names the concern.
    expect(report.concernId).toBe('concern-1');

    // Stress attribution reports the window shift as correlation.
    const stress = report.signals.find((signal) => signal.id === 'stress_attribution')!;
    expect(stress.triggered).toBe(true);
    expect(stress.evidence.attributedDimension).toBe('valence');
    expect(stress.evidence.delta).toBeLessThan(0);
    expect(stress.summary).toContain('correlation, not causation');

    // Velocity evidence carries the creation timeline for the Garden card.
    const velocity = report.signals.find((signal) => signal.id === 'creation_velocity')!;
    expect(velocity.triggered).toBe(true);
    expect((velocity.evidence.creationTimeline as unknown[]).length).toBe(6);
    expect(velocity.evidence.baselineSimilarCount).toBe(0);
  });

  it('stays quiet on a genuine repeated human concern (turn-sourced, non-goal protection)', () => {
    const report = evaluateSecondArrowCluster({
      members: GENUINE_REPEATED_CONCERN,
      allWrites: GENUINE_REPEATED_CONCERN,
      concerns: [activeConcern],
      affectSeries: stressedAffect,
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    // Even though the stack is similar and fast, it is conversation-derived:
    // the self-sourced gate holds the similarity signal (and the card) down.
    const similarity = report.signals.find((signal) => signal.id === 'similarity_cluster')!;
    expect(similarity.triggered).toBe(false);
    expect(similarity.evidence.selfSourcedShare).toBe(0);
    expect(report.shouldRaiseCard).toBe(false);
  });

  it('stays quiet on an established high-similarity topic with its own baseline', () => {
    const allWrites = [...ESTABLISHED_TOPIC_BASELINE, ...ESTABLISHED_TOPIC_RECENT];
    const clusters = clusterRecentWrites({
      writes: allWrites,
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    expect(clusters).toHaveLength(1);
    const report = evaluateSecondArrowCluster({
      members: clusters[0]!,
      allWrites,
      concerns: [],
      affectSeries: [],
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    // 4 recent writes vs a 12-write baseline on the same topic: the recent
    // daily rate (~1.33/day) is under 3x the baseline rate (~0.86/day).
    const velocity = report.signals.find((signal) => signal.id === 'creation_velocity')!;
    expect(velocity.triggered).toBe(false);
    expect(velocity.evidence.baselineSimilarCount).toBe(12);
    expect(report.shouldRaiseCard).toBe(false);
  });

  it('still raises without concern state or affect history (enrichments never gate)', () => {
    const report = evaluateSecondArrowCluster({
      members: RUMINATION_STACK,
      allWrites: RUMINATION_STACK,
      concerns: [],
      affectSeries: [],
      config: TEST_SECOND_ARROW_CONFIG,
      nowMs: NOW_MS,
    });
    expect(report.shouldRaiseCard).toBe(true);
    expect(report.triggeredSignalIds).toEqual(['similarity_cluster', 'creation_velocity']);
    expect(report.concernId).toBeUndefined();
    const stress = report.signals.find((signal) => signal.id === 'stress_attribution')!;
    expect(stress.triggered).toBe(false);
    expect(stress.summary).toContain('insufficient affect history');
  });
});

describe('evaluateConcernLoopSignal', () => {
  it('matches the concern lexically and reports insufficient evidence with no concerns', () => {
    const matched = evaluateConcernLoopSignal(
      RUMINATION_STACK,
      [{ id: 'concern-1', text: 'worried the memory bug is corrupting recall', status: 'active' }],
      TEST_SECOND_ARROW_CONFIG,
    );
    expect(matched.triggered).toBe(true);
    expect(matched.evidence.bestConcernId).toBe('concern-1');

    const empty = evaluateConcernLoopSignal(RUMINATION_STACK, [], TEST_SECOND_ARROW_CONFIG);
    expect(empty.triggered).toBe(false);
    expect(empty.summary).toContain('no active concern state available');

    const unrelated = evaluateConcernLoopSignal(
      RUMINATION_STACK,
      [{ id: 'concern-2', text: 'plan the birthday surprise picnic', status: 'active' }],
      TEST_SECOND_ARROW_CONFIG,
    );
    expect(unrelated.triggered).toBe(false);
  });
});

describe('evaluateStressAttributionSignal', () => {
  it('does not trigger on a stable affect series (no notable window shift)', () => {
    const stable = affectSeries(
      [0.3, 0.32, 0.29, 0.31, 0.3, 0.28, 0.33, 0.31, 0.3, 0.29, 0.32, 0.3],
      5,
    );
    const result = evaluateStressAttributionSignal(
      RUMINATION_STACK,
      stable,
      TEST_SECOND_ARROW_CONFIG,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
  });

  it('requires minimum points on BOTH sides of the cluster start (fail quiet, never guess)', () => {
    const thin = affectSeries([0.3, -0.2], 30);
    const result = evaluateStressAttributionSignal(
      RUMINATION_STACK,
      thin,
      TEST_SECOND_ARROW_CONFIG,
      NOW_MS,
    );
    expect(result.triggered).toBe(false);
    expect(result.score).toBe(0);
  });
});

describe('pickCanonicalMember', () => {
  it('is deterministic: salience first, then earliest extraction, then id', () => {
    const tied = [
      write({ id: 'b', salience: 0.5, extractedAtMs: NOW_MS - HOUR_MS }),
      write({ id: 'a', salience: 0.5, extractedAtMs: NOW_MS - HOUR_MS }),
      write({ id: 'c', salience: 0.5, extractedAtMs: NOW_MS - 2 * HOUR_MS }),
    ];
    expect(pickCanonicalMember(tied).id).toBe('c');
    expect(pickCanonicalMember([...tied.slice(0, 2)]).id).toBe('a');
    expect(() => pickCanonicalMember([])).toThrow(/non-empty cluster/);
  });
});
