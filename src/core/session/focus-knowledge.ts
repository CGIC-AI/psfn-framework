import { existsSync, readFileSync } from 'node:fs';
import type { SessionEntry } from './types.js';
import { appendJsonLine } from '../../persistence/jsonl.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { MemoryScopeQuery } from '../../memory/types.js';
import { normalizeMemoryScopeRefs, normalizeMemoryScopeTags } from '../../memory/types.js';

const log = createComponentLogger('FocusKnowledge');

const DEFAULT_KNOWLEDGE_LIST_LIMIT = 8;
const MAX_FOCUS_SCOPE_CHARS = 300;
const MAX_FOCUS_KNOWLEDGE_CHARS = 2_000;
const MAX_FOCUS_EVIDENCE_SNIPPET_CHARS = 200;
const MAX_FOCUS_EVIDENCE_QUERY_CHARS = 200;
const MAX_FOCUS_EVIDENCE_ITEMS = 32;

export interface FocusEvidenceRecord {
  source: string;
  snippet: string;
  query?: string;
  resultCount?: number;
  attempt?: number;
  timestamp: number;
}

export interface FocusCompactionRange {
  startEntryId: number;
  endEntryId: number;
}

export interface FocusKnowledgeBlock {
  id: string;
  channelId: string;
  focusId: string;
  scope: string;
  knowledge: string;
  createdAt: number;
  startedAt: number;
  completedAt: number;
  rangeStartId?: number;
  rangeEndId?: number;
  evidenceCount: number;
  evidence: FocusEvidenceRecord[];
}

export interface FocusProjectContextSummary {
  channelId: string;
  scope: string;
  scopeKey: string;
  knowledgeBlockCount: number;
  totalEvidenceCount: number;
  latestKnowledgeBlockId: string;
  latestKnowledge: string;
  latestCompletedAt: number;
  startedAt: number;
}

export interface FocusKnowledgeAppendInput {
  channelId: string;
  focusId: string;
  scope: string;
  knowledge: string;
  startedAt: number;
  completedAt?: number;
  rangeStartId?: number;
  rangeEndId?: number;
  evidenceCount?: number;
  evidence?: FocusEvidenceRecord[];
}

interface FocusKnowledgeListOptions {
  limit?: number;
}

interface FocusKnowledgeStoreOptions {
  now?: () => number;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeScopeKey(value: string): string {
  return compactText(value).toLowerCase();
}

export function buildFocusMemoryScopeQuery(scope: string): MemoryScopeQuery | null {
  const compactScope = compactText(scope);
  if (!compactScope) return null;

  const scopeKey = normalizeScopeKey(compactScope);
  const refs = normalizeMemoryScopeRefs([
    { kind: 'project', id: compactScope },
    ...(scopeKey !== compactScope ? [{ kind: 'project', id: scopeKey }] : []),
  ]);
  const tags = normalizeMemoryScopeTags([
    `project:${scopeKey}`,
    `scope:${scopeKey}`,
  ]);

  return {
    ...(refs.length > 0 ? { refs } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    mode: 'only',
  };
}

function clampText(value: string, maxChars: number): string {
  const compact = compactText(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 3)}...`;
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function normalizeFiniteInteger(value: unknown): number | undefined {
  const normalized = normalizeFiniteNumber(value);
  if (normalized === undefined) return undefined;
  return Math.floor(normalized);
}

function normalizeOptionalRange(
  startEntryId: unknown,
  endEntryId: unknown,
): { rangeStartId: number; rangeEndId: number } | null {
  const start = normalizeFiniteInteger(startEntryId);
  const end = normalizeFiniteInteger(endEntryId);
  if (start === undefined || end === undefined) return null;
  if (start <= 0 || end <= 0 || end < start) return null;
  return { rangeStartId: start, rangeEndId: end };
}

export function normalizeFocusEvidence(value: unknown): FocusEvidenceRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const source = typeof candidate.source === 'string' ? compactText(candidate.source) : '';
  const snippet = typeof candidate.snippet === 'string'
    ? clampText(candidate.snippet, MAX_FOCUS_EVIDENCE_SNIPPET_CHARS)
    : '';

  if (!source || !snippet) return null;

  const timestamp = normalizeFiniteInteger(candidate.timestamp) ?? Date.now();
  const query = typeof candidate.query === 'string'
    ? clampText(candidate.query, MAX_FOCUS_EVIDENCE_QUERY_CHARS)
    : undefined;
  const resultCount = normalizeFiniteInteger(candidate.resultCount);
  const attempt = normalizeFiniteInteger(candidate.attempt);

  return {
    source,
    snippet,
    ...(query ? { query } : {}),
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    timestamp,
  };
}

function normalizeEvidenceList(value: unknown): FocusEvidenceRecord[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((item) => normalizeFocusEvidence(item))
    .filter((item): item is FocusEvidenceRecord => item !== null);
  if (normalized.length <= MAX_FOCUS_EVIDENCE_ITEMS) return normalized;
  return normalized.slice(0, MAX_FOCUS_EVIDENCE_ITEMS);
}

function normalizeBlock(raw: unknown): FocusKnowledgeBlock | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  const id = typeof candidate.id === 'string' ? compactText(candidate.id) : '';
  const channelId = typeof candidate.channelId === 'string' ? compactText(candidate.channelId) : '';
  const focusId = typeof candidate.focusId === 'string' ? compactText(candidate.focusId) : '';
  const scope = typeof candidate.scope === 'string'
    ? clampText(candidate.scope, MAX_FOCUS_SCOPE_CHARS)
    : '';
  const knowledge = typeof candidate.knowledge === 'string'
    ? clampText(candidate.knowledge, MAX_FOCUS_KNOWLEDGE_CHARS)
    : '';
  const createdAt = normalizeFiniteInteger(candidate.createdAt);
  const startedAt = normalizeFiniteInteger(candidate.startedAt);
  const completedAt = normalizeFiniteInteger(candidate.completedAt);
  const evidenceCount = normalizeFiniteInteger(candidate.evidenceCount) ?? 0;
  const evidence = normalizeEvidenceList(candidate.evidence);

  if (!id || !channelId || !focusId || !scope || !knowledge) {
    return null;
  }
  if (createdAt === undefined || startedAt === undefined || completedAt === undefined) {
    return null;
  }

  const range = normalizeOptionalRange(candidate.rangeStartId, candidate.rangeEndId);
  return {
    id,
    channelId,
    focusId,
    scope,
    knowledge,
    createdAt,
    startedAt,
    completedAt,
    ...(range ? range : {}),
    evidenceCount: Math.max(0, evidenceCount),
    evidence,
  };
}

function buildFocusKnowledgeId(now: number): string {
  return `focus-${now.toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

function normalizeListLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined) {
    return DEFAULT_KNOWLEDGE_LIST_LIMIT;
  }
  return Math.max(1, Math.floor(limit));
}

function mergeCompactionRanges(ranges: FocusCompactionRange[]): FocusCompactionRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((left, right) => (
    left.startEntryId === right.startEntryId
      ? left.endEntryId - right.endEntryId
      : left.startEntryId - right.startEntryId
  ));

  const merged: FocusCompactionRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...range });
      continue;
    }
    if (range.startEntryId <= previous.endEntryId + 1) {
      previous.endEntryId = Math.max(previous.endEntryId, range.endEntryId);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

export function applyFocusCompactionRanges(
  entries: SessionEntry[],
  ranges: readonly FocusCompactionRange[],
): { entries: SessionEntry[]; compactedCount: number } {
  if (entries.length === 0 || ranges.length === 0) {
    return { entries, compactedCount: 0 };
  }

  let compactedCount = 0;
  const filtered = entries.filter((entry) => {
    const compacted = ranges.some(range => entry.id >= range.startEntryId && entry.id <= range.endEntryId);
    if (compacted) compactedCount += 1;
    return !compacted;
  });

  return {
    entries: filtered,
    compactedCount,
  };
}

export class FocusKnowledgeStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private loaded = false;
  private blocks: FocusKnowledgeBlock[] = [];

  constructor(filePath: string, options: FocusKnowledgeStoreOptions = {}) {
    this.filePath = filePath;
    this.now = options.now ?? Date.now;
  }

  append(input: FocusKnowledgeAppendInput): FocusKnowledgeBlock {
    this.ensureLoaded();

    const now = this.now();
    const channelId = compactText(input.channelId);
    const focusId = compactText(input.focusId);
    const scope = clampText(input.scope, MAX_FOCUS_SCOPE_CHARS);
    const knowledge = clampText(input.knowledge, MAX_FOCUS_KNOWLEDGE_CHARS);
    const completedAt = normalizeFiniteInteger(input.completedAt) ?? now;
    const startedAt = normalizeFiniteInteger(input.startedAt) ?? completedAt;
    const evidence = normalizeEvidenceList(input.evidence);
    const evidenceCount = Math.max(
      normalizeFiniteInteger(input.evidenceCount) ?? evidence.length,
      evidence.length,
    );

    if (!channelId || !focusId || !scope || !knowledge) {
      throw new Error('focus knowledge append requires channelId, focusId, scope, and knowledge');
    }

    const range = normalizeOptionalRange(input.rangeStartId, input.rangeEndId);
    const block: FocusKnowledgeBlock = {
      id: buildFocusKnowledgeId(now),
      channelId,
      focusId,
      scope,
      knowledge,
      createdAt: now,
      startedAt,
      completedAt,
      ...(range ? range : {}),
      evidenceCount,
      evidence,
    };

    appendJsonLine(this.filePath, block);
    this.blocks.push(block);
    return block;
  }

  listByChannel(channelId: string, options: FocusKnowledgeListOptions = {}): FocusKnowledgeBlock[] {
    this.ensureLoaded();
    const normalizedChannelId = compactText(channelId);
    if (!normalizedChannelId) return [];

    const limit = normalizeListLimit(options.limit);
    const channelBlocks = this.blocks
      .filter(block => block.channelId === normalizedChannelId)
      .sort((left, right) => left.createdAt - right.createdAt);

    if (channelBlocks.length <= limit) return [...channelBlocks];
    return channelBlocks.slice(channelBlocks.length - limit);
  }

  listProjectContextsByChannel(
    channelId: string,
    options: FocusKnowledgeListOptions = {},
  ): FocusProjectContextSummary[] {
    const channelBlocks = this.listByChannel(channelId, { limit: Number.MAX_SAFE_INTEGER });
    if (channelBlocks.length === 0) return [];

    const summaries = new Map<string, FocusProjectContextSummary>();
    for (const block of channelBlocks) {
      const scopeKey = normalizeScopeKey(block.scope);
      if (!scopeKey) continue;

      const existing = summaries.get(scopeKey);
      if (!existing) {
        summaries.set(scopeKey, {
          channelId: block.channelId,
          scope: block.scope,
          scopeKey,
          knowledgeBlockCount: 1,
          totalEvidenceCount: block.evidenceCount,
          latestKnowledgeBlockId: block.id,
          latestKnowledge: block.knowledge,
          latestCompletedAt: block.completedAt,
          startedAt: block.startedAt,
        });
        continue;
      }

      existing.scope = block.scope;
      existing.knowledgeBlockCount += 1;
      existing.totalEvidenceCount += block.evidenceCount;
      existing.latestKnowledgeBlockId = block.id;
      existing.latestKnowledge = block.knowledge;
      existing.latestCompletedAt = block.completedAt;
      existing.startedAt = Math.min(existing.startedAt, block.startedAt);
    }

    const limit = normalizeListLimit(options.limit);
    const grouped = [...summaries.values()]
      .sort((left, right) => left.latestCompletedAt - right.latestCompletedAt);
    if (grouped.length <= limit) return grouped;
    return grouped.slice(grouped.length - limit);
  }

  getProjectContextSummary(channelId: string, scope: string): FocusProjectContextSummary | null {
    const scopeKey = normalizeScopeKey(scope);
    if (!scopeKey) return null;

    return this.listProjectContextsByChannel(channelId, { limit: Number.MAX_SAFE_INTEGER })
      .find(summary => summary.scopeKey === scopeKey)
      ?? null;
  }

  getCompactionRanges(channelId: string): FocusCompactionRange[] {
    const ranges = this.listByChannel(channelId, { limit: Number.MAX_SAFE_INTEGER })
      .map((block) => normalizeOptionalRange(block.rangeStartId, block.rangeEndId))
      .filter((range): range is { rangeStartId: number; rangeEndId: number } => range !== null)
      .map(range => ({
        startEntryId: range.rangeStartId,
        endEntryId: range.rangeEndId,
      }));
    return mergeCompactionRanges(ranges);
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!existsSync(this.filePath)) return;

    const raw = readFileSync(this.filePath, 'utf-8');
    if (!raw.trim()) return;

    const lines = raw.split('\n');
    for (const [index, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const normalized = normalizeBlock(parsed);
        if (normalized) {
          this.blocks.push(normalized);
        } else {
          log.warn('Skipping malformed focus knowledge entry', { line: index + 1 });
        }
      } catch (error) {
        log.warn('Skipping unreadable focus knowledge line', {
          line: index + 1,
          error: String(error),
        });
      }
    }

    this.blocks.sort((left, right) => left.createdAt - right.createdAt);
  }
}
