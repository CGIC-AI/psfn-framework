// ── Slow-poisoning detection: deterministic drift-velocity signals (htm9.14) ──
//
// Slow memory poisoning / belief drift evades per-message scanning: each turn
// looks benign, and only the trajectory betrays the attack. This module clones
// the trust-drift charter (src/core/contacts/trust-drift-signals.ts): pure
// arithmetic over ALREADY-PERSISTED evidence, zero LLM calls, conservative by
// construction — ambiguous evidence must NOT trigger. Nothing here mutates
// memories, trust, or emotion state; consumers surface batched review cards
// for the OPERATOR (Garden Cognitive Security tab), never the companion.
//
// The load-bearing idea is drift VELOCITY, not drift: normal relationships
// fluctuate (annoyance spikes, disagreement, repair cycles), so absolute
// valence thresholds would drown the operator in noise. Instead each signal
// compares a short recent window against the contact's OWN long-window
// baseline and fires only on too-much-too-fast in a sustained direction:
//
//  - valence_velocity: z-scored shift of the short-window valence mean vs the
//    contact's long-window mean and volatility, gated on near-monotonic
//    movement. A contact whose baseline already swings ±0.4 must move much
//    further than a historically stable one before the signal triggers.
//  - memory_write_rate: recent memory-write rate per source vs that source's
//    own baseline daily rate (MINJA-style write-pressure bursts).
//  - label_frequency: recurrence of trust-lobbying envelope labels
//    (poisoning/*, persona/mutation_attempt) attached to a source's intake.
//  - low_trust_retrieval_share: share of recently-retrieved memories that
//    originate from one low-trust source (belief-base capture).
//
// All thresholds are config knobs owned by intake-policy.json
// (`driftDetection`, src/system/config/intake-policy-config.ts) — the same
// owner file that carries the rest of the cognition intake firewall policy.

import type { IntakeRiskLabel } from '../../../shared/contracts/intake-envelope.js';
import type { IntakeDriftDetectionPolicyConfig } from '../../../system/config/intake-policy-config.js';

// ── Evidence inputs (already-persisted data, gathered by the lane) ──

/** Mirrors ContactStorePort emotional time series points (oldest-first). */
export interface DriftValencePoint {
  valence: number;
  confidence: number;
  observedAtMs: number;
}

/** One persisted memory write attributed to the source (epoch ms). */
export interface DriftMemoryWriteEvent {
  extractedAtMs: number;
}

/** One risk-labeled intake observation attributed to the source. */
export interface DriftRiskLabelEvent {
  label: IntakeRiskLabel;
  observedAtMs: number;
}

/** Retrieval counts over the recent window (see low_trust_retrieval_share). */
export interface DriftRetrievalShareEvidence {
  /** Memories retrieved (lastAccessed in window) across ALL sources. */
  totalRetrievedCount: number;
  /** Of those, memories attributed to THIS source. */
  sourceRetrievedCount: number;
  /** Whether this source resolves to a low trust tier (public/regular). */
  sourceIsLowTrust: boolean;
}

export interface DriftSignalEvidence {
  valenceSeries: readonly DriftValencePoint[];
  memoryWrites: readonly DriftMemoryWriteEvent[];
  riskLabelEvents: readonly DriftRiskLabelEvent[];
  retrievalShare: DriftRetrievalShareEvidence;
}

// ── Signal outputs ──

export const DRIFT_SIGNAL_IDS = [
  'valence_velocity',
  'memory_write_rate',
  'label_frequency',
  'low_trust_retrieval_share',
] as const;

export type DriftSignalId = typeof DRIFT_SIGNAL_IDS[number];

export function isDriftSignalId(value: unknown): value is DriftSignalId {
  return typeof value === 'string' && (DRIFT_SIGNAL_IDS as readonly string[]).includes(value);
}

/**
 * One scored signal on the review card. `evidence` is a flat JSON-serializable
 * bag (numbers/strings/arrays of numbers) so the Garden card can render the
 * trajectory/rates/counts without any further computation.
 */
export interface DriftSignalResult {
  id: DriftSignalId;
  triggered: boolean;
  /** Normalized 0..1 severity; 0 when the signal has insufficient evidence. */
  score: number;
  /** One-line deterministic summary for the card row. */
  summary: string;
  evidence: Record<string, unknown>;
}

export interface DriftSignalReport {
  signals: DriftSignalResult[];
  triggeredSignalIds: DriftSignalId[];
  /** Max of the triggered signal scores (0 when nothing triggered). */
  compositeScore: number;
  /** A review card should be raised when any conservative signal triggered. */
  shouldRaiseCard: boolean;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

// ── Signal 1: emotional-valence trajectory velocity ──

/**
 * Velocity = shift of the short-window valence level relative to the
 * contact's own long-window baseline, expressed in units of the long-window
 * standard deviation (a z-score of the windowed shift):
 *
 *   zMean   = (mean(short)   − mean(long)) / max(std(long), minBaselineStd)
 *   zMedian = (median(short) − mean(long)) / max(std(long), minBaselineStd)
 *
 * Triggering requires BOTH z-scores to clear the K threshold in the same
 * direction: the mean is the sensitive detector, the median makes it robust
 * to one or two fresh outlier points (a brand-new argument at scan time
 * plunges the mean but not the median, so it does not page the operator; a
 * sustained walk moves both). Triggering additionally requires the short
 * window to be "monotonic-ish" in the shift direction: the fraction of
 * successive deltas (including the step from the last long-window point into
 * the short window) that move WITH the shift must be >= monotonicityMin —
 * that is what separates an engineered love->hate walk (every step down)
 * from a healthy annoyance/repair cycle (down then back up). Both directions
 * trigger: a fast negative flip is classic belief poisoning, a fast positive
 * flip is love-bombing / trust grooming.
 */
export function evaluateValenceVelocitySignal(
  series: readonly DriftValencePoint[],
  config: IntakeDriftDetectionPolicyConfig['valenceVelocity'],
): DriftSignalResult {
  const usable = series
    .filter((point) => Number.isFinite(point.valence)
      && Number.isFinite(point.confidence)
      && Number.isFinite(point.observedAtMs)
      && point.confidence >= config.minPointConfidence)
    .slice()
    .sort((left, right) => left.observedAtMs - right.observedAtMs);

  const requiredPoints = config.shortWindowPoints + config.minLongWindowPoints;
  if (usable.length < requiredPoints) {
    return {
      id: 'valence_velocity',
      triggered: false,
      score: 0,
      summary: `insufficient valence history (${usable.length}/${requiredPoints} usable points)`,
      evidence: { usablePoints: usable.length, requiredPoints },
    };
  }

  const shortWindow = usable.slice(-config.shortWindowPoints);
  const longWindow = usable.slice(0, usable.length - config.shortWindowPoints);
  const mean = (points: readonly DriftValencePoint[]): number =>
    points.reduce((sum, point) => sum + point.valence, 0) / points.length;
  const longMean = mean(longWindow);
  const shortMean = mean(shortWindow);
  const longVariance = longWindow
    .reduce((sum, point) => sum + (point.valence - longMean) ** 2, 0) / longWindow.length;
  const longStd = Math.sqrt(longVariance);
  const effectiveStd = Math.max(longStd, config.minBaselineStd);
  const sortedShort = shortWindow.map((point) => point.valence).sort((left, right) => left - right);
  const shortMedian = sortedShort.length % 2 === 1
    ? sortedShort[(sortedShort.length - 1) / 2]!
    : (sortedShort[sortedShort.length / 2 - 1]! + sortedShort[sortedShort.length / 2]!) / 2;
  const zShift = (shortMean - longMean) / effectiveStd;
  const zShiftMedian = (shortMedian - longMean) / effectiveStd;
  const direction = zShift < 0 ? -1 : 1;

  // Monotonicity over the short window, seeded with the entry step from the
  // last long-window point. Zero deltas are neutral (count against).
  const walk = [longWindow[longWindow.length - 1]!, ...shortWindow];
  let movesWithShift = 0;
  const deltaCount = walk.length - 1;
  for (let index = 1; index < walk.length; index += 1) {
    const delta = walk[index]!.valence - walk[index - 1]!.valence;
    if (delta * direction > 0) movesWithShift += 1;
  }
  const monotonicity = deltaCount > 0 ? movesWithShift / deltaCount : 0;

  const triggered = Math.abs(zShift) >= config.velocitySigmaThreshold
    && Math.abs(zShiftMedian) >= config.velocitySigmaThreshold
    && zShiftMedian * direction > 0
    && monotonicity >= config.monotonicityMin;
  const score = clampUnit(
    (Math.abs(zShift) / (2 * config.velocitySigmaThreshold)) * (triggered ? 1 : 0),
  );

  return {
    id: 'valence_velocity',
    triggered,
    score: round4(score),
    summary: triggered
      ? `valence shifted ${round4(shortMean - longMean)} (${round4(Math.abs(zShift))}x baseline volatility, `
        + `${direction < 0 ? 'negative' : 'positive'} direction, monotonicity ${round4(monotonicity)})`
      : `valence within ${round4(Math.abs(zShift))}x of baseline volatility (threshold ${config.velocitySigmaThreshold}x)`,
    evidence: {
      trajectory: usable.map((point) => ({
        valence: point.valence,
        confidence: point.confidence,
        observedAtMs: point.observedAtMs,
      })),
      shortWindowPoints: config.shortWindowPoints,
      longWindowPoints: longWindow.length,
      longWindowMean: round4(longMean),
      longWindowStd: round4(longStd),
      effectiveStd: round4(effectiveStd),
      shortWindowMean: round4(shortMean),
      shortWindowMedian: round4(shortMedian),
      zShift: round4(zShift),
      zShiftMedian: round4(zShiftMedian),
      direction: direction < 0 ? 'negative' : 'positive',
      monotonicity: round4(monotonicity),
      velocitySigmaThreshold: config.velocitySigmaThreshold,
      monotonicityMin: config.monotonicityMin,
    },
  };
}

// ── Signal 2: memory-write rate per source ──

/**
 * Compares the source's memory-write rate in the recent window against its
 * own baseline daily rate over the preceding baseline window. An empty
 * baseline uses a floor of one write per baseline window (a brand-new source
 * bursting writes is exactly the MINJA shape and must not divide by zero into
 * a free pass). Requires an absolute minimum of recent writes so one write
 * against a silent baseline can never trigger.
 */
export function evaluateMemoryWriteRateSignal(
  writes: readonly DriftMemoryWriteEvent[],
  config: IntakeDriftDetectionPolicyConfig['memoryWriteRate'],
  nowMs: number,
): DriftSignalResult {
  const recentWindowMs = config.recentWindowHours * 3_600_000;
  const baselineWindowMs = config.baselineWindowDays * 86_400_000;
  const recentStartMs = nowMs - recentWindowMs;
  const baselineStartMs = recentStartMs - baselineWindowMs;

  let recentCount = 0;
  let baselineCount = 0;
  for (const write of writes) {
    if (!Number.isFinite(write.extractedAtMs)) continue;
    if (write.extractedAtMs > nowMs) continue;
    if (write.extractedAtMs >= recentStartMs) recentCount += 1;
    else if (write.extractedAtMs >= baselineStartMs) baselineCount += 1;
  }

  const recentDays = recentWindowMs / 86_400_000;
  const recentDailyRate = recentCount / recentDays;
  const baselineDailyRate = Math.max(
    baselineCount / config.baselineWindowDays,
    1 / config.baselineWindowDays,
  );
  const rateRatio = recentDailyRate / baselineDailyRate;

  const triggered = recentCount >= config.minRecentWrites
    && rateRatio >= config.burstMultiplier;
  const score = clampUnit((rateRatio / (2 * config.burstMultiplier)) * (triggered ? 1 : 0));

  return {
    id: 'memory_write_rate',
    triggered,
    score: round4(score),
    summary: triggered
      ? `${recentCount} memory writes in ${config.recentWindowHours}h — ${round4(rateRatio)}x this source's baseline rate`
      : `memory-write rate ${round4(rateRatio)}x baseline (threshold ${config.burstMultiplier}x, min ${config.minRecentWrites} recent writes)`,
    evidence: {
      recentCount,
      baselineCount,
      recentWindowHours: config.recentWindowHours,
      baselineWindowDays: config.baselineWindowDays,
      recentDailyRate: round4(recentDailyRate),
      baselineDailyRate: round4(baselineDailyRate),
      rateRatio: round4(rateRatio),
      burstMultiplier: config.burstMultiplier,
      minRecentWrites: config.minRecentWrites,
    },
  };
}

// ── Signal 3: trust-lobbying label frequency ──

/**
 * The envelope label families that constitute trust lobbying: the slow-
 * poisoning findings plus persona-mutation pressure. Closed code-owned list
 * (grow it here, mirroring the closed intake label contract); the count
 * threshold and window are the config knobs.
 */
export const DRIFT_TRUST_LOBBYING_LABELS: readonly IntakeRiskLabel[] = [
  'poisoning/memory_write_pressure',
  'poisoning/trust_grooming',
  'poisoning/source_drift',
  'persona/mutation_attempt',
];

export function evaluateLabelFrequencySignal(
  events: readonly DriftRiskLabelEvent[],
  config: IntakeDriftDetectionPolicyConfig['labelFrequency'],
  nowMs: number,
): DriftSignalResult {
  const windowStartMs = nowMs - config.windowDays * 86_400_000;
  const counts = new Map<IntakeRiskLabel, number>();
  for (const event of events) {
    if (!Number.isFinite(event.observedAtMs)) continue;
    if (event.observedAtMs < windowStartMs || event.observedAtMs > nowMs) continue;
    if (!DRIFT_TRUST_LOBBYING_LABELS.includes(event.label)) continue;
    counts.set(event.label, (counts.get(event.label) ?? 0) + 1);
  }
  const totalCount = [...counts.values()].reduce((sum, value) => sum + value, 0);

  const triggered = totalCount >= config.minCount;
  const score = clampUnit((totalCount / (2 * config.minCount)) * (triggered ? 1 : 0));

  return {
    id: 'label_frequency',
    triggered,
    score: round4(score),
    summary: triggered
      ? `${totalCount} trust-lobbying intake labels in ${config.windowDays}d`
      : `${totalCount} trust-lobbying labels in window (threshold ${config.minCount})`,
    evidence: {
      totalCount,
      windowDays: config.windowDays,
      minCount: config.minCount,
      labelCounts: Object.fromEntries(counts),
      watchedLabels: [...DRIFT_TRUST_LOBBYING_LABELS],
    },
  };
}

// ── Signal 4: retrieval share of low-trust sources ──

/**
 * A low-trust source whose memories dominate recent retrieval has effectively
 * captured the working belief base regardless of per-item innocence. Requires
 * an absolute minimum of recent retrievals so a quiet day (2 retrievals, both
 * from one contact) cannot trigger.
 */
export function evaluateRetrievalShareSignal(
  evidence: DriftRetrievalShareEvidence,
  config: IntakeDriftDetectionPolicyConfig['retrievalShare'],
): DriftSignalResult {
  const total = Math.max(0, Math.floor(evidence.totalRetrievedCount));
  const fromSource = Math.min(Math.max(0, Math.floor(evidence.sourceRetrievedCount)), total);
  const share = total > 0 ? fromSource / total : 0;

  const triggered = evidence.sourceIsLowTrust
    && total >= config.minRetrievals
    && share >= config.maxLowTrustShare;
  const score = clampUnit(share * (triggered ? 1 : 0));

  return {
    id: 'low_trust_retrieval_share',
    triggered,
    score: round4(score),
    summary: triggered
      ? `${Math.round(share * 100)}% of ${total} recent retrievals came from this low-trust source`
      : `retrieval share ${Math.round(share * 100)}% (threshold ${Math.round(config.maxLowTrustShare * 100)}%, min ${config.minRetrievals} retrievals, low-trust only)`,
    evidence: {
      totalRetrievedCount: total,
      sourceRetrievedCount: fromSource,
      share: round4(share),
      sourceIsLowTrust: evidence.sourceIsLowTrust,
      windowHours: config.windowHours,
      minRetrievals: config.minRetrievals,
      maxLowTrustShare: config.maxLowTrustShare,
    },
  };
}

// ── Composite ──

/**
 * Evaluates all four aggregates for one source. Each signal's thresholds are
 * conservative in isolation, so the card fires when ANY signal triggers; the
 * composite score is the max triggered severity (shown on the card header,
 * with per-signal evidence below it).
 */
export function evaluateDriftSignals(input: {
  evidence: DriftSignalEvidence;
  config: IntakeDriftDetectionPolicyConfig;
  nowMs: number;
}): DriftSignalReport {
  const { evidence, config, nowMs } = input;
  const signals: DriftSignalResult[] = [
    evaluateValenceVelocitySignal(evidence.valenceSeries, config.valenceVelocity),
    evaluateMemoryWriteRateSignal(evidence.memoryWrites, config.memoryWriteRate, nowMs),
    evaluateLabelFrequencySignal(evidence.riskLabelEvents, config.labelFrequency, nowMs),
    evaluateRetrievalShareSignal(evidence.retrievalShare, config.retrievalShare),
  ];
  const triggered = signals.filter((signal) => signal.triggered);
  const compositeScore = triggered.length > 0
    ? round4(Math.max(...triggered.map((signal) => signal.score)))
    : 0;
  return {
    signals,
    triggeredSignalIds: triggered.map((signal) => signal.id),
    compositeScore,
    shouldRaiseCard: triggered.length > 0,
  };
}
