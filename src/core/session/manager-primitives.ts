import { isRecord } from '../../shared/utils/types.js';
import { clampUnit } from '../../shared/utils/numeric.js';
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
import type { TrustLevel } from '../../system/trust/types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import { decodeStoredChannelVisibility } from '../../system/trust/types.js';
import type { ChannelMeta } from '../../system/trust/policy.js';
import { COMPACTION_REFUSAL_PATTERNS, matchesRefusalPatterns } from '../../system/security/refusal-patterns.js';
import {
  formatToolObservationForContext,
  parseToolObservationMetadata,
  type ToolObservationMetadata,
} from './tool-observation.js';
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
const MAX_HISTORY_SUMMARY_ITEMS = 6;
const MAX_HISTORY_SUMMARY_ITEM_CHARS = 160;
const DEFAULT_SUMMARY_SOURCE_ENTRY_CHARS = 700;
const MAX_SUMMARY_SOURCE_TOOL_FAILURE_CHARS = 220;
const MAX_FALLBACK_RECENT_SUMMARY_ITEMS = 4;
const MAX_FALLBACK_RECENT_SUMMARY_ITEM_CHARS = 140;

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
  /** Stored-value decode domain: ChannelPrivacy (legacy 'broadcast' -> 'public'). */
  sourceVisibility: ChannelPrivacy;
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

/**
 * Minimum conversational (user/assistant) entries the temporal window must
 * retain. A casual temporal cue in a message ("today", "just now") narrows the
 * window for retrieval purposes, but it must never strip the immediate
 * conversation: with no floor, a same-day filter right after a date boundary
 * reduced a live turn's context to a single exchange and the companion
 * re-answered her own previous reply.
 */
export const TEMPORAL_WINDOW_MIN_CONVERSATIONAL_ENTRIES = 12;

/**
 * Backfill reaches at most this far into the past. The floor exists to keep
 * conversational continuity across a date boundary (last night's exchange is
 * still "the conversation"), not to drag week-old content back into a
 * temporally anchored turn.
 */
export const TEMPORAL_WINDOW_BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
  const filtered = entries.filter(entry => isEntryWithinTemporalWindow(entry, temporalWindow, nowMs));
  const conversationalCount = filtered.filter(isConversationalDialogueEntry).length;
  if (conversationalCount >= TEMPORAL_WINDOW_MIN_CONVERSATIONAL_ENTRIES) {
    return filtered;
  }

  // Backfill the most recent pre-window entries (bounded by the backfill age
  // cap) until the floor is met, so temporal narrowing never severs the live
  // conversation at a date boundary.
  const backfillCutoff = nowMs - TEMPORAL_WINDOW_BACKFILL_MAX_AGE_MS;
  const kept = new Set(filtered);
  const backfilled: SessionEntry[] = [...filtered];
  let missing = TEMPORAL_WINDOW_MIN_CONVERSATIONAL_ENTRIES - conversationalCount;
  for (let index = entries.length - 1; index >= 0 && missing > 0; index--) {
    const entry = entries[index];
    if (kept.has(entry)) continue;
    if (!Number.isFinite(entry.timestamp) || entry.timestamp < backfillCutoff) continue;
    backfilled.push(entry);
    kept.add(entry);
    if (isConversationalDialogueEntry(entry)) {
      missing -= 1;
    }
  }
  return backfilled.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
}

function isConversationalDialogueEntry(entry: SessionEntry): boolean {
  return (entry.role === 'user' || entry.role === 'assistant')
    && !isNonConversationalSessionEntry(entry);
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
  // Legacy CompletionHandoff bookkeeping rows (no longer written, but still
  // present in stores/backups until purged) are runtime metadata, never
  // conversation. Excluding them here keeps window collection, token
  // accounting, and prompt conversion consistent.
  if (envelope.type === 'completion_handoff') return true;
  const lane = envelope.sessionLane;
  if (!isRecord(lane)) return false;

  const laneMetadata = lane as Partial<InternalSessionLaneMetadata>;
  return laneMetadata.schemaVersion === 1 && laneMetadata.kind === 'internal';
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

interface ToolFailureSummary {
  metadata: ToolObservationMetadata;
  content: string;
}

interface ToolFailureAggregate {
  toolName: string;
  count: number;
  latestContent: string;
}

function resolveToolHistorySummary(entry: SessionEntry): ToolFailureSummary | null {
  const metadata = parseToolObservationMetadata(entry.metadata);
  if (!metadata?.isError) return null;
  return {
    metadata,
    content: formatToolObservationForContext(entry.content, metadata),
  };
}

function normalizeToolFailureSummaryContent(content: string): string {
  return content
    .replace(/\[Tool result:[^\]]+\]\s*/giu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function aggregateToolFailure(
  aggregates: Map<string, ToolFailureAggregate>,
  failure: ToolFailureSummary,
): void {
  const toolName = failure.metadata.toolName || 'unknown_tool';
  const latestContent = clipHistorySummaryContent(
    normalizeToolFailureSummaryContent(failure.content) || 'failed without a readable error payload',
    MAX_SUMMARY_SOURCE_TOOL_FAILURE_CHARS,
  );
  const existing = aggregates.get(toolName);
  if (existing) {
    existing.count += 1;
    existing.latestContent = latestContent;
    return;
  }
  aggregates.set(toolName, {
    toolName,
    count: 1,
    latestContent,
  });
}

function formatToolFailureAggregate(aggregate: ToolFailureAggregate): string {
  const countText = aggregate.count === 1 ? '1 time' : `${aggregate.count} times`;
  return `${aggregate.toolName} failed ${countText}; latest error: ${aggregate.latestContent}`;
}

function resolveSummarySourceSpeaker(entry: SessionEntry, characterName?: string): string {
  if (entry.role === 'tool') {
    const metadata = parseToolObservationMetadata(entry.metadata);
    return `Tool ${metadata?.toolName || entry.authorName || 'result'}`;
  }
  return resolveHistorySummarySpeaker(entry, characterName);
}

export function buildSessionSummarySourceBlock(params: {
  entries: readonly SessionEntry[];
  characterName?: string;
  maxEntryChars?: number;
  omitToolFailures?: boolean;
}): string {
  const maxEntryChars = Math.max(80, Math.floor(params.maxEntryChars ?? DEFAULT_SUMMARY_SOURCE_ENTRY_CHARS));
  const transcriptLines: string[] = [];
  const toolFailures = new Map<string, ToolFailureAggregate>();

  for (const entry of params.entries) {
    if (isNonConversationalSessionEntry(entry)) continue;

    if (entry.role === 'tool') {
      const failureSummary = resolveToolHistorySummary(entry);
      if (failureSummary) {
        if (!params.omitToolFailures) {
          aggregateToolFailure(toolFailures, failureSummary);
        }
        continue;
      }
    }

    const normalizedContent = normalizeHistorySummaryContent(entry.content);
    if (!normalizedContent) continue;
    const speaker = resolveSummarySourceSpeaker(entry, params.characterName);
    transcriptLines.push(`${speaker}: ${clipHistorySummaryContent(normalizedContent, maxEntryChars)}`);
  }

  const sections: string[] = [];
  if (transcriptLines.length > 0) {
    sections.push(['[Conversation excerpt]', ...transcriptLines].join('\n'));
  }

  if (toolFailures.size > 0) {
    sections.push([
      '[Compressed tool failures]',
      ...[...toolFailures.values()].map(formatToolFailureAggregate),
    ].join('\n'));
  }

  return sections.join('\n\n').trim();
}

interface FallbackRecentSummaryLine {
  speaker: string;
  content: string;
}

function buildFallbackRecentSummaryLines(
  entries: readonly SessionEntry[],
  characterName?: string,
): FallbackRecentSummaryLine[] {
  const lines: FallbackRecentSummaryLine[] = [];
  for (const entry of entries) {
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    if (isNonConversationalSessionEntry(entry)) continue;
    const normalizedContent = normalizeHistorySummaryContent(entry.content);
    if (!normalizedContent) continue;
    lines.push({
      speaker: resolveHistorySummarySpeaker(entry, characterName),
      content: normalizedContent,
    });
  }
  return lines.slice(-MAX_FALLBACK_RECENT_SUMMARY_ITEMS);
}

function formatFallbackRecentSummaryClause(line: FallbackRecentSummaryLine, maxContentChars: number): string {
  const content = clipHistorySummaryContent(
    line.content,
    maxContentChars,
  );
  return `${line.speaker} noted "${content}"`;
}

function buildFallbackRecentSummaryParagraph(
  lines: readonly FallbackRecentSummaryLine[],
  maxContentChars: number,
): string | null {
  if (lines.length === 0) return null;
  const clauses = lines.map(line => formatFallbackRecentSummaryClause(line, maxContentChars));
  return `Earlier in the summarized span, ${joinHistorySummaryClauses(clauses)}.`;
}

export function buildRecentSessionSummaryFallbackText(params: {
  entries: readonly SessionEntry[];
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

  const lines = buildFallbackRecentSummaryLines(params.entries, params.characterName);
  for (let lineCount = lines.length; lineCount > 0; lineCount -= 1) {
    const selectedLines = lines.slice(-lineCount);
    for (
      let maxContentChars = MAX_FALLBACK_RECENT_SUMMARY_ITEM_CHARS;
      maxContentChars >= 32;
      maxContentChars -= 24
    ) {
      const paragraph = buildFallbackRecentSummaryParagraph(selectedLines, maxContentChars);
      if (!paragraph) continue;
      if (countTokens([...headerLines, paragraph].join('\n')) <= params.maxTokens) {
        return [...headerLines, paragraph].join('\n');
      }
    }
  }

  const failureBlock = buildSessionSummarySourceBlock({
    entries: params.entries,
    characterName: params.characterName,
  }).split('\n').filter(line => line.includes('failed ')).slice(-2);
  if (failureBlock.length === 0) return '';
  const compressedFailureSummary = [
    ...headerLines,
    `Earlier tool calls had compressed failures: ${failureBlock.join(' / ')}.`,
  ].join('\n');
  return countTokens(compressedFailureSummary) <= params.maxTokens ? compressedFailureSummary : '';
}

function formatRepeatedToolFailureSummary(failures: readonly ToolFailureSummary[]): HistorySummaryLine {
  const latest = failures[failures.length - 1];
  const toolName = latest.metadata.toolName;
  const latestContent = latest.content;
  const content = failures.length === 1
    ? latestContent
    : `${toolName} failed ${failures.length} times. Most recent failure: ${latestContent}`;
  return {
    speaker: 'Tool',
    content,
  };
}

function pushHistorySummaryLine(
  grouped: HistorySummaryLine[],
  line: HistorySummaryLine,
): void {
  const last = grouped.at(-1);
  if (last && last.speaker === line.speaker) {
    last.content = `${last.content} / ${line.content}`;
    return;
  }

  grouped.push(line);
}

function buildHistorySummaryLines(
  entries: SessionEntry[],
  characterName?: string,
): HistorySummaryLine[] {
  const grouped: HistorySummaryLine[] = [];
  let pendingToolFailures: ToolFailureSummary[] = [];

  const flushToolFailures = (): void => {
    if (pendingToolFailures.length === 0) return;
    pushHistorySummaryLine(grouped, formatRepeatedToolFailureSummary(pendingToolFailures));
    pendingToolFailures = [];
  };

  for (const entry of entries) {
    if (entry.role === 'tool') {
      const failureSummary = resolveToolHistorySummary(entry);
      if (failureSummary) {
        pendingToolFailures.push(failureSummary);
        continue;
      }
      flushToolFailures();
    } else {
      flushToolFailures();
    }

    const normalizedContent = normalizeHistorySummaryContent(entry.content);
    if (!normalizedContent) continue;

    pushHistorySummaryLine(grouped, {
      speaker: resolveHistorySummarySpeaker(entry, characterName),
      content: normalizedContent,
    });
  }
  flushToolFailures();

  return grouped.slice(-MAX_HISTORY_SUMMARY_ITEMS);
}

function formatHistorySummaryClause(line: HistorySummaryLine, maxContentChars: number): string {
  const content = clipHistorySummaryContent(line.content, maxContentChars).replace(/[.!?]+$/u, '');
  const verb = line.speaker === 'Tool' ? 'reported' : 'said';
  return `${line.speaker} ${verb}: ${content}`;
}

function joinHistorySummaryClauses(clauses: readonly string[]): string {
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]} and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join('; ')}; and ${clauses[clauses.length - 1]}`;
}

function buildHistorySummaryParagraph(
  lines: readonly HistorySummaryLine[],
  maxContentChars: number,
): string | null {
  if (lines.length === 0) return null;
  const clauses = lines.map(line => formatHistorySummaryClause(line, maxContentChars));
  return `In the summarized span, ${joinHistorySummaryClauses(clauses)}.`;
}

function fitHistorySummaryParagraph(
  headerLines: readonly string[],
  summaryLines: readonly HistorySummaryLine[],
  maxTokens: number,
): string | null {
  for (let lineCount = summaryLines.length; lineCount > 0; lineCount -= 1) {
    const lines = summaryLines.slice(-lineCount);
    for (
      let maxContentChars = MAX_HISTORY_SUMMARY_ITEM_CHARS;
      maxContentChars >= 32;
      maxContentChars -= 24
    ) {
      const paragraph = buildHistorySummaryParagraph(lines, maxContentChars);
      if (!paragraph) continue;
      if (countTokens([...headerLines, paragraph].join('\n')) <= maxTokens) {
        return paragraph;
      }
    }
  }

  return null;
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

  const paragraph = fitHistorySummaryParagraph(
    headerLines,
    buildHistorySummaryLines(params.entries, params.characterName),
    params.maxTokens,
  );
  return paragraph ? [...headerLines, paragraph].join('\n') : '';
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

export function parseChannelVisibility(value?: string): ChannelPrivacy | undefined {
  // Parses persisted visibility labels; the shared decoder maps records
  // written before the E3.1 rename / E3.3 broadcast split onto ChannelPrivacy
  // ('semi_private' -> 'invite_only', 'broadcast' -> 'public').
  return decodeStoredChannelVisibility(value);
}

export function isUntrustedVisibility(privacy: ChannelPrivacy): boolean {
  // Public structural access is untrusted context; broadcast surfaces are
  // always 'public', so the retired broadcast check is subsumed.
  return privacy === 'public';
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
    // Mirror metadata is persisted; decode legacy 'semi_private' records.
    const sourceVisibility = decodeStoredChannelVisibility(parsed.sourceVisibility);
    if (!sourceVisibility) {
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
      sourceVisibility,
      trustLevel: parsed.trustLevel,
      mirroredAt: parsed.mirroredAt,
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}
