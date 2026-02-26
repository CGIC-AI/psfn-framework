// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryStore } from './store.js';
import type { MemoryType, SensitivityLevel, MemoryRedactionOperation } from './types.js';
import {
  VALID_MEMORY_TYPES,
  VALID_SENSITIVITY_LEVELS,
  VALID_MEMORY_REDACTION_OPERATIONS,
} from './types.js';

const INTERNAL_SHARD_SOURCE_PARAM = '__psfnShardSource';
const SCRATCHPAD_DEFAULT_LIMIT = 20;
const SCRATCHPAD_MAX_LIMIT = 64;

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

export function createMemoryWriteTool(writer: MemoryWriter): AgentTool<any> {
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
          return {
            content: [{ type: 'text', text: 'Error: text is required' }] satisfies TextContent[],
            details: { isError: true },
          };
        }
        if (!VALID_MEMORY_TYPES.includes(type)) {
          return {
            content: [{ type: 'text', text: `Error: invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(', ')}` }] satisfies TextContent[],
            details: { isError: true },
          };
        }

        const importance = params.importance !== undefined ? clamp(Number(params.importance), 0, 1) : undefined;
        const emotionalValence = params.emotional_valence !== undefined ? clamp(Number(params.emotional_valence), -1, 1) : undefined;
        const confidence = params.confidence !== undefined ? clamp(Number(params.confidence), 0, 1) : undefined;

        const tags = params.tags
          ? params.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
          : undefined;

        const result = await writer.write({
          text: text.trim(),
          type,
          importance,
          emotionalValence,
          confidence,
          tags,
          sourceRef: buildToolSourceRef('memory_write', toolCallId, internalSource),
          sensitivity: params.sensitivity,
        });

        switch (result.action) {
          case 'created':
            return {
              content: [{ type: 'text', text: `Memory created (id: ${result.memory.id}, type: ${type})` }] satisfies TextContent[],
              details: {},
            };
          case 'deduplicated':
            return {
              content: [{ type: 'text', text: `Duplicate detected — bumped salience on existing memory (id: ${result.existingId})` }] satisfies TextContent[],
              details: {},
            };
          case 'superseded':
            return {
              content: [{ type: 'text', text: `Memory created, superseding older conflicting memory (id: ${result.memory.id}, type: ${type})` }] satisfies TextContent[],
              details: {},
            };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error writing memory: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
          return {
            content: [{ type: 'text', text: 'Error: records must be a non-empty array' }] satisfies TextContent[],
            details: { isError: true },
          };
        }

        // Validate and convert records
        const records: MemoryWriteOptions[] = [];
        for (let i = 0; i < rawRecords.length; i++) {
          const r = rawRecords[i];
          const text = r.text as string;
          const type = r.type as MemoryType;

          if (!text || text.trim().length === 0) {
            return {
              content: [{ type: 'text', text: `Error: record[${i}] has empty text` }] satisfies TextContent[],
              details: { isError: true },
            };
          }
          if (!VALID_MEMORY_TYPES.includes(type)) {
            return {
              content: [{ type: 'text', text: `Error: record[${i}] has invalid type "${type}"` }] satisfies TextContent[],
              details: { isError: true },
            };
          }

          records.push({
            text: text.trim(),
            type,
            importance: r.importance !== undefined ? clamp(Number(r.importance), 0, 1) : undefined,
            emotionalValence: r.emotional_valence !== undefined ? clamp(Number(r.emotional_valence), -1, 1) : undefined,
            confidence: r.confidence !== undefined ? clamp(Number(r.confidence), 0, 1) : undefined,
            tags: r.tags ? r.tags.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : undefined,
            sourceRef: buildToolSourceRef(`memory_import:${source}`, toolCallId, internalSource),
            sensitivity: r.sensitivity,
          });
        }

        const result = await writer.importBatch(records);

        return {
          content: [{
            type: 'text',
            text:
              `Import complete: ${result.written} written, ${result.deduplicated} deduplicated, ` +
              `${result.superseded} superseded, ${result.errors} errors (${records.length} total)`,
          }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error importing memories: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
      const internalSource = extractInternalSource(params as Record<string, unknown>);
      const memoryId = params.memory_id?.trim();
      if (!memoryId) {
        return {
          content: [{ type: 'text', text: 'Error: memory_id is required' }] satisfies TextContent[],
          details: { isError: true },
        };
      }

      const operation = params.operation ?? 'auto';
      if (!VALID_MEMORY_REDACTION_OPERATIONS.includes(operation)) {
        return {
          content: [{ type: 'text', text: `Error: invalid operation "${operation}"` }] satisfies TextContent[],
          details: { isError: true },
        };
      }

      const sourceRef = buildToolSourceRef('memory_redact', toolCallId, internalSource);

      try {
        const redacted = await writer.redact({
          memoryId,
          operation,
          reason: params.reason?.trim(),
          requestedBy: sourceRef,
          sourceRef,
        });

        if (!redacted) {
          return {
            content: [{ type: 'text', text: `Memory not found or already deleted: ${memoryId}` }] satisfies TextContent[],
            details: { isError: true },
          };
        }

        if (redacted.operation === 'deleted') {
          return {
            content: [{
              type: 'text',
              text:
                `Memory redacted via delete (id: ${redacted.sourceMemoryId}, delete_id: ${redacted.deleteId}, behavior: ${redacted.behavior}).`,
            }] satisfies TextContent[],
            details: {},
          };
        }

        return {
          content: [{
            type: 'text',
            text:
              `Memory redacted via abstraction (source: ${redacted.sourceMemoryId}, abstracted: ${redacted.abstractedMemoryId}, ` +
              `delete_id: ${redacted.deleteId}, provenance_ref: ${redacted.externalProvenanceRef}).`,
          }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error redacting memory: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
      const memoryId = params.memory_id?.trim();
      if (!memoryId) {
        return {
          content: [{ type: 'text', text: 'Error: memory_id is required' }] satisfies TextContent[],
          details: { isError: true },
        };
      }

      try {
        const deleted = memoryStore.softDeleteMemory(memoryId, {
          deletedBy: 'tool:memory_delete',
          reason: params.reason?.trim(),
        });
        if (!deleted) {
          return {
            content: [{ type: 'text', text: `Memory not found or already deleted: ${memoryId}` }] satisfies TextContent[],
            details: { isError: true },
          };
        }

        return {
          content: [{
            type: 'text',
            text:
              `Memory soft-deleted (id: ${deleted.memoryId}, delete_id: ${deleted.deleteId}). ` +
              'Use undo_memory_delete with delete_id to restore.',
          }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error deleting memory: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
      const deleteId = params.delete_id?.trim();
      if (!deleteId) {
        return {
          content: [{ type: 'text', text: 'Error: delete_id is required' }] satisfies TextContent[],
          details: { isError: true },
        };
      }

      try {
        const restored = memoryStore.undoSoftDelete(deleteId, {
          restoredBy: 'tool:undo_memory_delete',
        });
        if (!restored) {
          return {
            content: [{ type: 'text', text: `Delete checkpoint not found or already restored: ${deleteId}` }] satisfies TextContent[],
            details: { isError: true },
          };
        }

        return {
          content: [{
            type: 'text',
            text: `Memory restored (id: ${restored.memoryId}, delete_id: ${restored.deleteId}).`,
          }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error restoring memory: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
        return {
          content: [{ type: 'text', text: formatScratchpadList(entries) }] satisfies TextContent[],
          details: {},
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error reading scratchpad: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
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
      const operation = params.operation;
      if (!SCRATCHPAD_WRITE_OPERATIONS.includes(operation)) {
        return {
          content: [{ type: 'text', text: `Error: invalid operation "${operation}"` }] satisfies TextContent[],
          details: { isError: true },
        };
      }

      try {
        switch (operation) {
          case 'add': {
            const content = params.content?.trim();
            if (!content) {
              return {
                content: [{ type: 'text', text: 'Error: content is required for add' }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            const result = memoryStore.addScratchpadEntry(content);
            const evictedSuffix = result.evictedIds.length > 0
              ? ` Evicted oldest ids: ${result.evictedIds.join(', ')}`
              : '';
            return {
              content: [{
                type: 'text',
                text: `Scratchpad entry added (id: ${result.entry.id}).${evictedSuffix}`,
              }] satisfies TextContent[],
              details: {},
            };
          }
          case 'replace': {
            const id = params.id?.trim();
            const content = params.content?.trim();
            if (!id) {
              return {
                content: [{ type: 'text', text: 'Error: id is required for replace' }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            if (!content) {
              return {
                content: [{ type: 'text', text: 'Error: content is required for replace' }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            const replaced = memoryStore.replaceScratchpadEntry(id, content);
            if (!replaced) {
              return {
                content: [{ type: 'text', text: `Scratchpad entry not found: ${id}` }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            return {
              content: [{ type: 'text', text: `Scratchpad entry replaced (id: ${replaced.id}).` }] satisfies TextContent[],
              details: {},
            };
          }
          case 'remove': {
            const id = params.id?.trim();
            if (!id) {
              return {
                content: [{ type: 'text', text: 'Error: id is required for remove' }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            const removed = memoryStore.removeScratchpadEntry(id);
            if (!removed) {
              return {
                content: [{ type: 'text', text: `Scratchpad entry not found: ${id}` }] satisfies TextContent[],
                details: { isError: true },
              };
            }
            return {
              content: [{ type: 'text', text: `Scratchpad entry removed (id: ${id}).` }] satisfies TextContent[],
              details: {},
            };
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error writing scratchpad: ${msg}` }] satisfies TextContent[],
          details: { isError: true },
        };
      }
    },
  };
}
