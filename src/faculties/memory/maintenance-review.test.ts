import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import {
  createMemoryStorePort,
  type MemoryStorePort,
} from './memory-store-port.js';
import { MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { MemoryWriter } from './writer.js';
import {
  buildConflictingMemoryReviewInput,
  buildHighImpactLowConfidenceReviewInput,
  buildProvenanceConfidenceReviewInput,
  buildStaleMemoryReviewInput,
  extractUniqueDetails,
} from './maintenance-review.js';

function makeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(4);
  arr[0] = 0.1 + seed * 0.01;
  arr[1] = 0.2 + seed * 0.01;
  arr[2] = 0.3 + seed * 0.01;
  arr[3] = 0.4 + seed * 0.01;
  return arr;
}

function makeEmbeddingService(): EmbeddingProviderPort {
  return {
    embed: vi.fn(async () => makeEmbedding()),
    embedBatch: vi.fn(async (texts: string[]) => texts.map((_, index) => makeEmbedding(index))),
    dims: 4,
  };
}

function makeMemory(id: string, text: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.7,
    sourceRef: `source:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 1,
    tags: ['test'],
    sensitivity: 'personal',
    ...overrides,
  };
}

function makeReviewCapableStore(candidate?: PurrMemory & { similarity: number }) {
  const store = {
    insertMemory: vi.fn(),
    persistMemoryWrite: vi.fn(async ({ memory }: { memory: PurrMemory }) => {
      store.insertMemory(memory, makeEmbedding());
    }),
    searchByEmbedding: vi.fn(() => (candidate ? [candidate] : [])),
    updateMemory: vi.fn(),
    recordPatchEvent: vi.fn(),
    runInTransaction: vi.fn((handler: () => unknown) => handler()),
    softDeleteMemory: vi.fn(),
    recordAbstractionLink: vi.fn(),
    recordEvolutionLink: vi.fn(),
    getEvolutionLinksForSourceMemory: vi.fn(() => []),
    getEvolutionLinksForTargetMemory: vi.fn(() => []),
    getAllActiveMemories: vi.fn(() => []),
    listActiveMemories: vi.fn(() => []),
    countActiveMemories: vi.fn(() => 0),
    getById: vi.fn(),
    getStats: vi.fn(() => ({ total: 0, byType: {}, avgSalience: 0 })),
    getMemoriesByChannel: vi.fn(() => []),
    getMemoriesByContact: vi.fn(() => []),
    searchByText: vi.fn(() => []),
    linkMemories: vi.fn(),
    unlinkMemories: vi.fn(),
    getLinkedMemories: vi.fn(() => []),
    bulkDelete: vi.fn(),
    bulkUpdate: vi.fn(),
    upsertContactProfile: vi.fn(),
    getContactProfile: vi.fn(),
    listContactProfiles: vi.fn(() => []),
    addScratchpadEntry: vi.fn(),
    replaceScratchpadEntry: vi.fn(),
    appendScratchpadEntry: vi.fn(),
    removeScratchpadEntry: vi.fn(),
    getScratchpadEntry: vi.fn(),
    listScratchpadEntries: vi.fn(() => []),
    upsertMemoryMaintenanceReview: vi.fn(async input => ({
      id: input.id ?? 'review',
      kind: input.kind,
      status: input.state.status,
      subjectMemoryId: input.subjectMemoryId,
      candidateMemoryIds: input.candidateMemoryIds ?? [],
      state: input.state,
      createdAt: input.createdAt ?? 0,
      updatedAt: input.updatedAt ?? 0,
    })),
    listMemoryMaintenanceReviews: vi.fn(async () => []),
    getMemoryMaintenanceReview: vi.fn(async () => undefined),
  };
  return store;
}

describe('Memory maintenance review scheduling', () => {
  it('queues near-duplicate review state with provenance and unique details asynchronously', async () => {
    const candidate = {
      ...makeMemory('existing-1', 'V prefers jasmine tea in the red mug', {
        sourceRef: 'legacy:import#1',
        provenanceRefs: ['archive:old#7'],
        confidence: 0.86,
      }),
      similarity: 0.86,
    };
    const store = makeReviewCapableStore(candidate);
    const scheduled: Array<() => Promise<void>> = [];
    const writer = new MemoryWriter(
      store as unknown as MemoryStorePort,
      makeEmbeddingService(),
      {
        maintenanceSchedule: task => {
          scheduled.push(task);
        },
        maintenanceNow: () => 1234,
      },
    );

    const result = await writer.write({
      text: 'V prefers jasmine tea in the blue mug',
      type: 'semantic',
      sourceRef: 'api:new#2',
      provenanceRefs: ['session:new#2'],
      confidence: 0.8,
    });

    expect(result.action).toBe('created');
    expect(store.upsertMemoryMaintenanceReview).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);

    await scheduled[0]();

    expect(store.upsertMemoryMaintenanceReview).toHaveBeenCalledOnce();
    const [review] = store.upsertMemoryMaintenanceReview.mock.calls[0];
    expect(review.kind).toBe('near_duplicate');
    expect(review.subjectMemoryId).toBe(result.memory.id);
    expect(review.candidateMemoryIds).toEqual(['existing-1']);
    expect(review.state.status).toBe('pending');
    expect(review.state.provenanceRefs).toEqual(expect.arrayContaining([
      'api:new#2',
      'session:new#2',
      'legacy:import#1',
      'archive:old#7',
    ]));
    expect(review.state.uniqueDetails[result.memory.id]).toContain('blue');
    expect(review.state.uniqueDetails['existing-1']).toContain('red');
    expect(review.state.candidates.find(candidateState => candidateState.memoryId === 'existing-1')).toMatchObject({
      sourceRef: 'legacy:import#1',
      provenanceRefs: expect.arrayContaining(['archive:old#7']),
      similarity: 0.86,
    });
  });

  it('queues provenance-confidence reviews for low-confidence single-source writes', async () => {
    const store = makeReviewCapableStore();
    const scheduled: Array<() => Promise<void>> = [];
    const writer = new MemoryWriter(
      store as unknown as MemoryStorePort,
      makeEmbeddingService(),
      {
        maintenanceSchedule: task => {
          scheduled.push(task);
        },
      },
    );

    const result = await writer.write({
      text: 'Uncorroborated low confidence detail',
      type: 'semantic',
      confidence: 0.42,
      sourceRef: 'api:single-source',
    });
    await scheduled[0]();

    expect(result.action).toBe('created');
    expect(store.upsertMemoryMaintenanceReview).toHaveBeenCalledOnce();
    const [review] = store.upsertMemoryMaintenanceReview.mock.calls[0];
    expect(review.kind).toBe('provenance_confidence');
    expect(review.state.recommendedAction).toBe('corroborate_or_dismiss');
    expect(review.state.metadata).toMatchObject({
      confidence: 0.42,
      provenanceEvidenceCount: 1,
    });
  });

  it('does not treat maintenance persistence as foreground write work', async () => {
    const candidate = {
      ...makeMemory('existing-2', 'V stores notes in a green notebook'),
      similarity: 0.86,
    };
    const store = makeReviewCapableStore(candidate);
    const scheduled: Array<() => Promise<void>> = [];
    const writer = new MemoryWriter(
      store as unknown as MemoryStorePort,
      makeEmbeddingService(),
      {
        maintenanceSchedule: task => {
          scheduled.push(task);
        },
      },
    );

    const result = await writer.write({
      text: 'V stores notes in a blue notebook',
      type: 'semantic',
      confidence: 0.75,
    });

    expect(result.action).toBe('created');
    expect(store.persistMemoryWrite).toHaveBeenCalledOnce();
    expect(store.upsertMemoryMaintenanceReview).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
  });
});

describe('Memory maintenance review state', () => {
  it('extracts stable unique detail tokens for merge review state', () => {
    expect(extractUniqueDetails(
      'V keeps the travel adapter in the blue pouch.',
      ['V keeps the travel adapter in the red pouch.'],
    )).toContain('blue');
  });

  it('builds high-impact, stale, and conflicting review states for uncertain memory maintenance', () => {
    const highImpact = buildHighImpactLowConfidenceReviewInput({
      memoryId: 'candidate-boundary-1',
      text: 'User has a family contact boundary that needs confirmation.',
      sourceRef: 'source:sleeptime|session:test',
      provenanceRefs: ['sleeptime_action:1'],
      confidence: 0.42,
      type: 'boundary',
      tags: ['family'],
      sensitivity: 'confidential',
    }, 10);
    expect(highImpact).toMatchObject({
      kind: 'high_impact_low_confidence',
      subjectMemoryId: 'candidate-boundary-1',
      createdAt: 10,
      state: {
        status: 'pending',
        recommendedAction: 'corroborate_or_dismiss',
        metadata: expect.objectContaining({
          confidence: 0.42,
          type: 'boundary',
          sensitivity: 'confidential',
        }),
      },
    });

    const stale = buildStaleMemoryReviewInput(makeMemory('stale-1', 'Old low-confidence profile detail', {
      confidence: 0.4,
      tags: ['profile'],
      extractedAt: 1_000,
      lastAccessed: 1_000,
    }), 92 * 24 * 60 * 60 * 1000);
    expect(stale).toMatchObject({
      kind: 'stale_memory',
      subjectMemoryId: 'stale-1',
      state: {
        recommendedAction: 'verify_or_supersede',
        metadata: expect.objectContaining({
          confidence: 0.4,
        }),
      },
    });

    const conflict = buildConflictingMemoryReviewInput(
      makeMemory('subject-1', 'User now prefers no weekend reminders.', {
        type: 'boundary',
        tags: ['boundary'],
      }),
      [
        makeMemory('candidate-1', 'User prefers weekend reminders.', {
          type: 'boundary',
          tags: ['boundary'],
        }),
      ],
      20,
    );
    expect(conflict).toMatchObject({
      kind: 'conflicting_memory',
      subjectMemoryId: 'subject-1',
      candidateMemoryIds: ['candidate-1'],
      createdAt: 20,
      state: {
        recommendedAction: 'resolve_conflict',
        candidates: [
          expect.objectContaining({ memoryId: 'subject-1' }),
          expect.objectContaining({ memoryId: 'candidate-1' }),
        ],
      },
    });
  });

  it('persists and exposes review queue metadata/status', async () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const store = new MemoryStore(db, 4);
    const port = createMemoryStorePort(store);

    try {
      const input = buildProvenanceConfidenceReviewInput(
        makeMemory('low-confidence-1', 'Single source memory', {
          confidence: 0.31,
          sourceRef: 'api:only',
          provenanceRefs: [],
        }),
        77,
      );
      expect(input).toBeDefined();
      const saved = store.upsertMemoryMaintenanceReview(input!);

      expect(saved.status).toBe('pending');
      expect(store.getMemoryMaintenanceReview(saved.id)).toEqual(saved);
      expect(store.listMemoryMaintenanceReviews({ status: 'pending' })).toEqual([saved]);
      expect(store.listMemoryMaintenanceReviews({ kind: 'provenance_confidence' })).toEqual([saved]);
      expect(port.listMemoryMaintenanceReviews).toBeDefined();
      await expect(port.listMemoryMaintenanceReviews?.({ status: 'pending' })).resolves.toEqual([saved]);
    } finally {
      db.close();
    }
  });

  it('quarantines malformed review state instead of silently accepting it', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const store = new MemoryStore(db, 4);

    try {
      const saved = store.upsertMemoryMaintenanceReview({
        id: 'malformed-review-1',
        kind: 'near_duplicate',
        subjectMemoryId: 'memory-1',
        candidateMemoryIds: ['memory-2'],
        state: {
          schemaVersion: 99,
          kind: 'near_duplicate',
          status: 'pending',
        } as any,
        createdAt: 1,
        updatedAt: 1,
      });

      expect(saved.status).toBe('quarantined');
      expect(saved.quarantineReason).toContain('schemaVersion');
      expect(saved.state.status).toBe('quarantined');
      expect(store.listMemoryMaintenanceReviews({ status: 'pending' })).toEqual([]);
      expect(store.listMemoryMaintenanceReviews({ status: 'quarantined' })).toEqual([saved]);
    } finally {
      db.close();
    }
  });

  it('reports review queue age and evolution decision diagnostics', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const store = new MemoryStore(db, 4);

    try {
      store.insertMemory(makeMemory('memory-1', 'Original durable fact'), makeEmbedding(1));
      store.insertMemory(makeMemory('memory-2', 'Updated durable fact'), makeEmbedding(2));
      store.recordEvolutionLink({
        sourceMemoryId: 'memory-1',
        targetMemoryId: 'memory-2',
        relation: 'supersedes',
        createdAt: 1_100,
      });
      store.recordEvolutionLink({
        sourceMemoryId: 'memory-2',
        targetMemoryId: 'memory-1',
        relation: 'conflicts_with',
        createdAt: 1_300,
      });
      const review = buildHighImpactLowConfidenceReviewInput({
        memoryId: 'candidate-boundary-2',
        text: 'Potential relationship boundary with low confidence.',
        sourceRef: 'source:sleeptime|session:test',
        confidence: 0.3,
        type: 'boundary',
        tags: ['relationship'],
        sensitivity: 'confidential',
      }, 1_000);
      expect(review).toBeDefined();
      store.upsertMemoryMaintenanceReview(review!);

      const diagnostics = store.getMemoryMaintenanceDiagnostics({ now: 4_000 });

      expect(diagnostics).toMatchObject({
        reviewCount: 1,
        pendingReviewCount: 1,
        reviewCountsByKind: { high_impact_low_confidence: 1 },
        reviewCountsByStatus: { pending: 1 },
        oldestPendingReviewAgeMs: 3_000,
        averagePendingReviewAgeMs: 3_000,
        evolutionDecisionCount: 2,
        evolutionDecisionCountsByRelation: {
          supersedes: 1,
          updates: 0,
          negates: 0,
          conflicts_with: 1,
        },
        supersessionDecisionCount: 1,
        conflictDecisionCount: 1,
        latestEvolutionDecisionAt: 1_300,
      });
    } finally {
      db.close();
    }
  });

  it('maps corrupt stored review JSON as quarantined on read', () => {
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const store = new MemoryStore(db, 4);

    try {
      db.prepare(`
        INSERT INTO l2_memory_maintenance_reviews (
          id, kind, status, subject_memory_id, candidate_memory_ids, state_json,
          quarantine_reason, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'corrupt-review-1',
        'near_duplicate',
        'pending',
        'memory-1',
        JSON.stringify(['memory-2']),
        '{not-json',
        null,
        10,
        10,
      );

      const listed = store.listMemoryMaintenanceReviews();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: 'corrupt-review-1',
        status: 'quarantined',
        quarantineReason: expect.stringContaining('JSON'),
      });
    } finally {
      db.close();
    }
  });
});
