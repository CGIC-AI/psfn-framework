// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type, type Static } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../core/agent/tool-surface/descriptions.js';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type {
  MemoryType,
  MemoryScopeKind,
  SensitivityLevel,
  MemoryRedactionOperation,
  MemoryFormationVAD,
  MemorySourceType,
  MemoryProvenance,
  RetrievalAccessScope,
} from './types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_MEMORY_SCOPE_KINDS,
  VALID_SENSITIVITY_LEVELS,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from './types.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { clampWithMidpointNaN } from '../../shared/utils/numeric.js';
import { normalizeToolArguments } from '../../shared/tool-argument-normalization.js';
import {
  TRUST_LEVELS,
  type TrustLevel,
} from '../../system/trust/types.js';
import {
  CHANNEL_PRIVACY_VALUES,
  type ChannelPrivacy,
} from '../../system/trust/context-envelope.js';
import {
  searchEpisodicEpisodesLexically,
  retrieveEpisodicTimeline,
  type EpisodicTimelineEntry,
  type EpisodicTimelineStore,
} from './retrieval/episodic.js';
import {
  filterQuarantinedEpisodicChains,
  type MemorySessionQuarantineFilter,
} from './retrieval/session-quarantine.js';
import type {
  HybridEpisodeSearchPort,
  HybridEpisodeSearchResponse,
} from './retrieval/episode-search.js';
import {
  formatEpisodeDrilldown,
  retrieveEpisodeDrilldown,
  type EpisodeDrilldownSessionReader,
  type EpisodeDrilldownStore,
} from './retrieval/episode-drilldown.js';
import {
  resolveMemoryRetrievalPolicy,
  type MemoryRetrievalPolicy,
} from '../../system/config/memory-retrieval-policy.js';
import type { SharedBackgroundProvider } from './retrieval/shared-background.js';
import { resolveAuthorizedRetrievalAccessScope } from './retrieval/access-scope.js';
import type {
  MemoryDeletionApprovalPort,
  MemoryDeletionProposalStorePort,
} from './deletion-proposals.js';
import {
  resolveMemoryDeletionJustification,
  type MemoryDeletionPolicy,
} from '../../system/config/memory-deletion-policy.js';
import {
  filterTopicMatches,
  formatMemoryCensusResult,
  formatMemoryExistsResult,
  formatSharedBackgroundResult,
  listFilteredMemories,
  type MemoryVisibilityFilter,
  normalizeOptionalToolString,
  partitionVisibleMemories,
  resolveMemoryVisibility,
  resolveMemoryVisibilityFilter,
  resolveTimelineRange,
} from './tools/visibility.js';

export {
  createScratchpadReadTool,
  createScratchpadTool,
  createScratchpadWriteTool,
} from './tools/scratchpad.js';

const INTERNAL_SOURCE_PARAM = '__psfnShardSource';
const MEMORY_SEARCH_DEFAULT_LIMIT = 5;
const MEMORY_SEARCH_MAX_LIMIT = 20;
const MEMORY_TIMELINE_DEFAULT_LIMIT = 8;
const MEMORY_TIMELINE_MAX_LIMIT = 20;
const MEMORY_TOOL_ACTIONS = [
  'write',
  'search',
  'episode_search',
  'get',
  'shared_background',
  'census',
  'exists',
  'timeline',
  'import',
  'patch',
  'redact',
  'delete',
  'restore',
] as const;
const SHARED_BACKGROUND_TOOL_LIMIT_DEFAULT = 12;
const SHARED_BACKGROUND_TOOL_LIMIT_MAX = 25;
const MEMORY_EPISODE_GET_LIMITS = {
  defaultSiblings: 12,
  maxSiblings: 25,
} as const;
type MemoryToolAction = (typeof MEMORY_TOOL_ACTIONS)[number];

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.floor(val)));
}

/**
 * Resolve the optional historical formation time for an imported memory record.
 * Fails closed: an unparseable, pre-epoch, or future `occurred_at` yields an
 * error string instead of silently coercing to the import wall-clock time
 * (bead n2z6). Returns an empty object when no timestamp was supplied.
 */
function parseImportOccurredAt(
  value: string | undefined,
  index: number,
): { extractedAt?: number; error?: string } {
  if (value === undefined) return {};
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { error: `Error: record[${index}] has an invalid occurred_at "${value}" (expected an ISO-8601 timestamp)` };
  }
  if (parsed < 0) {
    return { error: `Error: record[${index}] occurred_at "${value}" predates the Unix epoch` };
  }
  if (parsed > Date.now()) {
    return { error: `Error: record[${index}] occurred_at "${value}" is in the future` };
  }
  return { extractedAt: parsed };
}

function extractInternalSource(params: Record<string, unknown>): string | null {
  const candidate = params[INTERNAL_SOURCE_PARAM];
  if (typeof candidate !== 'string') return null;
  const normalized = candidate.trim();
  return normalized.length > 0 ? normalized : null;
}

function buildToolSourceRef(
  toolName: string,
  toolCallId: string,
  internalSource: string | null,
): string {
  if (!internalSource) return `source:tool:${toolName}|invocation:${toolCallId}`;
  return `source:${internalSource}|tool:${toolName}|invocation:${toolCallId}`;
}

function resolveInternalMemoryOrigin(internalSource: string | null): {
  sourceType: MemorySourceType;
  provenance: Pick<MemoryProvenance, 'shardId' | 'subagentId' | 'actor'>;
} {
  const shardId = internalSource?.startsWith('shard:')
    ? internalSource.slice('shard:'.length).trim()
    : '';
  if (shardId) {
    return {
      sourceType: 'shard',
      provenance: { shardId, actor: 'shard' },
    };
  }
  const subagentId = internalSource?.startsWith('subagent:')
    ? internalSource.slice('subagent:'.length).trim()
    : '';
  if (subagentId) {
    return {
      sourceType: 'subagent',
      provenance: { subagentId, actor: 'subagent' },
    };
  }
  return {
    sourceType: 'tool_write',
    provenance: {},
  };
}

/**
 * Stamp the logical request-context session identity into tool provenance so a
 * durable write executed during a testing session carries `sessionId`. The
 * MemoryWriter testing fence reads `provenance.sessionId`, and the exact-scope
 * testing purge selects rows by `provenance_json->>'sessionId'` — without this
 * stamp a testing-session write both bypasses the fence and survives purge.
 * Only session identity is stamped; shard/subagent origin stays owned by
 * resolveInternalMemoryOrigin and must not be overridden here.
 */
function stampRequestContextProvenance(): Pick<MemoryProvenance, 'sessionId'> {
  const sessionId = getRequestContext()?.sessionId;
  return sessionId && sessionId.trim().length > 0 ? { sessionId } : {};
}

/**
 * Conversation-time bound for a memory the companion authors DURING a live turn
 * (psfn-framework-ca980). Unlike deferred producers (sleeptime/episodic run long
 * after the conversation), a tool write executes synchronously inside the turn
 * the companion is having, so wall-clock now IS the conversation instant: the
 * request context carries no turn timestamp (CorrelationMetadata has none), but
 * the write happening IN the conversation makes `Date.now()` the correct, safe
 * anchor — a channel demotion cannot post-date content authored this instant, so
 * resolving the channel's CURRENT epoch is right (the content is authored under
 * the current classification). Applied ONLY to fresh live-turn writes: import
 * (historical `occurred_at`) and patch/redact of existing memories must NOT claim
 * now as their conversation time, so they stay unstamped and fail closed.
 */
function liveTurnConversationInstant(): Pick<MemoryProvenance, 'sourceConversationAt'> {
  return { sourceConversationAt: Date.now() };
}

function buildToolSourceContext(
  toolName: string,
  toolCallId: string,
  internalSource: string | null,
): {
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance: MemoryProvenance;
} {
  const sourceRef = buildToolSourceRef(toolName, toolCallId, internalSource);
  const origin = resolveInternalMemoryOrigin(internalSource);
  return {
    sourceRef,
    sourceType: origin.sourceType,
    provenance: {
      toolName,
      toolCallId,
      ...stampRequestContextProvenance(),
      ...origin.provenance,
    },
  };
}

function buildUnifiedMemorySourceContext(
  action: Exclude<MemoryToolAction, 'search' | 'episode_search' | 'timeline'>,
  toolCallId: string,
  internalSource: string | null,
  qualifiers: string[] = [],
): {
  sourceRef: string;
  sourceType: MemorySourceType;
  provenance: MemoryProvenance;
} {
  const base = internalSource
    ? `source:${internalSource}|tool:memory|action:${action}`
    : `source:tool:memory|action:${action}`;
  const sourceRef = [base, ...qualifiers.filter(Boolean), `invocation:${toolCallId}`].join('|');
  const origin = resolveInternalMemoryOrigin(internalSource);
  return {
    sourceRef,
    sourceType: origin.sourceType,
    provenance: {
      toolName: 'memory',
      toolCallId,
      ...stampRequestContextProvenance(),
      ...origin.provenance,
    },
  };
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

function formatEpisodicSearchResults(
  response: HybridEpisodeSearchResponse,
): string {
  const { results: entries, modes, degraded } = response;
  if (entries.length === 0) {
    return 'No visible canonical episodes matched the search query '
      + `(lexical_status=${modes.lexical.status}; semantic_status=${modes.semantic.status}; degraded=${String(degraded)}).`;
  }

  const lines = [
    `Episode search results (${entries.length}; lexical_status=${modes.lexical.status}; `
      + `semantic_status=${modes.semantic.status}; degraded=${String(degraded)}):`,
  ];
  if (modes.semantic.error) {
    lines.push(`Semantic retrieval error: ${modes.semantic.error}`);
  }
  for (const entry of entries) {
    const episode = entry.episode;
    lines.push(
      `- ${episode.id} | fused_score=${entry.fusedScore.toFixed(4)}`
      + ` | lexical_score=${entry.lexicalScore?.toFixed(4) ?? 'n/a'}`
      + ` | semantic_similarity=${entry.semanticSimilarity?.toFixed(4) ?? 'n/a'}`
      + ` | retrieval_modes=${entry.retrievalModes.join(',')}`
      + ` | matched_terms=${entry.matchedTerms.join(',')}`,
    );
    lines.push(`  ${formatTimelineInstant(episode.startedAt)} to ${formatTimelineInstant(episode.endedAt)}: ${episode.title}`);
    lines.push(`  Landmark: ${truncateTimelineText(episode.landmark, 220)}`);
    if (episode.meaning?.text) {
      lines.push(`  Meaning: ${truncateTimelineText(episode.meaning.text, 180)}`);
    }
    const relatedEpisodeIds = entry.chain.episodes
      .map(candidate => candidate.id)
      .filter(id => id !== episode.id);
    if (relatedEpisodeIds.length > 0) {
      lines.push(`  Related episode IDs: ${relatedEpisodeIds.join(', ')}`);
    }
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
    } else {
      // Candidates, not verdicts (h4fp.6): an episode she has not yet given
      // meaning to must never read as her settled lived past — the title and
      // landmark above are machine-drafted summaries awaiting her review.
      lines.push('  (unreviewed: machine-drafted summary — you have not yet given this episode its meaning)');
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
  episodicStore?: (EpisodicTimelineStore & EpisodeDrilldownStore) | null;
  episodeSearch?: HybridEpisodeSearchPort | null;
  sessionReader?: EpisodeDrilldownSessionReader | null;
  sessionQuarantineFilter?: MemorySessionQuarantineFilter | null;
  /**
   * Internal-only episode retrieval scope. The authorization resolver still
   * verifies the exact trusted reflection request context on every call.
   */
  episodicAccessScope?: RetrievalAccessScope | (() => RetrievalAccessScope | undefined);
  /**
   * Shared-background provider (E4.5) backing `action=shared_background`. When
   * absent the action fails closed with an explicit not-configured error.
   */
  sharedBackgroundProvider?: SharedBackgroundProvider | null;
  /**
   * Live episodic/timeline retrieval policy (zet.2). Threaded from the same
   * config authority the retrieval faculty uses so the `action=timeline` tool
   * path applies operator-set timeline knobs instead of compiled defaults.
   * Accepts a resolver so late-bound runtime config is honored per call.
   */
  memoryRetrievalPolicy?: MemoryRetrievalPolicy | (() => MemoryRetrievalPolicy | undefined);
  memoryDeletionProposalStore?: MemoryDeletionProposalStorePort | null;
  memoryDeletionApprovalPort?: MemoryDeletionApprovalPort | null;
  memoryDeletionPolicy?: MemoryDeletionPolicy | (() => MemoryDeletionPolicy | undefined);
}

export function createMemoryWriteTool(
  writer: MemoryWriter,
  options: MemoryWriteToolOptions = {},
): SubstrateAgentTool {
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

        const importance = normalizedParams.importance !== undefined ? clampWithMidpointNaN(Number(normalizedParams.importance), 0, 1) : undefined;
        const emotionalValence = normalizedParams.emotional_valence !== undefined ? clampWithMidpointNaN(Number(normalizedParams.emotional_valence), -1, 1) : undefined;
        const confidence = normalizedParams.confidence !== undefined ? clampWithMidpointNaN(Number(normalizedParams.confidence), 0, 1) : undefined;

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
          provenance: { ...sourceContext.provenance, ...liveTurnConversationInstant() },
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
        return textResultWithError(`Error writing memory: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryImportTool(writer: MemoryWriter): SubstrateAgentTool {
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
          occurred_at: Type.Optional(
            Type.String({
              description:
                'Historical formation time of this memory as an ISO-8601 timestamp '
                + '(e.g. "2024-03-01T12:00:00Z"). Use when restoring/migrating memories so '
                + 'they keep their original date instead of being stamped with the import time. '
                + 'Must not be in the future.',
            }),
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
          occurred_at?: string;
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
          if (r === undefined) {
            return textResultWithError(`Error: record[${i}] is missing`, true);
          }
          const text = r.text as string;
          const type = r.type as MemoryType;

          if (!text || text.trim().length === 0) {
            return textResultWithError(`Error: record[${i}] has empty text`, true);
          }
          if (!VALID_MEMORY_TYPES.includes(type)) {
            return textResultWithError(`Error: record[${i}] has invalid type "${type}"`, true);
          }

          const occurred = parseImportOccurredAt(r.occurred_at, i);
          if (occurred.error) {
            return textResultWithError(occurred.error, true);
          }

          const sourceContext = buildToolSourceContext(`memory_import:${source}`, toolCallId, internalSource);
          records.push({
            text: text.trim(),
            type,
            importance: r.importance !== undefined ? clampWithMidpointNaN(Number(r.importance), 0, 1) : undefined,
            emotionalValence: r.emotional_valence !== undefined ? clampWithMidpointNaN(Number(r.emotional_valence), -1, 1) : undefined,
            confidence: r.confidence !== undefined ? clampWithMidpointNaN(Number(r.confidence), 0, 1) : undefined,
            tags: parseTags(r.tags),
            sourceRef: sourceContext.sourceRef,
            sourceType: sourceContext.sourceType,
            provenance: sourceContext.provenance,
            sensitivity: r.sensitivity,
            ...(occurred.extractedAt !== undefined ? { extractedAt: occurred.extractedAt } : {}),
          });
        }

        const result = await writer.importBatch(records);

        return textResult(
          `Import complete: ${result.written} written, ${result.deduplicated} deduplicated, ` +
          `${result.superseded} superseded, ${result.errors} errors (${records.length} total)`,
        );
      } catch (error) {
        return textResultWithError(`Error importing memories: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryPatchTool(writer: MemoryWriter): SubstrateAgentTool {
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
          ...(params.importance !== undefined ? { importance: clampWithMidpointNaN(Number(params.importance), 0, 1) } : {}),
          ...(params.confidence !== undefined ? { confidence: clampWithMidpointNaN(Number(params.confidence), 0, 1) } : {}),
          ...(params.emotional_valence !== undefined
            ? { emotionalValence: clampWithMidpointNaN(Number(params.emotional_valence), -1, 1) }
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
        return textResultWithError(`Error patching memory: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryRedactTool(_writer: MemoryWriter): SubstrateAgentTool {
  return {
    name: 'memory_redact',
    description: 'Retired alias. Memory removal must use the justified deletion proposal workflow.',
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
      _toolCallId: string,
      _params: {
        memory_id: string;
        operation?: MemoryRedactionOperation;
        reason?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return textResultWithError(
        'Error: memory_redact is retired because redaction removes an active memory. Use memory with action=delete, justification_category, and explanation.',
        true,
      );
    },
  };
}

export function createMemoryDeleteTool(_memoryStore: MemoryStorePort): SubstrateAgentTool {
  return {
    name: 'memory_delete',
    description:
      'Retired alias. Memory deletion must be proposed through memory action=delete.',
    label: 'memory_delete',
    parameters: Type.Object({
      memory_id: Type.String({ description: 'Memory ID to soft-delete.' }),
      reason: Type.Optional(
        Type.String({ description: 'Reason for deletion (logged in safeguard audit/version snapshot).' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      _params: {
        memory_id: string;
        reason?: string;
      },
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      return textResultWithError(
        'Error: memory_delete is retired. Use memory with action=delete, justification_category, and explanation to create a Partner-alerted proposal for Operator validation.',
        true,
      );
    },
  };
}

export function createUndoMemoryDeleteTool(memoryStore: MemoryStorePort): SubstrateAgentTool {
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
        return textResultWithError(`Error restoring memory: ${toErrorMessage(error)}`, true);
      }
    },
  };
}

export function createMemoryTool(
  writer: MemoryWriter,
  memoryStore: MemoryStorePort,
  options: MemoryToolOptions = {},
): SubstrateAgentTool {
  const parameters = Type.Object({
      action: Type.Unsafe<MemoryToolAction>({
        type: 'string',
        enum: [...MEMORY_TOOL_ACTIONS],
        description: 'One of: write, search, episode_search, get, shared_background, census, exists, timeline, import, patch, redact, delete, restore.',
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
        Type.String({ description: 'Required for action=search, action=episode_search, or action=exists. Lexical memory or canonical episode topic query.' }),
      ),
      episode_id: Type.Optional(
        Type.String({
          description: 'Required for action=get. Exact episode ID from an episodic landmark or timeline result.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: `Optional result limit for action=search, action=episode_search, action=get sibling expansion, or action=timeline. Search: ${MEMORY_SEARCH_DEFAULT_LIMIT}-${MEMORY_SEARCH_MAX_LIMIT}; episode siblings: ${MEMORY_EPISODE_GET_LIMITS.defaultSiblings}-${MEMORY_EPISODE_GET_LIMITS.maxSiblings}; timeline: ${MEMORY_TIMELINE_DEFAULT_LIMIT}-${MEMORY_TIMELINE_MAX_LIMIT}.`,
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
        Type.String({ description: 'For action=episode_search, action=get, action=census, action=exists, or action=timeline, current channel id. Usually supplied by runtime context.' }),
      ),
      trust_level: Type.Optional(
        Type.Unsafe<TrustLevel>({
          type: 'string',
          enum: [...TRUST_LEVELS],
          description: 'For action=episode_search, action=get, action=census, action=exists, or action=timeline, current viewer trust level. Usually supplied by runtime context.',
        }),
      ),
      channel_visibility: Type.Optional(
        Type.Unsafe<ChannelPrivacy>({
          type: 'string',
          enum: [...CHANNEL_PRIVACY_VALUES],
          description: 'For action=episode_search, action=get, action=census, action=exists, or action=timeline, current channel visibility. Usually supplied by runtime context.',
        }),
      ),
      canonical_contact_id: Type.Optional(
        Type.String({ description: 'For action=episode_search, action=get, action=census, action=exists, or action=timeline, optional canonical contact id for trusted cross-channel continuity. Runtime ingress remains authoritative.' }),
      ),
      contact_a: Type.Optional(
        Type.String({ description: 'Required for action=shared_background. First contact id of the pair to find shared background for.' }),
      ),
      contact_b: Type.Optional(
        Type.String({ description: 'Required for action=shared_background. Second contact id of the pair to find shared background for.' }),
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
            occurred_at: Type.Optional(
              Type.String({
                description:
                  'Historical formation time of this memory as an ISO-8601 timestamp. Use when '
                  + 'restoring/migrating so the memory keeps its original date instead of the import '
                  + 'time. Must not be in the future.',
              }),
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
        Type.String({ description: 'Optional reason logged for patch operations.' }),
      ),
      justification_category: Type.Optional(
        Type.String({ description: 'Required for action=delete. Category id from settings.json memoryDeletionPolicy.' }),
      ),
      explanation: Type.Optional(
        Type.String({ description: 'Required for action=delete. Written explanation for Partner alert and Operator validation.' }),
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
  });
  type MemoryToolParams = Static<typeof parameters>;

  return {
    name: 'memory',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.memory,
    label: 'memory',
    parameters,
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
        const normalizedRecord = normalizedParams as unknown as Record<string, unknown>;
        const internalSource = extractInternalSource(normalizedRecord);
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
              importance: normalizedParams.importance !== undefined ? clampWithMidpointNaN(Number(normalizedParams.importance), 0, 1) : undefined,
              emotionalValence: normalizedParams.emotional_valence !== undefined
                ? clampWithMidpointNaN(Number(normalizedParams.emotional_valence), -1, 1)
                : undefined,
              formationVAD: options.getFormationVAD?.(),
              confidence: normalizedParams.confidence !== undefined ? clampWithMidpointNaN(Number(normalizedParams.confidence), 0, 1) : undefined,
              tags: parseTags(normalizedParams.tags),
              sourceRef: sourceContext.sourceRef,
              sourceType: sourceContext.sourceType,
              provenance: { ...sourceContext.provenance, ...liveTurnConversationInstant() },
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

          case 'episode_search': {
            if (!options.episodicStore) {
              return textResultWithError(
                'Error: episodic store is not configured for action=episode_search',
                true,
              );
            }
            const query = normalizedParams.query?.trim();
            if (!query) {
              return textResultWithError(
                'Error: query is required for action=episode_search. '
                + 'Missing required field "query". '
                + 'Minimal valid JSON: {"action":"episode_search","query":"topic"}. '
                + 'Do not retry action=episode_search without a non-empty query.',
                true,
              );
            }
            const visibility = resolveMemoryVisibility(normalizedParams, 'episode_search');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }
            const limit = normalizedParams.limit === undefined
              ? MEMORY_SEARCH_DEFAULT_LIMIT
              : clampInt(normalizedParams.limit, 1, MEMORY_SEARCH_MAX_LIMIT);
            const memoryRetrievalPolicy = resolveMemoryRetrievalPolicy(
              typeof options.memoryRetrievalPolicy === 'function'
                ? options.memoryRetrievalPolicy()
                : options.memoryRetrievalPolicy,
            );
            const requestedAccessScope = typeof options.episodicAccessScope === 'function'
              ? options.episodicAccessScope()
              : options.episodicAccessScope;
            const accessScope = resolveAuthorizedRetrievalAccessScope(
              visibility.channelId,
              requestedAccessScope,
            );
            const searchInput = {
              query,
              channelId: visibility.channelId,
              trustLevel: visibility.trustLevel,
              channelDisclosure: {
                channelPrivacy: visibility.channelVisibility,
                broadcast: visibility.broadcast,
              },
              ...(visibility.canonicalContactId
                ? { canonicalContactId: visibility.canonicalContactId }
                : {}),
              limit,
              accessScope,
              memoryRetrievalPolicy,
              sessionQuarantineFilter: options.sessionQuarantineFilter ?? null,
            };
            const response: HybridEpisodeSearchResponse = options.episodeSearch
              ? await options.episodeSearch.search(searchInput)
              : await (async (): Promise<HybridEpisodeSearchResponse> => {
                const rawResults = await searchEpisodicEpisodesLexically(options.episodicStore!, {
                  ...searchInput,
                  includeChain: chain => (
                    filterQuarantinedEpisodicChains(
                      options.sessionQuarantineFilter ?? null,
                      [chain],
                    ).length === 1
                  ),
                });
                return {
                  results: rawResults.map(entry => ({
                    episode: entry.episode,
                    chain: entry.chain,
                    fusedScore: entry.lexicalScore,
                    lexicalScore: entry.lexicalScore,
                    matchedTerms: entry.matchedTerms,
                    retrievalModes: ['lexical'],
                  })),
                  modes: {
                    lexical: { status: 'completed', candidateCount: rawResults.length },
                    semantic: { status: 'unavailable', candidateCount: 0 },
                  },
                  degraded: true,
                };
              })();
            return textResult(formatEpisodicSearchResults(response));
          }

          case 'get': {
            if (!options.episodicStore || !options.sessionReader) {
              return textResultWithError(
                'Error: episodic store and session reader are required for action=get',
                true,
              );
            }
            const episodeId = normalizedParams.episode_id?.trim();
            if (!episodeId) {
              return textResultWithError('Error: episode_id is required for action=get', true);
            }
            const visibility = resolveMemoryVisibility(normalizedParams, 'get');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }
            const siblingLimit = normalizedParams.limit === undefined
              ? MEMORY_EPISODE_GET_LIMITS.defaultSiblings
              : clampInt(normalizedParams.limit, 1, MEMORY_EPISODE_GET_LIMITS.maxSiblings);
            const result = await retrieveEpisodeDrilldown(
              options.episodicStore,
              options.sessionReader,
              {
                episodeId,
                channelId: visibility.channelId,
                trustLevel: visibility.trustLevel,
                channelDisclosure: {
                  channelPrivacy: visibility.channelVisibility,
                  broadcast: visibility.broadcast,
                },
                ...(visibility.canonicalContactId
                  ? { canonicalContactId: visibility.canonicalContactId }
                  : {}),
                siblingLimit,
              },
            );
            if (!result) {
              return textResultWithError(
                `Episode not found or not visible: ${episodeId}`,
                true,
              );
            }
            return textResult(formatEpisodeDrilldown(result));
          }

          case 'shared_background': {
            const provider = options.sharedBackgroundProvider;
            if (!provider) {
              return textResultWithError(
                'Error: shared-background retrieval is not configured for action=shared_background',
                true,
              );
            }
            const contactAId = normalizeOptionalToolString(normalizedParams.contact_a)
              ?? normalizeOptionalToolString(normalizedRecord.contactA);
            const contactBId = normalizeOptionalToolString(normalizedParams.contact_b)
              ?? normalizeOptionalToolString(normalizedRecord.contactB);
            if (!contactAId || !contactBId) {
              return textResultWithError(
                'Error: contact_a and contact_b are both required for action=shared_background',
                true,
              );
            }
            if (contactAId === contactBId) {
              return textResultWithError(
                'Error: contact_a and contact_b must be different contacts for action=shared_background',
                true,
              );
            }
            const visibility = resolveMemoryVisibility(normalizedParams, 'shared_background');
            if (!visibility.ok) {
              return textResultWithError(visibility.error, true);
            }
            const limit = normalizedParams.limit === undefined
              ? SHARED_BACKGROUND_TOOL_LIMIT_DEFAULT
              : clampInt(normalizedParams.limit, 1, SHARED_BACKGROUND_TOOL_LIMIT_MAX);
            const result = await provider.sharedBackground({
              contactAId,
              contactBId,
              access: {
                trustLevel: visibility.trustLevel,
                channelPrivacy: visibility.channelVisibility,
                broadcast: visibility.broadcast,
                ...(visibility.canonicalContactId ? { canonicalContactId: visibility.canonicalContactId } : {}),
              },
              limit,
            });
            return textResult(formatSharedBackgroundResult(result));
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

            const memoryRetrievalPolicy = resolveMemoryRetrievalPolicy(
              typeof options.memoryRetrievalPolicy === 'function'
                ? options.memoryRetrievalPolicy()
                : options.memoryRetrievalPolicy,
            );
            // An explicit caller/tool limit wins (clamped to the tool ceiling);
            // when absent, the policy's timelineLimit is the default — applied
            // inside retrieveEpisodicTimeline via the threaded policy, not a
            // compiled constant.
            const explicitLimit = normalizedParams.limit === undefined
              ? undefined
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
              ...(explicitLimit !== undefined ? { limit: explicitLimit } : {}),
              memoryRetrievalPolicy,
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
              if (record === undefined) {
                return textResultWithError(`Error: record[${i}] is missing`, true);
              }
              const text = record.text.trim();
              const type = record.type;

              if (!text) {
                return textResultWithError(`Error: record[${i}] has empty text`, true);
              }
              if (!VALID_MEMORY_TYPES.includes(type)) {
                return textResultWithError(`Error: record[${i}] has invalid type "${type}"`, true);
              }

              const occurred = parseImportOccurredAt(record.occurred_at, i);
              if (occurred.error) {
                return textResultWithError(occurred.error, true);
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
                importance: record.importance !== undefined ? clampWithMidpointNaN(Number(record.importance), 0, 1) : undefined,
                emotionalValence: record.emotional_valence !== undefined
                  ? clampWithMidpointNaN(Number(record.emotional_valence), -1, 1)
                  : undefined,
                confidence: record.confidence !== undefined ? clampWithMidpointNaN(Number(record.confidence), 0, 1) : undefined,
                tags: parseTags(record.tags),
                sourceRef: sourceContext.sourceRef,
                sourceType: sourceContext.sourceType,
                provenance: sourceContext.provenance,
                sensitivity: record.sensitivity,
                ...(occurred.extractedAt !== undefined ? { extractedAt: occurred.extractedAt } : {}),
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
              ...(normalizedParams.importance !== undefined ? { importance: clampWithMidpointNaN(Number(normalizedParams.importance), 0, 1) } : {}),
              ...(normalizedParams.confidence !== undefined ? { confidence: clampWithMidpointNaN(Number(normalizedParams.confidence), 0, 1) } : {}),
              ...(normalizedParams.emotional_valence !== undefined
                ? { emotionalValence: clampWithMidpointNaN(Number(normalizedParams.emotional_valence), -1, 1) }
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
            return textResultWithError(
              'Error: action=redact is retired because redaction removes an active memory. Use action=delete with justification_category and explanation.',
              true,
            );
          }

          case 'delete': {
            const memoryId = normalizedParams.memory_id?.trim();
            if (!memoryId) {
              return textResultWithError('Error: memory_id is required for action=delete', true);
            }
            const justificationCategory = normalizedParams.justification_category?.trim();
            if (!justificationCategory) {
              return textResultWithError('Error: justification_category is required for action=delete', true);
            }
            const explanation = normalizedParams.explanation?.trim();
            if (!explanation) {
              return textResultWithError('Error: explanation is required for action=delete', true);
            }
            const policy = typeof options.memoryDeletionPolicy === 'function'
              ? options.memoryDeletionPolicy()
              : options.memoryDeletionPolicy;
            resolveMemoryDeletionJustification(policy, justificationCategory, explanation);
            const proposalStore = options.memoryDeletionProposalStore;
            const approvalPort = options.memoryDeletionApprovalPort;
            if (!proposalStore || !approvalPort) {
              return textResultWithError(
                'Error: memory deletion proposal persistence and confirmation are not configured',
                true,
              );
            }
            const targetMemory = await memoryStore.getById(memoryId);
            if (!targetMemory || targetMemory.deletedAt || targetMemory.supersededBy) {
              return textResultWithError(`Memory not found or no longer active: ${memoryId}`, true);
            }
            const proposal = await proposalStore.createMemoryDeletionProposal({
              memoryId,
              justificationCategory,
              explanation,
              proposedBy: 'Companion',
            });
            await approvalPort.requestMemoryDeletionApproval({
              proposalId: proposal.id,
              memoryId,
              justificationCategory,
              explanation,
            });
            return textResult(
              `Memory deletion proposal ${proposal.id} is pending Operator validation. `
              + 'The Partner was alerted through the existing confirmation surface; the memory remains active.',
            );
          }

          case 'restore': {
            const deleteId = normalizedParams.delete_id?.trim();
            if (!deleteId) {
              return textResultWithError('Error: delete_id is required for action=restore', true);
            }

            const restored = await memoryStore.undoSoftDelete(deleteId, {
              restoredBy: 'tool:memory|action:restore',
              actorRole: 'Companion',
            });
            if (!restored) {
              return textResultWithError(`Delete checkpoint not found or already restored: ${deleteId}`, true);
            }

            return textResult(`Memory restored (id: ${restored.memoryId}, delete_id: ${restored.deleteId}).`);
          }
        }

        return textResultWithError(`Error: unsupported memory action "${action}"`, true);
      } catch (error) {
        return textResultWithError(`Error executing memory action: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
