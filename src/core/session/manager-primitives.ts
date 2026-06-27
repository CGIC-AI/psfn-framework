import { isRecord } from '../../shared/utils/types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
import type { SessionRoleEnvelopePreview } from '../internal-role-envelopes/projections.js';
import { countTokens } from '../../primitives/llm/tokens.js';
import {
  resolveTemporalTurnWindow,
  SESSION_HISTORY_MIN_MESSAGES,
  type ContextBudgetTurnCharacteristics,
  type TemporalTurnWindow,
} from '../../shared/context-budget.js';
import { formatActiveDate } from '../../shared/time/active-timezone.js';
import type { ChannelVisibility, TrustLevel } from '../../system/trust/types.js';
import type { ChannelMeta } from '../../system/trust/policy.js';
import { COMPACTION_REFUSAL_PATTERNS, matchesRefusalPatterns } from '../../system/security/refusal-patterns.js';
import type { SessionEntry } from './types.js';

/** Default number of cross-channel continuity messages to include in context. */
export const DEFAULT_CONTINUITY_CONTEXT_LIMIT = 10;
export const DEFAULT_MAX_HISTORY_SPAN_MS = 36 * 60 * 60 * 1000;

/**
 * Resolve a display name for a message role.
 * Maps 'assistant' to the configured character name and 'user' to the configured user name.
 * The actual message role field (sent to LLMs) is never changed — this is purely for display.
 */
export function resolveRoleName(
  role: string,
  config: { charName?: string; userName?: string },
): string {
  if (role === 'assistant') return config.charName?.trim() || 'Assistant';
  if (role === 'user') return config.userName?.trim() || 'User';
  return role;
}
export const DEFAULT_SESSION_MIRROR_MAX_CHARS = 220;
export const DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_IMPORT_BOOTSTRAP_MAX_TOKENS = 50_000;
const MIN_IMPORT_BOOTSTRAP_MAX_TOKENS = 1;

type CompactionPreservedTag = 'refusal' | 'boundary' | 'emotional';

interface TaggedCompactionEntry {
  tag: CompactionPreservedTag;
  messageId: number;
  speaker: string;
  content: string;
  emotionalWeight?: number;
}

interface EmotionalPatternWeight {
  pattern: RegExp;
  weight: number;
}

const BOUNDARY_PATTERNS = [
  /\bboundar(?:y|ies)\b/i,
  /\b(not comfortable|too personal|too private)\b/i,
  /\bplease\s+(do not|don't)\b/i,
  /\blet'?s\s+keep\b/i,
  /\bi(?:'m| am)\s+not\s+going\s+to\b/i,
];

const STRONG_EMOTIONAL_PATTERNS: EmotionalPatternWeight[] = [
  { pattern: /\b(i|we)\s+(love|adore|need|miss)\s+you\b/i, weight: 0.95 },
  {
    pattern: /\b(i|we)\s+(am|are|'m|feel|felt)(?:\s+\w+){0,3}\s+(heartbroken|devastated|terrified|grieving|betrayed|overwhelmed)\b/i,
    weight: 0.9,
  },
  { pattern: /\b(thank\s+you\s+for\s+being\s+here|you\s+mean\s+so\s+much\s+to\s+me)\b/i, weight: 0.82 },
];

const MODERATE_EMOTIONAL_PATTERNS: EmotionalPatternWeight[] = [
  {
    pattern: /\b(i|we)\s+(am|are|'m|feel|felt)(?:\s+\w+){0,3}\s+(sad|happy|afraid|scared|anxious|lonely|angry|grateful|thankful|relieved|ashamed|hurt)\b/i,
    weight: 0.58,
  },
  { pattern: /\b(i|we)\s+(need|needed)\s+support\b/i, weight: 0.55 },
  { pattern: /\b(this|that)\s+(hurt|matters|mattered)\s+to\s+me\b/i, weight: 0.52 },
];

const EMOTIONAL_KEYWORDS = new Set([
  'love',
  'adore',
  'heartbroken',
  'devastated',
  'grief',
  'grieving',
  'sad',
  'happy',
  'afraid',
  'scared',
  'anxious',
  'lonely',
  'angry',
  'thankful',
  'grateful',
  'hurt',
  'betrayed',
  'overwhelmed',
  'crying',
  'tears',
]);

const DEFAULT_EMOTIONAL_SALIENCE_THRESHOLD_PCT = 75;
const MAX_PRESERVED_SAFETY_TAGS = 8;
const MAX_PRESERVED_EMOTIONAL_ENTRIES = 6;
const MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS = 240;
const MAX_HISTORY_SUMMARY_LINES = 6;
const MAX_HISTORY_SUMMARY_LINE_CHARS = 160;

export interface SessionMessageRecordOptions {
  trustLevel?: TrustLevel;
  mirror?: boolean;
  turnId?: TurnID;
  requestId?: string;
  sourceMessageId?: string;
  metadata?: string;
  roleEnvelopePreview?: SessionRoleEnvelopePreview;
  channelMeta?: ChannelMeta;
}

export interface MirrorEntryMetadata {
  type: 'mirror';
  sourceChannelId: string;
  sourceRole: 'user' | 'assistant';
  sourceAuthorName?: string;
  sourceVisibility: ChannelVisibility;
  trustLevel: TrustLevel;
  mirroredAt: number;
  truncated: boolean;
}

export interface RecentEntryStoreLike {
  getRecent(channelId: string, limit: number): SessionEntry[];
}

export interface BudgetedRecentEntries {
  entries: SessionEntry[];
  sourceCount: number;
}

export interface SpanBoundRecentEntries extends BudgetedRecentEntries {
  cutoffTimestamp: number;
}

function isEntryWithinTemporalWindow(
  entry: SessionEntry,
  temporalWindow: TemporalTurnWindow,
  nowMs: number,
): boolean {
  if (!Number.isFinite(entry.timestamp) || entry.timestamp <= 0 || entry.timestamp > nowMs) return false;
  const entryDate = new Date(entry.timestamp);
  const nowDate = new Date(nowMs);

  if (temporalWindow.mode === 'same_day') {
    return formatActiveDate(entryDate) === formatActiveDate(nowDate);
  }

  const recentHours = Math.max(1, Math.floor(temporalWindow.recentHours ?? 12));
  return nowMs - entry.timestamp <= recentHours * 60 * 60 * 1000;
}

export function applyTemporalSessionHistoryWindow(
  entries: readonly SessionEntry[],
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  now: Date = new Date(),
): SessionEntry[] {
  const temporalWindow = resolveTemporalTurnWindow(turnBudgetCharacteristics);
  if (!temporalWindow) {
    return [...entries];
  }

  const nowMs = now.getTime();
  return entries.filter(entry => isEntryWithinTemporalWindow(entry, temporalWindow, nowMs));
}

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

interface RetryCallbacks {
  onRetry?: (params: { attempt: number; delayMs: number; error: Error }) => Promise<void> | void;
}

interface SessionMetadataEnvelope {
  sessionLane?: unknown;
  [key: string]: unknown;
}

interface InternalSessionLaneMetadata {
  schemaVersion: 1;
  kind: 'internal';
  source?: string;
}


function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope | null {
  if (!metadata) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  return parsed as SessionMetadataEnvelope;
}

export function isNonConversationalSessionEntry(entry: Pick<SessionEntry, 'metadata'>): boolean {
  const envelope = parseMetadataEnvelope(entry.metadata);
  if (!envelope) return false;
  const lane = envelope.sessionLane;
  if (!isRecord(lane)) return false;

  const laneMetadata = lane as Partial<InternalSessionLaneMetadata>;
  return laneMetadata.schemaVersion === 1 && laneMetadata.kind === 'internal';
}

export async function withRetry<T>(
  task: () => Promise<T>,
  config: RetryConfig,
  callbacks?: RetryCallbacks,
): Promise<T> {
  const maxRetries = Math.max(0, config.maxRetries);
  const baseDelayMs = Math.max(0, config.baseDelayMs);

  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxRetries) throw error;

      const err = error instanceof Error ? error : new Error(String(error));
      const retryAttempt = attempt + 1;
      const delayMs = baseDelayMs * (2 ** attempt);
      await callbacks?.onRetry?.({
        attempt: retryAttempt,
        delayMs,
        error: err,
      });

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
}

export function trimRecentEntriesToTokenBudget(entries: SessionEntry[], tokenBudget: number): SessionEntry[] {
  if (entries.length === 0) return [];
  if (tokenBudget <= 0) {
    return repairLeadingMultimodalReviewBoundary(entries, entries.slice(-SESSION_HISTORY_MIN_MESSAGES));
  }

  let usedTokens = 0;
  const selected: SessionEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const entryTokens = Math.max(1, countTokens(entry.content));
    if (selected.length >= SESSION_HISTORY_MIN_MESSAGES && usedTokens + entryTokens > tokenBudget) {
      break;
    }
    selected.push(entry);
    usedTokens += entryTokens;
  }

  return repairLeadingMultimodalReviewBoundary(entries, selected.reverse());
}

function isCurrentImageReviewEntry(entry: SessionEntry): boolean {
  return (
    (entry.role === 'assistant' || entry.role === 'system')
    && /(?:^|\n)Current image review:/i.test(entry.content)
  );
}

function findEntryIndexById(entries: readonly SessionEntry[], target: SessionEntry): number {
  const byId = entries.findIndex(entry => entry.id === target.id && entry.channelId === target.channelId);
  if (byId >= 0) return byId;
  return entries.indexOf(target);
}

export function repairLeadingMultimodalReviewBoundary(
  entries: readonly SessionEntry[],
  selectedEntries: readonly SessionEntry[],
): SessionEntry[] {
  const repaired = [...selectedEntries];
  while (repaired.length > 0) {
    const first = repaired[0];
    if (!isCurrentImageReviewEntry(first)) {
      return repaired;
    }

    const firstIndex = findEntryIndexById(entries, first);
    const predecessor = firstIndex > 0 ? entries[firstIndex - 1] : undefined;
    if (predecessor?.role === 'user') {
      if (!repaired.some(entry => entry.id === predecessor.id && entry.channelId === predecessor.channelId)) {
        repaired.unshift(predecessor);
      }
      return repaired;
    }

    repaired.shift();
  }
  return repaired;
}

export function collectRecentEntriesWithinTokenBudget(params: {
  store: RecentEntryStoreLike;
  channelId: string;
  estimatedCount: number;
  tokenBudget: number;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
  now?: Date;
}): BudgetedRecentEntries {
  let limit = Math.max(SESSION_HISTORY_MIN_MESSAGES, Math.floor(params.estimatedCount));
  let previousFetchedCount = -1;

  for (;;) {
    const recent = params.store.getRecent(params.channelId, limit);
    const visibleRecent = recent.filter(entry => !isNonConversationalSessionEntry(entry));
    const temporalRecent = applyTemporalSessionHistoryWindow(
      visibleRecent,
      params.turnBudgetCharacteristics,
      params.now,
    );
    const trimmed = trimRecentEntriesToTokenBudget(temporalRecent, params.tokenBudget);
    if (recent.length < limit || recent.length === previousFetchedCount) {
      return {
        entries: trimmed,
        sourceCount: temporalRecent.length,
      };
    }

    if (visibleRecent.length < recent.length) {
      previousFetchedCount = recent.length;
      limit = Math.max(limit + 1, limit * 2);
      continue;
    }

    if (trimmed.length < visibleRecent.length) {
      return {
        entries: trimmed,
        sourceCount: temporalRecent.length,
      };
    }

    previousFetchedCount = recent.length;
    limit = Math.max(limit + 1, limit * 2);
  }
}

export function resolveMaxHistorySpanMs(
  config: Record<string, unknown>,
): number {
  const candidate = config.maxHistorySpanMs;
  if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) {
    return DEFAULT_MAX_HISTORY_SPAN_MS;
  }
  return Math.floor(candidate);
}

function selectEntriesWithinHistorySpan(
  entries: SessionEntry[],
  cutoffTimestamp: number,
): SessionEntry[] {
  if (entries.length === 0) return [];

  const firstInRangeIndex = entries.findIndex(
    entry => Number.isFinite(entry.timestamp) && entry.timestamp >= cutoffTimestamp,
  );
  const inRange = firstInRangeIndex === -1 ? [] : entries.slice(firstInRangeIndex);
  if (inRange.length >= SESSION_HISTORY_MIN_MESSAGES) {
    return inRange;
  }

  return entries.slice(-Math.min(entries.length, SESSION_HISTORY_MIN_MESSAGES));
}

export function collectRecentEntriesWithinHistorySpan(params: {
  store: RecentEntryStoreLike;
  channelId: string;
  estimatedCount: number;
  maxHistorySpanMs: number;
  nowMs?: number;
}): SpanBoundRecentEntries {
  const normalizedSpanMs = Math.max(1, Math.floor(params.maxHistorySpanMs));
  const cutoffTimestamp = (params.nowMs ?? Date.now()) - normalizedSpanMs;
  let limit = Math.max(SESSION_HISTORY_MIN_MESSAGES, Math.floor(params.estimatedCount));
  let previousFetchedCount = -1;

  for (;;) {
    const recent = params.store.getRecent(params.channelId, limit);
    const visibleRecent = recent.filter(entry => !isNonConversationalSessionEntry(entry));
    const inRange = selectEntriesWithinHistorySpan(visibleRecent, cutoffTimestamp);
    const oldestVisibleTimestamp = visibleRecent[0]?.timestamp;

    if (
      recent.length < limit
      || recent.length === previousFetchedCount
      || (typeof oldestVisibleTimestamp === 'number' && oldestVisibleTimestamp <= cutoffTimestamp)
    ) {
      return {
        entries: inRange,
        sourceCount: recent.length,
        cutoffTimestamp,
      };
    }

    previousFetchedCount = recent.length;
    limit = Math.max(limit + 1, limit * 2);
  }
}

function normalizeHistorySummaryContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function clipHistorySummaryContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function resolveHistorySummarySpeaker(
  entry: SessionEntry,
  characterName?: string,
): string {
  switch (entry.role) {
    case 'assistant':
      return resolveRoleName('assistant', { charName: characterName });
    case 'user':
      return entry.authorName?.trim() || resolveRoleName('user', {});
    case 'tool':
      return 'Tool';
    default:
      return entry.authorName?.trim() || 'System';
  }
}

interface HistorySummaryLine {
  speaker: string;
  content: string;
}

function buildHistorySummaryLines(
  entries: SessionEntry[],
  characterName?: string,
): HistorySummaryLine[] {
  const grouped: HistorySummaryLine[] = [];

  for (const entry of entries) {
    const normalizedContent = normalizeHistorySummaryContent(entry.content);
    if (!normalizedContent) continue;

    const speaker = resolveHistorySummarySpeaker(entry, characterName);
    const last = grouped.at(-1);
    if (last && last.speaker === speaker) {
      last.content = `${last.content} / ${normalizedContent}`;
      continue;
    }

    grouped.push({ speaker, content: normalizedContent });
  }

  return grouped.slice(-MAX_HISTORY_SUMMARY_LINES);
}

function fitHistorySummaryLine(
  prefixLines: string[],
  line: HistorySummaryLine,
  maxTokens: number,
): string | null {
  let content = clipHistorySummaryContent(line.content, MAX_HISTORY_SUMMARY_LINE_CHARS);

  for (;;) {
    const candidate = `- ${line.speaker}: ${content}`;
    if (countTokens([...prefixLines, candidate].join('\n')) <= maxTokens) {
      return candidate;
    }
    if (content.length <= 16) {
      return null;
    }
    content = clipHistorySummaryContent(content, Math.max(16, content.length - 24));
  }
}

export function buildSessionHistorySummaryText(params: {
  entries: SessionEntry[];
  characterName?: string;
  maxTokens: number;
}): string {
  if (params.entries.length === 0 || params.maxTokens <= 0) {
    return '';
  }

  const headerLines = ['[History summary]'];
  if (countTokens(headerLines.join('\n')) > params.maxTokens) {
    return '';
  }

  const lines = [...headerLines];
  for (const line of buildHistorySummaryLines(params.entries, params.characterName)) {
    const fitted = fitHistorySummaryLine(lines, line, params.maxTokens);
    if (!fitted) break;
    lines.push(fitted);
  }

  return lines.length > headerLines.length ? lines.join('\n') : '';
}

export function normalizeImportBootstrapMaxTokens(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_IMPORT_BOOTSTRAP_MAX_TOKENS;
  }
  return Math.max(MIN_IMPORT_BOOTSTRAP_MAX_TOKENS, Math.floor(value));
}

function classifyCompactionTag(content: string): CompactionPreservedTag | null {
  if (!content) return null;
  if (matchesRefusalPatterns(content, COMPACTION_REFUSAL_PATTERNS)) return 'refusal';
  if (BOUNDARY_PATTERNS.some(pattern => pattern.test(content))) return 'boundary';
  return null;
}

function normalizeTaggedContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS - 3)}...`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function resolveEmotionalSalienceThreshold(config: SubstrateConfig): number {
  const thresholdPct = config.compactionEmotionalSalienceThresholdPct
    ?? DEFAULT_EMOTIONAL_SALIENCE_THRESHOLD_PCT;
  return clampUnit(thresholdPct / 100);
}

function applyWeightedPatterns(content: string, patterns: EmotionalPatternWeight[]): number {
  let score = 0;
  for (const candidate of patterns) {
    if (candidate.pattern.test(content)) score += candidate.weight;
  }
  return score;
}

function scoreEmotionalSalience(content: string): number {
  const normalized = content.toLowerCase().trim();
  if (!normalized) return 0;

  let score = 0;
  score += applyWeightedPatterns(normalized, STRONG_EMOTIONAL_PATTERNS);
  score += applyWeightedPatterns(normalized, MODERATE_EMOTIONAL_PATTERNS);

  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1);
  const keywordHits = tokens.reduce(
    (count, token) => count + (EMOTIONAL_KEYWORDS.has(token) ? 1 : 0),
    0,
  );
  if (keywordHits > 0) {
    score += Math.min(0.36, keywordHits * 0.12);
  }

  if (/[!?]{2,}/.test(content)) {
    score += 0.08;
  }
  if (/\b(very|really|so|extremely|deeply)\b/.test(normalized) && keywordHits > 0) {
    score += 0.08;
  }
  if (/\b(i|we)\s+(am|are|'m|feel|felt)\b/.test(normalized) && keywordHits > 0) {
    score += 0.12;
  }

  return clampUnit(score);
}

function scanCompactionSafetyEntries(entries: SessionEntry[]): TaggedCompactionEntry[] {
  const preserved: TaggedCompactionEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.role === 'user' || entry.role === 'tool') continue;

    const normalizedContent = normalizeTaggedContent(entry.content);
    if (!normalizedContent) continue;

    const tag = classifyCompactionTag(normalizedContent);
    if (!tag) continue;

    const dedupeKey = `${tag}:${normalizedContent.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    preserved.push({
      tag,
      messageId: entry.id,
      speaker: entry.authorName ?? entry.role,
      content: normalizedContent,
    });
  }

  return preserved.slice(-MAX_PRESERVED_SAFETY_TAGS);
}

function scanCompactionEmotionalEntries(
  entries: SessionEntry[],
  emotionalThreshold: number,
): TaggedCompactionEntry[] {
  const threshold = clampUnit(emotionalThreshold);
  const candidates: TaggedCompactionEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.role === 'tool') continue;
    const verbatimContent = entry.content.trim();
    if (!verbatimContent) continue;

    const emotionalWeight = scoreEmotionalSalience(verbatimContent);
    if (emotionalWeight < threshold) continue;

    const dedupeKey = `${entry.role}:${verbatimContent.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      tag: 'emotional',
      messageId: entry.id,
      speaker: entry.authorName ?? entry.role,
      content: verbatimContent,
      emotionalWeight,
    });
  }

  const selected = candidates
    .sort((left, right) => {
      const weightDelta = (right.emotionalWeight ?? 0) - (left.emotionalWeight ?? 0);
      if (weightDelta !== 0) return weightDelta;
      return right.messageId - left.messageId;
    })
    .slice(0, MAX_PRESERVED_EMOTIONAL_ENTRIES);

  selected.sort((left, right) => left.messageId - right.messageId);
  return selected;
}

function escapeTaggedValue(content: string): string {
  return content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildCompactionPreservedTagBlock(
  entries: SessionEntry[],
  emotionalThreshold: number,
): string {
  const preserved = [
    ...scanCompactionSafetyEntries(entries),
    ...scanCompactionEmotionalEntries(entries, emotionalThreshold),
  ];

  if (preserved.length === 0) return '';

  const taggedLines = preserved.map((entry) => {
    const salienceScoreAttr = entry.tag === 'emotional' && entry.emotionalWeight !== undefined
      ? ` salience_score="${entry.emotionalWeight.toFixed(2)}"`
      : '';
    return (
      `<${entry.tag} message_id="${entry.messageId}" speaker="${escapeTaggedValue(entry.speaker)}"${salienceScoreAttr}>`
      + `${escapeTaggedValue(entry.content)}</${entry.tag}>`
    );
  });

  return ['[Preserved refusal, boundary, and emotional entries]', ...taggedLines].join('\n');
}

export function appendCompactionMetadataBlocks(summary: string, blocks: string[]): string {
  const trimmedSummary = summary.trim();
  const normalizedBlocks = blocks
    .map(block => block.trim())
    .filter(block => block.length > 0);
  if (normalizedBlocks.length === 0) return trimmedSummary;
  if (!trimmedSummary) return normalizedBlocks.join('\n\n');
  return `${trimmedSummary}\n\n${normalizedBlocks.join('\n\n')}`;
}

export function parseChannelVisibility(value?: string): ChannelVisibility | undefined {
  switch (value) {
    case 'private':
    case 'semi_private':
    case 'public':
    case 'broadcast':
      return value;
    default:
      return undefined;
  }
}

export function isUntrustedVisibility(visibility: ChannelVisibility): boolean {
  return visibility === 'public' || visibility === 'broadcast';
}

export function wrapUntrustedContext(content: string, source: 'public' = 'public'): string {
  return `<untrusted_context source="${source}">\n${content}\n</untrusted_context>`;
}

export function normalizeMirrorText(content: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return { text: '', truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, Math.max(1, maxChars - 3))}...`, truncated: true };
}

export function parseMirrorMetadata(value?: string): MirrorEntryMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MirrorEntryMetadata>;
    if (parsed.type !== 'mirror') return null;
    if (parsed.sourceRole !== 'user' && parsed.sourceRole !== 'assistant') return null;
    if (
      parsed.sourceVisibility !== 'private'
      && parsed.sourceVisibility !== 'semi_private'
      && parsed.sourceVisibility !== 'public'
      && parsed.sourceVisibility !== 'broadcast'
    ) {
      return null;
    }
    if (
      parsed.trustLevel !== 'primary'
      && parsed.trustLevel !== 'trusted'
      && parsed.trustLevel !== 'regular'
      && parsed.trustLevel !== 'public'
    ) {
      return null;
    }
    if (typeof parsed.sourceChannelId !== 'string' || !parsed.sourceChannelId.trim()) return null;
    if (typeof parsed.mirroredAt !== 'number' || !Number.isFinite(parsed.mirroredAt)) return null;

    return {
      type: 'mirror',
      sourceChannelId: parsed.sourceChannelId,
      sourceRole: parsed.sourceRole,
      sourceAuthorName: typeof parsed.sourceAuthorName === 'string' ? parsed.sourceAuthorName : undefined,
      sourceVisibility: parsed.sourceVisibility,
      trustLevel: parsed.trustLevel,
      mirroredAt: parsed.mirroredAt,
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}
