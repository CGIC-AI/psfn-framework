import type { MemoryStorePort } from '../memory-store-port.js';
import type {
  MemoryScopeKind,
  MemoryScopeQuery,
  PurrMemory,
} from '../types.js';
import {
  memoryMatchesScopeQuery,
  normalizeMemoryScopeQuery,
  VALID_MEMORY_SCOPE_KINDS,
} from '../types.js';
import {
  TRUST_LEVELS,
  type TrustLevel,
} from '../../../system/trust/types.js';
import {
  CHANNEL_PRIVACY_VALUES,
  type ChannelPrivacy,
} from '../../../system/trust/context-envelope.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import {
  evaluateRetrievalAccessDecision,
  summarizeWithheldMemories,
} from '../retrieval/access.js';
import type {
  SharedBackgroundResult,
  SharedBackgroundSource,
} from '../retrieval/shared-background.js';
import {
  formatMemoryWithheldReasonLabel,
  formatMemoryWithheldRelevanceBandLabel,
  listMemoryWithheldReasonEntries,
  listMemoryWithheldRelevanceBandEntries,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';
import {
  lexicalMemoryScoreToSimilarity,
  normalizeLexicalMemoryQuery,
  scoreLexicalMemoryMatch,
  tokenizeLexicalMemoryQuery,
} from '../lexical-match.js';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/i;

type TimelineRangeParams = {
  date?: unknown;
  after?: unknown;
  before?: unknown;
};

type TimelineRangeResult =
  | { ok: true; from?: string; to?: string; label: string }
  | { ok: false; error: string };

type MemoryVisibilityParams = {
  channel_id?: unknown;
  channelId?: unknown;
  trust_level?: unknown;
  trustLevel?: unknown;
  channel_visibility?: unknown;
  channelVisibility?: unknown;
  canonical_contact_id?: unknown;
  canonicalContactId?: unknown;
};

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

export type MemoryVisibilityAction = 'timeline' | 'census' | 'exists' | 'shared_background';

type MemoryScopeFilterParams = {
  contact_id?: unknown;
  contactId?: unknown;
  scope_kind?: unknown;
  scopeKind?: unknown;
  scope_id?: unknown;
  scopeId?: unknown;
  scope_tag?: unknown;
  scopeTag?: unknown;
  include_archived?: unknown;
  includeArchived?: unknown;
};

type MemoryScopeFilterResult =
  | {
    ok: true;
    contactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }
  | { ok: false; error: string };

export interface MemoryVisibilityFilter {
  contactId?: string;
  scopeQuery?: MemoryScopeQuery;
  includeArchived: boolean;
}

export interface MemoryAccessOptions {
  trustLevel: TrustLevel;
  channelPrivacy: ChannelPrivacy;
  broadcast: boolean;
  canonicalContactId?: string;
}

export interface MemoryAccessPartition {
  visible: PurrMemory[];
  withheld: Array<PurrMemory & { similarity?: number }>;
  withheldSummary?: MemoryWithheldSummary;
}

export function resolveTimelineRange(params: TimelineRangeParams): TimelineRangeResult {
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

export function resolveMemoryVisibility(
  params: MemoryVisibilityParams,
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

export function normalizeOptionalToolString(value: unknown): string | undefined {
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

export function resolveMemoryVisibilityFilter(
  params: MemoryScopeFilterParams,
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

export async function listFilteredMemories(
  memoryStore: MemoryStorePort,
  filter: MemoryVisibilityFilter,
): Promise<PurrMemory[]> {
  const memories = await memoryStore.listMemories();
  return memories.filter(memory => memoryMatchesVisibilityFilter(memory, filter));
}

export function partitionVisibleMemories<T extends PurrMemory & { similarity?: number }>(
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

export function formatMemoryCensusResult(partition: MemoryAccessPartition): string {
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

export function formatMemoryExistsResult(partition: MemoryAccessPartition): string {
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

const SHARED_BACKGROUND_SOURCE_LABELS: Record<SharedBackgroundSource, string> = {
  edge_evidence: 'edge-evidence',
  co_mention: 'co-mention',
  shared_room: 'shared-room',
};

function formatSharedBackgroundSources(sources: readonly SharedBackgroundSource[]): string {
  if (sources.length === 0) return 'unknown';
  return sources.map(source => SHARED_BACKGROUND_SOURCE_LABELS[source]).join(', ');
}

export function formatSharedBackgroundResult(result: SharedBackgroundResult): string {
  const nameA = result.contactADisplayName ?? result.contactAId;
  const nameB = result.contactBDisplayName ?? result.contactBId;
  const lines = [`Shared background between ${nameA} and ${nameB}:`];

  if (!result.resolved) {
    const missing = result.missingContactIds.length > 0
      ? result.missingContactIds.join(', ')
      : 'one or both contacts';
    lines.push(`- Could not resolve both contacts (${missing}). No shared background returned.`);
    lines.push('No memory text returned.');
    return lines.join('\n');
  }

  if (result.items.length === 0) {
    lines.push('- No shared-background memories are visible in this context.');
  } else {
    lines.push(`- Visible shared-background memories: ${result.items.length} (of ${result.totalCandidates} candidate${result.totalCandidates === 1 ? '' : 's'}).`);
    for (const item of result.items) {
      lines.push(
        `- [${formatSharedBackgroundSources(item.sources)}] `
        + `(${item.memory.type}; ${item.memory.sensitivity}): ${item.memory.text}`,
      );
    }
  }

  if (result.truncated) {
    lines.push(`- Result truncated to the top ${result.limit} by evidence-source priority, then salience, then recency.`);
  }

  if (result.withheldSummary && result.withheldSummary.totalCount > 0) {
    const plural = result.withheldSummary.totalCount === 1 ? 'memory was' : 'memories were';
    lines.push(
      `- Withheld context: ${result.withheldSummary.totalCount} candidate ${plural} present but withheld by trust/privacy gates.`,
    );
    const reasonLine = listMemoryWithheldReasonEntries(result.withheldSummary.reasonCounts)
      .map(({ reason, count }) => `${count} ${formatMemoryWithheldReasonLabel(reason)}`)
      .join(', ');
    if (reasonLine) {
      lines.push(`- Withheld trust/privacy reasons: ${reasonLine}.`);
    }
    lines.push('- Protected withheld memory text, memory IDs, contact IDs, and scope labels are not included.');
  }

  return lines.join('\n');
}

export function filterTopicMatches(memories: readonly PurrMemory[], query: string): Array<PurrMemory & { similarity: number }> {
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
