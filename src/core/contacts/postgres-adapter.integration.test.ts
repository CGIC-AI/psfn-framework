import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';

import { createPostgresPool } from '../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import type { TrustLevel } from '../../system/trust/types.js';
import { createPostgresContactStore } from './postgres-adapter.js';

const TIMEOUT_MS = 120_000;
const APPLICATION_NAME = 'psfn-contact-trust-cas-test';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  return (await harness.createDatabase()).databaseUrl;
}

async function waitForBlockedContactQuery(pool: Pool, queryPattern: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const observed = await pool.query<{ blocked: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND application_name = $1
            AND state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE $2
        ) AS blocked
      `,
      [APPLICATION_NAME, queryPattern],
    );
    if (observed.rows[0]?.blocked === true) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for a blocked contact query matching ${queryPattern}`);
}

interface TrustInterleavingCase {
  label: string;
  initialTrustLevel: TrustLevel;
  requestedTrustLevel?: TrustLevel;
  concurrentTrustLevel: TrustLevel;
}

const TRUST_INTERLEAVINGS: TrustInterleavingCase[] = [
  {
    label: 'trusted promotion',
    initialTrustLevel: 'regular',
    requestedTrustLevel: 'public',
    concurrentTrustLevel: 'trusted',
  },
  {
    label: 'primary promotion',
    initialTrustLevel: 'regular',
    requestedTrustLevel: 'public',
    concurrentTrustLevel: 'primary',
  },
  {
    label: 'trusted demotion',
    initialTrustLevel: 'trusted',
    concurrentTrustLevel: 'regular',
  },
];

describe('PostgresContactStore trust concurrency', () => {
  it.each(TRUST_INTERLEAVINGS)(
    'preserves a concurrent $label that commits after the profile read',
    async ({ initialTrustLevel, requestedTrustLevel, concurrentTrustLevel }) => {
      const databaseUrl = await freshDatabaseUrl();
      const pool = createPostgresPool(databaseUrl, {
        applicationName: APPLICATION_NAME,
        allowExitOnIdle: true,
        max: 8,
      });
      let blocker: PoolClient | null = null;
      try {
        const store = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool });
        const contact = await store.upsert(
          {
            displayName: 'Real Postgres Trust Race',
            trustLevel: initialTrustLevel,
          },
          { actor: 'operator:postgres-trust-race' },
        );

        blocker = await pool.connect();
        await blocker.query('BEGIN');
        await blocker.query(
          'UPDATE contacts SET trust_level = $1 WHERE id = $2',
          [concurrentTrustLevel, contact.id],
        );

        const profileUpdate = store.upsert({
          id: contact.id,
          displayName: 'Real Postgres Trust Race Renamed',
          ...(requestedTrustLevel ? { trustLevel: requestedTrustLevel } : {}),
        });
        await waitForBlockedContactQuery(pool, '%UPDATE contacts%');
        await blocker.query('COMMIT');
        blocker.release();
        blocker = null;

        const updated = await profileUpdate;
        expect(updated.displayName).toBe('Real Postgres Trust Race Renamed');
        expect(updated.trustLevel).toBe(concurrentTrustLevel);
      } finally {
        if (blocker) {
          await blocker.query('ROLLBACK').catch(() => undefined);
          blocker.release();
        }
        await pool.end();
      }
    },
    TIMEOUT_MS,
  );

  it('derives merged trust from rows locked after a concurrent promotion commits', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: APPLICATION_NAME,
      allowExitOnIdle: true,
      max: 8,
    });
    let blocker: PoolClient | null = null;
    try {
      const store = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool });
      const source = await store.upsert({
        id: '00000000-0000-4000-8000-000000000001',
        displayName: 'Merge Source',
        trustLevel: 'public',
      });
      const target = await store.upsert({
        id: '00000000-0000-4000-8000-000000000002',
        displayName: 'Merge Target',
        trustLevel: 'regular',
      });

      blocker = await pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'UPDATE contacts SET trust_level = $1 WHERE id = $2',
        ['trusted', target.id],
      );

      const merge = store.mergeContacts(source.id, target.id);
      await waitForBlockedContactQuery(pool, '%contacts%');
      await blocker.query('COMMIT');
      blocker.release();
      blocker = null;

      await expect(merge).resolves.toBe(true);
      await expect(store.getById(target.id)).resolves.toMatchObject({ trustLevel: 'trusted' });
    } finally {
      if (blocker) {
        await blocker.query('ROLLBACK').catch(() => undefined);
        blocker.release();
      }
      await pool.end();
    }
  }, TIMEOUT_MS);
});
