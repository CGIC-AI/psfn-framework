import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../../core/agent/contracts.js';
import type {
  MemoryAdminPrivacySummary,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import { AdminMemoryDataService } from './memory-service.js';

const OPERATOR_SESSION = 'cookie:operator-a';

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

    const result = await service.forSession(OPERATOR_SESSION).listMemories(new URLSearchParams({
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

    const result = await service.forSession(OPERATOR_SESSION).searchMemories('memory');

    expect(memoryStore.getAdminMemoryPrivacySummary).toHaveBeenCalledTimes(1);
    expect(memoryStore.getAllActiveMemories).not.toHaveBeenCalled();
    expect(result.results.map(memory => memory.id)).toEqual(['visible-search-result']);
    expect(result.privacySummary).toMatchObject({
      activeMemoryCount: 4,
      matchingMemoryCount: 1,
      pageMemoryCount: 1,
    });
  });

  it('pages managed-scope memory scans past the store page clamp', async () => {
    // Simulates the Postgres listAdminMemories clamp: at most 2 rows per
    // page here, regardless of the requested limit.
    const clampedPageSize = 2;
    const scoped = Array.from({ length: 5 }, (_, index) => makeMemory(`scoped-${index}`, {
      scopeRef: { kind: 'project', id: 'greenhouse', label: 'Greenhouse' },
      scopeTags: ['project:greenhouse'],
    }));
    const listAdminMemories = vi.fn(async (options: { limit: number; offset: number }) => ({
      memories: scoped.slice(options.offset, options.offset + Math.min(options.limit, clampedPageSize)),
      total: scoped.length,
      privacySummary: makePrivacySummary(),
    }));
    const memoryStore = { listAdminMemories } as unknown as MemoryStorePort;
    const service = new AdminMemoryDataService({ memoryStore });

    const scopes = await service.forSession(OPERATOR_SESSION).listManagedScopes();
    expect(scopes.scopes).toEqual([expect.objectContaining({
      kind: 'project',
      id: 'greenhouse',
      memoryCount: 5,
    })]);
    // Every page request advances the offset by the rows actually returned.
    expect(listAdminMemories.mock.calls.map(call => call[0]?.offset)).toEqual([0, 2, 4]);

    const detail = await service.forSession(OPERATOR_SESSION).getManagedScopeDetail('project', 'greenhouse');
    expect(detail?.scope.memoryCount).toBe(5);
    expect(detail?.memories).toHaveLength(5);
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

    const result = await service.forSession(OPERATOR_SESSION).bulkUpdate(['m1', 'missing', 'm2'], {
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

    const list = await service.forSession(OPERATOR_SESSION).listMemories();
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

    const search = await service.forSession(OPERATOR_SESSION).searchMemories('confession');
    expect(search.results.find(memory => memory.id === 'intimate-1')?.bodyRedacted).toBe(true);
    expect(search.results.find(memory => memory.id === 'personal-1')?.bodyRedacted).toBeUndefined();
  });

  it('reveals a single memory body with an audited memory_access event and a TTL-bound grant', async () => {
    let now = BASE_NOW;
    const intimate = makeMemory('intimate-reveal', { sensitivity: 'intimate', text: 'Hidden truth.' });
    const { service, appendAuditTimelineEntry } = makeGatedService([intimate], { now: () => now });

    const redacted = await service.forSession(OPERATOR_SESSION).getMemoryDetail('intimate-reveal');
    expect(redacted?.memory.bodyRedacted).toBe(true);
    expect(appendAuditTimelineEntry).not.toHaveBeenCalled();

    const revealed = await service.forSession(OPERATOR_SESSION).revealMemory('intimate-reveal');
    expect(revealed?.memory.text).toBe('Hidden truth.');
    expect(revealed?.memory.bodyRedacted).toBeUndefined();
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'allowed',
      'Operator revealed intimate memory "intimate-reveal" body (13 chars).',
      ['source=api:test:intimate-reveal'],
    );

    // The per-item grant persists across reads until the TTL expires.
    const stillVisible = await service.forSession(OPERATOR_SESSION).getMemoryDetail('intimate-reveal');
    expect(stillVisible?.memory.bodyRedacted).toBeUndefined();

    now = BASE_NOW + 15 * 60 * 1_000;
    const expired = await service.forSession(OPERATOR_SESSION).getMemoryDetail('intimate-reveal');
    expect(expired?.memory.bodyRedacted).toBe(true);
  });

  it('audits a denied memory_access event when revealing a missing memory', async () => {
    const { service, appendAuditTimelineEntry } = makeGatedService([]);
    expect(await service.forSession(OPERATOR_SESSION).revealMemory('missing')).toBeNull();
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

    const status = service.forSession(OPERATOR_SESSION).elevateBodyAccess();
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

    const elevatedList = await service.forSession(OPERATOR_SESSION).listMemories();
    expect(elevatedList.elevation.elevated).toBe(true);
    expect(elevatedList.memories[0]?.bodyRedacted).toBeUndefined();
    expect(elevatedList.memories[0]?.text).toBe('Memory confidential-elevated');

    now = BASE_NOW + 15 * 60 * 1_000;
    const expiredList = await service.forSession(OPERATOR_SESSION).listMemories();
    expect(expiredList.elevation).toEqual({ elevated: false, ttlMs: 15 * 60 * 1_000 });
    expect(expiredList.memories[0]?.bodyRedacted).toBe(true);
  });

  it('drops an active elevation immediately with an audit event', async () => {
    const confidential = makeMemory('confidential-dropped', { sensitivity: 'confidential' });
    const { service, appendAuditTimelineEntry } = makeGatedService([confidential]);

    service.forSession(OPERATOR_SESSION).elevateBodyAccess();
    const status = service.forSession(OPERATOR_SESSION).dropBodyElevation();
    expect(status.elevated).toBe(false);
    expect(appendAuditTimelineEntry).toHaveBeenCalledWith(
      'memory_access',
      'allowed',
      'Operator ended Garden memory body access elevation; intimate/confidential memory bodies are redacted again.',
    );

    const list = await service.forSession(OPERATOR_SESSION).listMemories();
    expect(list.memories[0]?.bodyRedacted).toBe(true);
  });


  it('scopes elevation and reveal grants to the requesting admin session', async () => {
    const intimate = makeMemory('intimate-cross-session', { sensitivity: 'intimate', text: 'Only for A.' });
    const { service } = makeGatedService([intimate]);
    const operatorA = service.forSession('cookie:operator-a');
    const operatorB = service.forSession('cookie:operator-b');

    operatorA.elevateBodyAccess();
    expect(operatorA.getBodyElevationStatus().elevated).toBe(true);
    expect(operatorB.getBodyElevationStatus().elevated).toBe(false);

    const listForA = await operatorA.listMemories();
    expect(listForA.memories[0]?.bodyRedacted).toBeUndefined();
    const listForB = await operatorB.listMemories();
    expect(listForB.elevation.elevated).toBe(false);
    expect(listForB.memories[0]?.bodyRedacted).toBe(true);

    // Per-item reveals are session-scoped too.
    operatorA.dropBodyElevation();
    await operatorA.revealMemory('intimate-cross-session');
    expect((await operatorA.getMemoryDetail('intimate-cross-session'))?.memory.bodyRedacted).toBeUndefined();
    expect((await operatorB.getMemoryDetail('intimate-cross-session'))?.memory.bodyRedacted).toBe(true);

    // Dropping B's (empty) elevation never disturbs A's grants.
    operatorB.dropBodyElevation();
    expect((await operatorA.getMemoryDetail('intimate-cross-session'))?.memory.bodyRedacted).toBeUndefined();
  });

  it('fail-closes to redacted bodies and refuses grants without a session identity', async () => {
    const intimate = makeMemory('intimate-anon', { sensitivity: 'intimate' });
    const { service } = makeGatedService([intimate]);
    const anonymous = service.forSession(null);

    expect(anonymous.getBodyElevationStatus().elevated).toBe(false);
    expect(() => anonymous.elevateBodyAccess()).toThrowError(
      'Garden memory body elevation requires an admin session identity',
    );
    await expect(anonymous.revealMemory('intimate-anon')).rejects.toThrowError(
      'Garden memory reveal requires an admin session identity',
    );
    const list = await anonymous.listMemories();
    expect(list.memories[0]?.bodyRedacted).toBe(true);

    // Even with another session elevated, the anonymous view stays redacted.
    service.forSession('cookie:operator-a').elevateBodyAccess();
    const stillRedacted = await anonymous.listMemories();
    expect(stillRedacted.memories[0]?.bodyRedacted).toBe(true);
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

    const detail = await service.forSession(OPERATOR_SESSION).getManagedScopeDetail('project', 'garden');
    expect(detail?.memories[0]?.memory.bodyRedacted).toBe(true);
    expect(detail?.elevation.elevated).toBe(false);

    service.forSession(OPERATOR_SESSION).elevateBodyAccess();
    const elevatedDetail = await service.forSession(OPERATOR_SESSION).getManagedScopeDetail('project', 'garden');
    expect(elevatedDetail?.memories[0]?.memory.bodyRedacted).toBeUndefined();
    expect(elevatedDetail?.memories[0]?.memory.text).toBe('Memory intimate-scoped');
  });
});
