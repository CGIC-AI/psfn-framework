// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryType, SensitivityLevel } from './types.js';
import { VALID_MEMORY_TYPES, VALID_SENSITIVITY_LEVELS } from './types.js';

function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
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
        description: 'Memory type: episodic (events), semantic (facts), emotional (feelings), procedural (patterns), reflection (meta)',
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
      _toolCallId: string,
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
          sourceRef: 'tool:memory_write',
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
      _toolCallId: string,
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
            sourceRef: `tool:memory_import:${source}`,
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
