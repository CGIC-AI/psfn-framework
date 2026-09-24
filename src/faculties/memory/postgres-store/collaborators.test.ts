import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { QueryResult } from 'pg';
import type { PurrMemory } from '../types.js';
import {
  MemorySubjectAuthorizationDeniedError,
  type MemorySubjectQueryAuthorization,
} from '../../../shared/contracts/memory-subject.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';
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
  it('invalidates the retrieval corpus on upsert and reads shapes at query time by contact', async () => {
    const pool = new ScriptedPool(sql => sql.includes('from recent_contact_shapes')
      ? [{
        schema_version: 1, contact_id: 'newer', summary_text: 'summary newer', source_memory_ids: [],
        confidence_score: 0.5, novelty_score: 0.5, updated_at: '2', fresh_until: '3',
      }]
      : []);
    const { ctx } = makeContext(pool);
    const store = new PostgresRecentContactShapeStore(ctx);
    await store.upsertRecentContactShape({
      schemaVersion: 1, contactId: 'newer', summary: 'summary newer', sourceMemoryIds: [],
      confidenceScore: 0.5, noveltyScore: 0.5, updatedAt: 2, freshUntil: 3,
    });

    expect(ctx.markRetrievalCorpusChanged).toHaveBeenCalledTimes(1);
    expect(await store.getRecentContactShape('newer')).toMatchObject({ contactId: 'newer', updatedAt: 2, freshUntil: 3 });
    const lookup = pool.statements.find(statement => statement.sql.includes('contact_id = $1'));
    expect(lookup?.values).toEqual(['newer']);
    expect((await store.listRecentContactShapes()).map(item => item.contactId)).toEqual(['newer']);
    expect(pool.statements.at(-1)?.sql).toContain('order by updated_at desc');
  });
});

describe('PostgresMemoryLinkStore', () => {
  it('canonicalizes undirected links and reports duplicates from the insert result', async () => {
    let linked = false;
    const pool = new ScriptedPool((sql) => {
      if (sql.startsWith('insert into memory_links')) {
        if (linked) return [];
        linked = true;
        return [{ id1: 'a' }];
      }
      if (sql.startsWith('delete from memory_links')) {
        if (!linked) return [];
        linked = false;
        return [{ id1: 'a' }];
      }
      if (sql.includes('from memory_links')) {
        return linked ? [{ id1: 'a', id2: 'b', link_type: 'related', created_at: '5' }] : [];
      }
      return [];
    });
    const { ctx } = makeContext(pool);
    const store = new PostgresMemoryLinkStore(ctx);

    expect(await store.linkMemories(' b ', 'a')).toMatchObject({ id1: 'a', id2: 'b', linkType: 'related' });
    expect(await store.linkMemories('a', 'b')).toBeNull();
    expect(await store.linkMemories('a', 'a')).toBeNull();
    expect(await store.getLinkedMemories('b')).toEqual([{ id1: 'a', id2: 'b', linkType: 'related', createdAt: 5 }]);
    expect(await store.unlinkMemories('b', 'a')).toBe(true);
    expect(await store.unlinkMemories('b', 'a')).toBe(false);
    expect(ctx.markRetrievalCorpusChanged).toHaveBeenCalledTimes(2);
  });

  it('reads evolution links by endpoint and relation, newest first, without a resident view', async () => {
    const pool = new ScriptedPool();
    const store = new PostgresMemoryLinkStore(makeContext(pool).ctx);

    await store.getEvolutionLinksForSourceMemory(' next ', 'supersedes');
    expect(pool.statements.at(-1)?.sql).toContain('where source_memory_id = $1');
    expect(pool.statements.at(-1)?.sql).toContain('order by created_at desc, id desc');
    expect(pool.statements.at(-1)?.values).toEqual(['next', 'supersedes']);
    await store.getEvolutionLinksForTargetMemory('prev');
    expect(pool.statements.at(-1)?.sql).toContain('where target_memory_id = $1');
    expect(pool.statements.at(-1)?.values).toEqual(['prev', null]);
    const before = pool.statements.length;
    expect(await store.getEvolutionLinksForTargetMemory('  ')).toEqual([]);
    expect(pool.statements).toHaveLength(before);
  });
});

describe('PostgresMemoryMaintenanceReviewStore', () => {
  it('summarizes pending review ages and evolution decisions with aggregate SQL', async () => {
    const pool = new ScriptedPool((sql, values) => {
      if (sql.includes('group by kind, status')) {
        return [{ kind: 'high_impact_low_confidence', status: 'pending', count: '1' }];
      }
      if (sql.includes("where status = 'pending'")) {
        expect(values).toEqual([400]);
        return [{ count: '1', oldest: 300, average: '300' }];
      }
      return [];
    });
    const store = new PostgresMemoryMaintenanceReviewStore(makeContext(pool).ctx, async () => ({
      total: 2,
      byRelation: { supersedes: 1, updates: 0, negates: 1, conflicts_with: 0 },
      latestCreatedAt: 70,
    }));

    const diagnostics = await store.getMemoryMaintenanceDiagnostics({ now: 400 });

    expect(diagnostics).toMatchObject({
      reviewCount: 1,
      pendingReviewCount: 1,
      reviewCountsByKind: { high_impact_low_confidence: 1 },
      reviewCountsByStatus: { pending: 1 },
      oldestPendingReviewAgeMs: 300,
      averagePendingReviewAgeMs: 300,
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
  it('rejects non-update authorization and reads delete versions by id on the write client', async () => {
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
    expect(pool.statements).toHaveLength(0);

    expect(await deletion.getDeleteVersion('delete-1')).toBeUndefined();
    expect(pool.statements.at(-1)?.sql).toContain('from l2_memory_delete_versions where delete_id = $1');
    expect(pool.statements.at(-1)?.values).toEqual(['delete-1']);
    expect(await deletion.undoSoftDelete('delete-1')).toBeNull();
    expect(await deletion.softDeleteMemory('absent')).toBeNull();
    expect(reads.getById).toHaveBeenCalledWith('absent');
  });
});
