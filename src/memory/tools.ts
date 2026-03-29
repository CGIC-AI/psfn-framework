// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryStore } from './store.js';
import type {
  MemoryType,
  SensitivityLevel,
  MemoryRedactionOperation,
  MemoryFormationVAD,
  MemorySourceType,
} from './types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from './types.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const SCRATCHPAD_DEFAULT_LIMIT = 20;
const SCRATCHPAD_MAX_LIMIT = 64;

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

function formatScratchpadList(
  entries: Array<{ id: string; content: string; updatedAt: number }>,
): string {
  if (entries.length === 0) {
    return 'Scratchpad is empty.';
  }

  const lines = [`Scratchpad entries (${entries.length}):`];
  for (const entry of entries) {
    lines.push(`- ${entry.id} [${new Date(entry.updatedAt).toISOString()}]: ${entry.content}`);
  }
  return lines.join('\n');
}

export interface MemoryWriteToolOptions {
  getFormationVAD?: () => MemoryFormationVAD | undefined;
}

export function createMemoryWriteTool(
  writer: MemoryWriter,
  options: MemoryWriteToolOptions = {},
): AgentTool<any> {
  return {
    name: 'memory_write',
    description:
      'Write a new memory. Automatically deduplicates against existing memories. ' +
      'Use for intentionally recording important facts, observations, or learnings.',
    label: 'memory_write',
    parameters: Type.Object({
      text: Type.String({ description: 'The memory text — a single clear sentence stating the fact' }),
      type: Type.Unsafe<MemoryType>({
        type: 'string',
        enum: [...VALID_MEMORY_TYPES],
        description: 'Memory type: episodic (events), semantic (facts), emotional (feelings), procedural (patterns), boundary (refusal/safety constraints), reflection (meta)',
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
          description: 'Privacy level: public (share anywhere), personal (trusted only), intimate (primary only), confidential (1:1 only). Default: personal.',
        }),
      ),
    }),
    execute: async (
      toolCallId: string,
      params: {
        text: string;
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
        const internalSource = extractInternalSource(params as Record<string, unknown>);
        const { text, type } = params;

        if (!text || text.trim().length === 0) {
          return textResultWithError('Error: text is required', true);
        }
        if (!VALID_MEMORY_TYPES.includes(type)) {
          return textResultWithError(
            `Error: invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`,
            true,
          );
        }

        const importance = params.importance !== undefined ? clamp(Number(params.importance), 0, 1) : undefined;
        const emotionalValence = params.emotional_valence !== undefined ? clamp(Number(params.emotional_valence), -1, 1) : undefined;
        const confidence = params.confidence !== undefined ? clamp(Number(params.confidence), 0, 1) : undefined;

        const tags = params.tags
          ? params.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
          : undefined;
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
          sensitivity: params.sensitivity,
        });

        switch (result.action) {
          case 'created':
            return textResult(`Memory created (id: ${result.memory.id}, type: ${type})`);
          case 'deduplicated':
            return textResult(`Duplicate detected — bumped salience on existing memory (id: ${result.existingId})`);
          case 'superseded':
            return textResult(`Memory created, superseding older conflicting memory (id: ${result.memory.id}, type: ${type})`);
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
            tags: r.tags ? r.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : undefined,
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
      + 'Use for surgical belief correction, emotional-weight adjustment, or tag/provenance correction.',
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
          ...(params.tags ? { tags: params.tags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean) } : {}),
          ...(params.append_tags
            ? { appendTags: params.append_tags.split(',').map(tag => tag.trim().toLowerCase()).filter(Boolean) }
            : {}),
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

export function createMemoryDeleteTool(memoryStore: MemoryStore): AgentTool<any> {
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

        const deleted = memoryStore.softDeleteMemory(memoryId, {
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

export function createUndoMemoryDeleteTool(memoryStore: MemoryStore): AgentTool<any> {
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

        const restored = memoryStore.undoSoftDelete(deleteId, {
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

export function createScratchpadReadTool(memoryStore: MemoryStore): AgentTool<any> {
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

export function createScratchpadWriteTool(memoryStore: MemoryStore): AgentTool<any> {
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
            const result = memoryStore.addScratchpadEntry(content);
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
            const replaced = memoryStore.replaceScratchpadEntry(id, content);
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
            const removed = memoryStore.removeScratchpadEntry(id);
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
