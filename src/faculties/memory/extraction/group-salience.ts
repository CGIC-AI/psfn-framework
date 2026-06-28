import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySalienceReasonWeights,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import { clamp } from './config.js';
import type { GroupMemoryRangeChunk } from './group-ranges.js';

export const GROUP_MEMORY_SALIENCE_REASON_CODES = [
  'companion_mention',
  'direct_address',
  'participant_fact',
  'explicit_preference',
  'relationship_claim',
  'boundary_safety',
  'commitment',
  'emotional_event',
  'durable_plan',
] as const;

export type GroupMemorySalienceReason =
  typeof GROUP_MEMORY_SALIENCE_REASON_CODES[number];

export const GROUP_MEMORY_SALIENCE_SKIP_REASONS = [
  'empty_content',
  'non_user_message',
  'low_signal',
  'duplicate_repetition',
  'below_threshold',
  'candidate_cap',
] as const;

export type GroupMemorySalienceSkipReason =
  typeof GROUP_MEMORY_SALIENCE_SKIP_REASONS[number];

export interface GroupMemorySalienceCandidateSpan {
  channelId: string;
  startMessageId: number;
  endMessageId: number;
  contextStartMessageId: number;
  contextEndMessageId: number;
  sourceMessageIds: number[];
  newSourceMessageIds: number[];
  contextMessageIds: number[];
  score: number;
  reasons: GroupMemorySalienceReason[];
  entries: SessionEntry[];
  newEntries: SessionEntry[];
  contributingAuthorIds: string[];
  contributingAuthorNames: string[];
}

export interface GroupMemorySalienceTelemetry {
  messagesConsidered: number;
  eligibleMessageCount: number;
  selectedMessageCount: number;
  candidateSpansSelected: number;
  skipReasons: Record<GroupMemorySalienceSkipReason, number>;
  selectedReasonCounts: Record<GroupMemorySalienceReason, number>;
  minCandidateScore: number;
  maxCandidateSpansPerChunk: number;
  neighboringContextMessages: number;
}

export interface GroupMemorySalienceSelection {
  channelId: string;
  chunkStartMessageId: number;
  chunkEndMessageId: number;
  candidateSpans: GroupMemorySalienceCandidateSpan[];
  telemetry: GroupMemorySalienceTelemetry;
}

export interface GroupMemorySalienceSelectionOptions {
  chunk: GroupMemoryRangeChunk;
  settings?: GroupMemorySettings;
  companionNames?: readonly string[];
  companionAuthorIds?: readonly string[];
}

interface ScoredEntry {
  entry: SessionEntry;
  entryIndex: number;
  score: number;
  reasons: GroupMemorySalienceReason[];
  skipReasons: GroupMemorySalienceSkipReason[];
}

interface CandidateRawSpan {
  contextStartIndex: number;
  contextEndIndex: number;
  scoredEntries: ScoredEntry[];
}

const REASON_WEIGHT_KEYS: Record<GroupMemorySalienceReason, keyof GroupMemorySalienceReasonWeights> = {
  companion_mention: 'companionMention',
  direct_address: 'directAddress',
  participant_fact: 'participantFact',
  explicit_preference: 'explicitPreference',
  relationship_claim: 'relationshipClaim',
  boundary_safety: 'boundarySafety',
  commitment: 'commitment',
  emotional_event: 'emotionalEvent',
  durable_plan: 'durablePlan',
};

const EXPLICIT_PREFERENCE_PATTERN =
  /\b(favorite|favourite|prefer|prefers|preferred|like|likes|liked|love|loves|loved|hate|hates|hated|dislike|dislikes|allergic|allergy)\b/;
const RELATIONSHIP_PATTERN =
  /\b(partner|spouse|wife|husband|fiance|fiancee|girlfriend|boyfriend|sister|brother|mother|father|mom|dad|parent|son|daughter|child|family|roommate|friend|best friend|coworker|colleague|manager|mentor)\b/;
const BOUNDARY_SAFETY_PATTERN =
  /\b(boundary|boundaries|do not|don't|dont|never|stop|unsafe|safe|safety|private|secret|consent|trigger|panic|crisis|emergency)\b/;
const COMMITMENT_PATTERN =
  /\b(i will|i'll|ill|we will|we'll|promise|committed|commitment|deadline|due|meeting|appointment|remind me|follow up|follow-up)\b/;
const EMOTIONAL_EVENT_PATTERN =
  /\b(happy|excited|grateful|relieved|sad|anxious|angry|upset|stressed|overwhelmed|afraid|scared|hurt|lonely|heartbroken|devastated|grieving|proud)\b/;
const DURABLE_PLAN_PATTERN =
  /\b(plan|plans|planning|tomorrow|tonight|next week|next month|schedule|scheduled|trip|travel|vacation|birthday|moving|move|job|project|school|class|doctor|medication|health)\b/;
const PARTICIPANT_FACT_PATTERN =
  /\b(i am|i'm|im|my|mine|we are|we're|were|i live|i work|i study|i have|i had|i was|i grew up|i moved)\b/;
const LOW_INFORMATION_PATTERN =
  /^(ok|okay|k|lol|lmao|rofl|haha|hehe|yes|yeah|yep|no|nah|thanks|thank you|ty|gm|gn|hi|hey|hello|bye|brb|fr|real|same)$/;

export function selectGroupMemorySalienceCandidates(
  options: GroupMemorySalienceSelectionOptions,
): GroupMemorySalienceSelection {
  const settings = options.settings ?? createDefaultGroupMemorySettings();
  const salience = settings.salience;
  const skipReasons = createSkipReasonCounts();
  const selectedReasonCounts = createSelectedReasonCounts();
  const scored: ScoredEntry[] = [];
  const recentNormalizedTexts: string[] = [];

  for (const entry of options.chunk.newEntries) {
    const entryIndex = options.chunk.entries.findIndex(candidate => candidate.id === entry.id);
    const scoredEntry = scoreEntry({
      entry,
      entryIndex: entryIndex >= 0 ? entryIndex : 0,
      settings,
      companionNames: options.companionNames ?? [],
      companionAuthorIds: options.companionAuthorIds ?? [],
      recentNormalizedTexts,
    });
    scored.push(scoredEntry);
    for (const reason of scoredEntry.skipReasons) {
      skipReasons[reason] += 1;
    }
    const normalized = normalizeContent(entry.content);
    if (normalized) {
      recentNormalizedTexts.push(normalized);
      const repeatWindow = Math.max(1, salience.lowSignalRules.repeatWindowMessages);
      while (recentNormalizedTexts.length > repeatWindow) {
        recentNormalizedTexts.shift();
      }
    }
  }

  const selectedEntries = scored
    .filter(entry => entry.score >= salience.minCandidateScore)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.entry.id - right.entry.id;
    });
  for (const scoredEntry of scored) {
    if (
      scoredEntry.skipReasons.length === 0
      && scoredEntry.score < salience.minCandidateScore
    ) {
      skipReasons.below_threshold += 1;
    }
  }

  const rawSpans = buildRawSpans({
    chunkEntries: options.chunk.entries,
    selectedEntries,
    neighboringContextMessages: Math.max(0, salience.neighboringContextMessages),
  });
  const selectedRawSpans = rawSpans
    .sort((left, right) => {
      const scoreDelta = scoreRawSpan(right) - scoreRawSpan(left);
      if (scoreDelta !== 0) return scoreDelta;
      return left.contextStartIndex - right.contextStartIndex;
    })
    .slice(0, Math.max(1, salience.maxCandidateSpansPerChunk));
  skipReasons.candidate_cap += Math.max(
    0,
    rawSpans.length - selectedRawSpans.length,
  );

  const candidateSpans = selectedRawSpans
    .sort((left, right) => left.contextStartIndex - right.contextStartIndex)
    .map(rawSpan => toCandidateSpan(options.chunk, rawSpan));
  for (const span of candidateSpans) {
    for (const reason of span.reasons) {
      selectedReasonCounts[reason] += 1;
    }
  }

  return {
    channelId: options.chunk.channelId,
    chunkStartMessageId: options.chunk.spanStartMessageId,
    chunkEndMessageId: options.chunk.spanEndMessageId,
    candidateSpans,
    telemetry: {
      messagesConsidered: options.chunk.newEntries.length,
      eligibleMessageCount: scored.filter(entry => entry.skipReasons.length === 0).length,
      selectedMessageCount: candidateSpans.reduce(
        (sum, span) => sum + span.newSourceMessageIds.length,
        0,
      ),
      candidateSpansSelected: candidateSpans.length,
      skipReasons,
      selectedReasonCounts,
      minCandidateScore: salience.minCandidateScore,
      maxCandidateSpansPerChunk: salience.maxCandidateSpansPerChunk,
      neighboringContextMessages: salience.neighboringContextMessages,
    },
  };
}

function scoreEntry(params: {
  entry: SessionEntry;
  entryIndex: number;
  settings: GroupMemorySettings;
  companionNames: readonly string[];
  companionAuthorIds: readonly string[];
  recentNormalizedTexts: readonly string[];
}): ScoredEntry {
  const { entry, settings } = params;
  const skipReasons: GroupMemorySalienceSkipReason[] = [];
  const content = entry.content.trim();
  if (!content) {
    return {
      entry,
      entryIndex: params.entryIndex,
      score: 0,
      reasons: [],
      skipReasons: ['empty_content'],
    };
  }
  if (entry.role !== 'user') {
    return {
      entry,
      entryIndex: params.entryIndex,
      score: 0,
      reasons: [],
      skipReasons: ['non_user_message'],
    };
  }

  const normalized = normalizeContent(content);
  const reasons = detectReasons({
    content,
    normalized,
    companionNames: params.companionNames,
    companionAuthorIds: params.companionAuthorIds,
  });
  let score = reasons.reduce(
    (sum, reason) => sum + settings.salience.reasonWeights[REASON_WEIGHT_KEYS[reason]],
    0,
  );

  if (settings.salience.lowSignalRules.enabled) {
    if (isLowInformationMessage(normalized, content, reasons, settings)) {
      skipReasons.push('low_signal');
      score -= settings.salience.lowSignalRules.lowInformationPenalty;
    }
    if (isRepeatedMessage(normalized, params.recentNormalizedTexts, settings)) {
      skipReasons.push('duplicate_repetition');
      score -= settings.salience.lowSignalRules.lowInformationPenalty;
    }
  }

  return {
    entry,
    entryIndex: params.entryIndex,
    score: roundScore(clamp(score, 0, 10)),
    reasons,
    skipReasons,
  };
}

function detectReasons(params: {
  content: string;
  normalized: string;
  companionNames: readonly string[];
  companionAuthorIds: readonly string[];
}): GroupMemorySalienceReason[] {
  const reasons = new Set<GroupMemorySalienceReason>();
  if (containsCompanionMention(params.content, params.normalized, params.companionNames, params.companionAuthorIds)) {
    reasons.add('companion_mention');
  }
  if (isDirectAddress(params.content, params.normalized, params.companionNames, params.companionAuthorIds)) {
    reasons.add('direct_address');
  }
  if (PARTICIPANT_FACT_PATTERN.test(params.normalized)) {
    reasons.add('participant_fact');
  }
  if (EXPLICIT_PREFERENCE_PATTERN.test(params.normalized)) {
    reasons.add('explicit_preference');
  }
  if (RELATIONSHIP_PATTERN.test(params.normalized)) {
    reasons.add('relationship_claim');
  }
  if (BOUNDARY_SAFETY_PATTERN.test(params.normalized)) {
    reasons.add('boundary_safety');
  }
  if (COMMITMENT_PATTERN.test(params.normalized)) {
    reasons.add('commitment');
  }
  if (EMOTIONAL_EVENT_PATTERN.test(params.normalized)) {
    reasons.add('emotional_event');
  }
  if (DURABLE_PLAN_PATTERN.test(params.normalized)) {
    reasons.add('durable_plan');
  }
  return [...reasons];
}

function containsCompanionMention(
  content: string,
  normalized: string,
  companionNames: readonly string[],
  companionAuthorIds: readonly string[],
): boolean {
  return buildCompanionAliases(companionNames).some(alias => hasWord(normalized, alias))
    || companionAuthorIds.some(authorId => content.includes(`<@${authorId}>`));
}

function isDirectAddress(
  content: string,
  normalized: string,
  companionNames: readonly string[],
  companionAuthorIds: readonly string[],
): boolean {
  const trimmed = content.trim();
  if (companionAuthorIds.some(authorId => trimmed.startsWith(`<@${authorId}>`))) {
    return true;
  }
  return buildCompanionAliases(companionNames).some(alias => (
    normalized === alias
    || normalized.startsWith(`${alias} `)
  ));
}

function buildCompanionAliases(companionNames: readonly string[]): string[] {
  return [...new Set(
    companionNames
      .map(name => normalizeContent(name))
      .filter(Boolean),
  )];
}

function hasWord(normalized: string, word: string): boolean {
  if (!word) return false;
  return new RegExp(`(^|\\s)${escapeRegExp(word)}(\\s|$)`).test(normalized);
}

function isLowInformationMessage(
  normalized: string,
  content: string,
  reasons: readonly GroupMemorySalienceReason[],
  settings: GroupMemorySettings,
): boolean {
  if (LOW_INFORMATION_PATTERN.test(normalized)) return true;
  return reasons.length === 0
    && content.length <= settings.salience.lowSignalRules.shortMessageMaxChars;
}

function isRepeatedMessage(
  normalized: string,
  recentNormalizedTexts: readonly string[],
  settings: GroupMemorySettings,
): boolean {
  if (!normalized) return false;
  const repeatCount = recentNormalizedTexts.filter(value => value === normalized).length + 1;
  return repeatCount >= settings.salience.lowSignalRules.repeatThreshold;
}

function buildRawSpans(params: {
  chunkEntries: readonly SessionEntry[];
  selectedEntries: readonly ScoredEntry[];
  neighboringContextMessages: number;
}): CandidateRawSpan[] {
  const rawSpans = params.selectedEntries
    .map(scoredEntry => ({
      contextStartIndex: Math.max(0, scoredEntry.entryIndex - params.neighboringContextMessages),
      contextEndIndex: Math.min(
        params.chunkEntries.length - 1,
        scoredEntry.entryIndex + params.neighboringContextMessages,
      ),
      scoredEntries: [scoredEntry],
    }))
    .sort((left, right) => left.contextStartIndex - right.contextStartIndex);

  const merged: CandidateRawSpan[] = [];
  for (const rawSpan of rawSpans) {
    const previous = merged.at(-1);
    if (!previous || rawSpan.contextStartIndex > previous.contextEndIndex + 1) {
      merged.push({ ...rawSpan, scoredEntries: [...rawSpan.scoredEntries] });
      continue;
    }
    previous.contextEndIndex = Math.max(previous.contextEndIndex, rawSpan.contextEndIndex);
    previous.scoredEntries.push(...rawSpan.scoredEntries);
  }
  return merged;
}

function toCandidateSpan(
  chunk: GroupMemoryRangeChunk,
  rawSpan: CandidateRawSpan,
): GroupMemorySalienceCandidateSpan {
  const entries = chunk.entries.slice(
    rawSpan.contextStartIndex,
    rawSpan.contextEndIndex + 1,
  );
  const newEntryIdSet = new Set(chunk.newEntries.map(entry => entry.id));
  const sourceMessageIds = rawSpan.scoredEntries
    .map(scoredEntry => scoredEntry.entry.id)
    .sort((left, right) => left - right);
  const reasons = [...new Set(
    rawSpan.scoredEntries.flatMap(scoredEntry => scoredEntry.reasons),
  )].sort();
  const contributingAuthorIds = [...new Set(
    rawSpan.scoredEntries
      .map(scoredEntry => scoredEntry.entry.authorId)
      .filter((authorId): authorId is string => Boolean(authorId)),
  )];
  const contributingAuthorNames = [...new Set(
    rawSpan.scoredEntries
      .map(scoredEntry => scoredEntry.entry.authorName)
      .filter((authorName): authorName is string => Boolean(authorName)),
  )];

  return {
    channelId: chunk.channelId,
    startMessageId: entries[0]?.id ?? chunk.spanStartMessageId,
    endMessageId: entries.at(-1)?.id ?? chunk.spanEndMessageId,
    contextStartMessageId: entries[0]?.id ?? chunk.contextStartMessageId,
    contextEndMessageId: entries.at(-1)?.id ?? chunk.contextEndMessageId,
    sourceMessageIds,
    newSourceMessageIds: sourceMessageIds.filter(id => newEntryIdSet.has(id)),
    contextMessageIds: entries.map(entry => entry.id),
    score: roundScore(scoreRawSpan(rawSpan)),
    reasons,
    entries,
    newEntries: entries.filter(entry => newEntryIdSet.has(entry.id)),
    contributingAuthorIds,
    contributingAuthorNames,
  };
}

function scoreRawSpan(rawSpan: CandidateRawSpan): number {
  return rawSpan.scoredEntries.reduce((sum, entry) => sum + entry.score, 0);
}

function normalizeContent(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9<@>\s'-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function roundScore(value: number): number {
  return Number(value.toFixed(4));
}

function createSkipReasonCounts(): Record<GroupMemorySalienceSkipReason, number> {
  return Object.fromEntries(
    GROUP_MEMORY_SALIENCE_SKIP_REASONS.map(reason => [reason, 0]),
  ) as Record<GroupMemorySalienceSkipReason, number>;
}

function createSelectedReasonCounts(): Record<GroupMemorySalienceReason, number> {
  return Object.fromEntries(
    GROUP_MEMORY_SALIENCE_REASON_CODES.map(reason => [reason, 0]),
  ) as Record<GroupMemorySalienceReason, number>;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
