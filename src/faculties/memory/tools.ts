// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type {
  MemoryType,
  MemoryScopeKind,
  MemoryScopeQuery,
  SensitivityLevel,
  MemoryRedactionOperation,
  MemoryFormationVAD,
  MemorySourceType,
  PurrMemory,
} from './types.js';
import {
  memoryMatchesScopeQuery,
  normalizeMemoryScopeQuery,
  VALID_MEMORY_TYPES,
  VALID_MEMORY_SCOPE_KINDS,
  VALID_SENSITIVITY_LEVELS,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from './types.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { normalizeToolArguments } from '../../shared/tool-argument-normalization.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import {
  TRUST_LEVELS,
  type TrustLevel,
} from '../../system/trust/types.js';
import {
  CHANNEL_PRIVACY_VALUES,
  type ChannelPrivacy,
} from '../../system/trust/context-envelope.js';
import { classifyChannelDisclosure } from '../../system/trust/policy.js';
import {
  retrieveEpisodicTimeline,
  type EpisodicTimelineEntry,
  type EpisodicTimelineStore,
} from './retrieval/episodic.js';
import {
  evaluateRetrievalAccessDecision,
  summarizeWithheldMemories,
} from './retrieval/access.js';
import {
  formatMemoryWithheldReasonLabel,
  formatMemoryWithheldRelevanceBandLabel,
  listMemoryWithheldReasonEntries,
  listMemoryWithheldRelevanceBandEntries,
  type MemoryWithheldSummary,
} from './withheld-summary.js';
import {
  lexicalMemoryScoreToSimilarity,
  normalizeLexicalMemoryQuery,
  scoreLexicalMemoryMatch,
  tokenizeLexicalMemoryQuery,
} from './lexical-match.js';

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const SCRATCHPAD_DEFAULT_LIMIT = 20;
const SCRATCHPAD_MAX_LIMIT = 64;
const MEMORY_SEARCH_DEFAULT_LIMIT = 5;
const MEMORY_SEARCH_MAX_LIMIT = 20;
const MEMORY_TIMELINE_DEFAULT_LIMIT = 8;
const MEMORY_TIMELINE_MAX_LIMIT = 20;
const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i;
const MEMORY_TOOL_ACTIONS = [
  'write',
  'search',
  'census',
  'exists',
  'timeline',
  'import',
  'patch',
  'redact',
  'delete',
  'restore',
] as const;
type MemoryToolAction = (typeof MEMORY_TOOL_ACTIONS)[number];
type ScratchpadToolAction = 'list' | 'add' | 'replace' | 'append' | 'remove';
const SCRATCHPAD_TOOL_ACTIONS: ScratchpadToolAction[] = ['list', 'add', 'replace', 'append', 'remove'];

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.floor(val)));
}

function extractInternalSource(params: Record<string, unknown>): string | null {
  const candidate = params[INTERNAL_SHARD_SOURCE_PARAM];
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildToolSourceRef(
  toolName: string,
  toolCallId: string,
  shardSource: string | null,
): string {
  if (!shardSource) return `source:tool:${toolName}|invocation:${toolCallId}`;
  return `source:${shardSource}|tool:${toolName}|invocation:${toolCallId}`;
}

function buildToolSourceContext(
  toolName: string,
  toolCallId: string,
  shardSource: string | null,
): {
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance: {
    toolName: string;
    toolCallId: string;
    shardId?: string;
    actor?: 'shard';
  };
} {
  const sourceRef = buildToolSourceRef(toolName, toolCallId, shardSource);
  const shardId = shardSource?.startsWith('shard:') ? shardSource.slice('shard:'.length) : undefined;
  return {
    sourceRef,
    sourceType: shardId ? 'shard' : 'tool_write',
    provenance: {
      toolName,
      toolCallId,
      ...(shardId ? { shardId, actor: 'shard' as const } : {}),
    },
  };
}

function buildUnifiedMemorySourceContext(
  action: Exclude<MemoryToolAction, 'search' | 'timeline'>,
  toolCallId: string,
  shardSource: string | null,
  qualifiers: string[] = [],
): {
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance: {
    toolName: string;
    toolCallId: string;
    shardId?: string;
    actor?: 'shard';
  };
} {
  const base = shardSource
    ? `source:${shardSource}|tool:memory|action:${action}`
    : `source:tool:memory|action:${action}`;
  const sourceRef = [base, ...qualifiers.filter(Boolean), `invocation:${toolCallId}`].join('|');
  const shardId = shardSource?.startsWith('shard:') ? shardSource.slice('shard:'.length) : undefined;
  return {
    sourceRef,
    sourceType: shardId ? 'shard' : 'tool_write',
    provenance: {
      toolName: 'memory',
      toolCallId,
      ...(shardId ? { shardId, actor: 'shard' as const } : {}),
    },
  };
}

function formatScratchpadList(
  entries: Array<{ id: string; content: string; updatedAt: number }>,
): string {
  if (entries.length === 0) {
    return 'Scratchpad is empty. Use it for temporary same-day working notes, excerpts, and working summaries.';
  }

  const lines = [
    `Scratchpad entries (${entries.length}) [24h ephemeral working context]:`,
    'Do not use scratchpad for durable reminders, proactive follow-ups, relationship state, journals, or stable memories. Promote stable facts to memory, follow-ups to orient open threads, and durable notes to journal.',
  ];
  for (const entry of entries) {
    lines.push(`- ${entry.id} [${new Date(entry.updatedAt).toISOString()}]: ${entry.content}`);
  }
  return lines.join('\n');
}

function formatMemorySearchResults(
  entries: Array<{
    id: string;
    text: string;
    type: string;
    sensitivity: string;
    similarity: number;
  }>,
): string {
  if (entries.length === 0) {
    return 'No memories matched the search query.';
  }

  const lines = [`Memory search results (${entries.length}):`];
  for (const entry of entries) {
    lines.push(
      `- ${entry.id} [${entry.type}, ${entry.sensitivity}, similarity=${entry.similarity.toFixed(2)}]: ${entry.text}`,
    );
  }
  return lines.join('\n');
}

function formatEpisodicTimeline(
  entries: readonly EpisodicTimelineEntry[],
  rangeLabel: string,
): string {
  if (entries.length === 0) {
    return `No visible episodic memories found for ${rangeLabel}.`;
  }

  const linkedCount = entries.filter(entry => entry.source === 'linked').length;
  const linkedSuffix = linkedCount > 0
    ? `, including ${linkedCount} linked continuation${linkedCount === 1 ? '' : 's'}`
    : '';
  const lines = [
    `Episodic timeline for ${rangeLabel} (${entries.length} episode${entries.length === 1 ? '' : 's'}${linkedSuffix}):`,
  ];

  for (const entry of entries) {
    const episode = entry.episode;
    const timeRange = `${formatTimelineInstant(episode.startedAt)} to ${formatTimelineInstant(episode.endedAt)}`;
    const linkParts: string[] = [];
    if (entry.source === 'linked') {
      linkParts.push(`linked ${entry.relation ?? 'related'} episode`);
      if (entry.outsideRequestedRange) linkParts.push('outside requested range');
      if (entry.linkedFromEpisodeId) linkParts.push(`from ${entry.linkedFromEpisodeId}`);
    }
    const linkSuffix = linkParts.length > 0 ? ` [${linkParts.join(', ')}]` : '';
    lines.push(`- ${timeRange}: ${episode.title} (${episode.id})${linkSuffix}`);
    lines.push(`  ${truncateTimelineText(episode.landmark, 220)}`);
    if (episode.themes.length > 0) {
      lines.push(`  Themes: ${episode.themes.slice(0, 6).join(', ')}`);
    }
    if (episode.meaning?.text) {
      lines.push(`  Meaning: ${truncateTimelineText(episode.meaning.text, 180)}`);
    }
  }

  return lines.join('\n');
}

function formatTimelineInstant(isoInstant: string): string {
  return isoInstant.replace('.000Z', 'Z').replace('T', ' ');
}

function truncateTimelineText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeTagEntries(entries: readonly unknown[]): string[] | undefined {
  const normalized = entries
    .flatMap(entry => (typeof entry === 'string' ? [entry.trim().toLowerCase()] : []))
    .filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function parseTags(tags: unknown): string[] | undefined {
  if (tags === undefined || tags === null) return undefined;
  if (Array.isArray(tags)) return normalizeTagEntries(tags);
  if (typeof tags !== 'string') return undefined;
  const trimmed = tags.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) return normalizeTagEntries(parsed);
    } catch {
      // Fall through to comma-splitting below for malformed legacy input.
    }
  }
  return normalizeTagEntries(trimmed.split(','));
}

export interface MemoryWriteToolOptions {
  getFormationVAD?: () => MemoryFormationVAD | undefined;
}

export interface MemoryToolOptions extends MemoryWriteToolOptions {
  episodicStore?: EpisodicTimelineStore | null;
}

interface MemoryToolParams {
  action: MemoryToolAction;
  text?: string;
  type?: MemoryType;
  importance?: number;
  emotional_valence?: number;
  confidence?: number;
  tags?: string;
  sensitivity?: SensitivityLevel;
  query?: string;
  limit?: number;
  contact_id?: string;
  contactId?: string;
  scope_kind?: MemoryScopeKind;
  scopeKind?: MemoryScopeKind;
  scope_id?: string;
  scopeId?: string;
  scope_tag?: string;
  scopeTag?: string;
  include_archived?: boolean;
  includeArchived?: boolean;
  records?: Array<{
    text: string;
    type: MemoryType;
    importance?: number;
    emotional_valence?: number;
    confidence?: number;
    tags?: string;
    sensitivity?: SensitivityLevel;
  }>;
  source?: string;
  memory_id?: string;
  operation?: MemoryRedactionOperation;
  reason?: string;
  delete_id?: string;
  date?: string;
  after?: string;
  before?: string;
  channel_id?: string;
  channelId?: string;
  trust_level?: TrustLevel;
  trustLevel?: TrustLevel;
  channel_visibility?: ChannelPrivacy;
  channelVisibility?: ChannelPrivacy;
  canonical_contact_id?: string;
  canonicalContactId?: string;
  formation_vad?: MemoryFormationVAD;
  clear_formation_vad?: boolean;
  append_tags?: string;
}

type TimelineRangeResult =
  | { ok: true; from?: string; to?: string; label: string }
  | { ok: false; error: string };

type TimelineVisibilityResult =
  | {
    ok: true;
    channelId: string;
    trustLevel: TrustLevel;
    channelVisibility: ChannelPrivacy;
    /** Broadcast flag from channel classification (viewer context carries privacy only). */
    broadcast: boolean;
    canonicalContactId?: string;
  }
  | { ok: false; error: string };

type MemoryVisibilityAction = 'timeline' | 'census' | 'exists';

type MemoryScopeFilterResult =
  | {
    ok: true;
    contactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }
  | { ok: false; error: string };

interface MemoryVisibilityFilter {
  contactId?: string;
  scopeQuery?: MemoryScopeQuery;
  includeArchived: boolean;
}

interface MemoryAccessOptions {
  trustLevel: TrustLevel;
  channelPrivacy: ChannelPrivacy;
  broadcast: boolean;
  canonicalContactId?: string;
}

interface MemoryAccessPartition {
  visible: PurrMemory[];
  withheld: Array<PurrMemory & { similarity?: number }>;
  withheldSummary?: MemoryWithheldSummary;
}

function resolveTimelineRange(params: MemoryToolParams): TimelineRangeResult {
  const date = normalizeOptionalToolString(params.date);
  const after = normalizeOptionalToolString(params.after);
  const before = normalizeOptionalToolString(params.before);

  if (date && (after || before)) {
    return { ok: false, error: 'Error: provide either date or after/before for action=timeline, not both' };
  }

  if (date) {
    const dayRange = normalizeTimelineDate(date);
    if (!dayRange) {
      return { ok: false, error: 'Error: date must be a valid YYYY-MM-DD UTC date for action=timeline' };
    }
    return {
      ok: true,
      from: dayRange.from,
      to: dayRange.to,
      label: `date ${date}`,
    };
  }

  if (!after && !before) {
    return { ok: false, error: 'Error: date or after/before is required for action=timeline' };
  }

  const from = after ? normalizeTimelineBoundary(after, 'after', 'start') : undefined;
  if (from && 'error' in from) {
    return { ok: false, error: from.error };
  }
  const to = before ? normalizeTimelineBoundary(before, 'before', 'end') : undefined;
  if (to && 'error' in to) {
    return { ok: false, error: to.error };
  }

  const normalizedFrom = from?.value;
  const normalizedTo = to?.value;
  if (normalizedFrom && normalizedTo && normalizedFrom > normalizedTo) {
    return { ok: false, error: 'Error: after must be before or equal to before for action=timeline' };
  }

  return {
    ok: true,
    ...(normalizedFrom ? { from: normalizedFrom } : {}),
    ...(normalizedTo ? { to: normalizedTo } : {}),
    label: normalizedFrom && normalizedTo
      ? `range ${normalizedFrom} to ${normalizedTo}`
      : normalizedFrom
        ? `range after ${normalizedFrom}`
        : `range before ${normalizedTo}`,
  };
}

function resolveMemoryVisibility(
  params: MemoryToolParams,
  action: MemoryVisibilityAction,
): TimelineVisibilityResult {
  const requestContext = getRequestContext();
  const channelId = normalizeOptionalToolString(params.channel_id)
    ?? normalizeOptionalToolString(params.channelId)
    ?? normalizeOptionalToolString(requestContext?.channelId);
  const trustLevelResult = normalizeTimelineTrustLevel(
    params.trust_level ?? params.trustLevel ?? requestContext?.viewerTrustLevel,
    action,
  );
  const visibilityResult = normalizeTimelineChannelVisibility(
    params.channel_visibility ?? params.channelVisibility ?? requestContext?.viewerChannelPrivacy,
    action,
  );
  const canonicalContactId = normalizeOptionalToolString(params.canonical_contact_id)
    ?? normalizeOptionalToolString(params.canonicalContactId);

  if (!channelId) {
    return { ok: false, error: `Error: channel_id is required for action=${action} when no request context channel is available` };
  }
  if (!trustLevelResult.ok) {
    return { ok: false, error: trustLevelResult.error };
  }
  if (!visibilityResult.ok) {
    return { ok: false, error: visibilityResult.error };
  }

  return {
    ok: true,
    channelId,
    trustLevel: trustLevelResult.value,
    channelVisibility: visibilityResult.value,
    broadcast: classifyChannelDisclosure(channelId).broadcast,
    ...(canonicalContactId ? { canonicalContactId } : {}),
  };
}

function normalizeOptionalToolString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimelineTrustLevel(
  value: unknown,
  action: MemoryVisibilityAction,
): { ok: true; value: TrustLevel } | { ok: false; error: string } {
  const normalized = normalizeOptionalToolString(value);
  if (!normalized) {
    return { ok: false, error: `Error: trust_level is required for action=${action} when no request context trust is available` };
  }
  if ((TRUST_LEVELS as readonly string[]).includes(normalized)) {
    return { ok: true, value: normalized as TrustLevel };
  }
  return {
    ok: false,
    error: `Error: invalid trust_level "${normalized}" for action=${action}. Must be one of: ${TRUST_LEVELS.join(', ')}`,
  };
}

function normalizeTimelineChannelVisibility(
  value: unknown,
  action: MemoryVisibilityAction,
): { ok: true; value: ChannelPrivacy } | { ok: false; error: string } {
  const normalized = normalizeOptionalToolString(value);
  if (!normalized) {
    return {
      ok: false,
      error: `Error: channel_visibility is required for action=${action} when no request context visibility is available`,
    };
  }
  if ((CHANNEL_PRIVACY_VALUES as readonly string[]).includes(normalized)) {
    return { ok: true, value: normalized as ChannelPrivacy };
  }
  return {
    ok: false,
    error: `Error: invalid channel_visibility "${normalized}" for action=${action}. Must be one of: ${CHANNEL_PRIVACY_VALUES.join(', ')}`,
  };
}

function normalizeTimelineDate(value: string): { from: string; to: string } | null {
  const dateParts = parseDateOnlyParts(value);
  if (!dateParts) return null;
  return {
    from: new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 0, 0, 0, 0)).toISOString(),
    to: new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day, 23, 59, 59, 999)).toISOString(),
  };
}

function normalizeTimelineBoundary(
  value: string,
  field: 'after' | 'before',
  dateOnlyEdge: 'start' | 'end',
): { value: string } | { error: string } {
  const dateRange = normalizeTimelineDate(value);
  if (dateRange) {
    return { value: dateOnlyEdge === 'start' ? dateRange.from : dateRange.to };
  }
  if (!ISO_INSTANT_WITH_ZONE_PATTERN.test(value)) {
    return {
      error: `Error: ${field} must be a valid YYYY-MM-DD date or ISO-8601 timestamp with timezone for action=timeline`,
    };
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return {
      error: `Error: ${field} must be a valid YYYY-MM-DD date or ISO-8601 timestamp with timezone for action=timeline`,
    };
  }
  return { value: new Date(timestamp).toISOString() };
}

function parseDateOnlyParts(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function normalizeOptionalBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return fallback;
}

function resolveMemoryVisibilityFilter(
  params: MemoryToolParams,
  defaultIncludeArchived: boolean,
): MemoryScopeFilterResult & { includeArchived?: boolean } {
  const contactId = normalizeOptionalToolString(params.contact_id)
    ?? normalizeOptionalToolString(params.contactId);
  const rawScopeKind = normalizeOptionalToolString(params.scope_kind)
    ?? normalizeOptionalToolString(params.scopeKind);
  const scopeId = normalizeOptionalToolString(params.scope_id)
    ?? normalizeOptionalToolString(params.scopeId);
  const scopeTag = normalizeOptionalToolString(params.scope_tag)
    ?? normalizeOptionalToolString(params.scopeTag);
  const includeArchived = normalizeOptionalBoolean(
    params.include_archived ?? params.includeArchived,
    defaultIncludeArchived,
  );

  let scopeKind: MemoryScopeKind | undefined;
  if (rawScopeKind) {
    if (!(VALID_MEMORY_SCOPE_KINDS as readonly string[]).includes(rawScopeKind)) {
      return {
        ok: false,
        error: `Error: invalid scope_kind "${rawScopeKind}". Must be one of: ${VALID_MEMORY_SCOPE_KINDS.join(', ')}`,
      };
    }
    scopeKind = rawScopeKind as MemoryScopeKind;
  }
  if ((scopeKind && !scopeId) || (!scopeKind && scopeId)) {
    return { ok: false, error: 'Error: scope_kind and scope_id must be provided together' };
  }

  const scopeQuery = normalizeMemoryScopeQuery({
    ...(scopeKind && scopeId ? { refs: [{ kind: scopeKind, id: scopeId }] } : {}),
    ...(scopeTag ? { tags: [scopeTag] } : {}),
    mode: 'only',
  });
  return {
    ok: true,
    ...(contactId ? { contactId } : {}),
    ...(scopeQuery ? { scopeQuery } : {}),
    includeArchived,
  };
}

function memoryState(memory: Pick<PurrMemory, 'deletedAt' | 'supersededBy'>): 'active' | 'archived' {
  return memory.deletedAt || memory.supersededBy ? 'archived' : 'active';
}

function memoryMatchesVisibilityFilter(memory: PurrMemory, filter: MemoryVisibilityFilter): boolean {
  if (!filter.includeArchived && memoryState(memory) === 'archived') return false;
  if (filter.contactId && memory.contactId !== filter.contactId) return false;
  if (filter.scopeQuery && !memoryMatchesScopeQuery(memory, filter.scopeQuery)) return false;
  return true;
}

async function listFilteredMemories(
  memoryStore: MemoryStorePort,
  filter: MemoryVisibilityFilter,
): Promise<PurrMemory[]> {
  const memories = await memoryStore.listMemories();
  return memories.filter(memory => memoryMatchesVisibilityFilter(memory, filter));
}

function partitionVisibleMemories<T extends PurrMemory & { similarity?: number }>(
  memories: readonly T[],
  access: MemoryAccessOptions,
): MemoryAccessPartition {
  const visible: PurrMemory[] = [];
  const withheld: Array<PurrMemory & { similarity?: number }> = [];
  for (const memory of memories) {
    const decision = evaluateRetrievalAccessDecision(memory, access);
    if (decision.allowed) {
      visible.push(memory);
    } else {
      withheld.push(memory);
    }
  }
  const { summary } = summarizeWithheldMemories(memories, access);
  return {
    visible,
    withheld,
    ...(summary ? { withheldSummary: summary } : {}),
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  const normalized = key.trim();
  if (!normalized) return;
  counts[normalized] = (counts[normalized] ?? 0) + 1;
}

function countBy<T>(items: readonly T[], keyForItem: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    incrementCount(counts, keyForItem(item) ?? 'none');
  }
  return counts;
}

function formatCounts(counts: Record<string, number>, maxEntries = 8): string {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey));
  if (entries.length === 0) return 'none';
  const visible = entries.slice(0, maxEntries).map(([key, count]) => `${key}: ${count}`);
  const hiddenCount = entries.length - visible.length;
  if (hiddenCount > 0) visible.push(`${hiddenCount} more`);
  return visible.join(', ');
}

function scopeRefLabel(memory: PurrMemory): string | undefined {
  if (!memory.scopeRef) return undefined;
  return `${memory.scopeRef.kind}:${memory.scopeRef.id}`;
}

function provenanceBucket(memory: PurrMemory): string {
  if (memory.sourceType && memory.sourceType !== 'unknown') return memory.sourceType;
  const normalized = memory.sourceRef.toLowerCase();
  if (normalized.includes('shard:')) return 'shard';
  if (normalized.includes('tool:') || normalized.includes('source:tool')) return 'tool_write';
  if (normalized.includes('heartbeat')) return 'heartbeat';
  if (normalized.includes('reflection')) return 'reflection';
  if (normalized.includes('session') || normalized.includes('turn') || normalized.includes('conversation')) return 'turn';
  return 'unspecified_source';
}

function formatWithheldContext(
  summary: MemoryWithheldSummary | undefined,
  withheld: readonly PurrMemory[],
): string[] {
  if (!summary || summary.totalCount <= 0) return [];
  const plural = summary.totalCount === 1 ? 'memory was' : 'memories were';
  const lines = [
    `- Withheld context: ${summary.totalCount} candidate ${plural} present but not included in visible detail because trust/privacy gates withheld it.`,
  ];
  const reasonLine = listMemoryWithheldReasonEntries(summary.reasonCounts)
    .map(({ reason, count }) => `${count} ${formatMemoryWithheldReasonLabel(reason)}`)
    .join(', ');
  if (reasonLine) {
    lines.push(`- Withheld trust/privacy reasons: ${reasonLine}.`);
  }
  const relevanceLine = listMemoryWithheldRelevanceBandEntries(summary.relevanceBands ?? {})
    .map(({ band, count }) => `${count} ${formatMemoryWithheldRelevanceBandLabel(band)}`)
    .join(', ');
  if (relevanceLine) {
    lines.push(`- Withheld relevance bands: ${relevanceLine}.`);
  }
  lines.push(`- Withheld categories: ${formatCounts(countBy(withheld, memory => memory.type))}.`);
  lines.push(`- Withheld states: ${formatCounts(countBy(withheld, memoryState))}.`);
  lines.push(`- Withheld provenance classes: ${formatCounts(countBy(withheld, provenanceBucket))}.`);
  lines.push('- Protected withheld memory text, memory IDs, contact IDs, and scope labels are not included.');
  return lines;
}

function formatVisibleMemoryBreakdown(visible: readonly PurrMemory[]): string[] {
  if (visible.length === 0) return [];
  const lines = [
    `- By type: ${formatCounts(countBy(visible, memory => memory.type))}.`,
    `- By sensitivity: ${formatCounts(countBy(visible, memory => memory.sensitivity))}.`,
    `- By state: ${formatCounts(countBy(visible, memoryState))}.`,
  ];
  const contactCounts = countBy(visible, memory => memory.contactId ?? 'not contact-scoped');
  lines.push(`- By contact scope: ${formatCounts(contactCounts)}.`);
  const scopeRefCounts = countBy(visible, memory => scopeRefLabel(memory) ?? 'not scope-ref-scoped');
  lines.push(`- By scope ref: ${formatCounts(scopeRefCounts)}.`);
  const scopeTagCounts = countBy(
    visible.flatMap(memory => memory.scopeTags?.length ? memory.scopeTags : ['not scope-tag-scoped']),
    tag => tag,
  );
  lines.push(`- By scope tag: ${formatCounts(scopeTagCounts)}.`);
  return lines;
}

function formatMemoryCensusResult(partition: MemoryAccessPartition): string {
  const lines = ['Memory census:'];
  const visibleCount = partition.visible.length;
  const withheldCount = partition.withheldSummary?.totalCount ?? 0;
  if (visibleCount === 0 && withheldCount === 0) {
    lines.push('- No memories matched the requested filters.');
    lines.push('No memory text returned.');
    return lines.join('\n');
  }

  lines.push(`- Visible memories: ${visibleCount}.`);
  lines.push(...formatVisibleMemoryBreakdown(partition.visible));
  lines.push(...formatWithheldContext(partition.withheldSummary, partition.withheld));
  lines.push('No memory text returned.');
  return lines.join('\n');
}

function formatMemoryExistsResult(partition: MemoryAccessPartition): string {
  const visibleCount = partition.visible.length;
  const withheldCount = partition.withheldSummary?.totalCount ?? 0;
  const totalCount = visibleCount + withheldCount;
  const lines = ['Memory exists check:'];
  if (totalCount === 0) {
    lines.push('- Result: no matching memories found for the requested topic and filters.');
    lines.push('No memory text returned.');
    return lines.join('\n');
  }

  if (visibleCount > 0) {
    lines.push(`- Result: yes, ${visibleCount} visible matching ${visibleCount === 1 ? 'memory' : 'memories'} found.`);
  } else {
    lines.push('- Result: yes, matching memory exists, but none is visible in this channel.');
  }
  lines.push(...formatVisibleMemoryBreakdown(partition.visible));
  lines.push(...formatWithheldContext(partition.withheldSummary, partition.withheld));
  lines.push('No memory text returned.');
  return lines.join('\n');
}

function filterTopicMatches(memories: readonly PurrMemory[], query: string): Array<PurrMemory & { similarity: number }> {
  const normalizedQuery = normalizeLexicalMemoryQuery(query);
  const tokens = tokenizeLexicalMemoryQuery(normalizedQuery);
  if (tokens.length === 0) return [];
  return memories
    .map((memory) => {
      const score = scoreLexicalMemoryMatch(memory, tokens, normalizedQuery);
      if (score <= 0) return null;
      return {
        ...memory,
        similarity: lexicalMemoryScoreToSimilarity(score),
      };
    })
    .filter((memory): memory is PurrMemory & { similarity: number } => memory !== null)
    .sort((left, right) => (
      right.similarity - left.similarity
      || right.salience - left.salience
      || right.extractedAt - left.extractedAt
    ));
}

export function createMemoryWriteTool(
  writer: MemoryWriter,
  options: MemoryWriteToolOptions = {},
): AgentTool<any> {
  return {
    name: 'memory_write',
    description:
      'Write a new memory. Automatically deduplicates against existing memories. ' +
      'Use for intentionally recording important facts, observations, or learnings. ' +
      'Pass each argument in its own field; do not serialize a JSON object into text.',
    label: 'memory_write',
    parameters: Type.Object({
      text: Type.String({
        description:
          'The memory text only. Use just the fact or secret string itself, not JSON, not field labels, and not other parameters.',
      }),
      type: Type.Unsafe<MemoryType>({
        type: 'string',
        enum: [...VALID_MEMORY_TYPES],
        description:
          'Memory type only. Set this as a separate field: episodic (events), semantic (facts), emotional (feelings), procedural (patterns), boundary (refusal/safety constraints), reflection (meta).',
      }),
      importance: Type.Optional(
        Type.Number({ description: '0-1, how significant (default 0.5). 0.8+ for core identity facts.' }),
      ),
      emotional_valence: Type.Optional(
        Type.Number({ description: '-1 to 1, emotional tone (-1 very negative, 0 neutral, 1 very positive). Default 0.' }),
      ),
      confidence: Type.Optional(
        Type.Number({ description: '0-1, how confident in this fact (default 0.8). Higher confidence can supersede lower.' }),
      ),
      tags: Type.Optional(
        Type.String({ description: 'Comma-separated tags (e.g. "identity, preference")' }),
      ),
      sensitivity: Type.Optional(
        Type.Unsafe<SensitivityLevel>({
          type: 'string',
          enum: [...VALID_SENSITIVITY_LEVELS],
          description:
            'Privacy level only. Set this as a separate field: public (share anywhere), personal (trusted only), intimate (primary only), confidential (1:1 only). Default: personal.',
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: {
        text: string;
        content?: string;
        type: MemoryType;
        importance?: number;
        emotional_valence?: number;
        confidence?: number;
        tags?: string;
        sensitivity?: SensitivityLevel;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const normalizedParams = (normalizeToolArguments(
          'memory_write',
          params as Record<string, unknown>,
        ) ?? params) as typeof params;
        const internalSource = extractInternalSource(normalizedParams as Record<string, unknown>);
        const { text, type } = normalizedParams;

        if (!text || text.trim().length === 0) {
          return textResultWithError('Error: text is required', true);
        }
        if (!VALID_MEMORY_TYPES.includes(type)) {
          return textResultWithError(
            `Error: invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
            true,
          );
        }

        const importance = normalizedParams.importance !== undefined ? clamp(Number(normalizedParams.importance), 0, 1) : undefined;
        const emotionalValence = normalizedParams.emotional_valence !== undefined ? clamp(Number(normalizedParams.emotional_valence), -1, 1) : undefined;
        const confidence = normalizedParams.confidence !== undefined ? clamp(Number(normalizedParams.confidence), 0, 1) : undefined;

        const tags = parseTags(normalizedParams.tags);
        const formationVAD = options.getFormationVAD?.();
        const sourceContext = buildToolSourceContext('memory_write', toolCallId, internalSource);

        const result = await writer.write({
          text: text.trim(),
          type,
          importance,
          emotionalValence,
          formationVAD,
          confidence,
          tags,
          sourceRef: sourceContext.sourceRef,
          sourceType: sourceContext.sourceType,
          provenance: sourceContext.provenance,
          sensitivity: normalizedParams.sensitivity,
        });

        switch (result.action) {
          case 'created':
            return textResult(`Memory created (id: ${result.memory.id}, type: ${type})`);
          case 'deduplicated':
            return textResult(`Duplicate detected — bumped salience on existing memory (id: ${result.existingId})`);
          case 'updated':
            return textResult(`Memory created and linked as a compatible update (id: ${result.memory.id}, type: ${type})`);
          case 'superseded':
            return textResult(`Memory created, superseding older conflicting memory (id: ${result.memory.id}, type: ${type})`);
          case 'negated':
            return textResult(`Memory created and linked as negating prior memory (id: ${result.memory.id}, type: ${type})`);
          case 'conflict':
            return textResult(`Memory created and linked for conflict review (id: ${result.memory.id}, type: ${type})`);
        }
      } catch (error) {
        return textResultWithError(`Error writing memory: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryImportTool(writer: MemoryWriter): AgentTool<any> {
  return {
    name: 'memory_import_batch',
    description:
      'Import multiple memories at once. Each record is deduped against existing memories ' +
      'and against earlier records in the same batch. Use for bulk restoration or migration.',
    label: 'memory_import_batch',
    parameters: Type.Object({
      records: Type.Array(
        Type.Object({
          text: Type.String(),
          type: Type.Unsafe<MemoryType>({ type: 'string', enum: [...VALID_MEMORY_TYPES] }),
          importance: Type.Optional(Type.Number()),
          emotional_valence: Type.Optional(Type.Number()),
          confidence: Type.Optional(Type.Number()),
          tags: Type.Optional(Type.String()),
          sensitivity: Type.Optional(
            Type.Unsafe<SensitivityLevel>({ type: 'string', enum: [...VALID_SENSITIVITY_LEVELS] }),
          ),
        }),
        { description: 'Array of memory records to import' },
      ),
      source: Type.Optional(
        Type.String({ description: 'Import source label for provenance (e.g. "voxta", "backup"). Default: "import".' }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: {
        records: Array<{
          text: string;
          type: MemoryType;
          importance?: number;
          emotional_valence?: number;
          confidence?: number;
          tags?: string;
          sensitivity?: SensitivityLevel;
        }>;
        source?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const internalSource = extractInternalSource(params as Record<string, unknown>);
        const rawRecords = params.records;
        const source = params.source || 'import';

        if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
          return textResultWithError('Error: records must be a non-empty array', true);
        }

        // Validate and convert records
        const records: MemoryWriteOptions[] = [];
        for (let i = 0; i < rawRecords.length; i++) {
          const r = rawRecords[i];
          const text = r.text as string;
          const type = r.type as MemoryType;

          if (!text || text.trim().length === 0) {
            return textResultWithError(`Error: record[${i}] has empty text`, true);
          }
          if (!VALID_MEMORY_TYPES.includes(type)) {
            return textResultWithError(`Error: record[${i}] has invalid type "${type}"`, true);
          }

          const sourceContext = buildToolSourceContext(`memory_import:${source}`, toolCallId, internalSource);
          records.push({
            text: text.trim(),
            type,
            importance: r.importance !== undefined ? clamp(Number(r.importance), 0, 1) : undefined,
            emotionalValence: r.emotional_valence !== undefined ? clamp(Number(r.emotional_valence), -1, 1) : undefined,
            confidence: r.confidence !== undefined ? clamp(Number(r.confidence), 0, 1) : undefined,
            tags: parseTags(r.tags),
            sourceRef: sourceContext.sourceRef,
            sourceType: sourceContext.sourceType,
            provenance: sourceContext.provenance,
            sensitivity: r.sensitivity,
          });
        }

        const result = await writer.importBatch(records);

        return textResult(
          `Import complete: ${result.written} written, ${result.deduplicated} deduplicated, ` +
          `${result.superseded} superseded, ${result.errors} errors (${records.length} total)`,
        );
      } catch (error) {
        return textResultWithError(`Error importing memories: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryPatchTool(writer: MemoryWriter): AgentTool<any> {
  return {
    name: 'memory_patch',
    description:
      'Patch specific fields on an existing memory without deleting or superseding it. '
      + 'Use for surgical belief correction, emotional-weight adjustment, or tag/provenance correction. '
      + 'memory_id must be the plain memory id string. If you need an id from memory action=write, call memory first, read its tool result, then call memory_patch in a later assistant step.',
    label: 'memory_patch',
    parameters: Type.Object({
      memory_id: Type.String({ description: 'Memory ID to patch.' }),
      text: Type.Optional(Type.String({ description: 'Replacement memory text. Re-embeds the memory.' })),
      importance: Type.Optional(Type.Number({ description: '0-1 replacement importance.' })),
      confidence: Type.Optional(Type.Number({ description: '0-1 replacement confidence.' })),
      emotional_valence: Type.Optional(Type.Number({ description: '-1 to 1 replacement emotional valence.' })),
      formation_vad: Type.Optional(Type.Object({
        valence: Type.Number(),
        arousal: Type.Number(),
        dominance: Type.Number(),
      })),
      clear_formation_vad: Type.Optional(Type.Boolean({ description: 'Clear any existing formation VAD metadata.' })),
      tags: Type.Optional(Type.String({ description: 'Full replacement tag list as comma-separated values.' })),
      append_tags: Type.Optional(Type.String({ description: 'Tags to append as comma-separated values.' })),
      reason: Type.Optional(Type.String({ description: 'Audit reason for the patch.' })),
    }),
    execute: async (
      toolCallId: string,
      params: {
        memory_id: string;
        text?: string;
        importance?: number;
        confidence?: number;
        emotional_valence?: number;
        formation_vad?: MemoryFormationVAD;
        clear_formation_vad?: boolean;
        tags?: string;
        append_tags?: string;
        reason?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const internalSource = extractInternalSource(params as Record<string, unknown>);
        const memoryId = params.memory_id.trim();
        if (!memoryId) {
          return textResultWithError('Error: memory_id is required', true);
        }
        if (params.tags && params.append_tags) {
          return textResultWithError('Error: provide either tags or append_tags, not both', true);
        }
        const replacementTags = params.tags ? parseTags(params.tags) ?? [] : undefined;
        const appendTags = params.append_tags ? parseTags(params.append_tags) ?? [] : undefined;

        const sourceContext = buildToolSourceContext('memory_patch', toolCallId, internalSource);
        const result = await writer.patchMemory({
          memoryId,
          ...(params.text !== undefined ? { text: params.text } : {}),
          ...(params.importance !== undefined ? { importance: clamp(Number(params.importance), 0, 1) } : {}),
          ...(params.confidence !== undefined ? { confidence: clamp(Number(params.confidence), 0, 1) } : {}),
          ...(params.emotional_valence !== undefined
            ? { emotionalValence: clamp(Number(params.emotional_valence), -1, 1) }
            : {}),
          ...(params.formation_vad !== undefined ? { formationVAD: params.formation_vad } : {}),
          ...(params.clear_formation_vad !== undefined ? { clearFormationVAD: params.clear_formation_vad } : {}),
          ...(params.tags ? { tags: replacementTags } : {}),
          ...(params.append_tags ? { appendTags } : {}),
          ...(params.reason ? { reason: params.reason.trim() } : {}),
          sourceRef: sourceContext.sourceRef,
          sourceType: sourceContext.sourceType,
          provenance: sourceContext.provenance,
        });

        if (!result) {
          return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
        }

        return textResult(
          `Memory patched (id: ${result.memory.id}, event: ${result.patchEventId}, fields: ${result.updatedFields.join(', ')}).`,
        );
      } catch (error) {
        return textResultWithError(`Error patching memory: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryRedactTool(writer: MemoryWriter): AgentTool<any> {
  return {
    name: 'memory_redact',
    description:
      'Redact a memory using consent-aware behavior. ' +
      'operation=auto uses consent flags to choose delete vs abstraction. ' +
      'operation=delete always soft-deletes. operation=abstract keeps a generalized lesson and deletes the original.',
    label: 'memory_redact',
    parameters: Type.Object({
      memory_id: Type.String({ description: 'Memory ID to redact.' }),
      operation: Type.Optional(
        Type.Unsafe<MemoryRedactionOperation>({
          type: 'string',
          enum: [...VALID_MEMORY_REDACTION_OPERATIONS],
          description: 'auto (default), delete, or abstract.',
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: 'Reason for redaction (logged in delete checkpoint and abstraction provenance).' }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: {
        memory_id: string;
        operation?: MemoryRedactionOperation;
        reason?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const internalSource = extractInternalSource(params as Record<string, unknown>);
        const memoryId = params.memory_id.trim();
        if (!memoryId) {
          return textResultWithError('Error: memory_id is required', true);
        }

        const operation = params.operation ?? 'auto';
        if (!VALID_MEMORY_REDACTION_OPERATIONS.includes(operation)) {
          return textResultWithError(`Error: invalid operation "${operation}"`, true);
        }

        const sourceRef = buildToolSourceRef('memory_redact', toolCallId, internalSource);

        const redacted = await writer.redact({
          memoryId,
          operation,
          reason: params.reason?.trim(),
          requestedBy: sourceRef,
          sourceRef,
        });

        if (!redacted) {
          return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
        }

        if (redacted.operation === 'deleted') {
          return textResult(
            `Memory redacted via delete (id: ${redacted.sourceMemoryId}, delete_id: ${redacted.deleteId}, behavior: ${redacted.behavior}).`,
          );
        }

        return textResult(
          `Memory redacted via abstraction (source: ${redacted.sourceMemoryId}, abstracted: ${redacted.abstractedMemoryId}, ` +
          `delete_id: ${redacted.deleteId}, provenance_ref: ${redacted.externalProvenanceRef}).`,
        );
      } catch (error) {
        return textResultWithError(`Error redacting memory: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryDeleteTool(memoryStore: MemoryStorePort): AgentTool<any> {
  return {
    name: 'memory_delete',
    description:
      'Soft-delete a memory with a version snapshot checkpoint. ' +
      'Returns a delete_id that can be used with undo_memory_delete.',
    label: 'memory_delete',
    parameters: Type.Object({
      memory_id: Type.String({ description: 'Memory ID to soft-delete.' }),
      reason: Type.Optional(
        Type.String({ description: 'Reason for deletion (logged in safeguard audit/version snapshot).' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        memory_id: string;
        reason?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const memoryId = params.memory_id.trim();
        if (!memoryId) {
          return textResultWithError('Error: memory_id is required', true);
        }

        const deleted = await memoryStore.softDeleteMemory(memoryId, {
          deletedBy: 'tool:memory_delete',
          reason: params.reason?.trim(),
        });
        if (!deleted) {
          return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
        }

        return textResult(
          `Memory soft-deleted (id: ${deleted.memoryId}, delete_id: ${deleted.deleteId}). ` +
          'Use undo_memory_delete with delete_id to restore.',
        );
      } catch (error) {
        return textResultWithError(`Error deleting memory: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createUndoMemoryDeleteTool(memoryStore: MemoryStorePort): AgentTool<any> {
  return {
    name: 'undo_memory_delete',
    description:
      'Undo a prior memory_delete operation using its delete_id. ' +
      'Restores the soft-deleted memory from its checkpoint.',
    label: 'undo_memory_delete',
    parameters: Type.Object({
      delete_id: Type.String({ description: 'Delete checkpoint id returned by memory_delete.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        delete_id: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const deleteId = params.delete_id.trim();
        if (!deleteId) {
          return textResultWithError('Error: delete_id is required', true);
        }

        const restored = await memoryStore.undoSoftDelete(deleteId, {
          restoredBy: 'tool:undo_memory_delete',
        });
        if (!restored) {
          return textResultWithError(`Delete checkpoint not found or already restored: ${deleteId}`, true);
        }

        return textResult(`Memory restored (id: ${restored.memoryId}, delete_id: ${restored.deleteId}).`);
      } catch (error) {
        return textResultWithError(`Error restoring memory: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryTool(
  writer: MemoryWriter,
  memoryStore: MemoryStorePort,
  options: MemoryToolOptions = {},
): AgentTool<any> {
  return {
    name: 'memory',
    description:
      'Unified long-term memory tool. '
      + 'Use action=search with required query for lookup, action=write with required text and type to store memory, '
      + 'and action=census|exists|timeline for orientation before writing. '
      + 'Mutation actions require exact IDs: patch/redact/delete use memory_id; restore uses delete_id.',
    label: 'memory',
    parameters: Type.Object({
      action: Type.Unsafe<MemoryToolAction>({
        type: 'string',
        enum: [...MEMORY_TOOL_ACTIONS],
        description: 'One of: write, search, census, exists, timeline, import, patch, redact, delete, restore.',
      }),
      text: Type.Optional(
        Type.String({ description: 'Required for action=write. The memory text to store.' }),
      ),
      type: Type.Optional(
        Type.Unsafe<MemoryType>({
          type: 'string',
          enum: [...VALID_MEMORY_TYPES],
          description: 'Required for action=write. Memory type to store.',
        }),
      ),
      importance: Type.Optional(Type.Number({ description: 'Optional 0-1 significance for action=write.' })),
      emotional_valence: Type.Optional(Type.Number({ description: 'Optional -1 to 1 emotional valence for action=write.' })),
      confidence: Type.Optional(Type.Number({ description: 'Optional 0-1 confidence for action=write.' })),
      tags: Type.Optional(Type.String({ description: 'Optional comma-separated tags for action=write/import, or full replacement tags for action=patch.' })),
      append_tags: Type.Optional(Type.String({ description: 'Optional comma-separated tags to append for action=patch. Mutually exclusive with tags.' })),
      sensitivity: Type.Optional(
        Type.Unsafe<SensitivityLevel>({
          type: 'string',
          enum: [...VALID_SENSITIVITY_LEVELS],
          description: 'Optional sensitivity for action=write or action=import records.',
        }),
      ),
      query: Type.Optional(
        Type.String({ description: 'Required for action=search or action=exists. Lexical memory topic query.' }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Optional result limit for action=search or action=timeline. Search: ${MEMORY_SEARCH_DEFAULT_LIMIT}-${MEMORY_SEARCH_MAX_LIMIT}; timeline: ${MEMORY_TIMELINE_DEFAULT_LIMIT}-${MEMORY_TIMELINE_MAX_LIMIT}.`,
        }),
      ),
      contact_id: Type.Optional(
        Type.String({ description: 'For action=census or action=exists, restrict aggregate checks to one contact id.' }),
      ),
      scope_kind: Type.Optional(
        Type.Unsafe<MemoryScopeKind>({
          type: 'string',
          enum: [...VALID_MEMORY_SCOPE_KINDS],
          description: 'For action=census or action=exists with scope_id, restrict aggregate checks to this scope kind.',
        }),
      ),
      scope_id: Type.Optional(
        Type.String({ description: 'For action=census or action=exists with scope_kind, restrict aggregate checks to this scope id.' }),
      ),
      scope_tag: Type.Optional(
        Type.String({ description: 'For action=census or action=exists, restrict aggregate checks to memories carrying this scope tag.' }),
      ),
      include_archived: Type.Optional(
        Type.Boolean({ description: 'For action=census or action=exists, include soft-deleted or superseded memories in aggregate counts.' }),
      ),
      date: Type.Optional(
        Type.String({ description: 'For action=timeline, UTC day to navigate as YYYY-MM-DD.' }),
      ),
      after: Type.Optional(
        Type.String({ description: 'For action=timeline, inclusive range start as YYYY-MM-DD or ISO-8601 timestamp with timezone.' }),
      ),
      before: Type.Optional(
        Type.String({ description: 'For action=timeline, inclusive range end as YYYY-MM-DD or ISO-8601 timestamp with timezone.' }),
      ),
      channel_id: Type.Optional(
        Type.String({ description: 'For action=census, action=exists, or action=timeline, current channel id. Usually supplied by runtime context.' }),
      ),
      trust_level: Type.Optional(
        Type.Unsafe<TrustLevel>({
          type: 'string',
          enum: [...TRUST_LEVELS],
          description: 'For action=census, action=exists, or action=timeline, current viewer trust level. Usually supplied by runtime context.',
        }),
      ),
      channel_visibility: Type.Optional(
        Type.Unsafe<ChannelPrivacy>({
          type: 'string',
          enum: [...CHANNEL_PRIVACY_VALUES],
          description: 'For action=census, action=exists, or action=timeline, current channel visibility. Usually supplied by runtime context.',
        }),
      ),
      canonical_contact_id: Type.Optional(
        Type.String({ description: 'For action=census, action=exists, or action=timeline, optional canonical contact id for trusted cross-channel continuity.' }),
      ),
      records: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String(),
            type: Type.Unsafe<MemoryType>({ type: 'string', enum: [...VALID_MEMORY_TYPES] }),
            importance: Type.Optional(Type.Number()),
            emotional_valence: Type.Optional(Type.Number()),
            confidence: Type.Optional(Type.Number()),
            tags: Type.Optional(Type.String()),
            sensitivity: Type.Optional(
              Type.Unsafe<SensitivityLevel>({ type: 'string', enum: [...VALID_SENSITIVITY_LEVELS] }),
            ),
          }),
          { description: 'Required for action=import. Array of memory records to import.' },
        ),
      ),
      source: Type.Optional(
        Type.String({ description: 'Optional import source label for action=import. Default: "import".' }),
      ),
      memory_id: Type.Optional(
        Type.String({ description: 'Required for action=patch, action=redact, or action=delete. Memory ID to mutate.' }),
      ),
      operation: Type.Optional(
        Type.Unsafe<MemoryRedactionOperation>({
          type: 'string',
          enum: [...VALID_MEMORY_REDACTION_OPERATIONS],
          description: 'Optional redaction mode for action=redact: auto, delete, or abstract.',
        }),
      ),
      reason: Type.Optional(
        Type.String({ description: 'Optional reason logged for patch/redact/delete operations.' }),
      ),
      delete_id: Type.Optional(
        Type.String({ description: 'Required for action=restore. Delete checkpoint ID to restore.' }),
      ),
      formation_vad: Type.Optional(Type.Object({
        valence: Type.Number(),
        arousal: Type.Number(),
        dominance: Type.Number(),
      })),
      clear_formation_vad: Type.Optional(Type.Boolean({ description: 'Clear existing formation VAD metadata for action=patch.' })),
    }),
    execute: async (
      toolCallId: string,
      params: MemoryToolParams,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const normalizedParams = (normalizeToolArguments(
          'memory',
          params as unknown as Record<string, unknown>,
        ) ?? params) as MemoryToolParams;
        const internalSource = extractInternalSource(normalizedParams as unknown as Record<string, unknown>);
        const action = normalizedParams.action;

        if (!MEMORY_TOOL_ACTIONS.includes(action)) {
          return textResultWithError(`Error: invalid action "${String(action)}"`, true);
        }

        switch (action) {
          case 'write': {
            const text = normalizedParams.text?.trim();
            const type = normalizedParams.type;
            if (!text) {
              return textResultWithError('Error: text is required for action=write', true);
            }
            if (!type) {
              return textResultWithError('Error: type is required for action=write', true);
            }
            if (!VALID_MEMORY_TYPES.includes(type)) {
              return textResultWithError(
                `Error: invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
                true,
              );
            }

            const sourceContext = buildUnifiedMemorySourceContext('write', toolCallId, internalSource);
            const result = await writer.write({
              text,
              type,
              importance: normalizedParams.importance !== undefined ? clamp(Number(normalizedParams.importance), 0, 1) : undefined,
              emotionalValence: normalizedParams.emotional_valence !== undefined
                ? clamp(Number(normalizedParams.emotional_valence), -1, 1)
                : undefined,
              formationVAD: options.getFormationVAD?.(),
              confidence: normalizedParams.confidence !== undefined ? clamp(Number(normalizedParams.confidence), 0, 1) : undefined,
              tags: parseTags(normalizedParams.tags),
              sourceRef: sourceContext.sourceRef,
              sourceType: sourceContext.sourceType,
              provenance: sourceContext.provenance,
              sensitivity: normalizedParams.sensitivity,
            });

            switch (result.action) {
              case 'created':
                return textResult(`Memory created (id: ${result.memory.id}, type: ${type})`);
              case 'deduplicated':
                return textResult(`Duplicate detected — bumped salience on existing memory (id: ${result.existingId})`);
              case 'updated':
                return textResult(`Memory created and linked as a compatible update (id: ${result.memory.id}, type: ${type})`);
              case 'superseded':
                return textResult(`Memory created, superseding older conflicting memory (id: ${result.memory.id}, type: ${type})`);
              case 'negated':
                return textResult(`Memory created and linked as negating prior memory (id: ${result.memory.id}, type: ${type})`);
              case 'conflict':
                return textResult(`Memory created and linked for conflict review (id: ${result.memory.id}, type: ${type})`);
            }
            break;
          }

          case 'search': {
            const query = normalizedParams.query?.trim();
            if (!query) {
              return textResultWithError(
                'Error: query is required for action=search. '
                + 'Missing required field "query". '
                + 'Minimal valid JSON: {"action":"search","query":"topic"}. '
                + 'Do not retry action=search without a non-empty query.',
                true,
              );
            }

            const limit = normalizedParams.limit === undefined
              ? MEMORY_SEARCH_DEFAULT_LIMIT
              : clampInt(normalizedParams.limit, 1, MEMORY_SEARCH_MAX_LIMIT);
            const results = await memoryStore.searchByText(query, limit);
            return textResult(formatMemorySearchResults(results.map(memory => ({
              id: memory.id,
              text: memory.text,
              type: memory.type,
              sensitivity: memory.sensitivity,
              similarity: memory.similarity,
            }))));
          }

          case 'census': {
            const visibility = resolveMemoryVisibility(normalizedParams, 'census');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }
            const filterResult = resolveMemoryVisibilityFilter(normalizedParams, true);
            if (!filterResult.ok) {
              return textResultWithError(filterResult.error, true);
            }
            const filter: MemoryVisibilityFilter = {
              ...(filterResult.contactId ? { contactId: filterResult.contactId } : {}),
              ...(filterResult.scopeQuery ? { scopeQuery: filterResult.scopeQuery } : {}),
              includeArchived: filterResult.includeArchived ?? true,
            };
            const memories = await listFilteredMemories(memoryStore, filter);
            const partition = partitionVisibleMemories(memories, {
              trustLevel: visibility.trustLevel,
              channelPrivacy: visibility.channelVisibility,
              broadcast: visibility.broadcast,
              ...(visibility.canonicalContactId ? { canonicalContactId: visibility.canonicalContactId } : {}),
            });
            return textResult(formatMemoryCensusResult(partition));
          }

          case 'exists': {
            const query = normalizedParams.query?.trim();
            if (!query) {
              return textResultWithError('Error: query is required for action=exists', true);
            }
            const visibility = resolveMemoryVisibility(normalizedParams, 'exists');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }
            const filterResult = resolveMemoryVisibilityFilter(normalizedParams, false);
            if (!filterResult.ok) {
              return textResultWithError(filterResult.error, true);
            }
            const filter: MemoryVisibilityFilter = {
              ...(filterResult.contactId ? { contactId: filterResult.contactId } : {}),
              ...(filterResult.scopeQuery ? { scopeQuery: filterResult.scopeQuery } : {}),
              includeArchived: filterResult.includeArchived ?? false,
            };
            const memories = await listFilteredMemories(memoryStore, filter);
            const matchingMemories = filterTopicMatches(memories, query);
            const partition = partitionVisibleMemories(matchingMemories, {
              trustLevel: visibility.trustLevel,
              channelPrivacy: visibility.channelVisibility,
              broadcast: visibility.broadcast,
              ...(visibility.canonicalContactId ? { canonicalContactId: visibility.canonicalContactId } : {}),
            });
            return textResult(formatMemoryExistsResult(partition));
          }

          case 'timeline': {
            if (!options.episodicStore) {
              return textResultWithError('Error: episodic timeline store is not configured for action=timeline', true);
            }

            const range = resolveTimelineRange(normalizedParams);
            if (!range.ok) {
              return textResultWithError(range.error, true);
            }
            const visibility = resolveMemoryVisibility(normalizedParams, 'timeline');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }

            const limit = normalizedParams.limit === undefined
              ? MEMORY_TIMELINE_DEFAULT_LIMIT
              : clampInt(normalizedParams.limit, 1, MEMORY_TIMELINE_MAX_LIMIT);
            const entries = await retrieveEpisodicTimeline(options.episodicStore, {
              ...(range.from ? { from: range.from } : {}),
              ...(range.to ? { to: range.to } : {}),
              channelId: visibility.channelId,
              trustLevel: visibility.trustLevel,
              channelDisclosure: {
                channelPrivacy: visibility.channelVisibility,
                broadcast: visibility.broadcast,
              },
              ...(visibility.canonicalContactId ? { canonicalContactId: visibility.canonicalContactId } : {}),
              limit,
            });
            return textResult(formatEpisodicTimeline(entries, range.label));
          }

          case 'import': {
            const rawRecords = normalizedParams.records;
            const source = normalizedParams.source?.trim() || 'import';
            if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
              return textResultWithError('Error: records must be a non-empty array for action=import', true);
            }

            const records: MemoryWriteOptions[] = [];
            for (let i = 0; i < rawRecords.length; i++) {
              const record = rawRecords[i];
              const text = record.text.trim();
              const type = record.type;

              if (!text) {
                return textResultWithError(`Error: record[${i}] has empty text`, true);
              }
              if (!VALID_MEMORY_TYPES.includes(type)) {
                return textResultWithError(`Error: record[${i}] has invalid type "${type}"`, true);
              }

              const sourceContext = buildUnifiedMemorySourceContext(
                'import',
                toolCallId,
                internalSource,
                [`import_source:${source}`],
              );
              records.push({
                text,
                type,
                importance: record.importance !== undefined ? clamp(Number(record.importance), 0, 1) : undefined,
                emotionalValence: record.emotional_valence !== undefined
                  ? clamp(Number(record.emotional_valence), -1, 1)
                  : undefined,
                confidence: record.confidence !== undefined ? clamp(Number(record.confidence), 0, 1) : undefined,
                tags: parseTags(record.tags),
                sourceRef: sourceContext.sourceRef,
                sourceType: sourceContext.sourceType,
                provenance: sourceContext.provenance,
                sensitivity: record.sensitivity,
              });
            }

            const result = await writer.importBatch(records);
            return textResult(
              `Import complete: ${result.written} written, ${result.deduplicated} deduplicated, `
              + `${result.superseded} superseded, ${result.errors} errors (${records.length} total)`,
            );
          }

          case 'patch': {
            const memoryId = normalizedParams.memory_id?.trim();
            if (!memoryId) {
              return textResultWithError('Error: memory_id is required for action=patch', true);
            }
            if (normalizedParams.tags && normalizedParams.append_tags) {
              return textResultWithError('Error: provide either tags or append_tags for action=patch, not both', true);
            }

            const replacementTags = normalizedParams.tags ? parseTags(normalizedParams.tags) ?? [] : undefined;
            const appendTags = normalizedParams.append_tags ? parseTags(normalizedParams.append_tags) ?? [] : undefined;
            const sourceContext = buildUnifiedMemorySourceContext('patch', toolCallId, internalSource);
            const result = await writer.patchMemory({
              memoryId,
              ...(normalizedParams.text !== undefined ? { text: normalizedParams.text } : {}),
              ...(normalizedParams.importance !== undefined ? { importance: clamp(Number(normalizedParams.importance), 0, 1) } : {}),
              ...(normalizedParams.confidence !== undefined ? { confidence: clamp(Number(normalizedParams.confidence), 0, 1) } : {}),
              ...(normalizedParams.emotional_valence !== undefined
                ? { emotionalValence: clamp(Number(normalizedParams.emotional_valence), -1, 1) }
                : {}),
              ...(normalizedParams.formation_vad !== undefined ? { formationVAD: normalizedParams.formation_vad } : {}),
              ...(normalizedParams.clear_formation_vad !== undefined ? { clearFormationVAD: normalizedParams.clear_formation_vad } : {}),
              ...(normalizedParams.tags ? { tags: replacementTags } : {}),
              ...(normalizedParams.append_tags ? { appendTags } : {}),
              ...(normalizedParams.reason ? { reason: normalizedParams.reason.trim() } : {}),
              sourceRef: sourceContext.sourceRef,
              sourceType: sourceContext.sourceType,
              provenance: sourceContext.provenance,
            });

            if (!result) {
              return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
            }

            return textResult(
              `Memory patched (id: ${result.memory.id}, event: ${result.patchEventId}, fields: ${result.updatedFields.join(', ')}).`,
            );
          }

          case 'redact': {
            const memoryId = normalizedParams.memory_id?.trim();
            if (!memoryId) {
              return textResultWithError('Error: memory_id is required for action=redact', true);
            }

            const operation = normalizedParams.operation ?? 'auto';
            if (!VALID_MEMORY_REDACTION_OPERATIONS.includes(operation)) {
              return textResultWithError(`Error: invalid operation "${operation}"`, true);
            }

            const sourceContext = buildUnifiedMemorySourceContext('redact', toolCallId, internalSource);
            const redacted = await writer.redact({
              memoryId,
              operation,
              reason: normalizedParams.reason?.trim(),
              requestedBy: sourceContext.sourceRef,
              sourceRef: sourceContext.sourceRef,
            });

            if (!redacted) {
              return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
            }

            if (redacted.operation === 'deleted') {
              return textResult(
                `Memory redacted via delete (id: ${redacted.sourceMemoryId}, delete_id: ${redacted.deleteId}, behavior: ${redacted.behavior}).`,
              );
            }

            return textResult(
              `Memory redacted via abstraction (source: ${redacted.sourceMemoryId}, abstracted: ${redacted.abstractedMemoryId}, `
              + `delete_id: ${redacted.deleteId}, provenance_ref: ${redacted.externalProvenanceRef}).`,
            );
          }

          case 'delete': {
            const memoryId = normalizedParams.memory_id?.trim();
            if (!memoryId) {
              return textResultWithError('Error: memory_id is required for action=delete', true);
            }

            const deleted = await memoryStore.softDeleteMemory(memoryId, {
              deletedBy: 'tool:memory|action:delete',
              reason: normalizedParams.reason?.trim(),
            });
            if (!deleted) {
              return textResultWithError(`Memory not found or already deleted: ${memoryId}`, true);
            }

            return textResult(
              `Memory soft-deleted (id: ${deleted.memoryId}, delete_id: ${deleted.deleteId}). `
              + 'Use action=restore with delete_id to restore.',
            );
          }

          case 'restore': {
            const deleteId = normalizedParams.delete_id?.trim();
            if (!deleteId) {
              return textResultWithError('Error: delete_id is required for action=restore', true);
            }

            const restored = await memoryStore.undoSoftDelete(deleteId, {
              restoredBy: 'tool:memory|action:restore',
            });
            if (!restored) {
              return textResultWithError(`Delete checkpoint not found or already restored: ${deleteId}`, true);
            }

            return textResult(`Memory restored (id: ${restored.memoryId}, delete_id: ${restored.deleteId}).`);
          }
        }

        return textResultWithError(`Error: unsupported memory action "${action}"`, true);
      } catch (error) {
        return textResultWithError(`Error executing memory action: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createScratchpadTool(memoryStore: MemoryStorePort): AgentTool<any> {
  return {
    name: 'scratchpad',
    description:
      '24h ephemeral working-note workspace for temporary excerpts, summaries, and same-day task context. '
      + 'Use action=list|add|replace|append|remove. Do not use scratchpad for durable reminders, proactive follow-ups, relationship state, journals, or stable memories. '
      + 'Use orient concerns/open threads for reminders and proactive follow-ups, memory for stable facts, and journal for durable markdown notes.',
    label: 'scratchpad',
    parameters: Type.Object({
      action: Type.Unsafe<ScratchpadToolAction>({
        type: 'string',
        enum: [...SCRATCHPAD_TOOL_ACTIONS],
        description: 'One of: list, add, replace, append, remove.',
      }),
      limit: Type.Optional(
        Type.Number({ description: `Used with action=list. Maximum notes to return (1-${SCRATCHPAD_MAX_LIMIT}, default ${SCRATCHPAD_DEFAULT_LIMIT}).` }),
      ),
      id: Type.Optional(
        Type.String({ description: 'Required for action=replace, action=append, and action=remove. Scratchpad entry id.' }),
      ),
      content: Type.Optional(
        Type.String({ description: 'Required for action=add, action=replace, and action=append. Scratchpad note text.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action: ScratchpadToolAction;
        limit?: number;
        id?: string;
        content?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = params.action;
        if (!SCRATCHPAD_TOOL_ACTIONS.includes(action)) {
          return textResultWithError(`Error: invalid action "${action}"`, true);
        }

        switch (action) {
          case 'list': {
            const limit = params.limit === undefined
              ? SCRATCHPAD_DEFAULT_LIMIT
              : clampInt(params.limit, 1, SCRATCHPAD_MAX_LIMIT);
            const entries = memoryStore.listScratchpadEntries(limit);
            return textResult(formatScratchpadList(entries));
          }

          case 'add': {
            const content = params.content?.trim();
            if (!content) {
              return textResultWithError('Error: content is required for action=add', true);
            }
            const result = await memoryStore.addScratchpadEntry(content);
            const evictedSuffix = result.evictedIds.length > 0
              ? ` Evicted oldest ids: ${result.evictedIds.join(', ')}`
              : '';
            return textResult(
              `Scratchpad entry added (id: ${result.entry.id}). `
              + 'Keep temporary working context here; promote only stable outcomes elsewhere.'
              + evictedSuffix,
            );
          }

          case 'replace': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=replace', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for action=replace', true);
            }
            const replaced = await memoryStore.replaceScratchpadEntry(id, content);
            if (!replaced) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry replaced (id: ${replaced.id}).`);
          }

          case 'append': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=append', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for action=append', true);
            }
            const appended = await memoryStore.appendScratchpadEntry(id, content);
            if (!appended) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry appended (id: ${appended.id}).`);
          }

          case 'remove': {
            const id = params.id?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for action=remove', true);
            }
            const removed = await memoryStore.removeScratchpadEntry(id);
            if (!removed) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry removed (id: ${id}).`);
          }
        }

        return textResultWithError(`Error: unsupported scratchpad action "${action}"`, true);
      } catch (error) {
        return textResultWithError(`Error using scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createScratchpadReadTool(memoryStore: MemoryStorePort): AgentTool<any> {
  return {
    name: 'scratchpad_read',
    description:
      'List current scratchpad entries (short-lived working notes). ' +
      'Use before replacing or removing notes so you can reference the right id.',
    label: 'scratchpad_read',
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({ description: `Maximum notes to return (1-${SCRATCHPAD_MAX_LIMIT}, default ${SCRATCHPAD_DEFAULT_LIMIT}).` }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { limit?: number },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const limit = params.limit === undefined
          ? SCRATCHPAD_DEFAULT_LIMIT
          : clampInt(params.limit, 1, SCRATCHPAD_MAX_LIMIT);
        const entries = memoryStore.listScratchpadEntries(limit);
        return textResult(formatScratchpadList(entries));
      } catch (error) {
        return textResultWithError(`Error reading scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}

type ScratchpadWriteOperation = 'add' | 'replace' | 'remove';
const SCRATCHPAD_WRITE_OPERATIONS: ScratchpadWriteOperation[] = ['add', 'replace', 'remove'];

export function createScratchpadWriteTool(memoryStore: MemoryStorePort): AgentTool<any> {
  return {
    name: 'scratchpad_write',
    description:
      'Mutate scratchpad notes with add/replace/remove operations. ' +
      'Scratchpad is bounded and intended for short-lived working memory.',
    label: 'scratchpad_write',
    parameters: Type.Object({
      operation: Type.Unsafe<ScratchpadWriteOperation>({
        type: 'string',
        enum: [...SCRATCHPAD_WRITE_OPERATIONS],
        description: 'One of: add, replace, remove.',
      }),
      id: Type.Optional(
        Type.String({ description: 'Required for replace/remove. Scratchpad entry id.' }),
      ),
      content: Type.Optional(
        Type.String({ description: 'Required for add/replace. Scratchpad note text.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        operation: ScratchpadWriteOperation;
        id?: string;
        content?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const operation = params.operation;
        if (!SCRATCHPAD_WRITE_OPERATIONS.includes(operation)) {
          return textResultWithError(`Error: invalid operation "${operation}"`, true);
        }

        switch (operation) {
          case 'add': {
            const content = params.content?.trim();
            if (!content) {
              return textResultWithError('Error: content is required for add', true);
            }
            const result = await memoryStore.addScratchpadEntry(content);
            const evictedSuffix = result.evictedIds.length > 0
              ? ` Evicted oldest ids: ${result.evictedIds.join(', ')}`
              : '';
            return textResult(`Scratchpad entry added (id: ${result.entry.id}).${evictedSuffix}`);
          }
          case 'replace': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for replace', true);
            }
            if (!content) {
              return textResultWithError('Error: content is required for replace', true);
            }
            const replaced = await memoryStore.replaceScratchpadEntry(id, content);
            if (!replaced) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry replaced (id: ${replaced.id}).`);
          }
          case 'remove': {
            const id = params.id?.trim();
            if (!id) {
              return textResultWithError('Error: id is required for remove', true);
            }
            const removed = await memoryStore.removeScratchpadEntry(id);
            if (!removed) {
              return textResultWithError(`Scratchpad entry not found: ${id}`, true);
            }
            return textResult(`Scratchpad entry removed (id: ${id}).`);
          }
        }
      } catch (error) {
        return textResultWithError(`Error writing scratchpad: ${errorMessage(error)}`, true);
      }
    },
  };
}
