import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresMemoryStoreFromPool } from '../../faculties/memory/postgres-store.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import { grantFleetModelUsageReadAccess } from '../../persistence/postgres/model-usage-access.js';
import { PostgresModelUsageStore } from '../../persistence/postgres/model-usage-store.js';
import { planPostgresTenantAccess, provisionPostgresTenantAccess } from '../../persistence/postgres/tenancy.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

// psfn-framework-uhc6b. `npm run memory:repair:embeddings` must run as a fleet
// follower: on the 2026-11-28 shakedown soak the dry run, run as the follower
// companion's own runtime role, stopped at "Model usage migration authority
// must be the primary/canonical companion role" before reading a row.
//
// The fixture is the fleet posture: two provisioned companion tenants, each
// login role owning its schema, the model-usage ledger owned by the primary
// and followers granted exactly ledger SELECT by the real gateway DCL step.
// The CLI runs as its own process from a seeded runtime layout, as an operator
// runs it inside the follower's pod.

const INTEGRATION_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 60_000;
const PRIMARY_SCHEMA = 'companion_repair_primary';
const FOLLOWER_SCHEMA = 'companion_repair_follower';
const PRIMARY_PASSWORD = 'repair-primary';
const FOLLOWER_PASSWORD = 'repair-follower';
const PRIMARY_COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const FOLLOWER_COMPANION_ID = '22222222-2222-4222-8222-222222222222';
// The seeded settings.json embeds with a 384-dimension local model.
const DIMS = 384;
const MISSING_IDS = ['mem-010', 'mem-020'];

let harness: PostgresTestHarness | undefined;
let adminUrl = '';
let followerUrl = '';
let primaryRole = '';
let followerRole = '';
const tempDirs: string[] = [];
const pools: Pool[] = [];

function memory(id: string, text: string): PurrMemory {
  return {
    id, text, type: 'semantic', importance: 0.8, confidence: 0.9, emotionalValence: 0,
    tags: [], sensitivity: 'personal', consentFlags: {}, salience: 0.8,
    sourceRef: 'turn:invented', sourceType: 'turn', extractedAt: 1_000, lastAccessed: 1_000, accessCount: 0,
    provenance: {},
  };
}

function vector(seed: number): Float32Array {
  return Float32Array.from({ length: DIMS }, (_unused, index) => ((index + seed) % 7) / 7);
}

function withCredential(url: string, role: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

function adminPool(): Pool {
  const pool = createPostgresPool(adminUrl, { applicationName: 'psfn-repair-fleet-admin', max: 1 });
  pools.push(pool);
  return pool;
}

/** A follower's runtime layout: the two-companion manifest and the seeded owner files. */
function seedFollowerRuntime(): NodeJS.ProcessEnv {
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'psfn-repair-fleet-'));
  tempDirs.push(runtimeRoot);
  const systemDataDir = join(runtimeRoot, 'system-data');
  const followerDataDir = join(runtimeRoot, 'companions', 'follower');
  mkdirSync(systemDataDir, { recursive: true });
  mkdirSync(join(runtimeRoot, 'companions', 'primary'), { recursive: true });
  mkdirSync(followerDataDir, { recursive: true });
  const copySeed = (dir: string, ownerFile: string): void => {
    writeFileSync(
      join(dir, ownerFile),
      readFileSync(join(process.cwd(), 'config', ownerFile.replace(/\.json$/, '.seed.json')), 'utf8'),
      'utf8',
    );
  };
  for (const ownerFile of ['settings.json', 'models.json', 'providers.json']) copySeed(systemDataDir, ownerFile);
  for (const ownerFile of ['scheduler.json', 'capability-tier.json', 'charge-policy.json']) {
    copySeed(followerDataDir, ownerFile);
  }
  writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: { kind: 'env', envName: 'SHARED_MIGRATION_URL' },
    },
    companions: [
      {
        companionId: PRIMARY_COMPANION_ID,
        companionDataDir: 'companions/primary',
        characterCardPath: 'companions/primary/companion.json',
        postgresSchema: PRIMARY_SCHEMA,
        postgresRole: primaryRole,
        postgresDatabaseUrlRef: { kind: 'env', envName: 'PRIMARY_DATABASE_URL' },
      },
      {
        companionId: FOLLOWER_COMPANION_ID,
        companionDataDir: 'companions/follower',
        characterCardPath: 'companions/follower/companion.json',
        postgresSchema: FOLLOWER_SCHEMA,
        postgresRole: followerRole,
        postgresDatabaseUrlRef: { kind: 'env', envName: 'FOLLOWER_DATABASE_URL' },
      },
    ],
  })}\n`, 'utf8');
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
    PSFN_RUNTIME_ROOT: runtimeRoot,
    SYSTEM_DATA_DIR: systemDataDir,
    COMPANION_DATA_DIR: followerDataDir,
    WORKSPACE_PATH: join(runtimeRoot, 'workspaces', 'personal', FOLLOWER_COMPANION_ID),
    CHARACTER_CARD_PATH: join(followerDataDir, 'companion.json'),
    COMPANION_ID: FOLLOWER_COMPANION_ID,
    COMPANION_PG_SCHEMA: FOLLOWER_SCHEMA,
    // The follower pod holds only its own credential.
    POSTGRES_DATABASE_URL: followerUrl,
    FOLLOWER_DATABASE_URL: followerUrl,
    CONFIG_DIR: 'config',
  };
}

function runCli(env: NodeJS.ProcessEnv, args: readonly string[]) {
  const entrypoint = fileURLToPath(new URL('./backfill-memory-embeddings.ts', import.meta.url));
  return spawnSync(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    encoding: 'utf8',
    env,
    timeout: CLI_TIMEOUT_MS,
  });
}

async function embeddingState(ids: readonly string[]) {
  const result = await adminPool().query<{ id: string; has_embedding: boolean }>(
    `SELECT id, embedding IS NOT NULL AS has_embedding FROM ${FOLLOWER_SCHEMA}.l2_memories
     WHERE id = ANY($1::text[]) ORDER BY id`,
    [ids],
  );
  return result.rows;
}

async function ledgerRowCount(): Promise<number> {
  const result = await adminPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${PRIMARY_SCHEMA}.model_usage_events`,
  );
  return Number(result.rows[0]?.count);
}

/**
 * A memory-migration index the follower agent created and an operator later
 * dropped: any migration run recreates it, so its absence shows the dry run
 * changed no schema object.
 */
const SENTINEL_INDEX = 'idx_l2_memories_admin_retention';

async function sentinelIndexExists(): Promise<boolean> {
  const result = await adminPool().query<{ present: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${FOLLOWER_SCHEMA}.${SENTINEL_INDEX}`],
  );
  return result.rows[0]?.present === true;
}

beforeAll(async () => {
  harness = await startPostgresTestHarness();
  adminUrl = (await harness.createDatabase()).databaseUrl;
  const primary = planPostgresTenantAccess({ schema: PRIMARY_SCHEMA });
  const follower = planPostgresTenantAccess({ schema: FOLLOWER_SCHEMA });
  primaryRole = primary.role;
  followerRole = follower.role;
  const admin = adminPool();
  await provisionPostgresTenantAccess(admin, { plan: primary, relocateExtensions: ['vector'] });
  await provisionPostgresTenantAccess(admin, { plan: follower });
  await admin.query(`ALTER ROLE "${primary.role}" LOGIN CONNECTION LIMIT 20 PASSWORD '${PRIMARY_PASSWORD}'`);
  await admin.query(`ALTER ROLE "${follower.role}" LOGIN CONNECTION LIMIT 20 PASSWORD '${FOLLOWER_PASSWORD}'`);
  await admin.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
  const primaryUrl = withCredential(adminUrl, primary.role, PRIMARY_PASSWORD);
  followerUrl = withCredential(adminUrl, follower.role, FOLLOWER_PASSWORD);

  // The gateway, as the primary's owner credential, migrates the fleet ledger
  // and grants followers read access to it.
  const authority = PostgresModelUsageStore.connect(primaryUrl, { fleetAggregation: true }, {
    access: 'migration_authority', schema: PRIMARY_SCHEMA, role: primary.role,
  });
  await authority.waitUntilReady();
  await grantFleetModelUsageReadAccess({
    ownerDatabaseUrl: primaryUrl,
    primarySchema: PRIMARY_SCHEMA,
    primaryRole: primary.role,
    followerRoles: [follower.role],
  });

  // The follower agent, as its own role, owns its memory corpus. Two active
  // rows lost their embedding; one keeps it.
  const followerPool = createPostgresPool(followerUrl, {
    applicationName: 'psfn-repair-fleet-follower', allowExitOnIdle: true, schema: FOLLOWER_SCHEMA,
  });
  pools.push(followerPool);
  const store = await createPostgresMemoryStoreFromPool(followerPool, DIMS);
  await store.insertMemory(memory('mem-005', 'Robin started learning the cello.'), vector(5));
  await store.insertMemory(memory('mem-010', 'Robin keeps two beehives on the roof.'), vector(10));
  await store.insertMemory(memory('mem-020', 'The choir rehearses on Thursdays.'), vector(20));
  await followerPool.query('UPDATE l2_memories SET embedding = NULL WHERE id = ANY($1::text[])', [MISSING_IDS]);
  await followerPool.query(`DROP INDEX ${SENTINEL_INDEX}`);
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  for (const pool of pools.splice(0)) await pool.end();
  await harness?.stop();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
}, INTEGRATION_TIMEOUT_MS);

describe('memory:repair:embeddings as a fleet follower (psfn-framework-uhc6b)', () => {
  it('reports the follower corpus in a dry run without opening the ledger or changing the schema', async () => {
    const ledgerBefore = await ledgerRowCount();
    expect(await sentinelIndexExists()).toBe(false);

    const result = runCli(seedFollowerRuntime(), ['--json']);

    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
    const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))) as Record<string, unknown>;
    expect(report).toMatchObject({
      dryRun: true,
      missingOnly: true,
      schema: FOLLOWER_SCHEMA,
      total: 2,
      updated: 0,
      selectedMemoryIds: MISSING_IDS,
      coverageBefore: { activeMemoryCount: 3, activeMissingEmbeddingCount: 2 },
    });
    expect((await embeddingState(MISSING_IDS)).every(row => !row.has_embedding)).toBe(true);
    expect(await ledgerRowCount()).toBe(ledgerBefore);
    expect(await sentinelIndexExists()).toBe(false);
  }, INTEGRATION_TIMEOUT_MS);

  it('refuses --apply before any embedding call, because a follower cannot book the usage', async () => {
    const ledgerBefore = await ledgerRowCount();

    const result = runCli(seedFollowerRuntime(), ['--apply', '--limit', '1']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('cannot book embedding usage');
    expect(result.stderr).toContain(FOLLOWER_COMPANION_ID);
    expect(result.stderr).not.toContain('Model usage migration authority');
    expect((await embeddingState(MISSING_IDS)).every(row => !row.has_embedding)).toBe(true);
    expect(await ledgerRowCount()).toBe(ledgerBefore);
  }, INTEGRATION_TIMEOUT_MS);
});
