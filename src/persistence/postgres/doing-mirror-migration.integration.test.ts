import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import { PostgresDoingMirrorStore } from './doing-mirror-store.js';
import { POSTGRES_DOING_MIRROR_MIGRATIONS } from './migrations.js';

/**
 * psfn-framework-p2jr0 (1). The doing-mirror quarantine migration adds four
 * nullable/defaulted delivery-failure columns to an existing table and REPLACES
 * the pending-letter index with a quarantine-predicated one. Everything before
 * this file proved the SQL text; nothing proved that a database seeded under
 * the PRE-quarantine schema survives the replay — specifically that the
 * backfilled column defaults satisfy `mapRow`'s pairing invariant (a zero
 * failure count must carry no failure evidence) rather than throwing on the
 * first read after an upgrade.
 */

const INTEGRATION_TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_doing_mirror_migration';

/**
 * The schema as it stood before the quarantine columns: the CREATE TABLE and
 * its updated-at index, plus the pending-letter index the migration drops. The
 * drop is only actually exercised if that index exists first.
 */
const PRE_QUARANTINE_MIGRATIONS: readonly string[] = [
  ...POSTGRES_DOING_MIRROR_MIGRATIONS.slice(0, 2),
  `
  CREATE INDEX IF NOT EXISTS idx_doing_mirror_pending_letters
    ON doing_mirror_dispositions(updated_at_ms, item_type, item_id)
    WHERE letter_delivered_at_ms IS NULL;
  `,
];

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, INTEGRATION_TIMEOUT_MS);

async function seedPreQuarantineRow(
  pool: Pool,
  input: { itemId: string; letterId: string; deliveredAtMs: number | null },
): Promise<void> {
  await pool.query(`
    INSERT INTO doing_mirror_dispositions (
      item_type, item_id, state, reason, version, updated_at_ms, updated_by,
      letter_id, letter_subject, letter_body, letter_delivered_at_ms
    ) VALUES ('wishlist', $1, 'considering', NULL, 1, 1700000000000, 'partner',
              $2, 'A coastal walk', 'Considering this one.', $3)
  `, [input.itemId, input.letterId, input.deliveredAtMs]);
}

async function indexNames(pool: Pool): Promise<string[]> {
  const result = await pool.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = $1 AND tablename = 'doing_mirror_dispositions'
    ORDER BY indexname
  `, [SCHEMA]);
  return result.rows.map(row => row.indexname);
}

describe('doing-mirror quarantine migration replay', () => {
  it('backfills seeded pre-quarantine rows into mapper-valid records', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();

    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-migration-bootstrap',
      allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.end();

    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-migration',
      allowExitOnIdle: true,
      schema: SCHEMA,
    });
    let store: PostgresDoingMirrorStore | null = null;
    try {
      // 1. Stand up the schema as it was before the quarantine change, and put
      //    real rows in it: one still pending delivery, one already delivered.
      await runPostgresMigrations(pool, PRE_QUARANTINE_MIGRATIONS, { schema: SCHEMA });
      await seedPreQuarantineRow(pool, {
        itemId: 'wish-pending',
        letterId: '11111111-1111-4111-8111-111111111111',
        deliveredAtMs: null,
      });
      await seedPreQuarantineRow(pool, {
        itemId: 'wish-delivered',
        letterId: '22222222-2222-4222-8222-222222222222',
        deliveredAtMs: 1_700_000_001_000,
      });
      expect(await indexNames(pool)).toContain('idx_doing_mirror_pending_letters');

      // 2. Replay the full migration array over that populated database.
      await runPostgresMigrations(pool, POSTGRES_DOING_MIRROR_MIGRATIONS, { schema: SCHEMA });

      // 3. The backfilled defaults are exactly what the mapper's pairing
      //    invariant requires: a zero failure count with no failure evidence.
      const backfilled = await pool.query<{
        item_id: string;
        letter_failure_count: number;
        letter_last_error: string | null;
        letter_last_failed_at_ms: string | null;
        letter_quarantined_at_ms: string | null;
      }>(`
        SELECT item_id, letter_failure_count, letter_last_error,
               letter_last_failed_at_ms, letter_quarantined_at_ms
        FROM doing_mirror_dispositions
        ORDER BY item_id
      `);
      expect(backfilled.rows).toEqual([
        {
          item_id: 'wish-delivered',
          letter_failure_count: 0,
          letter_last_error: null,
          letter_last_failed_at_ms: null,
          letter_quarantined_at_ms: null,
        },
        {
          item_id: 'wish-pending',
          letter_failure_count: 0,
          letter_last_error: null,
          letter_last_failed_at_ms: null,
          letter_quarantined_at_ms: null,
        },
      ]);

      // 4. The index was replaced, not duplicated.
      const indexes = await indexNames(pool);
      expect(indexes).not.toContain('idx_doing_mirror_pending_letters');
      expect(indexes).toContain('idx_doing_mirror_drainable_letters');

      // 5. The invariant that actually matters: the upgraded rows read back
      //    through the real mapper instead of throwing on first access.
      store = await PostgresDoingMirrorStore.connect(databaseUrl, { schema: SCHEMA });
      const pending = await store.get('wishlist', 'wish-pending');
      expect(pending).toMatchObject({
        itemType: 'wishlist',
        itemId: 'wish-pending',
        state: 'considering',
        version: 1,
        updatedBy: 'partner',
        notification: {
          letterId: '11111111-1111-4111-8111-111111111111',
          failureCount: 0,
        },
      });
      expect(pending?.notification.lastError).toBeUndefined();
      expect(pending?.notification.lastFailedAt).toBeUndefined();
      expect(pending?.notification.quarantinedAt).toBeUndefined();
      expect(pending?.notification.deliveredAt).toBeUndefined();
      expect((await store.get('wishlist', 'wish-delivered'))?.notification.deliveredAt)
        .toBe(1_700_000_001_000);

      // 6. A backfilled row is still drainable: the new predicated index and
      //    the drain query agree that a NULL quarantine means "not quarantined".
      const drainable = await store.listPendingLetterDeliveries(10);
      expect(drainable.map(record => record.itemId)).toEqual(['wish-pending']);
    } finally {
      await store?.close();
      await pool.end().catch(() => undefined);
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('is idempotent when the quarantine migration is replayed again', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();

    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-migration-idempotence-bootstrap',
      allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await bootstrap.end();

    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror-migration-idempotence',
      allowExitOnIdle: true,
      schema: SCHEMA,
    });
    try {
      await runPostgresMigrations(pool, PRE_QUARANTINE_MIGRATIONS, { schema: SCHEMA });
      await seedPreQuarantineRow(pool, {
        itemId: 'wish-pending',
        letterId: '33333333-3333-4333-8333-333333333333',
        deliveredAtMs: null,
      });
      await runPostgresMigrations(pool, POSTGRES_DOING_MIRROR_MIGRATIONS, { schema: SCHEMA });
      // A second boot must not drop the new index or reset a column.
      await pool.query(`
        UPDATE doing_mirror_dispositions
        SET letter_failure_count = 2,
            letter_last_error = 'relay refused the delivery',
            letter_last_failed_at_ms = 1700000002000
        WHERE item_id = 'wish-pending'
      `);
      await runPostgresMigrations(pool, POSTGRES_DOING_MIRROR_MIGRATIONS, { schema: SCHEMA });

      expect(await indexNames(pool)).toContain('idx_doing_mirror_drainable_letters');
      const preserved = await pool.query<{ letter_failure_count: number }>(
        'SELECT letter_failure_count FROM doing_mirror_dispositions WHERE item_id = $1',
        ['wish-pending'],
      );
      expect(preserved.rows.at(0)?.letter_failure_count).toBe(2);
    } finally {
      await pool.end().catch(() => undefined);
    }
  }, INTEGRATION_TIMEOUT_MS);
});
