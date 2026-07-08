import type { SessionEntry } from '../../../core/session/types.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import {
  evaluateDeterministicGate,
  type DeterministicGateDefinition,
} from '../../../shared/gating/deterministic-gate.js';
import type { ChannelPrivacy } from '../../../system/trust/context-envelope.js';
import type { ExtractedFact } from '../types.js';
import { clamp } from './config.js';
import type {
  AcceptedFactCandidate,
  EmotionalSignal,
  ExtractionGateConfig,
  ExtractionPreLlmGateReason,
  FactAcceptanceDecision,
} from './types.js';
import { TRANSCRIPT_EMOTIONAL_SIGNAL_LIMIT } from './types.js';

const RELATIONSHIP_SIGNAL_HINTS = new Set([
  'partner',
  'spouse',
  'wife',
  'husband',
  'fiance',
  'fiancee',
  'girlfriend',
  'boyfriend',
  'sister',
  'brother',
  'mother',
  'father',
  'mom',
  'dad',
  'parent',
  'son',
  'daughter',
  'child',
  'family',
  'roommate',
  'friend',
  'coworker',
  'colleague',
  'manager',
  'mentor',
]);

const LOW_SIGNAL_EXACT_TEXT = new Set([
  'hi',
  'hello',
  'hey',
  'good morning',
  'good afternoon',
  'good evening',
  'how are you',
  'whats up',
  'thank you',
  'thanks',
  'bye',
  'goodbye',
  'see you',
  'talk later',
]);

const LOW_SIGNAL_PATTERNS = [
  /\b(user|assistant)\s+(greeted|greets|said|says|thanked|thanks|apologized|asked)\b.*\b(hi|hello|hey|thanks|thank you|goodbye|bye|how are you|whats up)\b/,
  /\b(exchanged|shared)\s+(greetings|pleasantries|small talk|chit chat|chitchat)\b/,
  /\b(quick|brief|short|rapid)\s+(chat|conversation|exchange|back and forth|chatter)\b/,
  /\bquick succession chatter\b/,
  /\b(user|assistant)\s+(joined|left|started|ended)\s+(the )?(chat|conversation)\b/,
  /\b(greetings|pleasantries|small talk|chit chat|chitchat)\b/,
];

const POSITIVE_EMOTION_HINTS = new Set([
  'happy',
  'excited',
  'grateful',
  'thankful',
  'relieved',
  'hopeful',
  'optimistic',
  'joy',
  'joyful',
  'love',
  'loved',
  'loving',
]);

const NEGATIVE_EMOTION_HINTS = new Set([
  'sad',
  'anxious',
  'anxiety',
  'angry',
  'upset',
  'stressed',
  'overwhelmed',
  'afraid',
  'scared',
  'hurt',
  'lonely',
  'heartbroken',
  'devastated',
  'grieving',
]);

const MEANINGFUL_SIGNAL_HINTS = new Set([
  'favorite',
  'favourite',
  'prefer',
  'prefers',
  'preferred',
  'plan',
  'plans',
  'planning',
  'moved',
  'move',
  'moving',
  'job',
  'work',
  'career',
  'school',
  'class',
  'project',
  'deadline',
  'promotion',
  'house',
  'home',
  'apartment',
  'travel',
  'trip',
  'vacation',
  'birthday',
  'doctor',
  'medication',
  'health',
  'relationship',
  'breakup',
  'divorce',
  'engaged',
  'married',
  'cat',
  'dog',
  'kid',
  'kids',
]);

const LOW_SIGNAL_TURN_PATTERNS = [
  /\bplease\s+summarize\b/,
  /\bplease\s+recap\b/,
  /\bplease\s+explain\b/,
  /\bcan\s+you\s+summarize\b/,
  /\bcould\s+you\s+summarize\b/,
  /\bwhat\s+are\s+the\s+findings\b/,
  /\bthanks?\b/,
  /\bthank\s+you\b/,
  /\bgood\s+(morning|afternoon|evening)\b/,
  /\bhello\b/,
  /\bhi\b/,
  /\bhey\b/,
  /\bbye\b/,
  /\bgoodbye\b/,
  /\bsee\s+you\b/,
  /\bsmall\s+talk\b/,
  /\bpleasantries\b/,
];

const MEANINGFUL_ENTRY_SCORE_THRESHOLD = 1.25;

export function evaluateFactAcceptance(
  fact: ExtractedFact,
  existingTexts: string[],
  gateConfig: ExtractionGateConfig,
): FactAcceptanceDecision {
  if (fact.importance < gateConfig.minImportance) {
    return { accepted: false, reason: 'low_importance', novelty: 1 };
  }

  if (fact.confidence < gateConfig.minConfidence) {
    return { accepted: false, reason: 'low_confidence', novelty: 1 };
  }

  if (isLowSignalFact(fact.text)) {
    return { accepted: false, reason: 'low_signal', novelty: 1 };
  }

  const novelty = computeNoveltyScore(fact.text, existingTexts);
  if (novelty < gateConfig.minNovelty) {
    return { accepted: false, reason: 'low_novelty', novelty };
  }

  return { accepted: true, novelty };
}

export interface ExtractionPreLlmGateDecision {
  allowed: boolean;
  reason?: ExtractionPreLlmGateReason;
  signalScore: number;
  signalCount: number;
  recentEntryCount: number;
  userEntryCount: number;
}

/**
 * Extraction pre-LLM gate expressed on the shared deterministic-gate primitive
 * (jpvd.4). Byte-identical to the original hand-rolled decision: an empty
 * transcript hard-closes first; otherwise the gate opens when any user turn
 * scores as meaningful (signalCount > 0) OR nothing was explicitly low-signal
 * (explicitLowSignalEntryCount === 0), and closes as 'low_signal' when a turn
 * was explicit filler and none was meaningful.
 */
export const EXTRACTION_PRE_LLM_GATE: DeterministicGateDefinition = {
  lane: 'extraction',
  blockWhen: [{ input: 'recentEntryCount', comparator: 'eq', threshold: 0, reason: 'empty_transcript' }],
  openWhenAny: [
    { input: 'signalCount', comparator: 'gt', threshold: 0 },
    { input: 'explicitLowSignalEntryCount', comparator: 'eq', threshold: 0 },
  ],
  closedReason: 'low_signal',
};

export function evaluateExtractionPreLlmGate(
  recentEntries: readonly SessionEntry[],
): ExtractionPreLlmGateDecision {
  const recent = recentEntries
    .filter(entry => typeof entry.content === 'string' && entry.content.trim().length > 0);
  const userEntries = recent.filter(entry => entry.role === 'user');

  let signalScore = 0;
  let signalCount = 0;
  let explicitLowSignalEntryCount = 0;
  for (const entry of userEntries) {
    const entryScore = scoreExtractionEntrySignal(entry.content);
    signalScore += entryScore;
    if (entryScore >= MEANINGFUL_ENTRY_SCORE_THRESHOLD) {
      signalCount++;
    }
    if (isExplicitLowSignalTurn(entry.content)) {
      explicitLowSignalEntryCount++;
    }
  }

  const decision = evaluateDeterministicGate(EXTRACTION_PRE_LLM_GATE, {
    recentEntryCount: recent.length,
    signalCount,
    explicitLowSignalEntryCount,
  });

  return {
    allowed: decision.open,
    ...(decision.open ? {} : { reason: decision.reason as ExtractionPreLlmGateReason }),
    signalScore: Number(signalScore.toFixed(4)),
    signalCount,
    recentEntryCount: recent.length,
    userEntryCount: userEntries.length,
  };
}

function scoreExtractionEntrySignal(content: string): number {
  const normalized = normalizeForSimilarity(content);
  if (!normalized) return 0;

  const tokens = tokenizeForSimilarity(normalized);
  let score = 0;

  if (LOW_SIGNAL_EXACT_TEXT.has(normalized) || LOW_SIGNAL_TURN_PATTERNS.some(pattern => pattern.test(normalized))) {
    score -= 1.4;
  }

  if (tokens.some(token => RELATIONSHIP_SIGNAL_HINTS.has(token))) {
    score += 1.3;
  }

  if (tokens.some(token => POSITIVE_EMOTION_HINTS.has(token) || NEGATIVE_EMOTION_HINTS.has(token))) {
    score += 1.1;
  }

  if (tokens.some(token => MEANINGFUL_SIGNAL_HINTS.has(token))) {
    score += 0.9;
  }

  if (/\b(i['’`]?m|i was|i have|i had|my|we are|we were)\b/.test(normalized)) {
    score += 0.35;
  }

  if (normalized.length >= 12) {
    score += 0.55;
  } else if (normalized.length <= 8) {
    score -= 0.2;
  }

  if (/[.!?]/.test(normalized)) {
    score += 0.1;
  }

  return score;
}

function isExplicitLowSignalTurn(content: string): boolean {
  const normalized = normalizeForSimilarity(content);
  if (!normalized) return true;
  if (LOW_SIGNAL_EXACT_TEXT.has(normalized)) return true;
  return LOW_SIGNAL_TURN_PATTERNS.some(pattern => pattern.test(normalized));
}

function isLowSignalFact(text: string): boolean {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return true;
  if (LOW_SIGNAL_EXACT_TEXT.has(normalized)) return true;

  const tokens = tokenizeForSimilarity(normalized);
  if (tokens.some(token => RELATIONSHIP_SIGNAL_HINTS.has(token))) {
    return false;
  }

  return LOW_SIGNAL_PATTERNS.some(pattern => pattern.test(normalized));
}

export function computeFactValueScore(fact: ExtractedFact, novelty: number): number {
  const typeBoost = fact.type === 'boundary' ? 1.6 : 1;
  return clamp(fact.importance, 0, 1) * clamp(fact.confidence, 0, 1) * clamp(novelty, 0, 1) * typeBoost;
}

export function deriveEmotionalSignal(
  acceptedFacts: ExtractedFact[],
  recentEntries: SessionEntry[],
): EmotionalSignal | null {
  const factSignal = deriveFactEmotionalSignal(acceptedFacts);
  const transcriptSignal = deriveTranscriptEmotionalSignal(recentEntries);

  if (!factSignal && !transcriptSignal) return null;
  if (factSignal && !transcriptSignal) return factSignal;
  if (!factSignal || !transcriptSignal) return transcriptSignal;

  const combinedConfidence = clamp(
    (factSignal.confidence * 0.7) + (transcriptSignal.confidence * 0.3),
    0,
    1,
  );
  const denominator = factSignal.confidence + transcriptSignal.confidence;
  const combinedValence = denominator > 0
    ? clamp(
      (
        (factSignal.valence * factSignal.confidence)
        + (transcriptSignal.valence * transcriptSignal.confidence)
      ) / denominator,
      -1,
      1,
    )
    : 0;

  if (Math.abs(combinedValence) < 0.08 && combinedConfidence < 0.5) {
    return null;
  }

  return { valence: combinedValence, confidence: combinedConfidence };
}

function deriveFactEmotionalSignal(facts: ExtractedFact[]): EmotionalSignal | null {
  const emotionalFacts = facts.filter((fact) => (
    fact.type === 'emotional' || Math.abs(fact.emotionalValence) >= 0.2
  ));
  if (emotionalFacts.length === 0) return null;

  let weightedValence = 0;
  let totalWeight = 0;
  let confidenceSum = 0;

  for (const fact of emotionalFacts) {
    const weight = clamp((fact.importance * 0.6) + (fact.confidence * 0.4), 0.1, 1);
    weightedValence += clamp(fact.emotionalValence, -1, 1) * weight;
    totalWeight += weight;
    confidenceSum += clamp(fact.confidence, 0, 1);
  }

  if (totalWeight <= 0) return null;

  return {
    valence: clamp(weightedValence / totalWeight, -1, 1),
    confidence: clamp(confidenceSum / emotionalFacts.length, 0.4, 1),
  };
}

function deriveTranscriptEmotionalSignal(entries: SessionEntry[]): EmotionalSignal | null {
  const userEntries = entries
    .filter(entry => entry.role === 'user')
    .slice(-TRANSCRIPT_EMOTIONAL_SIGNAL_LIMIT);
  if (userEntries.length === 0) return null;

  let valenceSum = 0;
  let signalCount = 0;

  for (const entry of userEntries) {
    const entrySignal = scoreTranscriptEmotionalValence(entry.content);
    if (entrySignal === null) continue;
    valenceSum += entrySignal;
    signalCount++;
  }

  if (signalCount === 0) return null;

  return {
    valence: clamp(valenceSum / signalCount, -1, 1),
    confidence: clamp(0.35 + (Math.min(signalCount, 4) * 0.1), 0, 0.75),
  };
}

function scoreTranscriptEmotionalValence(content: string): number | null {
  const normalized = normalizeForSimilarity(content);
  if (!normalized) return null;

  const tokens = tokenizeForSimilarity(normalized);
  let score = 0;
  let hits = 0;

  for (const token of tokens) {
    if (POSITIVE_EMOTION_HINTS.has(token)) {
      score += 1;
      hits++;
    } else if (NEGATIVE_EMOTION_HINTS.has(token)) {
      score -= 1;
      hits++;
    }
  }

  if (hits === 0) return null;
  return clamp(score / Math.max(2, hits), -1, 1);
}

export function compareAcceptedFactCandidates(left: AcceptedFactCandidate, right: AcceptedFactCandidate): number {
  if (right.valueScore !== left.valueScore) return right.valueScore - left.valueScore;
  if (right.fact.importance !== left.fact.importance) return right.fact.importance - left.fact.importance;
  if (right.fact.confidence !== left.fact.confidence) return right.fact.confidence - left.fact.confidence;
  if (right.novelty !== left.novelty) return right.novelty - left.novelty;
  return left.index - right.index;
}

export function computeNoveltyScore(text: string, existingTexts: string[]): number {
  if (existingTexts.length === 0) return 1;

  const normalized = normalizeForSimilarity(text);
  if (!normalized) return 0;

  const tokens = tokenizeForSimilarity(normalized);
  let maxSimilarity = 0;

  for (const existingText of existingTexts) {
    const normalizedExisting = normalizeForSimilarity(existingText);
    if (!normalizedExisting) continue;

    if (normalizedExisting === normalized) return 0;

    const containment = containmentSimilarity(normalized, normalizedExisting);
    const jaccard = jaccardSimilarity(tokens, tokenizeForSimilarity(normalizedExisting));
    maxSimilarity = Math.max(maxSimilarity, containment, jaccard);

    if (maxSimilarity >= 1) break;
  }

  return clamp(1 - maxSimilarity, 0, 1);
}

export function computeProfileNovelty(summary: string, existingSummary: string): number {
  if (!existingSummary.trim()) return 1;
  return computeNoveltyScore(summary, [existingSummary]);
}

function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeForSimilarity(text: string): string[] {
  return text
    .split(/[^a-z0-9]+/)
    .map(token => token.trim())
    .filter(token => token.length >= 2);
}

function containmentSimilarity(left: string, right: string): number {
  const hasContainment = left.includes(right) || right.includes(left);
  if (!hasContainment) return 0;

  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  return 0.85 + 0.15 * (shorter / longer);
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;

  const leftSet = new Set(left);
  const rightSet = new Set(right);

  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) intersection++;
  }

  const union = leftSet.size + rightSet.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function applyChannelImportanceCaps(
  fact: ExtractedFact,
  channelVisibility: ChannelPrivacy,
): ExtractedFact {
  if (fact.type === 'boundary') return fact;
  if (channelVisibility !== 'public') return fact;
  if (fact.importance <= 0.5) return fact;
  return { ...fact, importance: 0.5 };
}

export function buildExtractionSourceRef(
  channelId: string,
  entries: SessionEntry[],
  channelVisibility: ChannelPrivacy,
  triggerReason?: string,
  turnId?: TurnID,
  logicalSessionId?: string,
): string {
  const source = resolveExtractionSource(channelId);
  const lineRange = resolveExtractionLineRange(entries);
  const turnToken = turnId ? `|turn:${turnId}` : '';
  const triggerToken = triggerReason ? `|trigger:${triggerReason}` : '';
  const sessionToken = logicalSessionId?.trim() || channelId;
  return `${channelId}:extract|source:${source}|session:${sessionToken}|lines:${lineRange}${turnToken}${triggerToken}|visibility:${channelVisibility}|operation:extract`;
}

function resolveExtractionSource(channelId: string): string {
  if (channelId.startsWith('shard:')) return channelId;
  return 'session';
}

function resolveExtractionLineRange(entries: SessionEntry[]): string {
  const ids = entries
    .map(entry => entry.id)
    .filter(id => Number.isFinite(id));
  if (ids.length === 0) return 'unknown';
  const start = Math.min(...ids);
  const end = Math.max(...ids);
  return start === end ? `${start}` : `${start}-${end}`;
}
