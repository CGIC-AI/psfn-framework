// Former whole-corpus L2 callers against real Postgres (psfn-framework-dnaqt):
// keyset page scans cover the entire active corpus (including through the
// subject-authorized proxy, whose list selector returns one page), and the
// proactive-recall fallback is a bounded SQL slice equal to the former
// whole-corpus sort.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresMemoryStoreFromPool } from '../postgres-store.js';
import { createSubjectAuthorizedMemoryStore } from '../subject-authorized-store.js';
import { activeMemoryPages, collectActiveMemories } from '../active-memory-scan.js';
import { collectProactiveRecallCandidates } from '../retrieval/social-context.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import type { PurrMemory } from '../types.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const EMBEDDING = new Float32Array([0.9, 0.1, 0.1, 0.1]);
const VIEWER = 'contact-a';
const RECALL_SLICE = 24;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withPool<T>(handler: (pool: Pool) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-memory-whole-corpus-integration',
    allowExitOnIdle: true,
    max: 4,
  });
  try {
    return await handler(pool);
  } finally {
    await pool.end();
  }
}

function makeMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `whole corpus memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.4,
    sourceRef: `channel-a:${id}`,
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: ['whole-corpus'],
    sensitivity: 'personal',
    consentFlags: {},
    provenance: { subjectContactId: VIEWER },
    ...overrides,
  };
}

/**
 * 90 viewer-owned active memories (duplicate extractedAt pairs exercise the id
 * tie-break), 5 memories about another contact, 1 superseded and 1 deleted.
 * Two of every seven viewer memories are internal artifacts (source-ref prefix
 * or a mixed-case tag); lastAccessed repeats so its ordering ties are exercised.
 */
function corpus(): PurrMemory[] {
  const memories: PurrMemory[] = [];
  for (let index = 0; index < 90; index += 1) {
    const artifact = index % 7 === 3
      ? { sourceRef: `Source:Context_Feedback|turn-${index}` }
      : index % 7 === 5 ? { tags: ['Context_Feedback'] } : {};
    memories.push(makeMemory(`own-${String(index).padStart(2, '0')}`, {
      extractedAt: 1_700_000_000_000 + Math.floor(index / 2) * 1000,
      lastAccessed: 1_700_100_000_000 + (index % 9) * 1000,
      ...artifact,
    }));
  }
  for (let index = 0; index < 5; index += 1) {
    memories.push(makeMemory(`other-${index}`, {
      extractedAt: 1_700_050_000_000 + index,
      lastAccessed: 1_700_200_000_000,
      provenance: { subjectContactId: 'contact-b' },
    }));
  }
  memories.push(makeMemory('own-superseded', { supersededBy: 'own-00', lastAccessed: 1_700_300_000_000 }));
  return memories;
}

async function seed(pool: Pool): Promise<MemoryStorePort> {
  const store = await createPostgresMemoryStoreFromPool(pool, 4);
  for (const memory of corpus()) await store.insertMemory(memory, EMBEDDING);
  await store.insertMemory(makeMemory('own-deleted', { lastAccessed: 1_700_300_000_000 }), EMBEDDING);
  await store.softDeleteMemory('own-deleted', { deleteId: 'delete-own', deletedBy: 'tester' });
  return store;
}

const ids = (memories: readonly PurrMemory[]): string[] => memories.map(memory => memory.id);

function newestFirst(left: PurrMemory, right: PurrMemory): number {
  return right.extractedAt - left.extractedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

describe('whole-corpus L2 callers read bounded pages (dnaqt)', () => {
  it('scans every active memory in keyset pages, raw and through the authorized proxy', async () => {
    await withPool(async (pool) => {
      const raw = await seed(pool);
      const authorized = createSubjectAuthorizedMemoryStore(raw, { viewerContactId: VIEWER });

      // The former unbounded authorized call returned a single page of the
      // 64 authorized (non-artifact) viewer memories.
      expect((await authorized.listMemories()).length).toBe(50);

      const rawActive = corpus().filter(memory => !memory.supersededBy).sort(newestFirst);
      const pageSizes: number[] = [];
      for await (const page of activeMemoryPages(raw)) pageSizes.push(page.length);
      expect(pageSizes.every(size => size <= 50)).toBe(true);
      expect(ids(await collectActiveMemories(raw, () => true))).toEqual(ids(rawActive));

      // The subject-authorized selectors never surface internal artifacts.
      const viewerActive = rawActive
        .filter(memory => memory.id.startsWith('own-') && !isInternalMemoryArtifact(memory));
      expect(viewerActive.length).toBe(64);
      expect(ids(await collectActiveMemories(authorized, () => true))).toEqual(ids(viewerActive));
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('answers the proactive-recall fallback with a bounded slice equal to the former whole-corpus sort', async () => {
    await withPool(async (pool) => {
      const raw = await seed(pool);
      const authorized = createSubjectAuthorizedMemoryStore(raw, { viewerContactId: VIEWER });

      // Former semantics: every authorized active memory (newest first), minus
      // internal artifacts, stable-sorted by lastAccessed, first 24.
      const formerAuthorized = corpus()
        .filter(memory => memory.id.startsWith('own-') && !memory.supersededBy)
        .sort(newestFirst)
        .filter(memory => !isInternalMemoryArtifact(memory))
        .sort((left, right) => right.lastAccessed - left.lastAccessed)
        .slice(0, RECALL_SLICE);
      expect(formerAuthorized.length).toBe(RECALL_SLICE);
      expect(ids(await authorized.getRecentlyAccessedMemories(RECALL_SLICE))).toEqual(ids(formerAuthorized));
      expect(ids(await collectProactiveRecallCandidates(authorized, 'channel-without-memories')))
        .toEqual(ids(formerAuthorized));

      const formerRaw = corpus()
        .filter(memory => !memory.supersededBy)
        .sort(newestFirst)
        .filter(memory => !isInternalMemoryArtifact(memory))
        .sort((left, right) => right.lastAccessed - left.lastAccessed)
        .slice(0, RECALL_SLICE);
      expect(ids(await raw.getRecentlyAccessedMemories(RECALL_SLICE))).toEqual(ids(formerRaw));
    });
  }, INTEGRATION_TIMEOUT_MS);
});
