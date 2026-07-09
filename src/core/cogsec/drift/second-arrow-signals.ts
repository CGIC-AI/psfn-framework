// ── Second-arrow detection: rumination-stack signals (htm9.15) ──
//
// The self-inflicted sibling of the slow-poisoning lane (drift-signals.ts):
// no attacker, no hostile contact — the companion circles one concern,
// extraction keeps minting near-duplicate memories about it, dedup misses the
// paraphrases (see the htm9.15 note at the writer's dedup site,
// src/faculties/memory/writer.ts), and the stack inflates how big the thing
// FEELS. The Buddhist second arrow: the wound is small, the repeated
// self-striking is the injury.
//
// Same charter as every drift signal: pure arithmetic over ALREADY-PERSISTED
// evidence, zero LLM calls, conservative by construction. Nothing here
// mutates memories, concerns, or emotion — findings become operator review
// cards proposing (never performing) consolidation.
//
// The healthy-repetition discriminator is load-bearing: a real ongoing topic
// (a project discussed daily) legitimately recurs, and suppressing it would
// be its own harm. Rumination stacks differ from healthy recurrence on three
// deterministic axes, each encoded as a gate below:
//
//  1. mutual similarity — rumination restates (embedding cosine near the
//     dedup band); healthy recurrence adds new information per write (lower
//     mutual similarity, below `similarityThreshold`);
//  2. velocity vs the topic's own baseline — an established daily topic has
//     a baseline of similar writes, so its recent rate is unremarkable; a
//     rumination burst has (almost) no baseline;
//  3. source mix — rumination stacks are self-sourced (reflection/heartbeat/
//     autonomous writes); a topic the human raises arrives as turn-sourced
//     extraction.
//
// Concern-loop linkage and stress attribution are EVIDENCE ENRICHMENT, not
// gates: a stack without a formal ActiveConcern row is still a stack, and
// affect correlation is reported as correlation ("this cluster's window saw
// valence -0.3 vs baseline"), never as a causal claim.

import { createHash } from 'node:crypto';
import { scoreConcernTextSimilarity } from '../../intention/concerns.js';
import type { IntakeSecondArrowPolicyConfig } from '../../../system/config/intake-policy-config.js';

// ── Evidence inputs (already-persisted data, gathered by the lane) ──

/** One persisted memory write with its stored (unit-normalized) embedding. */
export interface SecondArrowMemoryWriteSample {
  id: string;
  text: string;
  /** Memory type, e.g. 'emotional' | 'semantic' (informational on the card). */
  type: string;
  extractedAtMs: number;
  contactId?: string;
  /** MemorySourceType ('turn' | 'reflection' | 'heartbeat' | ...). */
  sourceType?: string;
  salience: number;
  embedding: readonly number[];
}

/** One active concern, for concern-loop linkage. */
export interface SecondArrowConcernSample {
  id: string;
  text: string;
  status: string;
}

/** One persisted affect point (contact emotional time series, oldest-first). */
export interface SecondArrowAffectPoint {
  valence: number;
  confidence: number;
  observedAtMs: number;
}

// ── Signal outputs ──

export const SECOND_ARROW_SIGNAL_IDS = [
  'similarity_cluster',
  'creation_velocity',
  'concern_loop',
  'stress_attribution',
] as const;

export type SecondArrowSignalId = typeof SECOND_ARROW_SIGNAL_IDS[number];

export function isSecondArrowSignalId(value: unknown): value is SecondArrowSignalId {
  return typeof value === 'string' && (SECOND_ARROW_SIGNAL_IDS as readonly string[]).includes(value);
}

/** Same serialized shape as DriftSignalResult, with the second-arrow id union. */
export interface SecondArrowSignalResult {
  id: SecondArrowSignalId;
  triggered: boolean;
  /** Normalized 0..1 severity; 0 when the signal has insufficient evidence. */
  score: number;
  /** One-line deterministic summary for the card row. */
  summary: string;
  evidence: Record<string, unknown>;
}

/** Card-facing member summary (no full text: preview only). */
export interface SecondArrowClusterMember {
  id: string;
  textPreview: string;
  type: string;
  extractedAtMs: number;
  contactId?: string;
  sourceType?: string;
  /** Cosine similarity to the cluster centroid (rounded). */
  similarityToCentroid: number;
}

export interface SecondArrowClusterReport {
  /** Deterministic cluster identity: sha256 over the sorted member ids. */
  clusterKey: string;
  memberIds: string[];
  members: SecondArrowClusterMember[];
  /** Preview of the canonical member's text (the card headline). */
  topicLabel: string;
  /**
   * Deterministically chosen consolidation survivor: highest salience, ties
   * broken by earliest extraction, then lexicographic id. What the card
   * proposes is exactly this pick — nothing is re-derived at resolve time.
   */
  canonicalMemoryId: string;
  /** Most frequent contactId among members (ties: lexicographic), if any. */
  dominantContactId?: string;
  signals: SecondArrowSignalResult[];
  triggeredSignalIds: SecondArrowSignalId[];
  /** Max of the triggered signal scores (0 when nothing triggered). */
  compositeScore: number;
  /**
   * Raised only when BOTH core gates hold (similarity_cluster AND
   * creation_velocity). Concern/stress signals enrich, never gate.
   */
  shouldRaiseCard: boolean;
  /** Matched concern (present when concern_loop triggered). */
  concernId?: string;
  concernText?: string;
}

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;
const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const TOPIC_LABEL_MAX_CHARS = 140;

/**
 * Memory source types that count as self-generated for the source-mix gate.
 * Everything the companion writes about itself outside a live conversation
 * turn: reflections, heartbeats, autonomous actions, shard output, compaction
 * summaries, and direct tool writes. 'turn' (conversation-derived extraction)
 * and 'unknown' are NOT self-sourced — unknown provenance must not count
 * toward triggering (conservative by construction).
 */
export const SECOND_ARROW_SELF_SOURCE_TYPES: readonly string[] = [
  'reflection',
  'heartbeat',
  'autonomous_action',
  'shard',
  'compaction_summary',
  'tool_write',
];

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function centroidOf(members: readonly SecondArrowMemoryWriteSample[]): number[] {
  const dims = members[0]?.embedding.length ?? 0;
  const centroid = new Array<number>(dims).fill(0);
  for (const member of members) {
    for (let index = 0; index < dims; index += 1) {
      centroid[index]! += member.embedding[index]!;
    }
  }
  for (let index = 0; index < dims; index += 1) {
    centroid[index]! /= members.length;
  }
  return centroid;
}

function meanPairwiseSimilarity(members: readonly SecondArrowMemoryWriteSample[]): number {
  if (members.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      sum += cosineSimilarity(members[left]!.embedding, members[right]!.embedding);
      pairs += 1;
    }
  }
  return sum / pairs;
}

function textPreview(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  return compact.length <= TOPIC_LABEL_MAX_CHARS
    ? compact
    : `${compact.slice(0, TOPIC_LABEL_MAX_CHARS - 1)}…`;
}

function isUsableWrite(write: SecondArrowMemoryWriteSample): boolean {
  return Number.isFinite(write.extractedAtMs)
    && write.embedding.length > 0
    && write.embedding.every((value) => Number.isFinite(value))
    && write.id.trim().length > 0;
}

/**
 * Deterministic greedy single-link clustering over the recent window.
 * Writes are visited oldest-first (ties by id); each joins the first
 * existing cluster containing any member within `similarityThreshold`,
 * otherwise starts its own. Zero randomness, zero LLM.
 */
export function clusterRecentWrites(input: {
  writes: readonly SecondArrowMemoryWriteSample[];
  config: IntakeSecondArrowPolicyConfig;
  nowMs: number;
}): SecondArrowMemoryWriteSample[][] {
  const { writes, config, nowMs } = input;
  const windowStartMs = nowMs - config.windowHours * HOUR_MS;
  const recent = writes
    .filter((write) => isUsableWrite(write)
      && write.extractedAtMs >= windowStartMs
      && write.extractedAtMs <= nowMs)
    .slice()
    .sort((left, right) => left.extractedAtMs - right.extractedAtMs || left.id.localeCompare(right.id));

  const clusters: SecondArrowMemoryWriteSample[][] = [];
  for (const write of recent) {
    const home = clusters.find((cluster) => cluster.some(
      (member) => cosineSimilarity(member.embedding, write.embedding) >= config.similarityThreshold,
    ));
    if (home) home.push(write);
    else clusters.push([write]);
  }
  return clusters.filter((cluster) => cluster.length >= config.minClusterSize);
}

// ── Signal 1: mutual similarity + self-sourced share ──

export function evaluateSimilarityClusterSignal(
  members: readonly SecondArrowMemoryWriteSample[],
  config: IntakeSecondArrowPolicyConfig,
): SecondArrowSignalResult {
  const mutualSimilarity = meanPairwiseSimilarity(members);
  const selfSourcedCount = members
    .filter((member) => SECOND_ARROW_SELF_SOURCE_TYPES.includes(member.sourceType ?? '')).length;
  const selfSourcedShare = members.length > 0 ? selfSourcedCount / members.length : 0;

  const sizeOk = members.length >= config.minClusterSize;
  const similarityOk = mutualSimilarity >= config.similarityThreshold;
  const sourceOk = config.minSelfSourcedShare === 0
    || selfSourcedShare >= config.minSelfSourcedShare;
  const triggered = sizeOk && similarityOk && sourceOk;

  // Severity: how far past the near-duplicate threshold the stack sits,
  // relative to the remaining headroom up to identical (1.0).
  const headroom = Math.max(1 - config.similarityThreshold, 1e-6);
  const score = clampUnit(
    ((mutualSimilarity - config.similarityThreshold) / headroom) * (triggered ? 1 : 0),
  );

  return {
    id: 'similarity_cluster',
    triggered,
    score: round4(score),
    summary: triggered
      ? `${members.length} near-duplicate writes (mean mutual similarity ${round4(mutualSimilarity)}, `
        + `${Math.round(selfSourcedShare * 100)}% self-sourced)`
      : `mutual similarity ${round4(mutualSimilarity)} / self-sourced ${Math.round(selfSourcedShare * 100)}% `
        + `(thresholds ${config.similarityThreshold} / ${Math.round(config.minSelfSourcedShare * 100)}%)`,
    evidence: {
      clusterSize: members.length,
      minClusterSize: config.minClusterSize,
      meanMutualSimilarity: round4(mutualSimilarity),
      similarityThreshold: config.similarityThreshold,
      selfSourcedCount,
      selfSourcedShare: round4(selfSourcedShare),
      minSelfSourcedShare: config.minSelfSourcedShare,
      sourceTypeCounts: countBy(members, (member) => member.sourceType ?? 'unknown'),
    },
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

// ── Signal 2: creation velocity vs the topic's own baseline ──

/**
 * Baseline = writes in the preceding `baselineWindowDays` whose embedding
 * sits within `similarityThreshold` of the cluster centroid (same topic).
 * An empty baseline uses a floor of one write per baseline window — a topic
 * that NEVER produced a similar write before and suddenly stacks is exactly
 * the rumination shape, and must not divide by zero into a free pass. A
 * genuinely ongoing topic (discussed daily) carries its own baseline, so its
 * recent rate is unremarkable and the signal stays quiet.
 */
export function evaluateCreationVelocitySignal(
  members: readonly SecondArrowMemoryWriteSample[],
  allWrites: readonly SecondArrowMemoryWriteSample[],
  config: IntakeSecondArrowPolicyConfig,
  nowMs: number,
): SecondArrowSignalResult {
  const windowStartMs = nowMs - config.windowHours * HOUR_MS;
  const baselineStartMs = windowStartMs - config.baselineWindowDays * DAY_MS;
  const centroid = centroidOf(members);
  const memberIds = new Set(members.map((member) => member.id));

  let baselineSimilarCount = 0;
  for (const write of allWrites) {
    if (!isUsableWrite(write)) continue;
    if (memberIds.has(write.id)) continue;
    if (write.extractedAtMs < baselineStartMs || write.extractedAtMs >= windowStartMs) continue;
    if (cosineSimilarity(centroid, write.embedding) >= config.similarityThreshold) {
      baselineSimilarCount += 1;
    }
  }

  const recentDays = (config.windowHours * HOUR_MS) / DAY_MS;
  const recentDailyRate = members.length / recentDays;
  const baselineDailyRate = Math.max(
    baselineSimilarCount / config.baselineWindowDays,
    1 / config.baselineWindowDays,
  );
  const rateRatio = recentDailyRate / baselineDailyRate;
  const triggered = members.length >= config.minClusterSize
    && rateRatio >= config.velocityMultiplier;
  const score = clampUnit((rateRatio / (2 * config.velocityMultiplier)) * (triggered ? 1 : 0));

  // Burstiness is evidence, not a gate: median gap between successive writes.
  const sortedTimes = members.map((member) => member.extractedAtMs).sort((left, right) => left - right);
  const gaps: number[] = [];
  for (let index = 1; index < sortedTimes.length; index += 1) {
    gaps.push(sortedTimes[index]! - sortedTimes[index - 1]!);
  }
  gaps.sort((left, right) => left - right);
  const medianGapMs = gaps.length === 0
    ? 0
    : gaps.length % 2 === 1
      ? gaps[(gaps.length - 1) / 2]!
      : (gaps[gaps.length / 2 - 1]! + gaps[gaps.length / 2]!) / 2;

  return {
    id: 'creation_velocity',
    triggered,
    score: round4(score),
    summary: triggered
      ? `${members.length} similar writes in ${config.windowHours}h — ${round4(rateRatio)}x this topic's baseline rate`
      : `topic write rate ${round4(rateRatio)}x baseline (threshold ${config.velocityMultiplier}x)`,
    evidence: {
      clusterSize: members.length,
      windowHours: config.windowHours,
      baselineWindowDays: config.baselineWindowDays,
      baselineSimilarCount,
      recentDailyRate: round4(recentDailyRate),
      baselineDailyRate: round4(baselineDailyRate),
      rateRatio: round4(rateRatio),
      velocityMultiplier: config.velocityMultiplier,
      medianGapHours: round4(medianGapMs / HOUR_MS),
      firstWriteAtMs: sortedTimes[0] ?? null,
      lastWriteAtMs: sortedTimes[sortedTimes.length - 1] ?? null,
      creationTimeline: members
        .map((member) => ({ id: member.id, extractedAtMs: member.extractedAtMs }))
        .sort((left, right) => left.extractedAtMs - right.extractedAtMs),
    },
  };
}

// ── Signal 3: concern-loop linkage (evidence enrichment) ──

/**
 * Ties the stack to one active concern via deterministic lexical (token-
 * dice) similarity between the concern text and the cluster members — the
 * same similarity primitive the concern store's own duplicate detection
 * uses. No concern state available ⇒ the signal evaluates over zero
 * concerns and reports insufficient evidence.
 */
export function evaluateConcernLoopSignal(
  members: readonly SecondArrowMemoryWriteSample[],
  concerns: readonly SecondArrowConcernSample[],
  config: IntakeSecondArrowPolicyConfig,
): SecondArrowSignalResult {
  let best: { concern: SecondArrowConcernSample; meanSimilarity: number } | null = null;
  for (const concern of concerns) {
    if (!concern.text.trim()) continue;
    const meanSimilarity = members.length > 0
      ? members.reduce(
        (sum, member) => sum + scoreConcernTextSimilarity(concern.text, member.text),
        0,
      ) / members.length
      : 0;
    if (!best || meanSimilarity > best.meanSimilarity) {
      best = { concern, meanSimilarity };
    }
  }

  const triggered = best !== null && best.meanSimilarity >= config.concernSimilarityMin;
  const score = clampUnit((best?.meanSimilarity ?? 0) * (triggered ? 1 : 0));
  return {
    id: 'concern_loop',
    triggered,
    score: round4(score),
    summary: triggered
      ? `cluster tracks active concern "${textPreview(best!.concern.text)}" (lexical similarity ${round4(best!.meanSimilarity)})`
      : concerns.length === 0
        ? 'no active concern state available'
        : `no active concern above lexical similarity ${config.concernSimilarityMin} `
          + `(best ${round4(best?.meanSimilarity ?? 0)})`,
    evidence: {
      activeConcernCount: concerns.length,
      concernSimilarityMin: config.concernSimilarityMin,
      bestConcernId: best?.concern.id ?? null,
      bestConcernText: best ? textPreview(best.concern.text) : null,
      bestMeanSimilarity: round4(best?.meanSimilarity ?? 0),
    },
  };
}

// ── Signal 4: stress attribution (evidence enrichment, correlation only) ──

/**
 * Compares the affect series inside the cluster's creation window against
 * the series before it, in units of the baseline standard deviation.
 * Deterministic correlation reported as such — the summary never claims the
 * cluster CAUSED the shift, only that the window saw one.
 */
export function evaluateStressAttributionSignal(
  members: readonly SecondArrowMemoryWriteSample[],
  affectSeries: readonly SecondArrowAffectPoint[],
  config: IntakeSecondArrowPolicyConfig,
  nowMs: number,
): SecondArrowSignalResult {
  const stress = config.stressAttribution;
  const clusterStartMs = Math.min(...members.map((member) => member.extractedAtMs));
  const usable = affectSeries.filter((point) => Number.isFinite(point.valence)
    && Number.isFinite(point.observedAtMs)
    && point.observedAtMs <= nowMs);
  const windowPoints = usable.filter((point) => point.observedAtMs >= clusterStartMs);
  const baselinePoints = usable.filter((point) => point.observedAtMs < clusterStartMs);

  if (windowPoints.length < stress.minPoints || baselinePoints.length < stress.minPoints) {
    return {
      id: 'stress_attribution',
      triggered: false,
      score: 0,
      summary: `insufficient affect history (${windowPoints.length} window / ${baselinePoints.length} baseline points, `
        + `need ${stress.minPoints} each)`,
      evidence: {
        windowPointCount: windowPoints.length,
        baselinePointCount: baselinePoints.length,
        minPoints: stress.minPoints,
        clusterStartMs,
      },
    };
  }

  const mean = (points: readonly SecondArrowAffectPoint[]): number =>
    points.reduce((sum, point) => sum + point.valence, 0) / points.length;
  const baselineMean = mean(baselinePoints);
  const windowMean = mean(windowPoints);
  const baselineVariance = baselinePoints
    .reduce((sum, point) => sum + (point.valence - baselineMean) ** 2, 0) / baselinePoints.length;
  const baselineStd = Math.sqrt(baselineVariance);
  const effectiveStd = Math.max(baselineStd, stress.minBaselineStd);
  const delta = windowMean - baselineMean;
  const zShift = delta / effectiveStd;

  const triggered = Math.abs(zShift) >= stress.deltaSigmaThreshold;
  const score = clampUnit(
    (Math.abs(zShift) / (2 * stress.deltaSigmaThreshold)) * (triggered ? 1 : 0),
  );
  const direction = delta < 0 ? 'negative' : 'positive';

  return {
    id: 'stress_attribution',
    triggered,
    score: round4(score),
    summary: triggered
      ? `cluster window saw valence ${delta < 0 ? '' : '+'}${round4(delta)} vs baseline `
        + `(${round4(Math.abs(zShift))}x baseline volatility, ${direction}) — correlation, not causation`
      : `valence within ${round4(Math.abs(zShift))}x of baseline volatility during the cluster window`,
    evidence: {
      attributedDimension: 'valence',
      clusterStartMs,
      windowPointCount: windowPoints.length,
      baselinePointCount: baselinePoints.length,
      baselineMean: round4(baselineMean),
      windowMean: round4(windowMean),
      delta: round4(delta),
      baselineStd: round4(baselineStd),
      effectiveStd: round4(effectiveStd),
      zShift: round4(zShift),
      deltaSigmaThreshold: stress.deltaSigmaThreshold,
      direction,
    },
  };
}

// ── Composite ──

/**
 * Deterministic consolidation-survivor pick: highest salience, ties broken
 * by earliest extraction (the original statement of the topic), then id.
 */
export function pickCanonicalMember(
  members: readonly SecondArrowMemoryWriteSample[],
): SecondArrowMemoryWriteSample {
  if (members.length === 0) {
    throw new Error('Second-arrow canonical pick requires a non-empty cluster');
  }
  return members.slice().sort((left, right) => (
    right.salience - left.salience
    || left.extractedAtMs - right.extractedAtMs
    || left.id.localeCompare(right.id)
  ))[0]!;
}

export function computeClusterKey(memberIds: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...memberIds].sort()))
    .digest('hex');
}

/**
 * Full per-cluster evaluation. `shouldRaiseCard` requires BOTH core gates
 * (similarity_cluster AND creation_velocity) — the two together encode the
 * rumination-vs-healthy-recurrence discriminator. Concern-loop and stress
 * attribution enrich the evidence and the composite score, but never gate:
 * a stack without a formal concern row is still a stack, and affect history
 * may simply be too thin to evaluate.
 */
export function evaluateSecondArrowCluster(input: {
  members: readonly SecondArrowMemoryWriteSample[];
  allWrites: readonly SecondArrowMemoryWriteSample[];
  concerns: readonly SecondArrowConcernSample[];
  affectSeries: readonly SecondArrowAffectPoint[];
  config: IntakeSecondArrowPolicyConfig;
  nowMs: number;
}): SecondArrowClusterReport {
  const { members, allWrites, concerns, affectSeries, config, nowMs } = input;
  const similaritySignal = evaluateSimilarityClusterSignal(members, config);
  const velocitySignal = evaluateCreationVelocitySignal(members, allWrites, config, nowMs);
  const concernSignal = evaluateConcernLoopSignal(members, concerns, config);
  const stressSignal = evaluateStressAttributionSignal(members, affectSeries, config, nowMs);
  const signals = [similaritySignal, velocitySignal, concernSignal, stressSignal];
  const triggered = signals.filter((signal) => signal.triggered);
  const shouldRaiseCard = similaritySignal.triggered && velocitySignal.triggered;
  const compositeScore = triggered.length > 0
    ? round4(Math.max(...triggered.map((signal) => signal.score)))
    : 0;

  const centroid = centroidOf(members);
  const canonical = pickCanonicalMember(members);
  const memberIds = members.map((member) => member.id);
  const contactCounts = countBy(
    members.filter((member) => member.contactId),
    (member) => member.contactId!,
  );
  const sortedContactEntries = Object.entries(contactCounts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const dominantContactId: string | undefined = sortedContactEntries.length > 0
    ? sortedContactEntries[0]![0]
    : undefined;

  return {
    clusterKey: computeClusterKey(memberIds),
    memberIds,
    members: members
      .slice()
      .sort((left, right) => left.extractedAtMs - right.extractedAtMs || left.id.localeCompare(right.id))
      .map((member) => ({
        id: member.id,
        textPreview: textPreview(member.text),
        type: member.type,
        extractedAtMs: member.extractedAtMs,
        ...(member.contactId !== undefined ? { contactId: member.contactId } : {}),
        ...(member.sourceType !== undefined ? { sourceType: member.sourceType } : {}),
        similarityToCentroid: round4(cosineSimilarity(centroid, member.embedding)),
      })),
    topicLabel: textPreview(canonical.text),
    canonicalMemoryId: canonical.id,
    ...(dominantContactId !== undefined ? { dominantContactId } : {}),
    signals,
    triggeredSignalIds: triggered.map((signal) => signal.id),
    compositeScore,
    shouldRaiseCard,
    ...(concernSignal.triggered && typeof concernSignal.evidence.bestConcernId === 'string'
      ? { concernId: concernSignal.evidence.bestConcernId }
      : {}),
    ...(concernSignal.triggered && typeof concernSignal.evidence.bestConcernText === 'string'
      ? { concernText: concernSignal.evidence.bestConcernText }
      : {}),
  };
}
