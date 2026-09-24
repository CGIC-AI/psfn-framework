import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema } from '../postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../postgres/migrations.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { repairPostgresMemoryParticipantNames } from './memory-participant-name-repair.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const STALE_EMBEDDING = [0.9, 0.1, 0.1];
const REPAIRED_EMBEDDING = [0.1, 0.1, 0.9];

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withRepairDatabase(handler: (pool: Pool) => Promise<void>): Promise<void> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-participant-name-repair-integration',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
    await handler(pool);
  } finally {
    await pool.end();
  }
}

async function seed(pool: Pool, id: string, text: string, options: { supersededBy?: string } = {}): Promise<void> {
  await pool.query(`
    INSERT INTO l2_memories (
      id, text, type, importance, confidence, emotional_valence, salience,
      source_ref, extracted_at, last_accessed, access_count, superseded_by, embedding
    ) VALUES ($1, $2, 'semantic', 0.5, 0.9, 0, 0.5, 'source:test', 100, 100, 0, $3, $4::vector)
  `, [id, text, options.supersededBy ?? null, `[${STALE_EMBEDDING.join(',')}]`]);
}

function provider(embedBatch: EmbeddingProviderPort['embedBatch']): EmbeddingProviderPort {
  return {
    dims: REPAIRED_EMBEDDING.length,
    embed: async () => { throw new Error('unexpected single embed'); },
    embedBatch,
  };
}

async function readRow(pool: Pool, id: string): Promise<{ text: string; embedding: string }> {
  const result = await pool.query<{ text: string; embedding: string }>(
    'SELECT text, embedding::text AS embedding FROM l2_memories WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`missing row ${id}`);
  return row;
}

async function nearestTo(pool: Pool, vector: readonly number[]): Promise<string | undefined> {
  const result = await pool.query<{ id: string }>(
    'SELECT id FROM l2_memories ORDER BY embedding <=> $1::vector LIMIT 1',
    [`[${vector.join(',')}]`],
  );
  return result.rows[0]?.id;
}

async function lexicalMatches(pool: Pool, term: string): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM l2_memories WHERE search_vector @@ to_tsquery('simple', $1) ORDER BY id`,
    [term],
  );
  return result.rows.map(row => row.id);
}

async function patchEventCount(pool: Pool): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM l2_memory_patch_events');
  return Number(result.rows[0]?.count ?? 0);
}

describe('memory participant-name repair against Postgres', () => {
  it('atomically updates text, embedding, and lexical projection; archived rows stay untouched', async () => {
    await withRepairDatabase(async (pool) => {
      await seed(pool, 'm-active', 'The user told the companion about the kiln schedule.');
      await seed(pool, 'm-archived', 'The user told the companion about the garden.', { supersededBy: 'm-active' });
      await seed(pool, 'm-other', 'Weather notes for the harbor.');

      const embedded: string[][] = [];
      const report = await repairPostgresMemoryParticipantNames(pool, {
        canonicalContactName: 'Alex',
        companionName: 'Lyra',
        dryRun: false,
        embeddingProvider: provider(async (texts) => {
          embedded.push([...texts]);
          return texts.map(() => new Float32Array(REPAIRED_EMBEDDING));
        }),
      });

      expect(report.updated).toBe(1);
      expect(embedded).toEqual([['Alex told Lyra about the kiln schedule.']]);
      const repaired = await readRow(pool, 'm-active');
      expect(repaired.text).toBe('Alex told Lyra about the kiln schedule.');
      expect(repaired.embedding).toBe(`[${REPAIRED_EMBEDDING.join(',')}]`);
      expect(await nearestTo(pool, REPAIRED_EMBEDDING)).toBe('m-active');
      expect(await lexicalMatches(pool, 'alex')).toEqual(['m-active']);

      const archived = await readRow(pool, 'm-archived');
      expect(archived.text).toBe('The user told the companion about the garden.');
      expect(archived.embedding).toBe(`[${STALE_EMBEDDING.join(',')}]`);
      expect(await patchEventCount(pool)).toBe(1);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('leaves the row, embedding, and patch events unchanged when the provider fails', async () => {
    await withRepairDatabase(async (pool) => {
      await seed(pool, 'm-active', 'The user told the companion about the kiln schedule.');

      await expect(repairPostgresMemoryParticipantNames(pool, {
        canonicalContactName: 'Alex',
        companionName: 'Lyra',
        dryRun: false,
        embeddingProvider: provider(async () => { throw new Error('embedding provider down'); }),
      })).rejects.toThrow('embedding provider down');

      const row = await readRow(pool, 'm-active');
      expect(row.text).toBe('The user told the companion about the kiln schedule.');
      expect(row.embedding).toBe(`[${STALE_EMBEDDING.join(',')}]`);
      expect(await lexicalMatches(pool, 'alex')).toEqual([]);
      expect(await patchEventCount(pool)).toBe(0);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
