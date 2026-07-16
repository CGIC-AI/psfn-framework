import { describe, expect, it, vi } from 'vitest';
import type {
  MemoryStorePort,
  MemorySubjectAuthorizedMutation,
  MemorySubjectAuthorizedQuery,
} from './memory-store-port.js';
import { createSubjectAuthorizedMemoryStore } from './subject-authorized-store.js';
import type { PurrMemory } from './types.js';

function memory(id: string, text: string): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: 'test:subject-store',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'low',
    consentFlags: {},
  };
}

describe('subject-authorized memory store', () => {
  it('routes body, snippet, count, embedding, known-id, update, and bulk access through the SQL primitive', async () => {
    const visible = memory('visible', 'visible body');
    const queries: MemorySubjectAuthorizedQuery[] = [];
    const mutations: MemorySubjectAuthorizedMutation[] = [];
    const rawRead = vi.fn(() => {
      throw new Error('raw memory read must not run');
    });
    const store = {
      searchByEmbedding: rawRead,
      searchByText: rawRead,
      countActiveMemories: rawRead,
      getById: rawRead,
      updateMemory: rawRead,
      bulkUpdate: rawRead,
      bulkUpdateSalience: rawRead,
      queryAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
        queries.push(input);
        return input.selector.kind === 'count'
          ? { memories: [], total: 1 }
          : { memories: [{ ...visible, similarity: 0.75 }], total: 1 };
      }),
      mutateAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedMutation) => {
        mutations.push(input);
        return input.memoryIds.length;
      }),
    } as unknown as MemoryStorePort;
    const authorized = createSubjectAuthorizedMemoryStore(store, { viewerContactId: 'contact-a' });

    expect((await authorized.searchByText('visible', 5))[0]?.text).toBe('visible body');
    expect((await authorized.searchByEmbedding(new Float32Array([1]), 0.1, 5))[0]?.id).toBe('visible');
    expect(await authorized.countActiveMemories()).toBe(1);
    expect((await authorized.getById('visible'))?.text).toBe('visible body');
    await authorized.updateMemory('visible', { sensitivity: 'confidential' });
    expect(await authorized.bulkUpdate(['visible'], { sensitivity: 'intimate' })).toBe(1);

    expect(queries.map(query => [query.authorization.action, query.selector.kind])).toEqual([
      ['search', 'text_search'],
      ['embedding', 'embedding_search'],
      ['count', 'count'],
      ['detail', 'detail'],
    ]);
    expect(queries.every(query => query.authorization.viewerContactIds[0] === 'contact-a')).toBe(true);
    expect(mutations.map(mutation => mutation.authorization.action)).toEqual(['update', 'bulk_mutation']);
    expect(rawRead).not.toHaveBeenCalled();
  });

  it('fails closed without a trusted subject and never probes raw storage', async () => {
    const rawRead = vi.fn(() => {
      throw new Error('raw memory access must not run');
    });
    const store = {
      searchByEmbedding: rawRead,
      searchByText: rawRead,
      countActiveMemories: rawRead,
      getById: rawRead,
      updateMemory: rawRead,
      bulkUpdate: rawRead,
      queryAuthorizedMemorySubjects: rawRead,
      mutateAuthorizedMemorySubjects: rawRead,
    } as unknown as MemoryStorePort;
    const denied = createSubjectAuthorizedMemoryStore(store, {});

    expect(await denied.searchByText('known secret', 10)).toEqual([]);
    expect(await denied.searchByEmbedding(new Float32Array([1]), 0.1, 10)).toEqual([]);
    expect(await denied.countActiveMemories()).toBe(0);
    expect(await denied.getById('known-id')).toBeUndefined();
    expect(await denied.getStats()).toEqual({ total: 0, byType: {}, avgSalience: 0 });
    expect(await denied.listAdminMemories()).toMatchObject({ memories: [], total: 0 });
    expect(await denied.queryAuthorizedMemorySubjects({
      authorization: {
        action: 'detail',
        viewerContactIds: ['attacker-selected-contact'],
        allowedSubjectClasses: ['single_contact'],
        allowedViewerRelations: ['self'],
        classifierVersion: 1,
        grantBindings: [],
      },
      selector: { kind: 'detail', memoryId: 'known-id' },
    })).toEqual({ memories: [], total: 0 });
    await expect(denied.updateMemory('known-id', { sensitivity: 'low' }))
      .rejects.toThrow('trusted memory subject');
    await expect(denied.bulkUpdate(['known-id'], { sensitivity: 'low' }))
      .rejects.toThrow('trusted memory subject');
    await expect(denied.bulkUpdateSalience([{
      id: 'known-id',
      salience: 0.5,
      salienceDecayAnchorAt: 1,
    }])).rejects.toThrow('trusted memory subject');
    expect(rawRead).not.toHaveBeenCalled();
  });

  it('keeps replacement writes behind one atomic authorized primitive', async () => {
    const replacement = memory('replacement', 'replacement body');
    const rawWrite = vi.fn(() => {
      throw new Error('split raw write must not run');
    });
    const persistAuthorizedMemoryWrite = vi.fn(async () => undefined);
    const store = {
      persistMemoryWrite: rawWrite,
      mutateAuthorizedMemorySubjects: rawWrite,
      persistAuthorizedMemoryWrite,
    } as unknown as MemoryStorePort;
    const authorized = createSubjectAuthorizedMemoryStore(store, { viewerContactId: 'contact-a' });

    await authorized.persistMemoryWrite({
      memory: replacement,
      embedding: new Float32Array([1]),
      supersededMemoryIds: ['old-a'],
    });

    expect(persistAuthorizedMemoryWrite).toHaveBeenCalledWith({
      authorization: expect.objectContaining({
        action: 'bulk_mutation',
        viewerContactIds: ['contact-a'],
      }),
      memory: expect.objectContaining({
        id: 'replacement',
        provenance: { subjectContactId: 'contact-a' },
      }),
      embedding: expect.any(Float32Array),
      supersededMemoryIds: ['old-a'],
    });
    expect(rawWrite).not.toHaveBeenCalled();
  });
});
