import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMemoryWriteTool, createMemoryImportTool } from './tools.js';
import type { MemoryWriter, WriteResult, BatchImportResult } from './writer.js';
import type { PurrMemory } from './types.js';
import { VALID_MEMORY_TYPES } from './types.js';

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

  it('returns a valid SubstrateTool with correct name and schema', () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_write');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['text', 'type']);
    expect(typeof tool.execute).toBe('function');

    // Verify schema includes expected properties
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.text).toBeDefined();
    expect(props.type).toBeDefined();
    expect(props.type.enum).toEqual(VALID_MEMORY_TYPES);
    expect(props.importance).toBeDefined();
    expect(props.emotional_valence).toBeDefined();
    expect(props.confidence).toBeDefined();
    expect(props.tags).toBeDefined();
  });

  it('writes a memory and returns success content', async () => {
    const createdMemory = makeMemory({ id: 'mem-abc', type: 'episodic' });
    writer.write.mockResolvedValueOnce({
      action: 'created',
      memory: createdMemory,
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      text: 'V enjoys programming',
      type: 'episodic',
      importance: 0.7,
    });

    expect(result.content).toContain('Memory created');
    expect(result.content).toContain('mem-abc');
    expect(result.content).toContain('episodic');
    expect(result.isError).toBeUndefined();

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
    const result = await tool.execute({
      text: 'Duplicate text',
      type: 'semantic',
    });

    expect(result.content).toContain('Duplicate detected');
    expect(result.content).toContain('existing-456');
    expect(result.isError).toBeUndefined();
  });

  it('returns superseded message when contradiction resolved', async () => {
    writer.write.mockResolvedValueOnce({
      action: 'superseded',
      memory: makeMemory({ id: 'mem-new' }),
    } satisfies WriteResult);

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      text: 'Corrected fact',
      type: 'semantic',
      confidence: 0.95,
    });

    expect(result.content).toContain('superseding older conflicting memory');
    expect(result.content).toContain('mem-new');
    expect(result.isError).toBeUndefined();
  });

  it('handles errors gracefully and returns isError: true', async () => {
    writer.write.mockRejectedValueOnce(new Error('Database locked'));

    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      text: 'Will fail',
      type: 'semantic',
    });

    expect(result.content).toContain('Error writing memory');
    expect(result.content).toContain('Database locked');
    expect(result.isError).toBe(true);
  });

  it('returns error for empty text', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      text: '',
      type: 'semantic',
    });

    expect(result.content).toContain('Error: text is required');
    expect(result.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('returns error for invalid type', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      text: 'Some text',
      type: 'invalid_type',
    });

    expect(result.content).toContain('Error: invalid type');
    expect(result.isError).toBe(true);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('clamps importance to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    // Test above max
    await tool.execute({ text: 'High importance', type: 'semantic', importance: 1.5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 1.0,
    }));

    writer.write.mockClear();

    // Test below min
    await tool.execute({ text: 'Negative importance', type: 'semantic', importance: -0.3 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0,
    }));
  });

  it('clamps emotional_valence to -1 to 1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({ text: 'Extreme positive', type: 'emotional', emotional_valence: 5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: 1.0,
    }));

    writer.write.mockClear();

    await tool.execute({ text: 'Extreme negative', type: 'emotional', emotional_valence: -5 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      emotionalValence: -1.0,
    }));
  });

  it('clamps confidence to 0-1 range', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({ text: 'Over confident', type: 'semantic', confidence: 2 });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      confidence: 1.0,
    }));
  });

  it('uses NaN midpoint for non-numeric importance', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({ text: 'NaN test', type: 'semantic', importance: 'not_a_number' });
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      importance: 0.5, // midpoint of (0, 1)
    }));
  });

  it('adds tool:memory_write source tag', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({ text: 'Source tag test', type: 'semantic' });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'tool:memory_write',
    }));
  });

  it('parses comma-separated tags', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({
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

    await tool.execute({
      text: '  padded text  ',
      type: 'semantic',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'padded text',
    }));
  });

  it('omits optional fields when not provided', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute({ text: 'Minimal memory', type: 'semantic' });

    const callArgs = writer.write.mock.calls[0][0];
    expect(callArgs.importance).toBeUndefined();
    expect(callArgs.emotionalValence).toBeUndefined();
    expect(callArgs.confidence).toBeUndefined();
    expect(callArgs.tags).toBeUndefined();
  });
});

describe('createMemoryImportTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a valid SubstrateTool with correct name and schema', () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    expect(tool.name).toBe('memory_import_batch');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['records']);
    expect(typeof tool.execute).toBe('function');

    // Verify schema has records and source
    const props = tool.inputSchema.properties as Record<string, any>;
    expect(props.records).toBeDefined();
    expect(props.source).toBeDefined();
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
    const result = await tool.execute({
      records: [
        { text: 'Fact one', type: 'semantic' },
        { text: 'Fact two', type: 'semantic' },
        { text: 'Fact three', type: 'semantic' },
        { text: 'Duplicate', type: 'semantic' },
      ],
    });

    expect(result.content).toContain('Import complete');
    expect(result.content).toContain('3 written');
    expect(result.content).toContain('1 deduplicated');
    expect(result.content).toContain('0 superseded');
    expect(result.content).toContain('0 errors');
    expect(result.content).toContain('4 total');
    expect(result.isError).toBeUndefined();
  });

  it('adds tool:memory_import:<source> provenance tag', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute({
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

    await tool.execute({
      records: [
        { text: 'Default source', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('tool:memory_import:import');
  });

  it('returns error for empty records array', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute({ records: [] });

    expect(result.content).toContain('Error: records must be a non-empty array');
    expect(result.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('returns error for missing records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute({});

    expect(result.content).toContain('Error: records must be a non-empty array');
    expect(result.isError).toBe(true);
  });

  it('validates individual records have text', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute({
      records: [
        { text: 'Good record', type: 'semantic' },
        { text: '', type: 'semantic' }, // Empty text
      ],
    });

    expect(result.content).toContain('Error: record[1] has empty text');
    expect(result.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('validates individual records have valid type', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    const result = await tool.execute({
      records: [
        { text: 'Valid', type: 'semantic' },
        { text: 'Invalid type', type: 'bogus' },
      ],
    });

    expect(result.content).toContain('Error: record[1] has invalid type "bogus"');
    expect(result.isError).toBe(true);
    expect(writer.importBatch).not.toHaveBeenCalled();
  });

  it('clamps values in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute({
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

    await tool.execute({
      records: [
        { text: 'Tagged import', type: 'semantic', tags: 'Identity, PREFERENCE' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].tags).toEqual(['identity', 'preference']);
  });

  it('handles errors gracefully and returns isError: true', async () => {
    writer.importBatch.mockRejectedValueOnce(new Error('Storage full'));

    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);
    const result = await tool.execute({
      records: [
        { text: 'Will fail', type: 'semantic' },
      ],
    });

    expect(result.content).toContain('Error importing memories');
    expect(result.content).toContain('Storage full');
    expect(result.isError).toBe(true);
  });

  it('trims text in imported records', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute({
      records: [
        { text: '  spaces around  ', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].text).toBe('spaces around');
  });
});
