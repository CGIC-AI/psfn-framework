import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { QueryResult } from 'pg';
import type { MemoryEvolutionLink } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';
import {
  MemorySubjectAuthorizationDeniedError,
  type MemorySubjectQueryAuthorization,
} from '../../../shared/contracts/memory-subject.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';
import { buildHighImpactLowConfidenceReviewInput } from '../maintenance-review.js';
import { PostgresScratchpadStore } from './scratchpad.js';
import { PostgresRecentContactShapeStore } from './contact-shapes.js';
import { PostgresMemoryLinkStore } from './memory-links.js';
import { PostgresMemoryMaintenanceReviewStore } from './reviews.js';
import { PostgresMemoryBulkUpdates } from './bulk-updates.js';
import { PostgresL2BoundedReads } from './bounded-reads.js';
import { PostgresMemorySubjectAuthorizedWrites } from './subject-authorized-writes.js';
import { PostgresMemoryDeletionStore } from './memory-deletion.js';

type QueryHandler = (sql: string, values: readonly unknown[]) => Array<Record<string, unknown>>;

class ScriptedPool {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  constructor(private readonly handler: QueryHandler = () => []) {}

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, ' ').trim().toLowerCase();
    this.statements.push({ sql, values });
    const rows = this.handler(sql, values);
    return fromAny({ rows, rowCount: rows.length });
  }
}

function makeContext(pool: ScriptedPool, options: { inTransaction?: boolean } = {}) {
  const ctx = {
    pool: fromAny(pool),
    embeddingDims: 4,
    persist: <T>(task: () => Promise<T>) => task(),
    settle: () => Promise.resolve(),
    hasActiveTransaction: () => options.inTransaction === true,
    runInTransaction: async <T>(handler: () => T) => await handler(),
    queryWrite: async (text: string, values: readonly unknown[]) => (await pool.query(text, values)).rows,
    persistClassifiedMemoryRow: vi.fn(async () => undefined),
    markSalienceMaintenanceChanged: vi.fn(),
    markRetrievalCorpusChanged: vi.fn(),
  } satisfies PostgresMemoryStoreCollaboratorContext;
  return { ctx };
}

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `memory ${id}`,
    type: 'semantic',
    importance: 0.5,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: `api:test:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function authorization(action: MemorySubjectQueryAuthorization['action']): MemorySubjectQueryAuthorization {
  return {
    action,
    viewerContactIds: ['contact-a'],
    allowedSubjectClasses: ['single_contact'],
    allowedViewerRelations: ['self'],
    classifierVersion: 1,
    grantBindings: [],
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('PostgresScratchpadStore', () => {
  it('drops expired rows at hydration and mirrors the surviving entries', async () => {
    const now = Date.now();
    const pool = new ScriptedPool((sql) => sql.startsWith('select id, content') ? [
      { id: 'fresh', content: 'keep', created_at: String(now), updated_at: String(now) },
      { id: 'stale', content: 'expire', created_at: now - 3 * 86_400_000, updated_at: now - 3 * 86_400_000 },
    ] : []);
    const dir = mkdtempSync(join(tmpdir(), 'scratchpad-mirror-'));
    tempDirs.push(dir);
    const mirrorPath = join(dir, 'scratchpad.json');
    const store = new PostgresScratchpadStore(makeContext(pool).ctx, mirrorPath);

    await store.hydrate();

    expect(store.listScratchpadEntries().map(entry => entry.id)).toEqual(['fresh']);
    await vi.waitFor(() => {
      expect(pool.statements.some(statement => (
        statement.sql.startsWith('delete from scratchpad_entries') && statement.values[0] === 'stale'
      ))).toBe(true);
    });
    const mirror = JSON.parse(readFileSync(mirrorPath, 'utf8')) as { entries: Array<{ id: string }> };
    expect(mirror.entries.map(entry => entry.id)).toEqual(['fresh']);
  });

  it('evicts the oldest entries beyond the 64-entry capacity', async () => {
    const pool = new ScriptedPool();
    const store = new PostgresScratchpadStore(makeContext(pool).ctx, null);
    const base = Date.now();
    for (let index = 0; index < 64; index += 1) {
      await store.addScratchpadEntry(`note ${index}`, { id: `note-${index}`, now: base + index });
    }
    const result = await store.addScratchpadEntry('newest', { id: 'note-new', now: base + 100 });

    expect(result.evictedIds).toEqual(['note-0']);
    expect(await store.getScratchpadEntry('note-0')).toBeUndefined();
    expect(store.listScratchpadEntries()).toHaveLength(64);
    await expect(store.appendScratchpadEntry('note-new', '   ')).rejects.toThrow('Scratchpad content is required');
  });
});

describe('PostgresRecentContactShapeStore', () => {
  it('invalidates the retrieval corpus on upsert and lists newest first', async () => {
    const pool = new ScriptedPool();
    const { ctx } = makeContext(pool);
    const store = new PostgresRecentContactShapeStore(ctx);
    const shape = (contactId: string, updatedAt: number) => ({
      schemaVersion: 1 as const,
      contactId,
      summary: `summary ${contactId}`,
      sourceMemoryIds: [],
      confidenceScore: 0.5,
      noveltyScore: 0.5,
      updatedAt,
      freshUntil: updatedAt + 1,
    });

    await store.upsertRecentContactShape(shape('older', 1));
    await store.upsertRecentContactShape(shape('newer', 2));

    expect(ctx.markRetrievalCorpusChanged).toHaveBeenCalledTimes(2);
    expect((await store.listRecentContactShapes()).map(item => item.contactId)).toEqual(['newer', 'older']);
  });
});

describe('PostgresMemoryLinkStore', () => {
  it('canonicalizes undirected links and rejects self or duplicate links', async () => {
    const pool = new ScriptedPool();
    const { ctx } = makeContext(pool);
    const store = new PostgresMemoryLinkStore(ctx);

    expect(await store.linkMemories(' b ', 'a')).toMatchObject({ id1: 'a', id2: 'b', linkType: 'related' });
    expect(await store.linkMemories('a', 'b')).toBeNull();
    expect(await store.linkMemories('a', 'a')).toBeNull();
    expect((await store.getLinkedMemories('b')).map(link => link.id1)).toEqual(['a']);
    expect(await store.unlinkMemories('b', 'a')).toBe(true);
    expect(await store.unlinkMemories('b', 'a')).toBe(false);
    expect(ctx.markRetrievalCorpusChanged).toHaveBeenCalledTimes(2);
  });

  it('filters evolution links by endpoint and relation, newest first', async () => {
    const store = new PostgresMemoryLinkStore(makeContext(new ScriptedPool()).ctx);
    await store.recordEvolutionLink({
      sourceMemoryId: 'next', targetMemoryId: 'prev', relation: 'supersedes', confidence: 0.9, createdAt: 1,
    });
    await store.recordEvolutionLink({
      sourceMemoryId: 'next', targetMemoryId: 'other', relation: 'updates', confidence: 0.9, createdAt: 2,
    });

    expect((await store.getEvolutionLinksForSourceMemory('next')).map(link => link.targetMemoryId))
      .toEqual(['other', 'prev']);
    expect((await store.getEvolutionLinksForSourceMemory('next', 'supersedes')).map(link => link.targetMemoryId))
      .toEqual(['prev']);
    expect(await store.getEvolutionLinksForTargetMemory('  ')).toEqual([]);
    expect(store.evolutionLinks().size).toBe(2);
  });
});

describe('PostgresMemoryMaintenanceReviewStore', () => {
  it('summarizes pending review ages and evolution decisions from the link view', async () => {
    const evolution = new Map<string, MemoryEvolutionLink>([
      ['a', fromAny({ relation: 'supersedes', createdAt: 50 })],
      ['b', fromAny({ relation: 'negates', createdAt: 70 })],
    ]);
    const store = new PostgresMemoryMaintenanceReviewStore(makeContext(new ScriptedPool()).ctx, () => evolution);
    const input = buildHighImpactLowConfidenceReviewInput({
      memoryId: 'memory-1',
      text: 'The partner said they are moving abroad next month.',
      sourceRef: 'api:test:memory-1',
      confidence: 0.2,
      type: 'boundary',
    }, 100);
    if (!input) throw new Error('fixture must queue a high-impact low-confidence review');
    await store.upsertMemoryMaintenanceReview(input);

    const diagnostics = await store.getMemoryMaintenanceDiagnostics({ now: 400 });

    expect(diagnostics).toMatchObject({
      reviewCount: 1,
      pendingReviewCount: 1,
      oldestPendingReviewAgeMs: 300,
      evolutionDecisionCount: 2,
      supersessionDecisionCount: 1,
      conflictDecisionCount: 1,
      latestEvolutionDecisionAt: 70,
    });
  });
});

describe('PostgresMemoryBulkUpdates', () => {
  it('reads current rows once and advances counters only when Postgres reports an update', async () => {
    const pool = new ScriptedPool((sql) => sql.startsWith('update l2_memories') ? [{ id: 'kept' }] : []);
    const { ctx } = makeContext(pool);
    const reads = { getByIds: vi.fn(async (ids: readonly string[]) => ids
      .filter(id => id !== 'missing')
      .map(id => makeMemory(id))) };
    const updates = new PostgresMemoryBulkUpdates(ctx, reads);

    expect(await updates.bulkUpdate(['kept'], {})).toBe(0);
    expect(reads.getByIds).not.toHaveBeenCalled();
    expect(pool.statements).toHaveLength(0);
    expect(await updates.bulkUpdate([' kept ', 'raced', 'missing', ''], { sensitivity: 'confidential' })).toBe(1);

    expect(reads.getByIds).toHaveBeenCalledWith(['kept', 'raced', 'missing']);
    const update = pool.statements.find(statement => statement.sql.startsWith('update l2_memories'));
    expect(update?.values).toEqual(['kept', 'confidential', 'raced', 'confidential']);
    expect(ctx.markRetrievalCorpusChanged).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresL2BoundedReads', () => {
  it('fails closed before querying when raw embedding search is not a system bypass', async () => {
    const pool = new ScriptedPool();
    const reads = new PostgresL2BoundedReads(makeContext(pool).ctx, false);

    await expect(reads.searchByEmbedding(
      new Float32Array(4),
      0.5,
      5,
      undefined,
      fromAny({ authorization: 'subject-enforced' }),
    )).rejects.toThrow('cannot enforce subject authorization');
    expect(pool.statements).toHaveLength(0);
  });

  it('refuses committed-state window reads inside a memory-store transaction', async () => {
    const reads = new PostgresL2BoundedReads(makeContext(new ScriptedPool(), { inTransaction: true }).ctx, false);
    await expect(reads.listActiveMemoriesInWindow({
      fromMs: 0, toMs: 1, limit: 5, scope: { kind: 'companion' },
    })).rejects.toThrow('unavailable inside a memory-store transaction');
    await expect(reads.listActiveMemoryEmbeddingsSince(0)).rejects.toThrow('unavailable inside a memory-store transaction');
  });
});

describe('PostgresMemorySubjectAuthorizedWrites', () => {
  it('denies the whole mutation when any requested row is not authorized', async () => {
    const pool = new ScriptedPool(() => []);
    const writes = {
      updateMemory: vi.fn(async () => undefined),
      insertMemory: vi.fn(async () => undefined),
    };
    const subjectWrites = new PostgresMemorySubjectAuthorizedWrites(makeContext(pool).ctx, writes);

    await expect(subjectWrites.mutateAuthorizedMemorySubjects({
      authorization: authorization('update'),
      memoryIds: ['memory-1'],
      updates: { salience: 0.1 },
    })).rejects.toBeInstanceOf(MemorySubjectAuthorizationDeniedError);
    await expect(subjectWrites.mutateAuthorizedMemorySubjects({
      authorization: authorization('list'),
      memoryIds: ['memory-1'],
      updates: { salience: 0.1 },
    })).rejects.toThrow('does not permit mutation');
    expect(writes.updateMemory).not.toHaveBeenCalled();
  });
});

describe('PostgresMemoryDeletionStore', () => {
  it('rejects non-update authorization and restores snapshotted delete versions', async () => {
    const pool = new ScriptedPool();
    const reads = { getById: vi.fn(async () => undefined) };
    const deletion = new PostgresMemoryDeletionStore(
      makeContext(pool).ctx,
      reads,
      null,
      vi.fn(async () => undefined),
    );

    await expect(deletion.softDeleteAuthorizedMemorySubject({
      authorization: authorization('bulk_mutation'),
      memoryId: 'memory-1',
    })).rejects.toThrow('does not permit delete');

    const snapshot = deletion.snapshotVersions();
    deletion.recordVersion({
      deleteId: 'delete-1',
      memoryId: 'memory-1',
      snapshot: makeMemory('memory-1'),
      deletedAt: 1,
      deletedBy: 'agent',
    });
    expect(await deletion.getDeleteVersion('delete-1')).toBeDefined();
    deletion.restoreVersions(snapshot);
    expect(await deletion.getDeleteVersion('delete-1')).toBeUndefined();
    expect(await deletion.undoSoftDelete('delete-1')).toBeNull();
    expect(await deletion.softDeleteMemory('absent')).toBeNull();
    expect(reads.getById).toHaveBeenCalledWith('absent');
    expect(pool.statements).toHaveLength(0);
  });
});
