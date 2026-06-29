import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../../core/agent/contracts.js';
import type {
  MemoryAdminPrivacySummary,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import { AdminMemoryDataService } from './memory-service.js';

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.6,
    sourceRef: `api:test:${id}`,
    extractedAt: Date.UTC(2026, 0, 5, 12, 0, 0),
    lastAccessed: Date.UTC(2026, 0, 5, 12, 0, 0),
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function makePrivacySummary(overrides: Partial<MemoryAdminPrivacySummary> = {}): MemoryAdminPrivacySummary {
  return {
    activeMemoryCount: 9,
    highSensitivityCount: 2,
    consentGatedCount: 1,
    contactLinkedCount: 3,
    scopedCount: 4,
    preferenceCount: 5,
    durablePreferenceCount: 2,
    sensitivityCounts: {
      personal: 7,
      confidential: 2,
    },
    ...overrides,
  };
}

describe('AdminMemoryDataService', () => {
  it('delegates Garden list filters, count, ordering, and pagination to the memory store', async () => {
    const memory = makeMemory('page-memory');
    const memoryStore = {
      listAdminMemories: vi.fn(async () => ({
        memories: [memory],
        total: 12,
        privacySummary: makePrivacySummary(),
      })),
      getAllActiveMemories: vi.fn(async () => {
        throw new Error('Garden list should not scan active memories');
      }),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore });

    const result = await service.listMemories(new URLSearchParams({
      type: 'semantic',
      sensitivity: 'personal',
      retention: 'durable',
      preference: 'true',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      limit: '10',
      offset: '5',
    }));

    expect(memoryStore.listAdminMemories).toHaveBeenCalledWith({
      type: 'semantic',
      sensitivity: 'personal',
      retentionClass: 'durable',
      preferenceOnly: true,
      startDate: Date.UTC(2026, 0, 1, 0, 0, 0, 0),
      endDate: Date.UTC(2026, 0, 31, 23, 59, 59, 999),
      limit: 10,
      offset: 5,
    });
    expect(memoryStore.getAllActiveMemories).not.toHaveBeenCalled();
    expect(result.memories).toEqual([memory]);
    expect(result.pagination).toMatchObject({
      limit: 10,
      offset: 5,
      total: 12,
      hasPrevious: true,
      hasNext: true,
    });
    expect(result.privacySummary).toMatchObject({
      activeMemoryCount: 9,
      matchingMemoryCount: 12,
      pageMemoryCount: 1,
      highSensitivityCount: 2,
      consentGatedCount: 1,
    });
  });

  it('uses the store privacy aggregate for search without scanning all active memories', async () => {
    const visible = makeMemory('visible-search-result');
    const internal = makeMemory('internal-search-result', {
      sourceRef: 'source:context_feedback|turn:test|score:0.9',
      tags: ['context_feedback'],
    });
    const memoryStore = {
      getAdminMemoryPrivacySummary: vi.fn(async () => makePrivacySummary({ activeMemoryCount: 4 })),
      searchByEmbedding: vi.fn(async () => [
        { ...visible, similarity: 0.95 },
        { ...internal, similarity: 0.94 },
        { ...makeMemory('superseded-search-result', { supersededBy: 'replacement' }), similarity: 0.93 },
        { ...makeMemory('deleted-search-result', { deletedAt: 1, deletedBy: 'test' }), similarity: 0.92 },
      ]),
      getAllActiveMemories: vi.fn(async () => {
        throw new Error('Garden search should not scan active memories');
      }),
    } as unknown as MemoryStorePort;
    const embeddingService: EmbeddingProviderPort = {
      dims: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };
    const service = new AdminMemoryDataService({ memoryStore, embeddingService });

    const result = await service.searchMemories('memory');

    expect(memoryStore.getAdminMemoryPrivacySummary).toHaveBeenCalledTimes(1);
    expect(memoryStore.getAllActiveMemories).not.toHaveBeenCalled();
    expect(result.results.map(memory => memory.id)).toEqual(['visible-search-result']);
    expect(result.privacySummary).toMatchObject({
      activeMemoryCount: 4,
      matchingMemoryCount: 1,
      pageMemoryCount: 1,
    });
  });

  it('delegates retention-class bulk updates to the memory store bulk path', async () => {
    const memoryStore = {
      bulkUpdate: vi.fn(async () => 2),
      getById: vi.fn(async () => {
        throw new Error('Garden retention bulk update should not read memories one by one');
      }),
      updateMemory: vi.fn(async () => {
        throw new Error('Garden retention bulk update should not update memories one by one');
      }),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore });

    const result = await service.bulkUpdate(['m1', 'missing', 'm2'], {
      memoryType: 'Relational',
      sensitivity: 'Confidential',
      retentionClass: 'Durable',
    });

    expect(result).toEqual({ ok: true, count: 2 });
    expect(memoryStore.bulkUpdate).toHaveBeenCalledWith(['m1', 'missing', 'm2'], {
      type: 'relational',
      sensitivity: 'confidential',
      retentionClass: 'durable',
    });
    expect(memoryStore.getById).not.toHaveBeenCalled();
    expect(memoryStore.updateMemory).not.toHaveBeenCalled();
  });
});
