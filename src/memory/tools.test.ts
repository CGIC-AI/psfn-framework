import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryDeleteTool,
  createUndoMemoryDeleteTool,
} from './tools.js';
import type { MemoryWriter, WriteResult, BatchImportResult } from './writer.js';
import type { PurrMemory } from './types.js';
import { VALID_MEMORY_TYPES, VALID_SENSITIVITY_LEVELS } from './types.js';
import type { MemoryStore, MemoryDeleteVersion } from './store.js';

/** Extract text from AgentToolResult content array */
function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

// ── Mock MemoryWriter ──

function makeMemory(overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id: 'mem-001',
    text: 'Test memory',
    type: 'semantic',
    importance: 0.5,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: 'tool:memory_write',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 1,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function mockWriter(): {
  write: ReturnType<typeof vi.fn>;
  importBatch: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(async (): Promise<WriteResult> => ({
      action: 'created',
      memory: makeMemory(),
    })),
    importBatch: vi.fn(async (): Promise<BatchImportResult> => ({
      written: 0,
      deduplicated: 0,
      superseded: 0,
      errors: 0,
      results: [],
    })),
  };
}

describe('createMemoryWriteTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a valid AgentTool with correct name and schema', () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_write');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('memory_write');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('writes a memory and returns success content', async () => {
    const createdMemory = makeMemory({ id: 'mem-abc', type: 'episodic' });
    writer.write.mockResolvedValueOnce({
      action: 'created',
      memory: createdMemory,
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      text: 'V enjoys programming',
      type: 'episodic',
      importance: 0.7,
    });

    expect(resultText(result)).toContain('Memory created');
    expect(resultText(result)).toContain('mem-abc');
    expect(resultText(result)).toContain('episodic');
    expect(result.details?.isError).toBeUndefined();

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'V enjoys programming',
      type: 'episodic',
      importance: 0.7,
      sourceRef: 'tool:memory_write',
    }));
  });

  it('returns deduplicated message when duplicate detected', async () => {
    writer.write.mockResolvedValueOnce({
      action: 'deduplicated',
      memory: makeMemory(),
      existingId: 'existing-456',
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-2', {
      text: 'Duplicate text',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Duplicate detected');
    expect(resultText(result)).toContain('existing-456');
    expect(result.details?.isError).toBeUndefined();
  });

  it('returns superseded message when contradiction resolved', async () => {
    writer.write.mockResolvedValueOnce({
      action: 'superseded',
      memory: makeMemory({ id: 'mem-new' }),
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-3', {
      text: 'Corrected fact',
      type: 'semantic',
      confidence: 0.95,
    });

    expect(resultText(result)).toContain('superseding older conflicting memory');
    expect(resultText(result)).toContain('mem-new');
    expect(result.details?.isError).toBeUndefined();
  });

  it('handles errors gracefully and returns isError in details', async () => {
    writer.write.mockRejectedValueOnce(new Error('Database locked'));

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-4', {
      text: 'Will fail',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Error writing memory');
    expect(resultText(result)).toContain('Database locked');
    expect(result.details?.isError).toBe(true);
  });

  it('returns error for empty text', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-5', {
      text: '',
      type: 'semantic',
    });

    expect(resultText(result)).toContain('Error: text is required');
    expect(result.details?.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('returns error for invalid type', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-6', {
      text: 'Some text',
      type: 'invalid_type',
    });

    expect(resultText(result)).toContain('Error: invalid type');
    expect(result.details?.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('clamps importance to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    // Test above max
    await tool.execute('call-7', { text: 'High importance', type: 'semantic', importance: 1.5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 1.0,
    }));

    writer.write.mockClear();

    // Test below min
    await tool.execute('call-8', { text: 'Negative importance', type: 'semantic', importance: -0.3 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0,
    }));
  });

  it('clamps emotional_valence to -1 to 1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-9', { text: 'Extreme positive', type: 'emotional', emotional_valence: 5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: 1.0,
    }));

    writer.write.mockClear();

    await tool.execute('call-10', { text: 'Extreme negative', type: 'emotional', emotional_valence: -5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: -1.0,
    }));
  });

  it('clamps confidence to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-11', { text: 'Over confident', type: 'semantic', confidence: 2 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      confidence: 1.0,
    }));
  });

  it('uses NaN midpoint for non-numeric importance', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-12', { text: 'NaN test', type: 'semantic', importance: 'not_a_number' });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0.5, // midpoint of (0, 1)
    }));
  });

  it('adds tool:memory_write source tag', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13', { text: 'Source tag test', type: 'semantic' });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'tool:memory_write',
    }));
  });

  it('parses comma-separated tags', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-14', {
      text: 'Tagged memory',
      type: 'semantic',
      tags: ' Identity , Preference, HOBBY ',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      tags: ['identity', 'preference', 'hobby'],
    }));
  });

  it('trims text before writing', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-15', {
      text: '  padded text  ',
      type: 'semantic',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'padded text',
    }));
  });

  it('omits optional fields when not provided', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-16', { text: 'Minimal memory', type: 'semantic' });

    const callArgs = writer.write.mock.calls[0][0];
    expect(callArgs.importance).toBeUndefined();
    expect(callArgs.emotionalValence).toBeUndefined();
    expect(callArgs.confidence).toBeUndefined();
    expect(callArgs.tags).toBeUndefined();
  });

  it('passes sensitivity through to writer.write()', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-17', {
      text: 'Confidential detail',
      type: 'semantic',
      sensitivity: 'confidential',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sensitivity: 'confidential',
    }));
  });

  it('omits sensitivity when not provided', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-18', { text: 'No sensitivity', type: 'semantic' });

    const callArgs = writer.write.mock.calls[0][0];
    expect(callArgs.sensitivity).toBeUndefined();
  });
});

describe('createMemoryImportTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a valid AgentTool with correct name and schema', () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_import_batch');
    expect(tool.description).toBeTruthy();
    expect(tool.label).toBe('memory_import_batch');
    expect(tool.parameters).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('processes batch and returns summary content', async () => {
    writer.importBatch.mockResolvedValueOnce({
      written: 3,
      deduplicated: 1,
      superseded: 0,
      errors: 0,
      results: [],
    } satisfies BatchImportResult);

    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      records: [
        { text: 'Fact one', type: 'semantic' },
        { text: 'Fact two', type: 'semantic' },
        { text: 'Fact three', type: 'semantic' },
        { text: 'Duplicate', type: 'semantic' },
      ],
    });

    expect(resultText(result)).toContain('Import complete');
    expect(resultText(result)).toContain('3 written');
    expect(resultText(result)).toContain('1 deduplicated');
    expect(resultText(result)).toContain('0 superseded');
    expect(resultText(result)).toContain('0 errors');
    expect(resultText(result)).toContain('4 total');
    expect(result.details?.isError).toBeUndefined();
  });

  it('adds tool:memory_import:<source> provenance tag', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-2', {
      records: [
        { text: 'Voxta memory', type: 'semantic' },
      ],
      source: 'voxta',
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('tool:memory_import:voxta');
  });

  it('uses "import" as default source when not specified', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-3', {
      records: [
        { text: 'Default source', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('tool:memory_import:import');
  });

  it('returns error for empty records array', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-4', { records: [] });

    expect(resultText(result)).toContain('Error: records must be a non-empty array');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('returns error for missing records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-5', {} as any);

    expect(resultText(result)).toContain('Error: records must be a non-empty array');
    expect(result.details?.isError).toBe(true);
  });

  it('validates individual records have text', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-6', {
      records: [
        { text: 'Good record', type: 'semantic' },
        { text: '', type: 'semantic' }, // Empty text
      ],
    });

    expect(resultText(result)).toContain('Error: record[1] has empty text');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('validates individual records have valid type', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute('call-7', {
      records: [
        { text: 'Valid', type: 'semantic' },
        { text: 'Invalid type', type: 'bogus' },
      ],
    } as any);

    expect(resultText(result)).toContain('Error: record[1] has invalid type "bogus"');
    expect(result.details?.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('clamps values in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-8', {
      records: [
        {
          text: 'Clamped record',
          type: 'semantic',
          importance: 5.0,
          emotional_valence: -10,
          confidence: 99,
        },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].importance).toBe(1.0);
    expect(importedRecords[0].emotionalValence).toBe(-1.0);
    expect(importedRecords[0].confidence).toBe(1.0);
  });

  it('parses tags in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-9', {
      records: [
        { text: 'Tagged import', type: 'semantic', tags: 'Identity, PREFERENCE' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].tags).toEqual(['identity', 'preference']);
  });

  it('handles errors gracefully and returns isError in details', async () => {
    writer.importBatch.mockRejectedValueOnce(new Error('Storage full'));

    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-10', {
      records: [
        { text: 'Will fail', type: 'semantic' },
      ],
    });

    expect(resultText(result)).toContain('Error importing memories');
    expect(resultText(result)).toContain('Storage full');
    expect(result.details?.isError).toBe(true);
  });

  it('trims text in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-11', {
      records: [
        { text: '  spaces around  ', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].text).toBe('spaces around');
  });

  it('passes sensitivity through for imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-12', {
      records: [
        { text: 'Public fact', type: 'semantic', sensitivity: 'public' },
        { text: 'Intimate fact', type: 'emotional', sensitivity: 'intimate' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sensitivity).toBe('public');
    expect(importedRecords[1].sensitivity).toBe('intimate');
  });

  it('omits sensitivity when not provided in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13', {
      records: [
        { text: 'No sensitivity', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sensitivity).toBeUndefined();
  });
});

describe('memory_delete and undo_memory_delete tools', () => {
  function makeDeleteVersion(overrides: Partial<MemoryDeleteVersion> = {}): MemoryDeleteVersion {
    return {
      deleteId: 'del-1',
      memoryId: 'mem-1',
      snapshot: makeMemory({ id: 'mem-1' }),
      deletedAt: Date.now(),
      deletedBy: 'tool:memory_delete',
      ...overrides,
    };
  }

  function mockStore(): {
    softDeleteMemory: ReturnType<typeof vi.fn>;
    undoSoftDelete: ReturnType<typeof vi.fn>;
  } {
    return {
      softDeleteMemory: vi.fn(),
      undoSoftDelete: vi.fn(),
    };
  }

  it('soft-deletes memory and returns delete_id', async () => {
    const store = mockStore();
    store.softDeleteMemory.mockReturnValue(makeDeleteVersion({
      deleteId: 'del-abc',
      memoryId: 'mem-abc',
    }));

    const tool = createMemoryDeleteTool(store as unknown as MemoryStore);
    const result = await tool.execute('call-1', {
      memory_id: 'mem-abc',
      reason: 'stale',
    });

    expect(resultText(result as any)).toContain('Memory soft-deleted');
    expect(resultText(result as any)).toContain('del-abc');
    expect(store.softDeleteMemory).toHaveBeenCalledWith('mem-abc', {
      deletedBy: 'tool:memory_delete',
      reason: 'stale',
    });
  });

  it('returns error when memory_id is missing', async () => {
    const store = mockStore();
    const tool = createMemoryDeleteTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-2', {
      memory_id: '   ',
    });

    expect(resultText(result as any)).toContain('memory_id is required');
    expect((result.details as any).isError).toBe(true);
    expect(store.softDeleteMemory).not.toHaveBeenCalled();
  });

  it('returns error when memory is missing/already deleted', async () => {
    const store = mockStore();
    store.softDeleteMemory.mockReturnValue(null);
    const tool = createMemoryDeleteTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-3', { memory_id: 'missing' });
    expect(resultText(result as any)).toContain('not found or already deleted');
    expect((result.details as any).isError).toBe(true);
  });

  it('restores deleted memory from delete_id', async () => {
    const store = mockStore();
    store.undoSoftDelete.mockReturnValue(makeDeleteVersion({
      deleteId: 'del-restore',
      memoryId: 'mem-restore',
      restoredAt: Date.now(),
      restoredBy: 'tool:undo_memory_delete',
    }));
    const tool = createUndoMemoryDeleteTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-4', { delete_id: 'del-restore' });
    expect(resultText(result as any)).toContain('Memory restored');
    expect(resultText(result as any)).toContain('mem-restore');
    expect(store.undoSoftDelete).toHaveBeenCalledWith('del-restore', {
      restoredBy: 'tool:undo_memory_delete',
    });
  });

  it('returns error when delete checkpoint is missing', async () => {
    const store = mockStore();
    store.undoSoftDelete.mockReturnValue(null);
    const tool = createUndoMemoryDeleteTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-5', { delete_id: 'unknown' });
    expect(resultText(result as any)).toContain('Delete checkpoint not found');
    expect((result.details as any).isError).toBe(true);
  });
});
