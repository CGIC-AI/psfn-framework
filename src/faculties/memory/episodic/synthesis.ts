import { createHash } from 'node:crypto';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type {
  Episode,
  EpisodeAffect,
  EpisodeArc,
  EpisodeArtifactRef,
  EpisodeProvenanceRef,
  EpisodeSalience,
  EpisodeSpanRef,
} from '../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeArcWriteInput,
  EpisodeCandidateDecision,
  EpisodeCandidateDecisionStatus,
  EpisodeCreateInput,
  EpisodeUpdateInput,
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkScope,
  EpisodicStorePort,
} from './store-port.js';
import { proposeTopicSegments, type TopicSegment } from './topic-segmentation.js';
import type { PersonaPreamblePort } from '../../../core/identity/persona-preamble.js';

const log = createComponentLogger('EpisodicSynthesis');

export interface EpisodicSynthesisSessionReader {
  getRecentMessages(channelId: string, limit: number): SessionEntry[];
}

/**
 * Typed segmentation outcome per gated chunk (E5.4). Failures are visible,
 * never silent: a malformed proposal emits `outcome: 'failed'` and the run
 * writes/claims nothing for that chunk (watermark not advanced past it).
 */
export interface EpisodeSegmentationEvent {
  sessionId: string;
  channelId: string;
  outcome: 'segmented' | 'failed';
  chunkEntryCount: number;
  segmentCount: number;
  heldBackEntryCount: number;
  error?: string;
  timestamp: number;
}

export interface EpisodicTopicSegmentationOptions {
  /** JSON-owned enable flag (scheduler.json episodeSynthesis.topicSegmentationEnabled). */
  enabled: boolean;
  /** Required when enabled — segmentation never silently degrades to deterministic cuts. */
  llmProvider?: Pick<LLMProviderPort, 'complete'> | null;
  /** Segmentation telemetry sink; wired to the runtime event bus by composition. */
  onEvent?: (event: EpisodeSegmentationEvent) => void;
  /** Shared persona preamble service (E6.1); soft persona framing before the segmentation task prompt. */
  personaPreamble?: PersonaPreamblePort | null;
  now?: () => number;
}

export interface EpisodicSynthesisOptions {
  transcriptMessageLimit?: number;
  maxEpisodesPerRun?: number;
  maxPriorCandidates?: number;
  gapSplitMinutes?: number;
  maxEntriesPerEpisode?: number;
  /** Salience minimum: conversational entries required for a group to count. */
  minConversationalEntries?: number;
  /** Salience minimum: single-entry character floor for one-entry groups. */
  minSingleEntryChars?: number;
  /**
   * Contextual topic cutting inside deterministic chunk bounds (E5.4).
   * Absent or disabled => deterministic behavior is byte-identical.
   */
  topicSegmentation?: EpisodicTopicSegmentationOptions;
}

export interface EpisodicSynthesisRunInput {
  sessionId: string;
  sourceMessageId?: string;
}

export interface EpisodicSynthesisRunResult {
  consideredEntries: number;
  /** Entries dropped because another live episode already claims them. */
  claimedEntriesSkipped: number;
  candidateEpisodeCount: number;
  createdEpisodes: Episode[];
  skippedEpisodeIds: string[];
  linkedArcs: EpisodeArc[];
  /**
   * Entries held back as an unfinished trailing topic (not claimed, no
   * episode); they roll into the next pass. Always 0 in deterministic mode.
   */
  heldBackEntryCount: number;
  /** Chunks whose segmentation output failed schema validation (fail closed). */
  segmentationFailedChunkCount: number;
}

export interface EpisodicSynthesisWatermarkScope {
  sessionId: string;
  threadId?: string;
  channelId?: string;
}

export interface EpisodicSynthesisProcessingWatermark extends EpisodicSynthesisWatermarkScope {
  highWaterTurnId?: string;
  highWaterMessageId?: string;
  processedStartedAt: string;
  processedEndedAt: string;
  updatedAt: string;
  canonicalEpisodeIds: string[];
  skippedEpisodeIds: string[];
}

interface EpisodeGroup {
  entries: SessionEntry[];
}

interface SynthesisRunState {
  durableWatermark: EpisodicProcessingWatermark | undefined;
  createdEpisodes: Episode[];
  skippedEpisodeIds: string[];
  linkedArcs: EpisodeArc[];
  /** Candidates materialized this run; capped by maxEpisodesPerRun. */
  candidatesProcessed: number;
}

interface SegmentationRunOutcome {
  heldBackEntryCount: number;
  segmentationFailedChunkCount: number;
  candidateEpisodeCount: number;
}

interface ThemeScore {
  theme: string;
  score: number;
}

type EpisodeCandidateInput = EpisodeCreateInput & { id: string };

interface ConsolidationCandidateScore {
  episode: Episode;
  spanOverlapRatio: number;
  themeOverlap: number;
  artifactOverlap: number;
  turnBoundaryOverlap: boolean;
  timeGapMs: number;
}

interface CandidateDecisionResult {
  status: EpisodeCandidateDecisionStatus;
  action: 'create' | 'extend' | 'discard';
  reason: string;
  canonicalEpisode: Episode;
  sourceEpisode?: Episode;
  score?: ConsolidationCandidateScore;
}

const DEFAULT_TRANSCRIPT_MESSAGE_LIMIT = 96;
const DEFAULT_MAX_EPISODES_PER_RUN = 6;
const DEFAULT_MAX_PRIOR_CANDIDATES = 24;
const DEFAULT_GAP_SPLIT_MINUTES = 45;
const DEFAULT_MAX_ENTRIES_PER_EPISODE = 14;
const MIN_CONVERSATIONAL_ENTRIES = 2;
const MIN_SINGLE_ENTRY_CHARS = 120;
const MIN_RELATED_THEME_OVERLAP = 1;
const MIN_CONSOLIDATION_THEME_OVERLAP = 1;
const MIN_CONSOLIDATION_SPAN_OVERLAP_RATIO = 0.5;
const MAX_CONSOLIDATION_BOUNDARY_GAP_MS = 10 * 60_000;
const MIN_CONSOLIDATION_SEARCH_WINDOW_MS = 2 * 60 * 60_000;
const MAX_CONSOLIDATION_SEARCH_WINDOW_MS = 24 * 60 * 60_000;
const WATERMARK_LOOKBACK_MS = Math.max(MAX_CONSOLIDATION_BOUNDARY_GAP_MS, 45 * 60_000);
const EPISODIC_SYNTHESIS_PROCESSOR = 'episodic_synthesis';
const CLAIM_LOOKUP_CHUNK_SIZE = 200;
const MINUTE_MS = 60_000;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'been',
  'before',
  'being',
  'could',
  'from',
  'have',
  'into',
  'just',
  'like',
  'more',
  'need',
  'only',
  'over',
  'please',
  'that',
  'their',
  'then',
  'there',
  'this',
  'through',
  'with',
  'would',
  'your',
]);

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeBoundedUnit(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}

function stableHash(parts: readonly string[]): string {
  return createHash('sha256')
    .update(parts.join('\u001f'))
    .digest('hex')
    .slice(0, 24);
}

function stableId(prefix: string, parts: readonly string[]): string {
  return `${prefix}:${stableHash(parts)}`;
}

function toIso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function toUtcDay(timestamp: number): string {
  return toIso(timestamp).slice(0, 10);
}

function isCanonicalIsoInstant(value: string): boolean {
  return ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function normalizeContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function isConversational(entry: SessionEntry): boolean {
  return (entry.role === 'user' || entry.role === 'assistant') && normalizeContent(entry.content).length > 0;
}

function getTurnId(entry: SessionEntry): string {
  try {
    return resolveSessionEntryTurnContext(entry).turnId;
  } catch {
    return `session-entry:${entry.channelId}:${entry.id}`;
  }
}

/**
 * Deterministic per-source-message claim key. One live episode may hold the
 * active claim for a key; synthesis drops claimed messages from its input.
 */
export function sessionEntryClaimKey(entry: Pick<SessionEntry, 'channelId' | 'id'>): string {
  return `l0-message:${entry.channelId}:${entry.id}`;
}

function getEntryFingerprint(entry: SessionEntry): string {
  return stableHash([
    entry.channelId,
    String(entry.id),
    String(entry.timestamp),
    entry.role,
    normalizeContent(entry.content).slice(0, 240),
  ]);
}

function compareEntries(left: SessionEntry, right: SessionEntry): number {
  if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
  if (left.channelId !== right.channelId) return left.channelId.localeCompare(right.channelId);
  return left.id - right.id;
}

function groupEntries(
  entries: readonly SessionEntry[],
  options: {
    gapSplitMs: number;
    maxEntriesPerEpisode: number;
    minConversationalEntries: number;
    minSingleEntryChars: number;
  },
): EpisodeGroup[] {
  const groups: EpisodeGroup[] = [];
  let current: SessionEntry[] = [];

  for (const entry of entries) {
    const previous = current.at(-1);
    const startsNewGroup = previous
      && (
        toUtcDay(previous.timestamp) !== toUtcDay(entry.timestamp)
        || entry.timestamp - previous.timestamp >= options.gapSplitMs
        || current.length >= options.maxEntriesPerEpisode
      );

    if (startsNewGroup && current.length > 0) {
      groups.push({ entries: current });
      current = [];
    }
    current.push(entry);
  }

  if (current.length > 0) {
    groups.push({ entries: current });
  }

  return groups.filter(group => isSalientGroup(group.entries, options));
}

function isSalientGroup(
  entries: readonly SessionEntry[],
  minimums: { minConversationalEntries: number; minSingleEntryChars: number },
): boolean {
  if (entries.length >= minimums.minConversationalEntries) {
    return true;
  }
  const totalChars = entries.reduce((sum, entry) => sum + normalizeContent(entry.content).length, 0);
  return totalChars >= minimums.minSingleEntryChars;
}

function extractWords(entries: readonly SessionEntry[]): string[] {
  return entries
    .flatMap(entry => normalizeContent(entry.content).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [])
    .filter(word => !STOP_WORDS.has(word));
}

function inferThemes(entries: readonly SessionEntry[]): string[] {
  const scores = new Map<string, number>();
  for (const word of extractWords(entries)) {
    scores.set(word, (scores.get(word) ?? 0) + 1);
  }

  const ranked: ThemeScore[] = [...scores.entries()]
    .map(([theme, score]) => ({ theme, score }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.theme.localeCompare(right.theme);
    });

  const themes = ranked.slice(0, 5).map(entry => entry.theme);
  return themes.length > 0 ? themes : ['conversation'];
}

function summarizeTitle(entries: readonly SessionEntry[], themes: readonly string[]): string {
  const firstUserEntry = entries.find(entry => entry.role === 'user') ?? entries[0];
  const text = normalizeContent(firstUserEntry.content);
  if (text.length > 0) {
    const clipped = text.length > 72 ? `${text.slice(0, 69)}...` : text;
    return clipped;
  }
  return `Conversation about ${themes.slice(0, 2).join(' and ')}`;
}

function summarizeLandmark(entries: readonly SessionEntry[], themes: readonly string[]): string {
  if (entries.length === 0) {
    throw new Error('Cannot summarize an empty episode group');
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  const userTurns = entries.filter(entry => entry.role === 'user').length;
  const assistantTurns = entries.filter(entry => entry.role === 'assistant').length;
  return [
    `A ${entries.length}-message exchange`,
    `with ${userTurns} user turn${userTurns === 1 ? '' : 's'}`,
    `and ${assistantTurns} assistant turn${assistantTurns === 1 ? '' : 's'}`,
    `around ${themes.slice(0, 3).join(', ')}`,
    `from ${toIso(first.timestamp)}`,
    `to ${toIso(last.timestamp)}.`,
  ].join(' ');
}

function inferSalience(entries: readonly SessionEntry[], themes: readonly string[]): EpisodeSalience {
  const totalChars = entries.reduce((sum, entry) => sum + normalizeContent(entry.content).length, 0);
  const userTurns = entries.filter(entry => entry.role === 'user').length;
  const score = normalizeBoundedUnit(0.35 + Math.min(0.3, entries.length / 40) + Math.min(0.2, totalChars / 4000));
  const novelty = normalizeBoundedUnit(Math.min(0.85, themes.length / 8 + userTurns / 30));
  return {
    score,
    novelty,
    emotionalIntensity: inferEmotionalIntensity(entries),
  };
}

function inferEmotionalIntensity(entries: readonly SessionEntry[]): number {
  const text = entries.map(entry => entry.content).join(' ').toLowerCase();
  const markers = ['!', 'urgent', 'blocked', 'worried', 'excited', 'frustrated', 'love', 'hate'];
  const hits = markers.reduce((count, marker) => count + (text.includes(marker) ? 1 : 0), 0);
  return normalizeBoundedUnit(Math.min(0.8, 0.1 + hits * 0.12));
}

function inferAffect(entries: readonly SessionEntry[]): EpisodeAffect {
  const text = entries.map(entry => entry.content).join(' ').toLowerCase();
  const labels = new Set<string>();
  let valence = 0;

  if (/\b(thanks|great|good|love|excited|excellent)\b/.test(text)) {
    labels.add('positive');
    valence += 0.25;
  }
  if (/\b(blocked|worry|worried|bad|hate|frustrated|issue|bug)\b/.test(text)) {
    labels.add('concerned');
    valence -= 0.25;
  }
  if (/\b(plan|implement|debug|fix|ship|test|review)\b/.test(text)) {
    labels.add('focused');
  }

  return {
    valence: normalizeBoundedUnit((valence + 1) / 2) * 2 - 1,
    arousal: inferEmotionalIntensity(entries),
    dominance: 0.5,
    labels: labels.size > 0 ? [...labels].sort() : ['neutral'],
  };
}

function buildSpanRef(sessionId: string, entries: readonly SessionEntry[]): EpisodeSpanRef {
  if (entries.length === 0) {
    throw new Error('Cannot build an episode span for an empty group');
  }
  const first = entries[0];
  const last = entries[entries.length - 1];
  return {
    spanId: stableId('l0-session-span', [
      sessionId,
      String(first.id),
      String(last.id),
      String(first.timestamp),
      String(last.timestamp),
    ]),
    channelId: first.channelId,
    sessionId,
    startTurnId: getTurnId(first),
    endTurnId: getTurnId(last),
    startedAt: toIso(first.timestamp),
    endedAt: toIso(last.timestamp),
  };
}

function parseMetadataRecord(entry: SessionEntry): Record<string, unknown> | null {
  if (!entry.metadata) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.metadata) as unknown;
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function metadataString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function buildProvenanceRefs(
  sessionId: string,
  spanRef: EpisodeSpanRef,
  entries: readonly SessionEntry[],
): EpisodeProvenanceRef[] {
  const provenance = new Map<string, EpisodeProvenanceRef>();
  provenance.set(`l0_span:${spanRef.spanId}`, { kind: 'l0_span', refId: spanRef.spanId });
  provenance.set(`session:${sessionId}`, { kind: 'session', refId: sessionId });

  for (const entry of entries.slice(0, 12)) {
    const turnId = getTurnId(entry);
    provenance.set(`turn:${turnId}`, { kind: 'turn', refId: turnId });
    const metadata = parseMetadataRecord(entry);
    if (!metadata) continue;
    const operatorNoteId = metadataString(metadata, [
      'operatorNoteId',
      'operator_note_id',
      'operatorNoteRef',
      'operator_note_ref',
    ]);
    if (operatorNoteId) {
      provenance.set(`operator_note:${operatorNoteId}`, {
        kind: 'operator_note',
        refId: operatorNoteId,
      });
    }
  }

  return [...provenance.values()];
}

function buildEpisodeInput(
  sessionId: string,
  group: EpisodeGroup,
): EpisodeCandidateInput {
  const entries = group.entries;
  if (entries.length === 0) {
    throw new Error('Cannot synthesize an empty episode group');
  }
  const first = entries[0];
  const last = entries[entries.length - 1];

  const themes = inferThemes(entries);
  const spanRef = buildSpanRef(sessionId, entries);
  const id = stableId('episode', [
    sessionId,
    spanRef.spanId,
    ...entries.map(getEntryFingerprint),
  ]);

  return {
    id,
    title: summarizeTitle(entries, themes),
    landmark: summarizeLandmark(entries, themes),
    startedAt: toIso(first.timestamp),
    endedAt: toIso(last.timestamp),
    threadId: sessionId,
    channelId: first.channelId,
    participantContactIds: [...new Set(entries
      .map(entry => entry.authorId)
      .filter((authorId): authorId is string => typeof authorId === 'string' && authorId.trim().length > 0))].sort(),
    salience: inferSalience(entries, themes),
    affect: inferAffect(entries),
    themes,
    spanRefs: [spanRef],
    artifactRefs: inferArtifactRefs(entries),
    provenanceRefs: buildProvenanceRefs(sessionId, spanRef, entries),
  };
}

function inferArtifactRefs(entries: readonly SessionEntry[]): EpisodeArtifactRef[] {
  const refs = new Map<string, EpisodeArtifactRef>();
  for (const entry of entries) {
    const parsed = parseMetadataRecord(entry);
    if (!parsed) continue;
    const artifacts = (parsed as { artifacts?: unknown }).artifacts;
    if (!Array.isArray(artifacts)) continue;
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue;
      const record = artifact as Record<string, unknown>;
      const artifactId = typeof record.artifactId === 'string'
        ? record.artifactId.trim()
        : typeof record.id === 'string'
          ? record.id.trim()
          : '';
      if (!artifactId) continue;
      refs.set(artifactId, {
        artifactId,
        ...(typeof record.artifactType === 'string' && record.artifactType.trim()
          ? { artifactType: record.artifactType.trim() }
          : {}),
        ...(typeof record.uri === 'string' && record.uri.trim() ? { uri: record.uri.trim() } : {}),
        ...(typeof record.path === 'string' && record.path.trim() ? { path: record.path.trim() } : {}),
        ...(typeof record.createdAt === 'string' && isCanonicalIsoInstant(record.createdAt.trim())
          ? { createdAt: record.createdAt.trim() }
          : {}),
      });
    }
  }
  return [...refs.values()];
}

function themeOverlap(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.reduce((count, theme) => count + (rightSet.has(theme) ? 1 : 0), 0);
}

function mergeStringSets(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

function stringArrayFromRecord(
  record: Record<string, unknown> | undefined,
  key: string,
): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function mergeByKey<T>(left: readonly T[], right: readonly T[], keyFor: (value: T) => string): T[] {
  const values = new Map<string, T>();
  for (const value of [...left, ...right]) {
    const key = keyFor(value);
    if (!values.has(key)) values.set(key, value);
  }
  return [...values.values()];
}

function spanTimeRange(
  span: EpisodeSpanRef,
  fallbackStartedAt: string,
  fallbackEndedAt: string,
): { startedAt: number; endedAt: number } {
  return {
    startedAt: Date.parse(span.startedAt ?? fallbackStartedAt),
    endedAt: Date.parse(span.endedAt ?? fallbackEndedAt),
  };
}

function intervalOverlapRatio(
  left: { startedAt: number; endedAt: number },
  right: { startedAt: number; endedAt: number },
): number {
  const overlapMs = Math.max(0, Math.min(left.endedAt, right.endedAt) - Math.max(left.startedAt, right.startedAt));
  const leftDurationMs = Math.max(0, left.endedAt - left.startedAt);
  const rightDurationMs = Math.max(0, right.endedAt - right.startedAt);
  const smallerDurationMs = Math.min(leftDurationMs, rightDurationMs);

  if (smallerDurationMs === 0) {
    const leftInsideRight = left.startedAt >= right.startedAt && left.startedAt <= right.endedAt;
    const rightInsideLeft = right.startedAt >= left.startedAt && right.startedAt <= left.endedAt;
    return leftInsideRight || rightInsideLeft ? 1 : 0;
  }

  return normalizeBoundedUnit(overlapMs / smallerDurationMs);
}

function spanOverlapRatio(candidate: EpisodeCandidateInput, episode: Episode): number {
  let best = 0;
  for (const candidateSpan of candidate.spanRefs) {
    const candidateRange = spanTimeRange(candidateSpan, candidate.startedAt, candidate.endedAt);
    for (const episodeSpan of episode.spanRefs) {
      best = Math.max(
        best,
        intervalOverlapRatio(candidateRange, spanTimeRange(episodeSpan, episode.startedAt, episode.endedAt)),
      );
    }
  }
  return best;
}

function timeGapMs(candidate: EpisodeCandidateInput, episode: Episode): number {
  const candidateStart = Date.parse(candidate.startedAt);
  const candidateEnd = Date.parse(candidate.endedAt);
  const episodeStart = Date.parse(episode.startedAt);
  const episodeEnd = Date.parse(episode.endedAt);
  if (candidateStart <= episodeEnd && episodeStart <= candidateEnd) {
    return 0;
  }
  return candidateStart > episodeEnd ? candidateStart - episodeEnd : episodeStart - candidateEnd;
}

function hasTurnBoundaryOverlap(candidate: EpisodeCandidateInput, episode: Episode): boolean {
  const candidateBoundaries = new Set(candidate.spanRefs.flatMap(span => [
    span.startTurnId,
    span.endTurnId,
  ].filter((turnId): turnId is string => typeof turnId === 'string' && turnId.length > 0)));

  return episode.spanRefs.some(span => (
    (span.startTurnId !== undefined && candidateBoundaries.has(span.startTurnId))
    || (span.endTurnId !== undefined && candidateBoundaries.has(span.endTurnId))
  ));
}

function artifactOverlap(left: readonly EpisodeArtifactRef[], right: readonly EpisodeArtifactRef[]): number {
  const rightIds = new Set(right.map(ref => ref.artifactId));
  return left.reduce((count, ref) => count + (rightIds.has(ref.artifactId) ? 1 : 0), 0);
}

function hasMatchingScope(candidate: EpisodeCandidateInput, episode: Episode): boolean {
  const candidateSessionIds = new Set(candidate.spanRefs
    .map(span => span.sessionId)
    .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0));
  const episodeSessionMatches = episode.spanRefs.some(span => (
    span.sessionId !== undefined && candidateSessionIds.has(span.sessionId)
  ));
  const threadMatches = candidate.threadId !== undefined && episode.threadId === candidate.threadId;
  const channelMatches = candidate.channelId !== undefined && (
    episode.channelId === candidate.channelId
    || episode.spanRefs.some(span => span.channelId === candidate.channelId)
  );

  return channelMatches && (threadMatches || episodeSessionMatches);
}

function scoreConsolidationCandidate(
  candidate: EpisodeCandidateInput,
  episode: Episode,
): ConsolidationCandidateScore | null {
  if (!hasMatchingScope(candidate, episode)) return null;
  const score: ConsolidationCandidateScore = {
    episode,
    spanOverlapRatio: spanOverlapRatio(candidate, episode),
    themeOverlap: themeOverlap(candidate.themes, episode.themes),
    artifactOverlap: artifactOverlap(candidate.artifactRefs, episode.artifactRefs),
    turnBoundaryOverlap: hasTurnBoundaryOverlap(candidate, episode),
    timeGapMs: timeGapMs(candidate, episode),
  };
  const hasSemanticOverlap = score.themeOverlap >= MIN_CONSOLIDATION_THEME_OVERLAP || score.artifactOverlap > 0;
  const hasSpanOverlap = score.spanOverlapRatio >= MIN_CONSOLIDATION_SPAN_OVERLAP_RATIO
    || (
      score.turnBoundaryOverlap
      && score.timeGapMs <= MAX_CONSOLIDATION_BOUNDARY_GAP_MS
    );
  return hasSemanticOverlap && hasSpanOverlap ? score : null;
}

function mergeEpisodeWithCandidate(
  canonical: Episode,
  candidate: EpisodeCandidateInput,
): EpisodeUpdateInput {
  return {
    id: canonical.id,
    title: canonical.title,
    landmark: canonical.landmark,
    startedAt: canonical.startedAt <= candidate.startedAt ? canonical.startedAt : candidate.startedAt,
    endedAt: canonical.endedAt >= candidate.endedAt ? canonical.endedAt : candidate.endedAt,
    threadId: canonical.threadId ?? candidate.threadId,
    channelId: canonical.channelId ?? candidate.channelId,
    participantContactIds: mergeStringSets(canonical.participantContactIds, candidate.participantContactIds),
    salience: {
      score: Math.max(canonical.salience.score, candidate.salience.score),
      novelty: Math.max(canonical.salience.novelty ?? 0, candidate.salience.novelty ?? 0),
      emotionalIntensity: Math.max(
        canonical.salience.emotionalIntensity ?? 0,
        candidate.salience.emotionalIntensity ?? 0,
      ),
    },
    affect: {
      ...canonical.affect,
      arousal: Math.max(canonical.affect.arousal ?? 0, candidate.affect.arousal ?? 0),
      labels: mergeStringSets(canonical.affect.labels, candidate.affect.labels),
    },
    themes: mergeStringSets(canonical.themes, candidate.themes),
    spanRefs: mergeByKey(canonical.spanRefs, candidate.spanRefs, ref => ref.spanId),
    artifactRefs: mergeByKey(canonical.artifactRefs, candidate.artifactRefs, ref => ref.artifactId),
    provenanceRefs: mergeByKey(
      canonical.provenanceRefs,
      candidate.provenanceRefs,
      ref => `${ref.kind}:${ref.refId}:${ref.note ?? ''}`,
    ),
  };
}

function compareConsolidationScores(left: ConsolidationCandidateScore, right: ConsolidationCandidateScore): number {
  if (right.spanOverlapRatio !== left.spanOverlapRatio) return right.spanOverlapRatio - left.spanOverlapRatio;
  if (right.themeOverlap !== left.themeOverlap) return right.themeOverlap - left.themeOverlap;
  if (right.artifactOverlap !== left.artifactOverlap) return right.artifactOverlap - left.artifactOverlap;
  if (left.turnBoundaryOverlap !== right.turnBoundaryOverlap) return left.turnBoundaryOverlap ? -1 : 1;
  if (left.timeGapMs !== right.timeGapMs) return left.timeGapMs - right.timeGapMs;
  return right.episode.startedAt.localeCompare(left.episode.startedAt) || left.episode.id.localeCompare(right.episode.id);
}

function episodeEvidenceText(episode: Episode): string {
  return [
    episode.title,
    episode.landmark,
    ...episode.themes,
    ...episode.affect.labels,
  ].join(' ').toLowerCase();
}

function hasOperatorEvidence(episode: Episode): boolean {
  return episode.provenanceRefs.some(ref => ref.kind === 'operator_note')
    || episode.themes.some(theme => /\boperator(?:[-_ ]defined)?\b/i.test(theme));
}

function classifyArcKind(source: Episode, target: Episode, overlap: number): EpisodeArcWriteInput['arcKind'] {
  const targetText = episodeEvidenceText(target);
  const combinedText = `${episodeEvidenceText(source)} ${targetText}`;
  if (hasOperatorEvidence(source) || hasOperatorEvidence(target)) {
    return 'operator_defined';
  }
  if (/\b(resolved|resolution|fixed|completed|closed|done|finali[sz]ed|shipped|settled|unblocked)\b/.test(targetText)) {
    return 'resolution';
  }
  if (/\b(because|caused|causal|led to|resulted in|triggered|due to|as a result|blocked by|unblocked by)\b/.test(targetText)) {
    return 'causal';
  }
  if (/\b(contrast|different|changed|no longer|instead|opposite|reversed|formerly|moved from|moved to)\b/.test(combinedText)) {
    return 'contrast';
  }
  if (/\b(again|recurr|repeat|same issue|same pattern|returned|routine)\b/.test(targetText)) {
    return 'recurrence';
  }
  if (
    (source.threadId !== undefined && source.threadId === target.threadId)
    || /\b(continue|continuation|follow[- ]?up|update|checkpoint|next step|final pass|back to)\b/.test(targetText)
  ) {
    return 'continuation';
  }
  return overlap > 0 ? 'same_theme' : 'continuation';
}

function arcConfidence(kind: EpisodeArcWriteInput['arcKind'], overlap: number): number {
  const baseByKind: Record<EpisodeArcWriteInput['arcKind'], number> = {
    causal: 0.74,
    continuation: 0.68,
    contrast: 0.7,
    operator_defined: 0.82,
    recurrence: 0.7,
    resolution: 0.76,
    same_theme: 0.55,
  };
  return normalizeBoundedUnit(Math.min(0.95, baseByKind[kind] + Math.min(0.16, overlap * 0.04)));
}

function buildArcInput(source: Episode, target: Episode, overlap: number): EpisodeArcWriteInput {
  const sharedThemes = source.themes.filter(theme => target.themes.includes(theme));
  const themes = sharedThemes.length > 0 ? sharedThemes : target.themes.slice(0, 3);
  const arcKind = classifyArcKind(source, target, overlap);
  return {
    id: stableId('episode-arc', [source.id, target.id, themes.join('|')]),
    sourceEpisodeId: source.id,
    targetEpisodeId: target.id,
    arcKind,
    salience: normalizeBoundedUnit(Math.max(0.35, Math.min(source.salience.score, target.salience.score))),
    confidence: arcConfidence(arcKind, overlap),
    themes,
    spanRefs: target.spanRefs,
    artifactRefs: target.artifactRefs,
    provenanceRefs: target.provenanceRefs,
  };
}

function findRelatedSource(
  target: Episode,
  candidates: readonly Episode[],
): { episode: Episode; overlap: number } | null {
  let best: { episode: Episode; overlap: number; distanceMs: number } | null = null;
  const targetStart = Date.parse(target.startedAt);

  for (const candidate of candidates) {
    if (candidate.id === target.id || candidate.startedAt > target.startedAt) continue;
    const overlap = themeOverlap(candidate.themes, target.themes);
    const sameThread = candidate.threadId !== undefined && candidate.threadId === target.threadId;
    if (overlap < MIN_RELATED_THEME_OVERLAP && !sameThread) continue;

    const distanceMs = Math.max(0, targetStart - Date.parse(candidate.endedAt));
    if (
      !best
      || overlap > best.overlap
      || (overlap === best.overlap && distanceMs < best.distanceMs)
    ) {
      best = { episode: candidate, overlap, distanceMs };
    }
  }

  return best ? { episode: best.episode, overlap: best.overlap } : null;
}

export class EpisodicSynthesizer {
  private readonly store: Pick<
    EpisodicStorePort,
    | 'createEpisode'
    | 'updateEpisode'
    | 'getEpisode'
    | 'searchByTime'
    | 'writeEpisodeArc'
    | 'getProcessingWatermark'
    | 'upsertProcessingWatermark'
    | 'writeEpisodeCandidateDecision'
    | 'writeEpisodeLineage'
    | 'claimEpisodeMessages'
    | 'listEpisodeMessageClaims'
  >;
  private readonly sessionReader: EpisodicSynthesisSessionReader;
  private readonly transcriptMessageLimit: number;
  private readonly maxEpisodesPerRun: number;
  private readonly maxPriorCandidates: number;
  private readonly gapSplitMs: number;
  private readonly maxEntriesPerEpisode: number;
  private readonly minConversationalEntries: number;
  private readonly minSingleEntryChars: number;
  private readonly segmentationEnabled: boolean;
  private readonly segmentationProvider: Pick<LLMProviderPort, 'complete'> | null;
  private readonly segmentationPersonaPreamble: PersonaPreamblePort | null;
  private readonly onSegmentationEvent?: (event: EpisodeSegmentationEvent) => void;
  private readonly segmentationNow: () => number;
  private readonly processingWatermarks = new Map<string, EpisodicSynthesisProcessingWatermark>();

  constructor(
    store: Pick<
      EpisodicStorePort,
      | 'createEpisode'
      | 'updateEpisode'
      | 'getEpisode'
      | 'searchByTime'
      | 'writeEpisodeArc'
      | 'getProcessingWatermark'
      | 'upsertProcessingWatermark'
      | 'writeEpisodeCandidateDecision'
      | 'writeEpisodeLineage'
      | 'claimEpisodeMessages'
      | 'listEpisodeMessageClaims'
    >,
    sessionReader: EpisodicSynthesisSessionReader,
    options: EpisodicSynthesisOptions = {},
  ) {
    this.store = store;
    this.sessionReader = sessionReader;
    this.transcriptMessageLimit = normalizePositiveInteger(
      options.transcriptMessageLimit,
      DEFAULT_TRANSCRIPT_MESSAGE_LIMIT,
    );
    this.maxEpisodesPerRun = normalizePositiveInteger(options.maxEpisodesPerRun, DEFAULT_MAX_EPISODES_PER_RUN);
    this.maxPriorCandidates = normalizePositiveInteger(options.maxPriorCandidates, DEFAULT_MAX_PRIOR_CANDIDATES);
    this.gapSplitMs = normalizePositiveInteger(options.gapSplitMinutes, DEFAULT_GAP_SPLIT_MINUTES) * MINUTE_MS;
    this.maxEntriesPerEpisode = normalizePositiveInteger(
      options.maxEntriesPerEpisode,
      DEFAULT_MAX_ENTRIES_PER_EPISODE,
    );
    this.minConversationalEntries = normalizePositiveInteger(
      options.minConversationalEntries,
      MIN_CONVERSATIONAL_ENTRIES,
    );
    this.minSingleEntryChars = normalizePositiveInteger(
      options.minSingleEntryChars,
      MIN_SINGLE_ENTRY_CHARS,
    );
    const segmentation = options.topicSegmentation;
    this.segmentationEnabled = segmentation?.enabled === true;
    this.segmentationProvider = segmentation?.llmProvider ?? null;
    this.segmentationPersonaPreamble = segmentation?.personaPreamble ?? null;
    if (this.segmentationEnabled && !this.segmentationProvider) {
      // Fail closed at composition time: an enabled flag without a provider
      // must never silently degrade to deterministic-only cutting.
      throw new Error(
        'EpisodicSynthesizer topic segmentation is enabled but no LLM provider was supplied',
      );
    }
    if (segmentation?.onEvent) {
      this.onSegmentationEvent = segmentation.onEvent;
    }
    this.segmentationNow = segmentation?.now ?? (() => Date.now());
  }

  getProcessingWatermark(
    scope: EpisodicSynthesisWatermarkScope,
  ): EpisodicSynthesisProcessingWatermark | undefined {
    const watermark = this.processingWatermarks.get(this.watermarkKey(scope));
    return watermark
      ? {
        ...watermark,
        canonicalEpisodeIds: [...watermark.canonicalEpisodeIds],
        skippedEpisodeIds: [...watermark.skippedEpisodeIds],
      }
      : undefined;
  }

  async run(input: EpisodicSynthesisRunInput): Promise<EpisodicSynthesisRunResult> {
    const rawEntries = this.sessionReader
      .getRecentMessages(input.sessionId, this.transcriptMessageLimit)
      .filter(isConversational)
      .sort(compareEntries);
    const watermarkScope = this.buildProcessingWatermarkScope(input, rawEntries[0]?.channelId ?? input.sessionId);
    const durableWatermark = await this.store.getProcessingWatermark(watermarkScope);
    if (durableWatermark) this.rememberProcessingWatermark(durableWatermark);

    const lookbackEntries = this.applyWatermarkLookback(rawEntries, durableWatermark);
    // Hard claim rule: a message actively claimed by any episode can never
    // enter a new episode from this daytime synthesis path.
    const entries = await this.filterClaimedEntries(lookbackEntries);
    const claimedEntriesSkipped = lookbackEntries.length - entries.length;

    const salientGroups = groupEntries(entries, {
      gapSplitMs: this.gapSplitMs,
      maxEntriesPerEpisode: this.maxEntriesPerEpisode,
      minConversationalEntries: this.minConversationalEntries,
      minSingleEntryChars: this.minSingleEntryChars,
    });
    const state: SynthesisRunState = {
      durableWatermark,
      createdEpisodes: [],
      skippedEpisodeIds: [],
      linkedArcs: [],
      candidatesProcessed: 0,
    };
    let candidateEpisodeCount: number;
    let heldBackEntryCount = 0;
    let segmentationFailedChunkCount = 0;

    if (this.segmentationEnabled) {
      const outcome = await this.runSegmentedGroups(input, salientGroups, state);
      candidateEpisodeCount = outcome.candidateEpisodeCount;
      heldBackEntryCount = outcome.heldBackEntryCount;
      segmentationFailedChunkCount = outcome.segmentationFailedChunkCount;
    } else {
      const groups = salientGroups.slice(-this.maxEpisodesPerRun);
      candidateEpisodeCount = groups.length;
      for (const group of groups) {
        await this.processCandidateGroup(input, group, state);
      }
    }

    return {
      consideredEntries: entries.length,
      claimedEntriesSkipped,
      candidateEpisodeCount,
      createdEpisodes: state.createdEpisodes,
      skippedEpisodeIds: state.skippedEpisodeIds,
      linkedArcs: state.linkedArcs,
      heldBackEntryCount,
      segmentationFailedChunkCount,
    };
  }

  /**
   * Contextual topic cutting (E5.4). Deterministic chunk bounds stay the
   * outer limits; within each gated chunk the LLM proposes contiguous topic
   * segments. Chunks process oldest-first under the maxEpisodesPerRun budget;
   * anything not processed stays unclaimed with the watermark behind it, so
   * it remains visible to the next pass.
   */
  private async runSegmentedGroups(
    input: EpisodicSynthesisRunInput,
    groups: readonly EpisodeGroup[],
    state: SynthesisRunState,
  ): Promise<SegmentationRunOutcome> {
    if (!this.segmentationProvider) {
      throw new Error('EpisodicSynthesizer topic segmentation ran without an LLM provider');
    }
    let heldBackEntryCount = 0;
    let candidateEpisodeCount = 0;

    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      if (state.candidatesProcessed >= this.maxEpisodesPerRun) break;
      const group = groups[groupIndex];
      const isFinalGroup = groupIndex === groups.length - 1;
      const channelId = group.entries[0].channelId;

      let segments: TopicSegment[];
      try {
        segments = await proposeTopicSegments(this.segmentationProvider, {
          sessionId: input.sessionId,
          channelId,
          entries: group.entries,
        }, this.segmentationPersonaPreamble);
      } catch (error) {
        // Fail closed: no episode is written for this chunk, nothing from it
        // is claimed, and the run stops so the watermark never advances past
        // the chunk — its turns stay visible to the next pass.
        const message = error instanceof Error ? error.message : String(error);
        this.emitSegmentationEvent({
          sessionId: input.sessionId,
          channelId,
          outcome: 'failed',
          chunkEntryCount: group.entries.length,
          segmentCount: 0,
          heldBackEntryCount: 0,
          error: message,
        });
        log.warn('Topic segmentation failed closed; chunk left for the next pass', {
          sessionId: input.sessionId,
          channelId,
          chunkEntryCount: group.entries.length,
          error: message,
        });
        return { heldBackEntryCount, segmentationFailedChunkCount: 1, candidateEpisodeCount };
      }

      let heldForChunk = 0;
      const segmentGroups: EpisodeGroup[] = [];
      for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
        const segment = segments[segmentIndex];
        const segmentEntries = group.entries.slice(segment.startIndex, segment.endIndex + 1);
        const isTrailingOpenTopic = isFinalGroup
          && segmentIndex === segments.length - 1
          && segment.status === 'open';
        if (isTrailingOpenTopic) {
          // Trailing holdback: the unfinished topic's turns are neither
          // claimed nor episodized; they roll into the next pass and join
          // the next episode if the topic continues. A deterministic bound
          // after a non-final chunk already closes its trailing topic.
          heldForChunk = segmentEntries.length;
          continue;
        }
        segmentGroups.push({ entries: segmentEntries });
      }
      heldBackEntryCount += heldForChunk;
      this.emitSegmentationEvent({
        sessionId: input.sessionId,
        channelId,
        outcome: 'segmented',
        chunkEntryCount: group.entries.length,
        segmentCount: segments.length,
        heldBackEntryCount: heldForChunk,
      });

      for (const segmentGroup of segmentGroups) {
        if (state.candidatesProcessed >= this.maxEpisodesPerRun) break;
        const salient = isSalientGroup(segmentGroup.entries, {
          minConversationalEntries: this.minConversationalEntries,
          minSingleEntryChars: this.minSingleEntryChars,
        });
        if (!salient) continue;
        candidateEpisodeCount++;
        await this.processCandidateGroup(input, segmentGroup, state);
      }
    }

    return { heldBackEntryCount, segmentationFailedChunkCount: 0, candidateEpisodeCount };
  }

  private emitSegmentationEvent(event: Omit<EpisodeSegmentationEvent, 'timestamp'>): void {
    if (!this.onSegmentationEvent) return;
    this.onSegmentationEvent({ ...event, timestamp: this.segmentationNow() });
  }

  private async processCandidateGroup(
    input: EpisodicSynthesisRunInput,
    group: EpisodeGroup,
    state: SynthesisRunState,
  ): Promise<void> {
    state.candidatesProcessed++;
    const episodeInput = buildEpisodeInput(input.sessionId, group);
    const claims = group.entries.map(entry => ({
      claimKey: sessionEntryClaimKey(entry),
      turnId: getTurnId(entry),
      channelId: entry.channelId,
    }));
    const existing = await this.store.getEpisode(episodeInput.id);

    // Resolve which episode this candidate lands on BEFORE mutating store state,
    // then verify its source-message claims are available. A claim conflict must
    // abort the run without having created or extended an episode (mlwk.49);
    // otherwise a conflict leaves duplicate/extended episode state behind. New
    // episodes cannot be claimed before they exist (claims FK-reference the
    // episode), so this pre-check guards the mutation and the authoritative
    // claim write runs after.
    const consolidationTarget = existing
      ? null
      : await this.resolveConsolidationTarget(episodeInput, state.createdEpisodes);
    const survivingEpisodeId = existing?.id ?? consolidationTarget?.episode.id ?? episodeInput.id;
    await this.assertGroupClaimsAvailable(survivingEpisodeId, claims);

    let episode: Episode;
    let created = false;
    let decision: CandidateDecisionResult;
    if (existing) {
      episode = existing;
      state.skippedEpisodeIds.push(existing.id);
      decision = {
        status: 'superseded',
        action: 'discard',
        reason: 'candidate span already covered by canonical episode id',
        canonicalEpisode: episode,
      };
    } else if (consolidationTarget) {
      episode = await this.store.updateEpisode(
        mergeEpisodeWithCandidate(consolidationTarget.episode, episodeInput),
      );
      const currentRunIndex = state.createdEpisodes.findIndex(candidate => candidate.id === episode.id);
      if (currentRunIndex >= 0) {
        state.createdEpisodes[currentRunIndex] = episode;
      }
      state.skippedEpisodeIds.push(episode.id);
      decision = {
        status: 'merged',
        action: 'extend',
        reason: 'candidate span deterministically overlapped an active canonical episode',
        canonicalEpisode: episode,
        sourceEpisode: consolidationTarget.episode,
        score: consolidationTarget,
      };
    } else {
      // Near-real-time output is a CANDIDATE until the nightly sleep
      // cycle consolidates or confirms it (m58.1).
      episode = await this.store.createEpisode({ ...episodeInput, lifecycleStatus: 'candidate' });
      created = true;
      state.createdEpisodes.push(episode);
      decision = {
        status: 'canonical',
        action: 'create',
        reason: 'candidate span did not match an active canonical episode',
        canonicalEpisode: episode,
      };
    }

    // Authoritative claim for the surviving episode before recording downstream
    // artifacts; the pre-check above keeps a conflict from persisting a
    // created/extended episode.
    await this.store.claimEpisodeMessages({
      episodeId: episode.id,
      sessionId: input.sessionId,
      claims,
    });

    const candidateDecision = await this.persistCandidateDecisionAndWatermark(
      input,
      episodeInput,
      decision,
      state.durableWatermark,
    );
    state.durableWatermark = await this.updateWatermarkDecisionArtifacts(
      input,
      episodeInput,
      decision,
      state.durableWatermark,
      candidateDecision,
    );

    if (created) {
      const priorCandidates = await this.resolvePriorCandidates(episode, state.createdEpisodes);
      const related = findRelatedSource(episode, priorCandidates);
      if (!related) return;
      state.linkedArcs.push(await this.store.writeEpisodeArc(
        buildArcInput(related.episode, episode, related.overlap),
      ));
      await this.store.writeEpisodeLineage({
        id: stableId('episode-lineage', [related.episode.id, episode.id, candidateDecision.id]),
        sourceEpisodeId: related.episode.id,
        targetEpisodeId: episode.id,
        relation: 'derived_from',
        confidence: normalizeBoundedUnit(Math.max(0.45, Math.min(0.9, 0.55 + related.overlap * 0.1))),
        reason: 'new canonical episode linked to a related prior episode during synthesis',
        sourceRef: candidateDecision.id,
        provenanceRefs: episode.provenanceRefs,
        lineageJson: {
          schemaVersion: 1,
          candidateDecisionId: candidateDecision.id,
          relatedThemeOverlap: related.overlap,
        },
      });
    }
  }

  private async assertGroupClaimsAvailable(
    episodeId: string,
    claims: readonly { claimKey: string }[],
  ): Promise<void> {
    const claimKeys = claims.map(claim => claim.claimKey);
    for (let offset = 0; offset < claimKeys.length; offset += CLAIM_LOOKUP_CHUNK_SIZE) {
      const chunk = claimKeys.slice(offset, offset + CLAIM_LOOKUP_CHUNK_SIZE);
      const active = await this.store.listEpisodeMessageClaims({
        claimKeys: chunk,
        status: 'active',
        limit: chunk.length,
      });
      const conflict = active.find(claim => claim.episodeId !== episodeId);
      if (conflict) {
        throw new Error(
          `source message "${conflict.claimKey}" is already claimed by episode "${conflict.episodeId}"; `
          + `refusing to mutate episode "${episodeId}"`,
        );
      }
    }
  }

  private async filterClaimedEntries(entries: readonly SessionEntry[]): Promise<SessionEntry[]> {
    if (entries.length === 0) return [];
    const claimedKeys = new Set<string>();
    const keys = entries.map(sessionEntryClaimKey);
    for (let offset = 0; offset < keys.length; offset += CLAIM_LOOKUP_CHUNK_SIZE) {
      const chunk = keys.slice(offset, offset + CLAIM_LOOKUP_CHUNK_SIZE);
      const claims = await this.store.listEpisodeMessageClaims({
        claimKeys: chunk,
        status: 'active',
        limit: chunk.length,
      });
      for (const claim of claims) {
        claimedKeys.add(claim.claimKey);
      }
    }
    return entries.filter(entry => !claimedKeys.has(sessionEntryClaimKey(entry)));
  }

  private async resolvePriorCandidates(
    episode: Episode,
    currentRunEpisodes: readonly Episode[],
  ): Promise<Episode[]> {
    const dayWindowMs = 30 * 24 * 60 * 60 * 1000;
    const to = episode.startedAt;
    const from = new Date(Math.max(0, Date.parse(to) - dayWindowMs)).toISOString();
    const persisted = await this.store.searchByTime({
      from,
      to,
      limit: this.maxPriorCandidates,
    });
    return [...persisted, ...currentRunEpisodes]
      .filter(candidate => candidate.id !== episode.id && candidate.startedAt <= episode.startedAt)
      .sort((left, right) => {
        const startedDiff = Date.parse(right.startedAt) - Date.parse(left.startedAt);
        if (startedDiff !== 0) return startedDiff;
        return left.id.localeCompare(right.id);
      })
      .slice(0, this.maxPriorCandidates);
  }

  private async resolveConsolidationTarget(
    candidate: EpisodeCandidateInput,
    currentRunEpisodes: readonly Episode[],
  ): Promise<ConsolidationCandidateScore | null> {
    const startedAtMs = Date.parse(candidate.startedAt);
    const endedAtMs = Date.parse(candidate.endedAt);
    const durationMs = Math.max(0, endedAtMs - startedAtMs);
    const searchWindowMs = Math.min(
      MAX_CONSOLIDATION_SEARCH_WINDOW_MS,
      Math.max(MIN_CONSOLIDATION_SEARCH_WINDOW_MS, durationMs * 2),
    );
    const persisted = await this.store.searchByTime({
      from: new Date(Math.max(0, startedAtMs - searchWindowMs)).toISOString(),
      to: new Date(endedAtMs + searchWindowMs).toISOString(),
      limit: this.maxPriorCandidates,
    });
    const seenEpisodeIds = new Set<string>();
    const scores: ConsolidationCandidateScore[] = [];

    for (const episode of [...persisted, ...currentRunEpisodes]) {
      if (episode.id === candidate.id || seenEpisodeIds.has(episode.id)) continue;
      seenEpisodeIds.add(episode.id);
      const score = scoreConsolidationCandidate(candidate, episode);
      if (score) scores.push(score);
    }

    return scores.sort(compareConsolidationScores)[0] ?? null;
  }

  private watermarkKey(scope: EpisodicSynthesisWatermarkScope): string {
    return [
      scope.sessionId,
      scope.threadId ?? '',
      scope.channelId ?? '',
    ].join('\u001f');
  }

  private buildProcessingWatermarkScope(
    runInput: EpisodicSynthesisRunInput,
    channelId: string,
  ): EpisodicProcessingWatermarkScope {
    return {
      processor: EPISODIC_SYNTHESIS_PROCESSOR,
      sourceRef: runInput.sessionId,
      channelId,
      threadId: runInput.sessionId,
      sessionId: runInput.sessionId,
    };
  }

  private applyWatermarkLookback(
    entries: readonly SessionEntry[],
    watermark: EpisodicProcessingWatermark | undefined,
  ): SessionEntry[] {
    if (!watermark?.processedEndedAt) return [...entries];
    const lookbackStart = Date.parse(watermark.processedEndedAt) - Math.max(this.gapSplitMs, WATERMARK_LOOKBACK_MS);
    return entries.filter(entry => entry.timestamp >= lookbackStart);
  }

  private rememberProcessingWatermark(watermark: EpisodicProcessingWatermark): void {
    const scope: EpisodicSynthesisWatermarkScope = {
      sessionId: watermark.sessionId ?? watermark.sourceRef,
      ...(watermark.threadId ? { threadId: watermark.threadId } : {}),
      ...(watermark.channelId ? { channelId: watermark.channelId } : {}),
    };
    this.processingWatermarks.set(this.watermarkKey(scope), {
      ...scope,
      ...(watermark.highWaterTurnId ? { highWaterTurnId: watermark.highWaterTurnId } : {}),
      ...(watermark.highWaterMessageId ? { highWaterMessageId: watermark.highWaterMessageId } : {}),
      processedStartedAt: watermark.processedStartedAt ?? watermark.updatedAt,
      processedEndedAt: watermark.processedEndedAt ?? watermark.updatedAt,
      updatedAt: watermark.updatedAt,
      canonicalEpisodeIds: stringArrayFromRecord(watermark.nextWatermarkJson, 'canonicalEpisodeIds'),
      skippedEpisodeIds: stringArrayFromRecord(watermark.nextWatermarkJson, 'skippedEpisodeIds'),
    });
  }

  private async persistCandidateDecisionAndWatermark(
    runInput: EpisodicSynthesisRunInput,
    candidate: EpisodeCandidateInput,
    decision: CandidateDecisionResult,
    previous: EpisodicProcessingWatermark | undefined,
  ): Promise<EpisodeCandidateDecision> {
    // Reserve the watermark row (needed as the decision's FK target) WITHOUT
    // advancing the processed span. If the decision write below fails, the
    // durable watermark must not mark this span processed, or a later run
    // would skip it after lookback (mlwk.8). The span is advanced only after
    // the decision persists, via updateWatermarkDecisionArtifacts.
    const watermark = await this.upsertWatermarkForDecision(runInput, candidate, decision, previous, undefined, 'reserve');
    const candidateDecision = await this.store.writeEpisodeCandidateDecision({
      id: stableId('episode-candidate-decision', [
        watermark.id,
        candidate.id,
        decision.action,
        decision.canonicalEpisode.id,
      ]),
      candidateEpisodeId: decision.action === 'extend' ? undefined : decision.canonicalEpisode.id,
      canonicalEpisodeId: decision.canonicalEpisode.id,
      mergedIntoEpisodeId: decision.action === 'extend' ? decision.canonicalEpisode.id : undefined,
      supersededByEpisodeId: decision.action === 'discard' ? decision.canonicalEpisode.id : undefined,
      sourceWatermarkId: watermark.id,
      status: decision.status,
      channelId: candidate.channelId,
      threadId: candidate.threadId,
      sessionId: runInput.sessionId,
      startedAt: candidate.startedAt,
      endedAt: candidate.endedAt,
      overlapScore: decision.score?.spanOverlapRatio,
      confidence: this.decisionConfidence(decision),
      reason: decision.reason,
      candidateJson: {
        schemaVersion: 1,
        candidateEpisode: candidate,
        decision: this.decisionJson(decision),
      },
      artifactRefs: candidate.artifactRefs,
      provenanceRefs: candidate.provenanceRefs,
    });
    return candidateDecision;
  }

  private async updateWatermarkDecisionArtifacts(
    runInput: EpisodicSynthesisRunInput,
    candidate: EpisodeCandidateInput,
    decision: CandidateDecisionResult,
    previous: EpisodicProcessingWatermark | undefined,
    candidateDecision: EpisodeCandidateDecision,
  ): Promise<EpisodicProcessingWatermark> {
    return this.upsertWatermarkForDecision(runInput, candidate, decision, previous, candidateDecision.id, 'commit');
  }

  private async upsertWatermarkForDecision(
    runInput: EpisodicSynthesisRunInput,
    candidate: EpisodeCandidateInput,
    decision: CandidateDecisionResult,
    previous: EpisodicProcessingWatermark | undefined,
    candidateDecisionId: string | undefined,
    phase: 'reserve' | 'commit',
  ): Promise<EpisodicProcessingWatermark> {
    const scope = this.buildProcessingWatermarkScope(runInput, candidate.channelId ?? runInput.sessionId);
    const previousCanonicalIds = stringArrayFromRecord(previous?.nextWatermarkJson, 'canonicalEpisodeIds');
    const previousSkippedIds = stringArrayFromRecord(previous?.nextWatermarkJson, 'skippedEpisodeIds');
    const previousDecisionIds = stringArrayFromRecord(previous?.artifactsJson, 'candidateDecisionIds');
    const skippedEpisodeIds = decision.action === 'create'
      ? previousSkippedIds
      : mergeStringSets(previousSkippedIds, [decision.canonicalEpisode.id]);
    const candidateDecisionIds = candidateDecisionId
      ? mergeStringSets(previousDecisionIds, [candidateDecisionId])
      : previousDecisionIds;
    const candidateSpan = candidate.spanRefs[0];
    // During the 'reserve' phase the row only needs to exist as the decision's
    // FK target; the processed span carries forward the previous watermark so a
    // failed decision write cannot mark this candidate's span processed. The
    // 'commit' phase (after the decision persists) advances the span.
    const advanceSpan = phase === 'commit';
    const processedStartedAt = advanceSpan
      ? (previous?.processedStartedAt && previous.processedStartedAt <= candidate.startedAt
        ? previous.processedStartedAt
        : candidate.startedAt)
      : previous?.processedStartedAt ?? candidate.startedAt;
    const processedEndedAt = advanceSpan
      ? (previous?.processedEndedAt && previous.processedEndedAt >= candidate.endedAt
        ? previous.processedEndedAt
        : candidate.endedAt)
      : previous?.processedEndedAt ?? candidate.startedAt;
    const lastProcessedAt = advanceSpan
      ? candidate.endedAt
      : previous?.lastProcessedAt ?? candidate.startedAt;
    const watermark = await this.store.upsertProcessingWatermark({
      id: stableId('l01-processing-watermark', [
        scope.processor,
        scope.sourceRef,
        scope.channelId ?? '',
        scope.threadId ?? '',
        scope.sessionId ?? '',
      ]),
      ...scope,
      highWaterTurnId: candidateSpan.endTurnId ?? previous?.highWaterTurnId,
      highWaterMessageId: runInput.sourceMessageId ?? previous?.highWaterMessageId,
      processedStartedAt,
      processedEndedAt,
      previousWatermarkJson: previous ? {
        id: previous.id,
        highWaterTurnId: previous.highWaterTurnId,
        highWaterMessageId: previous.highWaterMessageId,
        processedStartedAt: previous.processedStartedAt,
        processedEndedAt: previous.processedEndedAt,
      } : {},
      nextWatermarkJson: {
        schemaVersion: 1,
        highWaterTurnId: candidateSpan.endTurnId ?? previous?.highWaterTurnId,
        highWaterMessageId: runInput.sourceMessageId ?? previous?.highWaterMessageId,
        canonicalEpisodeIds: mergeStringSets(previousCanonicalIds, [decision.canonicalEpisode.id]),
        skippedEpisodeIds,
        lastDecision: this.decisionJson(decision),
      },
      status: 'active',
      reconciliationStatus: 'clean',
      artifactsJson: {
        schemaVersion: 1,
        candidateDecisionIds,
        ...(candidateDecisionId ? { lastCandidateDecisionId: candidateDecisionId } : {}),
      },
      lastProcessedAt,
      updatedAt: candidate.endedAt,
    });
    this.rememberProcessingWatermark(watermark);
    return watermark;
  }

  private decisionConfidence(decision: CandidateDecisionResult): number {
    if (!decision.score) return 1;
    return normalizeBoundedUnit(Math.max(
      0.55,
      Math.min(0.95, 0.45 + decision.score.spanOverlapRatio * 0.4 + decision.score.themeOverlap * 0.05),
    ));
  }

  private decisionJson(decision: CandidateDecisionResult): Record<string, unknown> {
    return {
      action: decision.action,
      status: decision.status,
      reason: decision.reason,
      canonicalEpisodeId: decision.canonicalEpisode.id,
      ...(decision.sourceEpisode ? { sourceEpisodeId: decision.sourceEpisode.id } : {}),
      ...(decision.score ? {
        overlap: {
          spanOverlapRatio: decision.score.spanOverlapRatio,
          themeOverlap: decision.score.themeOverlap,
          artifactOverlap: decision.score.artifactOverlap,
          turnBoundaryOverlap: decision.score.turnBoundaryOverlap,
          timeGapMs: decision.score.timeGapMs,
        },
      } : {}),
    };
  }
}
