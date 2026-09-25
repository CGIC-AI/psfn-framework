// Real-Postgres proof that the gateway audit chain retires the removed Buzz
// channel's recovery tables (psfn-framework-lef2o). The drop runs in the
// gateway connection scope on every boot, so it must be idempotent, must leave
// the audit table intact, and must not touch unrelated relations.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, ensurePostgresSchema } from '../postgres.js';
import { POSTGRES_AUDIT_MIGRATIONS } from './migrations.js';

const TIMEOUT_MS = 120_000;
const RETIRED_TABLES = [
  'buzz_inbound_recovery',
  'buzz_replay_checkpoints',
  'buzz_room_memberships',
  'buzz_causal_events',
] as const;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

describe('gateway audit chain retires Buzz recovery tables', () => {
  it('drops populated retired tables, keeps unrelated tables, and reruns cleanly', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const pool = createPostgresPool(databaseUrl, { applicationName: 'retired-buzz-tables-test' });
    try {
      for (const table of RETIRED_TABLES) {
        await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
        await pool.query(`INSERT INTO ${table} (id) VALUES ('row-1')`);
      }
      await pool.query('CREATE TABLE unrelated_keep (id TEXT PRIMARY KEY)');

      await ensurePostgresSchema(pool, POSTGRES_AUDIT_MIGRATIONS);
      await ensurePostgresSchema(pool, POSTGRES_AUDIT_MIGRATIONS);

      const remaining = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = current_schema()
          ORDER BY table_name`,
      );
      const names = remaining.rows.map(row => row.table_name);
      for (const table of RETIRED_TABLES) expect(names).not.toContain(table);
      expect(names).toContain('gateway_audit');
      expect(names).toContain('unrelated_keep');
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);
});
