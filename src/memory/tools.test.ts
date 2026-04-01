import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMemoryTool,
  createMemoryWriteTool,
  createMemoryImportTool,
  createMemoryRedactTool,
  createMemoryDeleteTool,
  createUndoMemoryDeleteTool,
  createScratchpadTool,
} from './tools.js';
import type {
  MemoryWriter,
  WriteResult,
  BatchImportResult,
  MemoryRedactionResult,
} from './writer.js';
import type { PurrMemory } from './types.js';
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

describe('createMemoryTool', () => {
  let writer: ReturnType<typeof mockWriter>;

  function makeUnifiedDeleteVersion(overrides: Partial<MemoryDeleteVersion> = {}): MemoryDeleteVersion {
    return {
      deleteId: 'del-1',
      memoryId: 'mem-1',
      snapshot: makeMemory({ id: 'mem-1' }),
      deletedAt: Date.now(),
      deletedBy: 'tool:memory|action:delete',
      ...overrides,
    };
  }

  function mockUnifiedStore(): {
    searchByText: ReturnType<typeof vi.fn>;
    softDeleteMemory: ReturnType<typeof vi.fn>;
    undoSoftDelete: ReturnType<typeof vi.fn>;
  } {
    return {
      searchByText: vi.fn(),
      softDeleteMemory: vi.fn(),
      undoSoftDelete: vi.fn(),
    };
  }

  beforeEach(() => {
    writer = mockWriter();
  });

  it('returns a unified memory tool contract', () => {
    const tool = createMemoryTool(writer as unknown as MemoryWriter, mockUnifiedStore() as unknown as MemoryStore);

    expect(tool.name).toBe('memory');
    expect(tool.label).toBe('memory');
    expect(tool.description).toContain('Unified long-term memory tool');
    expect(tool.parameters).toBeDefined();
  });

  it('writes through action=write with unified provenance', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStore);

    await tool.execute('memory-call-1', {
      action: 'write',
      text: '  V enjoys precise APIs  ',
      type: 'semantic',
      importance: 0.7,
      tags: 'Identity, Preference',
    });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      text: 'V enjoys precise APIs',
      type: 'semantic',
      importance: 0.7,
      tags: ['identity', 'preference'],
      sourceRef: 'source:tool:memory|action:write|invocation:memory-call-1',
    }));
  });

  it('searches through action=search and formats results', async () => {
    const store = mockUnifiedStore();
    store.searchByText.mockReturnValue([
      { ...makeMemory({ id: 'mem-search-1', text: 'V likes direct answers', sensitivity: 'public' }), similarity: 0.82 },
    ]);
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStore);

    const result = await tool.execute('memory-call-2', {
      action: 'search',
      query: 'direct answers',
      limit: 2,
    });

    expect(store.searchByText).toHaveBeenCalledWith('direct answers', 2);
    expect(resultText(result as any)).toContain('Memory search results (1)');
    expect(resultText(result as any)).toContain('mem-search-1');
    expect(resultText(result as any)).toContain('similarity=0.82');
  });

  it('imports through action=import with unified provenance qualifiers', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStore);

    await tool.execute('memory-call-3', {
      action: 'import',
      source: 'backup',
      records: [{ text: 'Imported fact', type: 'semantic', tags: 'archive' }],
    });

    expect(writer.importBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        text: 'Imported fact',
        sourceRef: 'source:tool:memory|action:import|import_source:backup|invocation:memory-call-3',
        tags: ['archive'],
      }),
    ]);
  });

  it('redacts through action=redact with unified requestedBy/sourceRef', async () => {
    const store = mockUnifiedStore();
    const redact = vi.fn().mockResolvedValue({
      operation: 'deleted',
      behavior: 'delete',
      sourceMemoryId: 'mem-7',
      deleteId: 'del-7',
    } satisfies MemoryRedactionResult);
    const tool = createMemoryTool(
      { ...writer, redact } as unknown as MemoryWriter,
      store as unknown as MemoryStore,
    );

    const result = await tool.execute('memory-call-4', {
      action: 'redact',
      memory_id: 'mem-7',
      operation: 'delete',
      reason: 'consent revoked',
    });

    expect(redact).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: 'mem-7',
      operation: 'delete',
      reason: 'consent revoked',
      requestedBy: 'source:tool:memory|action:redact|invocation:memory-call-4',
      sourceRef: 'source:tool:memory|action:redact|invocation:memory-call-4',
    }));
    expect(resultText(result as any)).toContain('redacted via delete');
  });

  it('deletes and restores through unified actions', async () => {
    const store = mockUnifiedStore();
    store.softDeleteMemory.mockReturnValue(makeUnifiedDeleteVersion({
      deleteId: 'del-unified',
      deletedBy: 'tool:memory|action:delete',
    }));
    store.undoSoftDelete.mockReturnValue(makeUnifiedDeleteVersion({
      deleteId: 'del-unified',
      restoredBy: 'tool:memory|action:restore',
      restoredAt: Date.now(),
    }));
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStore);

    const deleted = await tool.execute('memory-call-5', {
      action: 'delete',
      memory_id: 'mem-1',
      reason: 'cleanup',
    });
    expect(store.softDeleteMemory).toHaveBeenCalledWith('mem-1', {
      deletedBy: 'tool:memory|action:delete',
      reason: 'cleanup',
    });
    expect(resultText(deleted as any)).toContain('Memory soft-deleted');

    const restored = await tool.execute('memory-call-6', {
      action: 'restore',
      delete_id: 'del-unified',
    });
    expect(store.undoSoftDelete).toHaveBeenCalledWith('del-unified', {
      restoredBy: 'tool:memory|action:restore',
    });
    expect(resultText(restored as any)).toContain('Memory restored');
  });

  it('accepts shard provenance overrides for unified write/import/redact actions', async () => {
    const store = mockUnifiedStore();
    const redact = vi.fn().mockResolvedValue({
      operation: 'deleted',
      behavior: 'delete',
      sourceMemoryId: 'mem-8',
      deleteId: 'del-8',
    } satisfies MemoryRedactionResult);
    const tool = createMemoryTool(
      { ...writer, redact } as unknown as MemoryWriter,
      store as unknown as MemoryStore,
    );

    await tool.execute('memory-call-7', {
      action: 'write',
      text: 'Shard write',
      type: 'semantic',
      __psfnShardSource: 'shard:shard-1',
    } as any);
    await tool.execute('memory-call-8', {
      action: 'import',
      records: [{ text: 'Shard import', type: 'semantic' }],
      __psfnShardSource: 'shard:shard-1',
    } as any);
    await tool.execute('memory-call-9', {
      action: 'redact',
      memory_id: 'mem-8',
      __psfnShardSource: 'shard:shard-1',
    } as any);

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:shard:shard-1|tool:memory|action:write|invocation:memory-call-7',
    }));
    expect(writer.importBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceRef: 'source:shard:shard-1|tool:memory|action:import|import_source:import|invocation:memory-call-8',
      }),
    ]);
    expect(redact).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:shard:shard-1|tool:memory|action:redact|invocation:memory-call-9',
    }));
  });

  it('fails closed on invalid or incomplete actions', async () => {
    const store = mockUnifiedStore();
    const tool = createMemoryTool(writer as unknown as MemoryWriter, store as unknown as MemoryStore);

    const missingQuery = await tool.execute('memory-call-10', { action: 'search' } as any);
    expect(resultText(missingQuery as any)).toContain('query is required for action=search');
    expect((missingQuery.details as any).isError).toBe(true);

    const badAction = await tool.execute('memory-call-11', { action: 'purge' } as any);
    expect(resultText(badAction as any)).toContain('invalid action');
    expect((badAction.details as any).isError).toBe(true);
  });
});

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
      sourceRef: 'source:tool:memory_write|invocation:call-1',
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

  it('adds tool:memory_write provenance with invocation id', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13', { text: 'Source tag test', type: 'semantic' });

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:tool:memory_write|invocation:call-13',
    }));
  });

  it('accepts internal shard provenance overrides for orchestration wrappers', async () => {
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter);

    await tool.execute('call-13b', {
      text: 'Shard reintegration finding',
      type: 'semantic',
      __psfnShardSource: 'shard:shard-abc',
    } as any);

    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      sourceRef: 'source:shard:shard-abc|tool:memory_write|invocation:call-13b',
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

  it('passes formationVAD from provider into writer.write()', async () => {
    const getFormationVAD = vi.fn(() => ({
      valence: 0.7,
      arousal: -0.35,
      dominance: 0.1,
    }));
    const tool = createMemoryWriteTool(writer as unknown as MemoryWriter, { getFormationVAD });

    await tool.execute('call-18b', { text: 'Mood-tagged memory', type: 'semantic' });

    expect(getFormationVAD).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith(expect.objectContaining({
      formationVAD: {
        valence: 0.7,
        arousal: -0.35,
        dominance: 0.1,
      },
    }));
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
    expect(importedRecords[0].sourceRef).toBe('source:tool:memory_import:voxta|invocation:call-2');
  });

  it('uses "import" as default source when not specified', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-3', {
      records: [
        { text: 'Default source', type: 'semantic' },
      ],
    });

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe('source:tool:memory_import:import|invocation:call-3');
  });

  it('accepts internal shard provenance for imported memory batches', async () => {
    const tool = createMemoryImportTool(writer as unknown as MemoryWriter);

    await tool.execute('call-3b', {
      records: [{ text: 'from shard', type: 'semantic' }],
      __psfnShardSource: 'shard:shard-xyz',
    } as any);

    const importedRecords = writer.importBatch.mock.calls[0][0];
    expect(importedRecords[0].sourceRef).toBe(
      'source:shard:shard-xyz|tool:memory_import:import|invocation:call-3b',
    );
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

describe('createMemoryRedactTool', () => {
  function makeRedaction(overrides: Partial<MemoryRedactionResult> = {}): MemoryRedactionResult {
    return {
      operation: 'abstracted',
      behavior: 'abstract',
      sourceMemoryId: 'mem-1',
      deleteId: 'del-1',
      abstractedMemoryId: 'mem-abstract-1',
      abstractedText: 'Partner benefits from medication reminders during high workload periods.',
      externalProvenanceRef: 'abstraction:ext-1',
      ...overrides,
    };
  }

  function mockRedactWriter(): { redact: ReturnType<typeof vi.fn> } {
    return {
      redact: vi.fn(),
    };
  }

  it('returns abstraction success details', async () => {
    const writer = mockRedactWriter();
    writer.redact.mockResolvedValue(makeRedaction());

    const tool = createMemoryRedactTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-1', {
      memory_id: 'mem-1',
      operation: 'auto',
      reason: 'consent request',
    });

    expect(resultText(result as any)).toContain('redacted via abstraction');
    expect(resultText(result as any)).toContain('mem-abstract-1');
    expect(resultText(result as any)).toContain('abstraction:ext-1');
    expect(writer.redact).toHaveBeenCalledWith(expect.objectContaining({
      memoryId: 'mem-1',
      operation: 'auto',
      reason: 'consent request',
      sourceRef: 'source:tool:memory_redact|invocation:call-1',
    }));
  });

  it('returns delete success details', async () => {
    const writer = mockRedactWriter();
    writer.redact.mockResolvedValue(makeRedaction({
      operation: 'deleted',
      behavior: 'delete',
      abstractedMemoryId: undefined,
      externalProvenanceRef: undefined,
    }));

    const tool = createMemoryRedactTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-2', {
      memory_id: 'mem-1',
      operation: 'delete',
    });

    expect(resultText(result as any)).toContain('redacted via delete');
    expect(resultText(result as any)).toContain('delete');
  });

  it('validates memory_id and operation', async () => {
    const writer = mockRedactWriter();
    const tool = createMemoryRedactTool(writer as unknown as MemoryWriter);

    const missingId = await tool.execute('call-3', { memory_id: '   ' });
    expect(resultText(missingId as any)).toContain('memory_id is required');
    expect((missingId.details as any).isError).toBe(true);

    const badOp = await tool.execute('call-4', {
      memory_id: 'mem-1',
      operation: 'purge' as any,
    });
    expect(resultText(badOp as any)).toContain('invalid operation');
    expect((badOp.details as any).isError).toBe(true);
    expect(writer.redact).not.toHaveBeenCalled();
  });

  it('returns error when memory is not found', async () => {
    const writer = mockRedactWriter();
    writer.redact.mockResolvedValue(null);

    const tool = createMemoryRedactTool(writer as unknown as MemoryWriter);
    const result = await tool.execute('call-5', { memory_id: 'missing' });
    expect(resultText(result as any)).toContain('not found or already deleted');
    expect((result.details as any).isError).toBe(true);
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

describe('scratchpad tools', () => {
  function mockScratchpadStore(): {
    listScratchpadEntries: ReturnType<typeof vi.fn>;
    addScratchpadEntry: ReturnType<typeof vi.fn>;
    replaceScratchpadEntry: ReturnType<typeof vi.fn>;
    appendScratchpadEntry: ReturnType<typeof vi.fn>;
    removeScratchpadEntry: ReturnType<typeof vi.fn>;
  } {
    return {
      listScratchpadEntries: vi.fn(),
      addScratchpadEntry: vi.fn(),
      replaceScratchpadEntry: vi.fn(),
      appendScratchpadEntry: vi.fn(),
      removeScratchpadEntry: vi.fn(),
    };
  }

  it('scratchpad list returns empty-state message', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([]);
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-1', { action: 'list' });
    expect(resultText(result as any)).toContain('Scratchpad is empty');
    expect(resultText(result as any)).toContain('temporary long-context notes');
    expect(store.listScratchpadEntries).toHaveBeenCalledWith(20);
  });

  it('scratchpad list returns formatted notes with timestamps and promotion guidance', async () => {
    const store = mockScratchpadStore();
    store.listScratchpadEntries.mockReturnValue([
      {
        id: 'sp-1',
        content: 'Remember to check weekly backup integrity.',
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
      },
    ]);
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-2', { action: 'list', limit: 3 });
    const text = resultText(result as any);
    expect(text).toContain('Scratchpad entries (1)');
    expect(text).toContain('ephemeral long-context workspace');
    expect(text).toContain('not canonical memory or orientation');
    expect(text).toContain('sp-1');
    expect(text).toContain('Remember to check weekly backup integrity.');
    expect(store.listScratchpadEntries).toHaveBeenCalledWith(3);
  });

  it('scratchpad add creates a note', async () => {
    const store = mockScratchpadStore();
    store.addScratchpadEntry.mockReturnValue({
      entry: {
        id: 'sp-1',
        content: 'Take a breath before responding',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      evictedIds: [],
    });
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-3', {
      action: 'add',
      content: 'Take a breath before responding',
    });
    expect(resultText(result as any)).toContain('Scratchpad entry added');
    expect(resultText(result as any)).toContain('promote only stable outcomes elsewhere');
    expect(store.addScratchpadEntry).toHaveBeenCalledWith('Take a breath before responding');
  });

  it('scratchpad replace updates existing note', async () => {
    const store = mockScratchpadStore();
    store.replaceScratchpadEntry.mockReturnValue({
      id: 'sp-2',
      content: 'Updated note',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-4', {
      action: 'replace',
      id: 'sp-2',
      content: 'Updated note',
    });
    expect(resultText(result as any)).toContain('Scratchpad entry replaced');
    expect(store.replaceScratchpadEntry).toHaveBeenCalledWith('sp-2', 'Updated note');
  });

  it('scratchpad append extends an existing note', async () => {
    const store = mockScratchpadStore();
    store.appendScratchpadEntry.mockReturnValue({
      id: 'sp-2',
      content: 'Original note\nAppended segment',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-4b', {
      action: 'append',
      id: 'sp-2',
      content: 'Appended segment',
    });
    expect(resultText(result as any)).toContain('Scratchpad entry appended');
    expect(store.appendScratchpadEntry).toHaveBeenCalledWith('sp-2', 'Appended segment');
  });

  it('scratchpad remove deletes note', async () => {
    const store = mockScratchpadStore();
    store.removeScratchpadEntry.mockReturnValue(true);
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const result = await tool.execute('call-5', {
      action: 'remove',
      id: 'sp-3',
    });
    expect(resultText(result as any)).toContain('Scratchpad entry removed');
    expect(store.removeScratchpadEntry).toHaveBeenCalledWith('sp-3');
  });

  it('scratchpad validates required params per action', async () => {
    const store = mockScratchpadStore();
    const tool = createScratchpadTool(store as unknown as MemoryStore);

    const missingAddContent = await tool.execute('call-6', { action: 'add' });
    expect(resultText(missingAddContent as any)).toContain('content is required for action=add');
    expect((missingAddContent.details as any).isError).toBe(true);

    const missingReplaceId = await tool.execute('call-7', {
      action: 'replace',
      content: 'x',
    });
    expect(resultText(missingReplaceId as any)).toContain('id is required for action=replace');
    expect((missingReplaceId.details as any).isError).toBe(true);

    const missingAppendContent = await tool.execute('call-7b', {
      action: 'append',
      id: 'sp-1',
    });
    expect(resultText(missingAppendContent as any)).toContain('content is required for action=append');
    expect((missingAppendContent.details as any).isError).toBe(true);

    const missingRemoveId = await tool.execute('call-8', {
      action: 'remove',
    });
    expect(resultText(missingRemoveId as any)).toContain('id is required for action=remove');
    expect((missingRemoveId.details as any).isError).toBe(true);
  });
});
