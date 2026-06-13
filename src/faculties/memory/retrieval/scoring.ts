import type { RetrievalVADInput } from '../../../core/agent/contracts.js';
import { DEFAULT_MOOD_CONGRUENCE_WEIGHT } from '../../../system/config/runtime-config-contracts.js';
import {
  computeBoundarySimilarityBoost,
  isBoundaryMemory,
} from '../boundary-log.js';
import {
  MEMORY_CONFIG,
  computeMemoryScopeMatchStrength,
  evaluateMemoryPrivacyRisk,
  type MemoryPrivacyRiskBreakdown,
  type MemoryScopeQuery,
  type PurrMemory,
  type RetrievalCallerContext,
  type RetrievalModeInput,
} from '../types.js';
import { normalizeRetrievalModes } from './modes.js';
import type { ScoredMemory } from './types.js';

export const SCORE_GUARANTEE_MIN_K = 3;
export const SCORE_GUARANTEE_FLOOR = 0.01;

const DEFAULT_RECENCY_DECAY_DAYS = 30;
const TEMPORAL_RECENCY_DECAY_DAYS = 7;
const TEMPORAL_SAME_DAY_EVIDENCE_BOOST = 1.2;
const REFLECTION_PROVENANCE_PREFIXES = [
  'reflection_journal:',
  'reflection_daily:',
  'reflection_process:',
] as const;

interface RetrievalScoreComponents {
  score: number;
  baseScore: number;
  evidenceSupport: number;
  contradictionPenaltyMultiplier: number;
  explicitlyQueried: boolean;
  lowConfidenceSingleSourceSuppressed: boolean;
  evidenceSourceCount: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
  retrievalModeExcluded: boolean;
}

export interface ScoreGuaranteeResult {
  scored: ScoredMemory[];
  rejectedByScore: number;
  scoreGuaranteedCount: number;
}

export function countSelectedMemoryTypes(scored: ScoredMemory[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of scored) {
    counts[item.memory.type] = (counts[item.memory.type] ?? 0) + 1;
  }
  return counts;
}

export function collectSelectedProvenanceRefs(
  scored: ScoredMemory[],
  retrievalSource: 'embedding' | 'lexical_fallback' = 'embedding',
): string[] {
  const refs = new Set<string>();
  if (retrievalSource === 'lexical_fallback') {
    refs.add('retrieval:lexical_fallback');
  }
  for (const item of scored) {
    // The metacognition monitor counts memory-backed evidence by the
    // `memory:` prefix; without these entries supporting_memories is
    // structurally zero and confabulation_risk pins at max confidence.
    if (item.memory.id.trim()) {
      refs.add(`memory:${item.memory.id.trim()}`);
    }
    for (const link of item.evolutionChain ?? []) {
      if (link.relation === 'conflicts_with' || link.relation === 'negates') {
        refs.add(`memory:${link.memory.id}|conflict:${link.relation}`);
      }
    }
    if (item.memory.sourceRef.trim()) {
      refs.add(item.memory.sourceRef.trim());
    }
    for (const provenanceRef of item.memory.provenanceRefs ?? []) {
      const normalized = provenanceRef.trim();
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

export function applyScoreGuarantee(scoredCandidates: ScoredMemory[]): ScoreGuaranteeResult {
  const positiveScored = scoredCandidates.filter(candidate => candidate.score > 0);
  const zeroScored = scoredCandidates.filter(candidate => candidate.score <= 0);
  const rejectedByScore = zeroScored.length;

  let scoreGuaranteedCount = 0;
  if (positiveScored.length < SCORE_GUARANTEE_MIN_K && zeroScored.length > 0) {
    const needed = SCORE_GUARANTEE_MIN_K - positiveScored.length;
    const rescued = zeroScored
      .sort((a, b) => b.memory.similarity - a.memory.similarity)
      .slice(0, needed)
      .map(item => ({
        ...item,
        score: item.memory.similarity * SCORE_GUARANTEE_FLOOR,
      }));
    positiveScored.push(...rescued);
    positiveScored.sort((a, b) => b.score - a.score);
    scoreGuaranteedCount = rescued.length;
  }

  return {
    scored: positiveScored,
    rejectedByScore,
    scoreGuaranteedCount,
  };
}

export function computeRetrievalScore(
  memory: PurrMemory & { similarity: number },
  contextText: string,
  options?: {
    currentVAD?: RetrievalVADInput;
    moodCongruenceWeight: number;
    scopeQuery?: MemoryScopeQuery;
    callerContext?: RetrievalCallerContext;
    retrievalMode?: RetrievalModeInput;
  },
): RetrievalScoreComponents {
  const now = Date.now();
  const retrievalModes = normalizeRetrievalModes(options?.callerContext, options?.retrievalMode);
  const temporalMode = retrievalModes.has('temporal');
  const reflectionMode = retrievalModes.has('reflection');
  const recencyBoost = computeRetrievalRecencyBoost(memory.extractedAt, now, temporalMode);
  const sameDayEvidenceBoost = temporalMode && hasSameDayTemporalEvidence(memory, now)
    ? TEMPORAL_SAME_DAY_EVIDENCE_BOOST
    : 1;
  const emotionalWeight = 1 + Math.abs(memory.emotionalValence) * 0.5;
  const moodCongruenceFactor = computeMoodCongruenceFactor(
    memory.formationVAD,
    options?.currentVAD,
    options?.moodCongruenceWeight ?? DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  );
  const typePriorityBoost = isBoundaryMemory(memory) ? 1.6 : 1;
  const boundarySimilarityBoost = isBoundaryMemory(memory)
    ? computeBoundarySimilarityBoost(contextText, memory)
    : 1;
  const scopeMatchStrength = computeMemoryScopeMatchStrength(memory, options?.scopeQuery);
  const scopeBoost = 1 + (scopeMatchStrength * 0.35);
  const accessReinforcementBoost = deriveAccessReinforcement(memory);
  const rawBaseScore = (
    memory.similarity *
    recencyBoost *
    sameDayEvidenceBoost *
    emotionalWeight *
    memory.importance *
    memory.salience *
    moodCongruenceFactor *
    typePriorityBoost *
    boundarySimilarityBoost *
    scopeBoost *
    accessReinforcementBoost
  );
  const evidence = deriveEvidenceSupport(memory);
  const contradictionPenaltyMultiplier = deriveContradictionPenalty(memory);
  const explicitlyQueried = hasExplicitMemoryMention(contextText, memory.text);
  const retrievalModeExcluded = reflectionMode && isReflectionRetrievalCandidate(memory);
  const lowConfidenceSingleSourceSuppressed = (
    evidence.sourceCount <= 1
    && memory.confidence < 0.45
    && !explicitlyQueried
  );
  const evidenceBoost = 0.45 + (evidence.support * 0.55);
  const baseScore = rawBaseScore * evidenceBoost * contradictionPenaltyMultiplier;
  const privacyEvaluation = evaluateMemoryPrivacyRisk(memory);
  const privacyPenalty = baseScore * privacyEvaluation.risk * MEMORY_CONFIG.privacyRiskPenaltyWeight;
  let score = retrievalModeExcluded ? 0 : Math.max(0, baseScore - privacyPenalty);
  if (!retrievalModeExcluded && lowConfidenceSingleSourceSuppressed) {
    const dominanceCap = memory.similarity * 0.02;
    score = Math.min(score, dominanceCap);
  }
  return {
    score,
    baseScore,
    evidenceSupport: evidence.support,
    contradictionPenaltyMultiplier,
    explicitlyQueried,
    lowConfidenceSingleSourceSuppressed,
    evidenceSourceCount: evidence.sourceCount,
    privacyRisk: privacyEvaluation.risk,
    privacyPenalty,
    privacyBreakdown: privacyEvaluation.breakdown,
    retrievalModeExcluded,
  };
}

function computeRetrievalRecencyBoost(
  extractedAt: number,
  now: number,
  temporalMode: boolean,
): number {
  if (!Number.isFinite(extractedAt)) return 1;
  const ageDays = Math.max(0, (now - extractedAt) / (1000 * 60 * 60 * 24));
  const decayDays = temporalMode ? TEMPORAL_RECENCY_DECAY_DAYS : DEFAULT_RECENCY_DECAY_DAYS;
  return 1 / (1 + ageDays / decayDays);
}

function hasSameDayTemporalEvidence(
  memory: Pick<PurrMemory, 'extractedAt' | 'sourceRef' | 'provenanceRefs'>,
  now: number,
): boolean {
  if (isSameUtcDay(memory.extractedAt, now)) return true;
  const currentDate = formatUtcDate(now);
  if (memory.sourceRef.includes(`date:${currentDate}`) || memory.sourceRef.includes(`createdAt:${currentDate}`)) {
    return true;
  }
  for (const ref of memory.provenanceRefs ?? []) {
    if (ref.includes(`date:${currentDate}`) || ref.includes(`createdAt:${currentDate}`)) {
      return true;
    }
  }
  return false;
}

function isReflectionRetrievalCandidate(
  memory: Pick<PurrMemory, 'type' | 'sourceRef' | 'provenanceRefs'>,
): boolean {
  if (memory.type === 'reflection') return true;
  if (REFLECTION_PROVENANCE_PREFIXES.some(prefix => memory.sourceRef.startsWith(prefix))) {
    return true;
  }
  return (memory.provenanceRefs ?? []).some(ref => (
    REFLECTION_PROVENANCE_PREFIXES.some(prefix => ref.startsWith(prefix))
  ));
}

function isSameUtcDay(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return formatUtcDate(left) === formatUtcDate(right);
}

function formatUtcDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '';
  return new Date(epochMs).toISOString().slice(0, 10);
}

function computeMoodCongruenceFactor(
  formationVAD: RetrievalVADInput | undefined,
  currentVAD: RetrievalVADInput | undefined,
  moodCongruenceWeight: number,
): number {
  if (moodCongruenceWeight <= 0) return 1;
  if (!isFiniteRetrievalVAD(formationVAD) || !isFiniteRetrievalVAD(currentVAD)) return 1;
  const similarity = computeVADSimilarity(formationVAD, currentVAD);
  return 1 + (moodCongruenceWeight * similarity);
}

function computeVADSimilarity(
  left: RetrievalVADInput,
  right: RetrievalVADInput,
): number {
  const deltaValence = clamp(left.valence, -1, 1) - clamp(right.valence, -1, 1);
  const deltaArousal = clamp(left.arousal, -1, 1) - clamp(right.arousal, -1, 1);
  const deltaDominance = clamp(left.dominance, -1, 1) - clamp(right.dominance, -1, 1);
  const distance = Math.sqrt(
    (deltaValence ** 2)
    + (deltaArousal ** 2)
    + (deltaDominance ** 2),
  );
  const maxDistance = 2 * Math.sqrt(3);
  return clamp(1 - (distance / maxDistance), 0, 1);
}

function isFiniteRetrievalVAD(vad: RetrievalVADInput | undefined): vad is RetrievalVADInput {
  if (!vad) return false;
  return Number.isFinite(vad.valence)
    && Number.isFinite(vad.arousal)
    && Number.isFinite(vad.dominance);
}

function deriveEvidenceSupport(
  memory: Pick<PurrMemory, 'confidence' | 'sourceRef' | 'provenanceRefs' | 'accessCount'>,
): { support: number; sourceCount: number } {
  const confidence = clamp(memory.confidence, 0, 1);
  const sourceCount = countDistinctEvidenceSources(memory);
  const sourceSupport = clamp(0.25 + (Math.min(4, sourceCount) / 4) * 0.75, 0, 1);
  const reinforcement = clamp(memory.accessCount / 8, 0, 1);
  const support = clamp(
    (confidence * 0.6)
    + (sourceSupport * 0.3)
    + (reinforcement * 0.1),
    0.05,
    1,
  );
  return { support, sourceCount };
}

function deriveAccessReinforcement(
  memory: Pick<PurrMemory, 'lastAccessed' | 'extractedAt' | 'accessCount'>,
): number {
  const effectiveLastAccessed = Number.isFinite(memory.lastAccessed)
    ? memory.lastAccessed
    : Number.isFinite(memory.extractedAt)
      ? memory.extractedAt
      : Date.now();
  const ageMs = Math.max(0, Date.now() - effectiveLastAccessed);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const freshnessDays = Math.max(1, MEMORY_CONFIG.retrievalAccessFreshnessDays);
  const countCap = Math.max(1, MEMORY_CONFIG.retrievalAccessCountCap);
  const freshness = clamp(1 / (1 + ageDays / freshnessDays), 0, 1);
  const reinforcement = clamp(memory.accessCount / countCap, 0, 1);
  const combinedSignal = clamp(
    (freshness * MEMORY_CONFIG.retrievalAccessFreshnessWeight)
    + (reinforcement * (1 - MEMORY_CONFIG.retrievalAccessFreshnessWeight)),
    0,
    1,
  );
  return 1 + (combinedSignal * MEMORY_CONFIG.retrievalAccessReinforcementMaxBoost);
}

function deriveContradictionPenalty(
  memory: Pick<PurrMemory, 'supersededBy' | 'tags'>,
): number {
  const normalizedTags = new Set(memory.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean));
  const hasContradictionHint = [...normalizedTags].some(tag => (
    tag === 'contradicted'
    || tag === 'contradiction'
    || tag === 'disputed'
    || tag === 'retracted'
    || tag === 'hallucinated'
    || tag.includes('contradict')
    || tag.includes('disput')
  ));
  if (memory.supersededBy) return 0.25;
  if (hasContradictionHint) return 0.55;
  return 1;
}

function countDistinctEvidenceSources(
  memory: Pick<PurrMemory, 'sourceRef' | 'provenanceRefs'>,
): number {
  const sourceSet = new Set<string>();
  const normalizedSourceRef = normalizeEvidenceSource(memory.sourceRef);
  if (normalizedSourceRef) sourceSet.add(normalizedSourceRef);
  for (const ref of memory.provenanceRefs ?? []) {
    const normalized = normalizeEvidenceSource(ref);
    if (normalized) sourceSet.add(normalized);
  }
  return sourceSet.size;
}

function normalizeEvidenceSource(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  const firstSeparator = trimmed.indexOf(':');
  if (firstSeparator <= 0) return trimmed;
  return trimmed.slice(0, firstSeparator + 1);
}

function hasExplicitMemoryMention(contextText: string, memoryText: string): boolean {
  const contextTokens = tokenizeForExplicitMatch(contextText);
  if (contextTokens.length === 0) return false;

  const memoryTokenSet = new Set(tokenizeForExplicitMatch(memoryText));
  if (memoryTokenSet.size === 0) return false;

  let overlap = 0;
  let hasLongOverlap = false;
  for (const token of contextTokens) {
    if (!memoryTokenSet.has(token)) continue;
    overlap++;
    if (token.length >= 6) {
      hasLongOverlap = true;
    }
  }

  if (overlap >= 2 && hasLongOverlap) return true;
  return overlap >= 3;
}

export function tokenizeForExplicitMatch(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4);
}

export function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

export function resolveMoodCongruenceWeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MOOD_CONGRUENCE_WEIGHT;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`moodCongruenceWeight must be a finite number between 0 and 1; received ${String(value)}`);
  }
  return value;
}
