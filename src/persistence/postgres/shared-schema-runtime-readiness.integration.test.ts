// ── Live-database integration tests for shared-schema runtime readiness ──
//
// Regression coverage for the opl1.2 fail-closed boundary (the CI blindspot
// that let three shared stores run lazy DDL under a companion credential that
// LACKS CREATE on the shared schema). These tests exercise the shared stores'
// `connect()` under a DML-only companion role — USAGE + SELECT/INSERT/UPDATE/
// DELETE, no CREATE, mirroring the least-privilege posture the fleet-auth access
// contracts apply in production — so that:
//   (a) a store connects and performs a basic operation against a gateway-
//       bootstrapped shared schema, and
//   (b) a store fails closed with a READINESS error (never a CREATE attempt)
//       when the gateway migration authority has not provisioned the schema.
//
// A store that still ran `ensureSharedSchema` in connect would either throw the
// runtime-authority assertion (schema owner mismatch) or attempt DDL and hit
// "permission denied" — both of which these tests refute.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SocialPotConfig } from '../../core/agent/fatigue/social-pot.js';
import { createPostgresPool, withPostgresClient } from '../postgres.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import { POSTGRES_SHARED_MIGRATIONS } from './migrations.js';
import { PostgresSocialPotStore } from './social-pot-store.js';
import { PostgresSpeakingArbiterStore } from './speaking-arbiter-store.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// The base shared chain (presence, ICP control plane, social pot, speaking
// arbiter) needs no pgvector; the plain postgres image is fast.
const TEST_IMAGE = 'postgres:16-alpine';
const INTEGRATION_TIMEOUT_MS = 120_000;

const COMPANION_ROLE = 'shared_runtime_companion';
const COMPANION_PASSWORD = 'companion-dml-only';
const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHANNEL = 'discord:guild-1:room-general';

const TICK_MS = 60 * 60_000;
const SOCIAL_POT_CONFIG: SocialPotConfig = {
  capUnits: 24,
  regenerationTickMs: TICK_MS,
  regenerationUnitsPerTick: 1,
};

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function companionUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = COMPANION_ROLE;
  url.password = COMPANION_PASSWORD;
  return url.toString();
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
  // One cluster-wide login role reused by every test database. It receives NO
  // CREATE anywhere; per-database DML grants are applied after provisioning.
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `CREATE ROLE ${quoteIdentifier(COMPANION_ROLE)} LOGIN NOINHERIT `
      + `CONNECTION LIMIT 8 PASSWORD '${COMPANION_PASSWORD}'`,
    );
  } finally {
    await admin.end();
  }
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

/**
 * Provision a fresh database exactly as the gateway would (shared schema owned
 * by a privileged migration authority — here the superuser), then hand the
 * companion role a strictly DML-only grant on the shared schema: USAGE plus
 * SELECT/INSERT/UPDATE/DELETE, and pointedly NO CREATE.
 */
async function bootstrappedDmlOnlyDatabase(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  await bootstrapSharedSchema(database.databaseUrl);
  const owner = createPostgresPool(database.databaseUrl, { max: 1 });
  try {
    await owner.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} `
      + `TO ${quoteIdentifier(COMPANION_ROLE)}`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA shared TO ${quoteIdentifier(COMPANION_ROLE)}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA shared `
      + `TO ${quoteIdentifier(COMPANION_ROLE)}`,
    );
    await owner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA shared `
      + `TO ${quoteIdentifier(COMPANION_ROLE)}`,
    );
  } finally {
    await owner.end();
  }
  return companionUrl(database.databaseUrl);
}

/**
 * A fresh database where the gateway migration authority has NOT run: no shared
 * schema, no ledger. The companion role can connect but holds no CREATE, so any
 * attempt to provision DDL from a store would be "permission denied".
 */
async function unprovisionedDmlOnlyDatabase(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  const database = await harness.createDatabase();
  const owner = createPostgresPool(database.databaseUrl, { max: 1 });
  try {
    await owner.query(
      `GRANT CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} `
      + `TO ${quoteIdentifier(COMPANION_ROLE)}`,
    );
  } finally {
    await owner.end();
  }
  return companionUrl(database.databaseUrl);
}

describe('shared-schema runtime readiness under a DML-only companion role', () => {
  it(
    'keeps existing operator-test episodes valid across the idempotent migration chain',
    async () => {
      if (!harness) throw new Error('Postgres integration harness is not available');
      const { databaseUrl } = await harness.createDatabase();
      const owner = createPostgresPool(databaseUrl, { max: 1 });
      try {
        await withPostgresClient(owner, async (client) => {
          await client.query('CREATE SCHEMA shared');
          await client.query('SET search_path TO shared, public');
          for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(0, 44)) {
            await client.query(statement);
          }
          await client.query(`
            INSERT INTO icp_conversation_episodes (
              conversation_id, channel_id, participant_companion_ids,
              root_initiation_id, initiated_by_companion_id, initiation_source,
              provenance_ref, opened_at_ms, last_activity_at_ms, status, revision
            ) VALUES (
              '22222222-2222-4222-8222-222222222222',
              'companion-dm:operator-test', ARRAY[$1::uuid, $2::uuid],
              '33333333-3333-4333-8333-333333333333', $1::uuid, 'operator_test',
              'operator-test:restart-regression', 1, 1, 'active', 1
            )
          `, [COMPANION_A, COMPANION_B]);
          for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(44)) {
            await client.query(statement);
          }
        });
        await expect(owner.query(`
          SELECT initiation_source
          FROM shared.icp_conversation_episodes
          WHERE conversation_id = '22222222-2222-4222-8222-222222222222'
        `)).resolves.toMatchObject({ rows: [{ initiation_source: 'operator_test' }] });
      } finally {
        await owner.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'grants the companion role DML but never CREATE on the shared schema',
    async () => {
      const runtimeUrl = await bootstrappedDmlOnlyDatabase();
      const companion = createPostgresPool(runtimeUrl, { max: 1, schema: 'shared' });
      try {
        // Baseline DML is allowed against a gateway-provisioned table.
        await expect(companion.query('SELECT version FROM shared_schema_migrations LIMIT 1'))
          .resolves.toBeDefined();
        // DDL is fail-closed: the credential mirrors production least privilege.
        await expect(companion.query('CREATE TABLE shared.dml_only_probe (id integer)'))
          .rejects.toThrow(/permission denied/i);
      } finally {
        await companion.end();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'social pot store connects and operates against a gateway-bootstrapped schema',
    async () => {
      const runtimeUrl = await bootstrappedDmlOnlyDatabase();
      const store = await PostgresSocialPotStore.connect(runtimeUrl);
      try {
        const snapshot = await store.readPot({
          companionId: COMPANION_A,
          nowMs: TICK_MS,
          config: SOCIAL_POT_CONFIG,
        });
        expect(snapshot.balance).toBe(SOCIAL_POT_CONFIG.capUnits);
        expect(snapshot.revision).toBe(1);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'speaking arbiter store connects and operates against a gateway-bootstrapped schema',
    async () => {
      const runtimeUrl = await bootstrappedDmlOnlyDatabase();
      const store = await PostgresSpeakingArbiterStore.connect(runtimeUrl);
      try {
        const episode = await store.ensureRoomEpisode({ channelId: CHANNEL, nowMs: TICK_MS });
        expect(episode.status).toBe('open');
        expect(episode.channelId).toBe(CHANNEL);
      } finally {
        await store.close();
      }
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'social pot store fails closed with a readiness error (never a CREATE attempt) when unprovisioned',
    async () => {
      const runtimeUrl = await unprovisionedDmlOnlyDatabase();
      await expect(PostgresSocialPotStore.connect(runtimeUrl))
        .rejects.toThrow(/gateway shared-schema migration authority has not run/i);
      // A store that still attempted DDL would have hit "permission denied"
      // (the role lacks CREATE) — prove it never tried.
      await expect(PostgresSocialPotStore.connect(runtimeUrl))
        .rejects.not.toThrow(/permission denied/i);
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'speaking arbiter store fails closed with a readiness error (never a CREATE attempt) when unprovisioned',
    async () => {
      const runtimeUrl = await unprovisionedDmlOnlyDatabase();
      await expect(PostgresSpeakingArbiterStore.connect(runtimeUrl))
        .rejects.toThrow(/gateway shared-schema migration authority has not run/i);
      await expect(PostgresSpeakingArbiterStore.connect(runtimeUrl))
        .rejects.not.toThrow(/permission denied/i);
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
