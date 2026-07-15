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

async function waitForConcurrencyGate(gate: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function installSelectedTrustAuditFailure(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE FUNCTION reject_selected_contact_trust_audit()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.field = 'trust_level' AND NEW.actor LIKE 'operator:postgres-audit-failure%' THEN
        RAISE EXCEPTION 'injected trust audit failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await pool.query(`
    CREATE TRIGGER reject_selected_contact_trust_audit_trigger
    BEFORE INSERT ON contact_mutation_audit
    FOR EACH ROW
    EXECUTE FUNCTION reject_selected_contact_trust_audit()
  `);
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
          'UPDATE contacts SET trust_level = $1, trust_version = trust_version + 1 WHERE id = $2',
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

  it('rejects a stale profile trust change after two committed operator mutations return to the same value', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const stalePool = createPostgresPool(databaseUrl, {
      applicationName: APPLICATION_NAME,
      allowExitOnIdle: true,
      max: 8,
    });
    const operatorPool = createPostgresPool(databaseUrl, {
      applicationName: `${APPLICATION_NAME}-operator`,
      allowExitOnIdle: true,
      max: 8,
    });
    const originalQuery = stalePool.query.bind(stalePool);
    let releaseProfileUpdate = (): void => undefined;
    try {
      const staleStore = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool: stalePool });
      const operatorStore = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool: operatorPool });
      const contact = await staleStore.upsert({
        displayName: 'Real Postgres Generic ABA',
        trustLevel: 'public',
      });

      let signalProfileUpdate = (): void => undefined;
      const profileUpdateReached = new Promise<void>((resolve) => {
        signalProfileUpdate = resolve;
      });
      const profileUpdateReleased = new Promise<void>((resolve) => {
        releaseProfileUpdate = resolve;
      });
      let shouldPause = true;
      stalePool.query = (async (text: string, values?: readonly unknown[]) => {
        const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (shouldPause && normalized.startsWith('update contacts set discord_user_id = coalesce')) {
          shouldPause = false;
          signalProfileUpdate();
          await profileUpdateReleased;
        }
        return await originalQuery(text, values ? [...values] : []);
      }) as typeof stalePool.query;

      const staleUpsert = staleStore.upsert({
        id: contact.id,
        displayName: 'Real Postgres Generic ABA Renamed',
        trustLevel: 'regular',
      });
      await waitForConcurrencyGate(profileUpdateReached, 'stale profile update');
      await expect(operatorStore.setTrustLevel(
        contact.id,
        'trusted',
        'operator:postgres-aba',
        { mutationSource: 'manual' },
      )).resolves.toBe(true);
      await expect(operatorStore.setTrustLevel(
        contact.id,
        'public',
        'operator:postgres-aba',
        { mutationSource: 'manual' },
      )).resolves.toBe(true);
      releaseProfileUpdate();

      await expect(staleUpsert).resolves.toMatchObject({
        displayName: 'Real Postgres Generic ABA Renamed',
        trustLevel: 'public',
      });
      await expect(staleStore.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([
        expect.objectContaining({ oldValue: 'trusted', newValue: 'public', actor: 'operator:postgres-aba' }),
        expect.objectContaining({ oldValue: 'public', newValue: 'trusted', actor: 'operator:postgres-aba' }),
      ]);
    } finally {
      stalePool.query = originalQuery as typeof stalePool.query;
      releaseProfileUpdate();
      await Promise.all([stalePool.end(), operatorPool.end()]);
    }
  }, TIMEOUT_MS);

  it('rejects a stale explicit trust change after two committed operator mutations return to the same value', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const staleBasePool = createPostgresPool(databaseUrl, {
      applicationName: APPLICATION_NAME,
      allowExitOnIdle: true,
      max: 8,
    });
    const operatorPool = createPostgresPool(databaseUrl, {
      applicationName: `${APPLICATION_NAME}-operator`,
      allowExitOnIdle: true,
      max: 8,
    });
    let signalTrustUpdate = (): void => undefined;
    const trustUpdateReached = new Promise<void>((resolve) => {
      signalTrustUpdate = resolve;
    });
    let releaseTrustUpdate = (): void => undefined;
    const trustUpdateReleased = new Promise<void>((resolve) => {
      releaseTrustUpdate = resolve;
    });
    let shouldPause = false;
    const stalePool = {
      query: staleBasePool.query.bind(staleBasePool),
      connect: async (): Promise<PoolClient> => {
        const client = await staleBasePool.connect();
        const originalClientQuery = client.query.bind(client);
        return {
          query: (async (text: string, values?: readonly unknown[]) => {
            const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
            if (shouldPause && normalized.startsWith('update contacts set trust_level = $1')) {
              shouldPause = false;
              signalTrustUpdate();
              await trustUpdateReleased;
            }
            return await originalClientQuery(text, values ? [...values] : []);
          }) as typeof client.query,
          release: () => client.release(),
        } as PoolClient;
      },
    } as unknown as Pool;
    try {
      const staleStore = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool: stalePool });
      const operatorStore = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool: operatorPool });
      const contact = await staleStore.upsert({
        displayName: 'Real Postgres Explicit ABA',
        trustLevel: 'public',
      });

      shouldPause = true;
      const staleMutation = staleStore.setTrustLevel(
        contact.id,
        'regular',
        'agent:contact-tool',
        { mutationSource: 'autonomous' },
      );
      await waitForConcurrencyGate(trustUpdateReached, 'stale explicit trust update');
      await expect(operatorStore.setTrustLevel(
        contact.id,
        'trusted',
        'operator:postgres-aba',
        { mutationSource: 'manual' },
      )).resolves.toBe(true);
      await expect(operatorStore.setTrustLevel(
        contact.id,
        'public',
        'operator:postgres-aba',
        { mutationSource: 'manual' },
      )).resolves.toBe(true);
      releaseTrustUpdate();

      await expect(staleMutation).resolves.toBe(false);
      await expect(staleStore.getById(contact.id)).resolves.toMatchObject({ trustLevel: 'public' });
      await expect(staleStore.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([
        expect.objectContaining({ oldValue: 'trusted', newValue: 'public', actor: 'operator:postgres-aba' }),
        expect.objectContaining({ oldValue: 'public', newValue: 'trusted', actor: 'operator:postgres-aba' }),
      ]);
    } finally {
      releaseTrustUpdate();
      await Promise.all([staleBasePool.end(), operatorPool.end()]);
    }
  }, TIMEOUT_MS);

  it('rolls back a generic trust CAS when the real audit insert fails', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: APPLICATION_NAME,
      allowExitOnIdle: true,
      max: 8,
    });
    try {
      const store = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool });
      const contact = await store.upsert({
        displayName: 'Real Generic Audit Rollback',
        trustLevel: 'regular',
      });
      await installSelectedTrustAuditFailure(pool);

      await expect(store.upsert({
        id: contact.id,
        displayName: contact.displayName,
        trustLevel: 'primary',
      }, {
        actor: 'operator:postgres-audit-failure',
        mutationSource: 'manual',
        allowPrimaryTrustAssignment: true,
      })).rejects.toThrow('injected trust audit failure');

      await expect(store.getById(contact.id)).resolves.toMatchObject({ trustLevel: 'regular' });
      await expect(store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([]);

      await expect(store.upsert({
        id: contact.id,
        displayName: contact.displayName,
        trustLevel: 'primary',
      }, {
        actor: 'operator:postgres-audit-success',
        mutationSource: 'manual',
        allowPrimaryTrustAssignment: true,
      })).resolves.toMatchObject({ trustLevel: 'primary' });
      await expect(store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([
        expect.objectContaining({
          actor: 'operator:postgres-audit-success:primary_allowed',
          oldValue: 'regular',
          newValue: 'primary',
        }),
      ]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('rolls back an explicit trust CAS when the real audit insert fails', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: APPLICATION_NAME,
      allowExitOnIdle: true,
      max: 8,
    });
    try {
      const store = await createPostgresContactStore(databaseUrl, 'primary-user-123', { pool });
      const contact = await store.upsert({
        displayName: 'Real Explicit Audit Rollback',
        trustLevel: 'regular',
      });
      await installSelectedTrustAuditFailure(pool);

      await expect(store.setTrustLevel(
        contact.id,
        'primary',
        'operator:postgres-audit-failure',
        { mutationSource: 'manual', allowPrimaryTrustAssignment: true },
      )).rejects.toThrow('injected trust audit failure');

      await expect(store.getById(contact.id)).resolves.toMatchObject({ trustLevel: 'regular' });
      await expect(store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([]);

      await expect(store.setTrustLevel(
        contact.id,
        'primary',
        'operator:postgres-audit-success',
        { mutationSource: 'manual', allowPrimaryTrustAssignment: true },
      )).resolves.toBe(true);
      await expect(store.listMutationAuditEntries({
        contactId: contact.id,
        field: 'trust_level',
      })).resolves.toEqual([
        expect.objectContaining({
          actor: 'operator:postgres-audit-success:primary_allowed',
          oldValue: 'regular',
          newValue: 'primary',
        }),
      ]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

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
        'UPDATE contacts SET trust_level = $1, trust_version = trust_version + 1 WHERE id = $2',
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
