// ── Live-database integration tests for cross-companion presence (W5a) ──
// Follows the schema-tenancy harness pattern: a throwaway dockerized postgres,
// a fresh database per test. Covers what the mocked-pool unit tests cannot:
// real DDL for the shared chain (table, index, ledger, CHECK constraint),
// since/updated_at semantics under real upserts, and provisioning idempotency
// under N concurrent agents.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import { PostgresCompanionPresenceStore } from './companion-presence-store.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// Presence plumbing does not need pgvector; the plain postgres image is fast.
const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) {
    await harness.stop();
  }
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) {
    throw new Error('Postgres integration harness is not available');
  }
  const database = await harness.createDatabase();
  return database.databaseUrl;
}

describe('companion_presence shared-schema integration', () => {
  it(
    'provisions the presence table, place index, and ledger version 2 in the shared schema only',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresCompanionPresenceStore.connect(databaseUrl);
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-presence-verify',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const tables = await pool.query<{ table_schema: string }>(
          `SELECT table_schema FROM information_schema.tables
           WHERE table_name = 'companion_presence' ORDER BY table_schema`,
        );
        expect(tables.rows.map(r => r.table_schema)).toEqual(['shared']);

        const index = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'shared' AND tablename = 'companion_presence'
             AND indexname = 'idx_companion_presence_place'`,
        );
        expect(index.rows).toHaveLength(1);

        const ledger = await pool.query<{ version: number; name: string }>(
          `SELECT version, name FROM shared.shared_schema_migrations ORDER BY version`,
        );
        expect(ledger.rows).toEqual([
          { version: 1, name: 'shared-schema-baseline' },
          { version: 2, name: 'companion-presence' },
        ]);
      } finally {
        await pool.end();
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'is idempotent under N concurrently-provisioning agents (advisory-lock serialized)',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      // Simulate a fleet of agents starting at once against a fresh database:
      // every concurrent provisioning path must succeed, not just one winner.
      await Promise.all(
        Array.from({ length: 6 }, () => bootstrapSharedSchema(databaseUrl)),
      );
      const stores = await Promise.all(
        Array.from({ length: 4 }, () => PostgresCompanionPresenceStore.connect(databaseUrl)),
      );
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-presence-concurrency',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        const ledger = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM shared.shared_schema_migrations`,
        );
        expect(ledger.rows[0]?.count).toBe('2');
        // Nothing leaked into public.
        const publicTables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = 'public'
             AND table_name IN ('companion_presence', 'shared_schema_migrations')`,
        );
        expect(publicTables.rows).toEqual([]);
      } finally {
        await pool.end();
        for (const store of stores) {
          await store.close();
        }
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'round-trips presence: upsert preserves since on refresh, resets it on a move, delete removes',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresCompanionPresenceStore.connect(databaseUrl);
      try {
        const first = await store.upsertPresence({
          companionId: COMPANION_A,
          siteId: 'site.home',
          placeId: 'place.living-room',
          kind: 'physical',
        });

        // Same-place refresh: since is preserved, updated_at moves forward.
        await new Promise((resolve) => setTimeout(resolve, 20));
        const refreshed = await store.upsertPresence({
          companionId: COMPANION_A,
          siteId: 'site.home',
          placeId: 'place.living-room',
          kind: 'physical',
        });
        expect(refreshed.since).toBe(first.since);
        expect(Date.parse(refreshed.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));

        // Move: since resets.
        const moved = await store.upsertPresence({
          companionId: COMPANION_A,
          siteId: 'site.home',
          placeId: 'place.kitchen',
          kind: 'physical',
        });
        expect(Date.parse(moved.since)).toBeGreaterThan(Date.parse(first.since));

        // Co-presence read is place-scoped.
        await store.upsertPresence({
          companionId: COMPANION_B,
          siteId: 'site.home',
          placeId: 'place.kitchen',
          kind: 'physical',
        });
        const kitchen = await store.listByPlace('site.home', 'place.kitchen');
        expect(kitchen.map(r => r.companionId).sort()).toEqual([COMPANION_A, COMPANION_B]);
        expect(await store.listByPlace('site.home', 'place.living-room')).toEqual([]);
        expect((await store.listAll()).map(r => r.companionId).sort())
          .toEqual([COMPANION_A, COMPANION_B]);

        // Graceful-shutdown delete.
        expect(await store.deletePresence(COMPANION_A)).toBe(true);
        expect(await store.deletePresence(COMPANION_A)).toBe(false);
        expect((await store.listByPlace('site.home', 'place.kitchen')).map(r => r.companionId))
          .toEqual([COMPANION_B]);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'enforces the kind CHECK constraint and the uuid key at the database layer',
    async () => {
      const databaseUrl = await freshDatabaseUrl();
      const store = await PostgresCompanionPresenceStore.connect(databaseUrl);
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'psfn-presence-constraints',
        allowExitOnIdle: true,
        max: 1,
      });
      try {
        await expect(pool.query(
          `INSERT INTO shared.companion_presence (companion_id, site_id, place_id, kind)
           VALUES ($1, 'site.home', 'place.x', 'astral')`,
          [COMPANION_A],
        )).rejects.toThrow(/check constraint/i);
        await expect(pool.query(
          `INSERT INTO shared.companion_presence (companion_id, site_id, place_id, kind)
           VALUES ('not-a-uuid', 'site.home', 'place.x', 'physical')`,
        )).rejects.toThrow(/uuid/i);
      } finally {
        await pool.end();
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
