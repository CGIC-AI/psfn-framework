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
  it('projects contact profiles to the exact proven subject without a role bypass', async () => {
    const selfProfile = {
      contactId: 'contact-self',
      summary: 'self profile',
      sourceMemoryIds: ['memory-self'],
      confidenceScore: 0.9,
      noveltyScore: 0.8,
      updatedAt: 10,
    };
    const otherProfile = { ...selfProfile, contactId: 'contact-other', summary: 'other profile' };
    const profiles = new Map([
      [selfProfile.contactId, selfProfile],
      [otherProfile.contactId, otherProfile],
    ]);
    const rawList = vi.fn(() => {
      throw new Error('raw profile listing must not run');
    });
    const getContactProfile = vi.fn(async (contactId: string) => profiles.get(contactId));
    const upsertContactProfile = vi.fn(async () => undefined);
    const authorized = createSubjectAuthorizedMemoryStore({
      getContactProfile,
      listContactProfiles: rawList,
      upsertContactProfile,
    } as unknown as MemoryStorePort, { viewerContactId: 'contact-self' });

    await expect(authorized.getContactProfile('contact-self')).resolves.toEqual(selfProfile);
    await expect(authorized.getContactProfile('contact-other')).resolves.toBeUndefined();
    await expect(authorized.listContactProfiles()).resolves.toEqual([selfProfile]);
    await expect(authorized.upsertContactProfile(otherProfile))
      .rejects.toThrow('trusted memory subject');
    await expect(authorized.upsertContactProfile(selfProfile)).resolves.toBeUndefined();

    expect(getContactProfile).toHaveBeenCalledTimes(2);
    expect(rawList).not.toHaveBeenCalled();
    expect(upsertContactProfile).toHaveBeenCalledWith(selfProfile);
  });

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

  it('limits fleet subjects to current single-contact self/co-subjects and preserves exact JIT bindings', async () => {
    const binding = {
      memoryId: 'visible',
      memoryRevision: 4,
      classifierVersion: 1,
      evidenceDigest: 'a'.repeat(64),
    };
    const queryAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAuthorizedQuery) => ({
      memories: input.selector.kind === 'detail' ? [memory('visible', 'private')] : [],
      total: 1,
    }));
    const store = createSubjectAuthorizedMemoryStore({
      queryAuthorizedMemorySubjects,
    } as unknown as MemoryStorePort, {
      viewerContactId: 'contact-self',
      viewerCoSubjectContactIds: ['contact-co'],
      grantBindings: [binding],
    });

    await expect(store.getById('visible')).resolves.toMatchObject({ id: 'visible' });
    expect(queryAuthorizedMemorySubjects).toHaveBeenCalledWith({
      authorization: {
        action: 'detail',
        viewerContactIds: ['contact-co', 'contact-self'],
        allowedSubjectClasses: ['single_contact'],
        allowedViewerRelations: ['self'],
        classifierVersion: 1,
        grantBindings: [binding],
      },
      selector: { kind: 'detail', memoryId: 'visible' },
    });
  });

  it('filters every linked endpoint through the same subject SQL primitive in one batch', async () => {
    const visibleIds = new Set(['source', 'allowed']);
    const rawLinks = [
      { id1: 'source', id2: 'allowed', linkType: 'supports' },
      { id1: 'source', id2: 'other-subject', linkType: 'supports' },
    ];
    const batchSelectors: string[][] = [];
    const queryAuthorizedMemorySubjects = vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
      if (input.selector.kind === 'detail') {
        const visible = visibleIds.has(input.selector.memoryId);
        return { memories: visible ? [memory(input.selector.memoryId, input.selector.memoryId)] : [], total: visible ? 1 : 0 };
      }
      if (input.selector.kind === 'details_batch') {
        batchSelectors.push([...input.selector.memoryIds]);
        const visible = input.selector.memoryIds.filter(id => visibleIds.has(id));
        return { memories: visible.map(id => memory(id, id)), total: visible.length };
      }
      throw new Error(`unexpected selector ${input.selector.kind}`);
    });
    const getLinkedMemories = vi.fn(async () => rawLinks);
    const store = createSubjectAuthorizedMemoryStore({
      queryAuthorizedMemorySubjects,
      getLinkedMemories,
    } as unknown as MemoryStorePort, { viewerContactId: 'contact-self' });

    await expect(store.getLinkedMemories('source')).resolves.toEqual([rawLinks[0]]);
    // Endpoints (excluding the already-authorized source) resolve in exactly one
    // batch query, not one per endpoint.
    expect(batchSelectors).toEqual([['allowed', 'other-subject']]);
    await expect(store.getLinkedMemories('other-subject')).resolves.toEqual([]);
    expect(getLinkedMemories).toHaveBeenCalledTimes(1);
  });

  it('getByIds returns exactly the authorized subset per-item getById would, in input order', async () => {
    const authorizedIds = new Set(['auth-1', 'auth-2', 'auth-3']);
    const queryCalls: MemorySubjectAuthorizedQuery[] = [];
    const store = {
      getById: vi.fn(() => { throw new Error('raw getById must not run'); }),
      queryAuthorizedMemorySubjects: vi.fn(async (input: MemorySubjectAuthorizedQuery) => {
        queryCalls.push(input);
        if (input.selector.kind === 'detail') {
          const visible = authorizedIds.has(input.selector.memoryId);
          return { memories: visible ? [memory(input.selector.memoryId, input.selector.memoryId)] : [], total: visible ? 1 : 0 };
        }
        if (input.selector.kind === 'details_batch') {
          const visible = input.selector.memoryIds.filter(id => authorizedIds.has(id));
          return { memories: visible.map(id => memory(id, id)), total: visible.length };
        }
        throw new Error(`unexpected selector ${input.selector.kind}`);
      }),
    } as unknown as MemoryStorePort;
    const authorized = createSubjectAuthorizedMemoryStore(store, { viewerContactId: 'contact-a' });

    // Mixed input: authorized, unauthorized, nonexistent, and a duplicate.
    const input = ['nonexistent', 'auth-2', 'unauth-x', 'auth-1', 'auth-2', 'auth-3', 'unauth-y'];
    const batched = (await authorized.getByIds(input)).map(m => m.id);
    const perItem = (
      await Promise.all([...new Set(input)].map(id => authorized.getById(id)))
    ).filter(Boolean).map(m => m!.id);

    // Equivalence: same authorized set as the per-item detail path.
    expect([...batched].sort()).toEqual([...perItem].sort());
    // Ordering preserved (first-seen input order, deduped, misses dropped).
    expect(batched).toEqual(['auth-2', 'auth-1', 'auth-3']);
    // O(1) batch queries: one details_batch call for the whole set.
    const batchCalls = queryCalls.filter(call => call.selector.kind === 'details_batch');
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0]!.authorization.action).toBe('detail');
  });

  it('getByIds fails closed: a batch query failure propagates without a raw fallback', async () => {
    const store = {
      getById: vi.fn(() => { throw new Error('raw getById must not run'); }),
      queryAuthorizedMemorySubjects: vi.fn(async () => {
        throw new Error('batch authorization query failed');
      }),
    } as unknown as MemoryStorePort;
    const authorized = createSubjectAuthorizedMemoryStore(store, { viewerContactId: 'contact-a' });

    await expect(authorized.getByIds(['auth-1', 'auth-2']))
      .rejects.toThrow('batch authorization query failed');
    expect(store.getById).not.toHaveBeenCalled();
  });

  it('getByIds returns nothing without a trusted subject and never probes raw storage', async () => {
    const rawRead = vi.fn(() => { throw new Error('raw memory access must not run'); });
    const store = {
      getById: rawRead,
      queryAuthorizedMemorySubjects: rawRead,
    } as unknown as MemoryStorePort;
    const denied = createSubjectAuthorizedMemoryStore(store, {});

    expect(await denied.getByIds(['known-id-a', 'known-id-b'])).toEqual([]);
    expect(rawRead).not.toHaveBeenCalled();
  });
});
