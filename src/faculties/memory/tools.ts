// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type {
  MemoryType,
  MemoryScopeKind,
  SensitivityLevel,
  MemoryRedactionOperation,
  MemoryFormationVAD,
  MemorySourceType,
} from './types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_MEMORY_SCOPE_KINDS,
  VALID_SENSITIVITY_LEVELS,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from './types.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
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
  retrieveEpisodicTimeline,
  type EpisodicTimelineEntry,
  type EpisodicTimelineStore,
} from './retrieval/episodic.js';
import type { SharedBackgroundProvider } from './retrieval/shared-background.js';
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

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const MEMORY_SEARCH_DEFAULT_LIMIT = 5;
const MEMORY_SEARCH_MAX_LIMIT = 20;
const MEMORY_TIMELINE_DEFAULT_LIMIT = 8;
const MEMORY_TIMELINE_MAX_LIMIT = 20;
const MEMORY_TOOL_ACTIONS = [
  'write',
  'search',
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
type MemoryToolAction = (typeof MEMORY_TOOL_ACTIONS)[number];

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
  /**
   * Shared-background provider (E4.5) backing `action=shared_background`. When
   * absent the action fails closed with an explicit not-configured error.
   */
  sharedBackgroundProvider?: SharedBackgroundProvider | null;
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
  contact_a?: string;
  contactA?: string;
  contact_b?: string;
  contactB?: string;
  formation_vad?: MemoryFormationVAD;
  clear_formation_vad?: boolean;
  append_tags?: string;
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
      + 'Use action=shared_background with contact_a and contact_b to find what links two people. '
      + 'Mutation actions require exact IDs: patch/redact/delete use memory_id; restore uses delete_id.',
    label: 'memory',
    parameters: Type.Object({
      action: Type.Unsafe<MemoryToolAction>({
        type: 'string',
        enum: [...MEMORY_TOOL_ACTIONS],
        description: 'One of: write, search, shared_background, census, exists, timeline, import, patch, redact, delete, restore.',
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

          case 'shared_background': {
            const provider = options.sharedBackgroundProvider;
            if (!provider) {
              return textResultWithError(
                'Error: shared-background retrieval is not configured for action=shared_background',
                true,
              );
            }
            const contactAId = normalizeOptionalToolString(normalizedParams.contact_a)
              ?? normalizeOptionalToolString(normalizedParams.contactA);
            const contactBId = normalizeOptionalToolString(normalizedParams.contact_b)
              ?? normalizeOptionalToolString(normalizedParams.contactB);
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
