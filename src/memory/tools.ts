// ── Memory Write/Import Tools ──
// Agent-accessible tools for intentional memory creation.

import type { SubstrateTool } from '../types.js';
import type { MemoryWriter, MemoryWriteOptions } from './writer.js';
import type { MemoryType, SensitivityLevel } from './types.js';
import { VALID_MEMORY_TYPES, VALID_SENSITIVITY_LEVELS } from './types.js';

function clamp(val: number, min: number, max: number): number {
  if (isNaN(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

export function createMemoryWriteTool(writer: MemoryWriter): SubstrateTool {
  return {
    name: 'memory_write',
    description:
      'Write a new memory. Automatically deduplicates against existing memories. ' +
      'Use for intentionally recording important facts, observations, or learnings.',
    inputSchema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The memory text — a single clear sentence stating the fact',
        },
        type: {
          type: 'string',
          enum: VALID_MEMORY_TYPES,
          description: 'Memory type: episodic (events), semantic (facts), emotional (feelings), procedural (patterns), reflection (meta)',
        },
        importance: {
          type: 'number',
          description: '0-1, how significant (default 0.5). 0.8+ for core identity facts.',
        },
        emotional_valence: {
          type: 'number',
          description: '-1 to 1, emotional tone (-1 very negative, 0 neutral, 1 very positive). Default 0.',
        },
        confidence: {
          type: 'number',
          description: '0-1, how confident in this fact (default 0.8). Higher confidence can supersede lower.',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tags (e.g. "identity, preference")',
        },
        sensitivity: {
          type: 'string',
          enum: VALID_SENSITIVITY_LEVELS,
          description: 'Privacy level: public (share anywhere), personal (trusted only), intimate (primary only), confidential (1:1 only). Default: personal.',
        },
      },
      required: ['text', 'type'],
    },
    execute: async (input) => {
      try {
        const text = input.text as string;
        const type = input.type as MemoryType;

        if (!text || text.trim().length === 0) {
          return { content: 'Error: text is required', isError: true };
        }
        if (!VALID_MEMORY_TYPES.includes(type)) {
          return { content: `Error: invalid type "${type}". Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`, isError: true };
        }

        const importance = input.importance !== undefined ? clamp(Number(input.importance), 0, 1) : undefined;
        const emotionalValence = input.emotional_valence !== undefined ? clamp(Number(input.emotional_valence), -1, 1) : undefined;
        const confidence = input.confidence !== undefined ? clamp(Number(input.confidence), 0, 1) : undefined;

        const tagsStr = input.tags as string | undefined;
        const tags = tagsStr
          ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
          : undefined;

        const sensitivity = input.sensitivity as SensitivityLevel | undefined;

        const result = await writer.write({
          text: text.trim(),
          type,
          importance,
          emotionalValence,
          confidence,
          tags,
          sourceRef: 'tool:memory_write',
          sensitivity,
        });

        switch (result.action) {
          case 'created':
            return { content: `Memory created (id: ${result.memory.id}, type: ${type})` };
          case 'deduplicated':
            return { content: `Duplicate detected — bumped salience on existing memory (id: ${result.existingId})` };
          case 'superseded':
            return { content: `Memory created, superseding older conflicting memory (id: ${result.memory.id}, type: ${type})` };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `Error writing memory: ${msg}`, isError: true };
      }
    },
  };
}

export function createMemoryImportTool(writer: MemoryWriter): SubstrateTool {
  return {
    name: 'memory_import_batch',
    description:
      'Import multiple memories at once. Each record is deduped against existing memories ' +
      'and against earlier records in the same batch. Use for bulk restoration or migration.',
    inputSchema: {
      type: 'object',
      properties: {
        records: {
          type: 'array',
          description: 'Array of memory records to import',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              type: { type: 'string', enum: VALID_MEMORY_TYPES },
              importance: { type: 'number' },
              emotional_valence: { type: 'number' },
              confidence: { type: 'number' },
              tags: { type: 'string' },
              sensitivity: { type: 'string', enum: VALID_SENSITIVITY_LEVELS },
            },
            required: ['text', 'type'],
          },
        },
        source: {
          type: 'string',
          description: 'Import source label for provenance (e.g. "voxta", "backup"). Default: "import".',
        },
      },
      required: ['records'],
    },
    execute: async (input) => {
      try {
        const rawRecords = input.records as Array<Record<string, unknown>>;
        const source = (input.source as string) || 'import';

        if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
          return { content: 'Error: records must be a non-empty array', isError: true };
        }

        // Validate and convert records
        const records: MemoryWriteOptions[] = [];
        for (let i = 0; i < rawRecords.length; i++) {
          const r = rawRecords[i];
          const text = r.text as string;
          const type = r.type as MemoryType;

          if (!text || text.trim().length === 0) {
            return { content: `Error: record[${i}] has empty text`, isError: true };
          }
          if (!VALID_MEMORY_TYPES.includes(type)) {
            return { content: `Error: record[${i}] has invalid type "${type}"`, isError: true };
          }

          const tagsStr = r.tags as string | undefined;
          const sensitivity = r.sensitivity as SensitivityLevel | undefined;
          records.push({
            text: text.trim(),
            type,
            importance: r.importance !== undefined ? clamp(Number(r.importance), 0, 1) : undefined,
            emotionalValence: r.emotional_valence !== undefined ? clamp(Number(r.emotional_valence), -1, 1) : undefined,
            confidence: r.confidence !== undefined ? clamp(Number(r.confidence), 0, 1) : undefined,
            tags: tagsStr ? tagsStr.split(',').map(t => t.trim().toLowerCase()).filter(Boolean) : undefined,
            sourceRef: `tool:memory_import:${source}`,
            sensitivity,
          });
        }

        const result = await writer.importBatch(records);

        return {
          content:
            `Import complete: ${result.written} written, ${result.deduplicated} deduplicated, ` +
            `${result.superseded} superseded, ${result.errors} errors (${records.length} total)`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `Error importing memories: ${msg}`, isError: true };
      }
    },
  };
}
