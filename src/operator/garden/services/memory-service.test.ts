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

describe('AdminMemoryDataService high-intimacy body gate', () => {
  const BASE_NOW = Date.UTC(2026, 5, 1, 12, 0, 0);

  function makeGatedService(memories: PurrMemory[], options?: { now?: () => number }) {
    const memoryById = new Map(memories.map(memory => [memory.id, memory]));
    const memoryStore = {
      listAdminMemories: vi.fn(async () => ({
        memories,
        total: memories.length,
        privacySummary: makePrivacySummary(),
      })),
      getAdminMemoryPrivacySummary: vi.fn(async () => makePrivacySummary()),
      searchByEmbedding: vi.fn(async () => memories.map(memory => ({ ...memory, similarity: 0.9 }))),
      getById: vi.fn(async (id: string) => memoryById.get(id) ?? null),
    } as unknown as MemoryStorePort;
    const embeddingService: EmbeddingProviderPort = {
      dims: 3,
      embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
      embedBatch: vi.fn(async () => []),
    };
    const appendAuditTimelineEntry = vi.fn();
    const service = new AdminMemoryDataService({
      memoryStore,
      embeddingService,
      appendAuditTimelineEntry,
      ...(options?.now ? { now: options.now } : {}),
    });
    return { service, appendAuditTimelineEntry };
  }

  it('redacts intimate/confidential bodies in list and search by default, keeping metadata honest', async () => {
    const intimate = makeMemory('intimate-1', {
      sensitivity: 'intimate',
      text: 'A very private confession.',
      embedding: new Float32Array([0.5, 0.5, 0.5]),
    });
    const confidential = makeMemory('confidential-1', { sensitivity: 'confidential' });
    const personal = makeMemory('personal-1');
    const { service } = makeGatedService([intimate, confidential, personal]);

    const list = await service.listMemories();
    expect(list.elevation).toEqual({ elevated: false, ttlMs: 15 * 60 * 1_000 });

    const intimateView = list.memories.find(memory => memory.id === 'intimate-1');
    expect(intimateView?.bodyRedacted).toBe(true);
    expect(intimateView?.text).toBe(
      `[REDACTED intimate memory body — ${intimate.text.length} chars hidden. `
      + 'Reveal this memory or elevate Garden memory body access to view (both are audit-logged).]',
    );
    expect(intimateView?.bodyRedaction).toEqual({
      sensitivity: 'intimate',
      originalLength: intimate.text.length,
      reason: 'high_intimacy_sensitivity',
      revealHint: 'Reveal this memory or elevate Garden memory body access to view (both are audit-logged).',
    });
    // Metadata stays browsable; the body-derived embedding is stripped.
    expect(intimateView).toMatchObject({
      id: 'intimate-1',
      type: 'semantic',
      sensitivity: 'intimate',
      salience: 0.6,
      sourceRef: 'api:test:intimate-1',
      extractedAt: intimate.extractedAt,
    });
    expect(intimateView?.embedding).toBeUndefined();

    expect(list.memories.find(memory => memory.id === 'confidential-1')?.bodyRedacted).toBe(true);
    const personalView = list.memories.find(memory => memory.id === 'personal-1');
    expect(personalView?.bodyRedacted).toBeUndefined();
    expect(personalView?.text).toBe('Memory personal-1');

    const search = await service.searchMemories('confession');
    expect(search.results.find(memory => memory.id === 'intimate-1')?.bodyRedacted).toBe(true);
    expect(search.results.find(memory => memory.id === 'personal-1')?.bodyRedacted).toBeUndefined();
  });

  it('reveals a single memory body with an audited memory_access event and a TTL-bound grant', async () => {
    let now = BASE_NOW;
    const intimate = makeMemory('intimate-reveal', { sensitivity: 'intimate', text: 'Hidden truth.' });
    const { service, appendAuditTimelineEntry } = makeGatedService([intimate], { now: () => now });

    const redacted = await service.getMemoryDetail('intimate-reveal');
    expect(redacted?.memory.bodyRedacted).toBe(true);
    expect(appendAuditTimelineEntry).not.toHaveBeenCalled();

    const revealed = await service.revealMemory('intimate-reveal');
    expect(revealed?.memory.text).toBe('Hidden truth.');
    expect(revealed?.memory.bodyRedacted).toBeUndefined();
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'allowed',
      'Operator revealed intimate memory "intimate-reveal" body (13 chars).',
      ['source=api:test:intimate-reveal'],
    );

    // The per-item grant persists across reads until the TTL expires.
    const stillVisible = await service.getMemoryDetail('intimate-reveal');
    expect(stillVisible?.memory.bodyRedacted).toBeUndefined();

    now = BASE_NOW + 15 * 60 * 1_000;
    const expired = await service.getMemoryDetail('intimate-reveal');
    expect(expired?.memory.bodyRedacted).toBe(true);
  });

  it('audits a denied memory_access event when revealing a missing memory', async () => {
    const { service, appendAuditTimelineEntry } = makeGatedService([]);
    expect(await service.revealMemory('missing')).toBeNull();
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'denied',
      'Memory reveal failed: memory "missing" was not found.',
    );
  });

  it('elevates session body access with audit events and expires the elevation after the TTL', async () => {
    let now = BASE_NOW;
    const confidential = makeMemory('confidential-elevated', { sensitivity: 'confidential' });
    const { service, appendAuditTimelineEntry } = makeGatedService([confidential], { now: () => now });

    const status = service.elevateBodyAccess();
    expect(status).toEqual({
      elevated: true,
      expiresAt: BASE_NOW + 15 * 60 * 1_000,
      ttlMs: 15 * 60 * 1_000,
    });
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'allowed',
      'Operator elevated Garden memory body access for 15 minutes; intimate/confidential memory bodies are visible.',
      [`expiresAt=${new Date(BASE_NOW + 15 * 60 * 1_000).toISOString()}`],
    );

    const elevatedList = await service.listMemories();
    expect(elevatedList.elevation.elevated).toBe(true);
    expect(elevatedList.memories[0]?.bodyRedacted).toBeUndefined();
    expect(elevatedList.memories[0]?.text).toBe('Memory confidential-elevated');

    now = BASE_NOW + 15 * 60 * 1_000;
    const expiredList = await service.listMemories();
    expect(expiredList.elevation).toEqual({ elevated: false, ttlMs: 15 * 60 * 1_000 });
    expect(expiredList.memories[0]?.bodyRedacted).toBe(true);
  });

  it('drops an active elevation immediately with an audit event', async () => {
    const confidential = makeMemory('confidential-dropped', { sensitivity: 'confidential' });
    const { service, appendAuditTimelineEntry } = makeGatedService([confidential]);

    service.elevateBodyAccess();
    const status = service.dropBodyElevation();
    expect(status.elevated).toBe(false);
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'allowed',
      'Operator ended Garden memory body access elevation; intimate/confidential memory bodies are redacted again.',
    );

    const list = await service.listMemories();
    expect(list.memories[0]?.bodyRedacted).toBe(true);
  });

  it('gates managed scope detail memory bodies behind the same elevation', async () => {
    const intimate = makeMemory('intimate-scoped', {
      sensitivity: 'intimate',
      scopeRef: { kind: 'project', id: 'garden', label: 'Garden' },
      scopeTags: ['project:garden'],
    });
    const memoryStore = {
      listAdminMemories: vi.fn(async () => ({
        memories: [intimate],
        total: 1,
        privacySummary: makePrivacySummary(),
      })),
    } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore });

    const detail = await service.getManagedScopeDetail('project', 'garden');
    expect(detail?.memories[0]?.memory.bodyRedacted).toBe(true);
    expect(detail?.elevation.elevated).toBe(false);

    service.elevateBodyAccess();
    const elevatedDetail = await service.getManagedScopeDetail('project', 'garden');
    expect(elevatedDetail?.memories[0]?.memory.bodyRedacted).toBeUndefined();
    expect(elevatedDetail?.memories[0]?.memory.text).toBe('Memory intimate-scoped');
  });
});
