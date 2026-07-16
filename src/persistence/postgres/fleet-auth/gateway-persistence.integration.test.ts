import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStaticCredentialVault } from '../../../boundary/custody/credential-vault.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import {
  initializeGatewayFleetAuthPersistence,
  reconcileFleetAuthAuthorityState,
  type GatewayFleetAuthPersistence,
} from './gateway-persistence.js';
import { FleetAuthLifecycleWitnessStore } from './lifecycle-witness.js';

const TIMEOUT_MS = 120_000;
const ROLES = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
} as const;
const PASSWORDS = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
} as const;
const keyPair = generateKeyPairSync('ed25519');
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

interface GatewayTestContext {
  databaseName: string;
  runtimeUrl: string;
  config: FleetAuthConfig;
  credentialVault: ReturnType<typeof createStaticCredentialVault>;
  systemDataDir: string;
  authorityFloorRoot: string;
  protectedRestoreRoots: string[];
}

let harness: PostgresTestHarness | null = null;
const roots: string[] = [];

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
}

function credential(envName: string) {
  return { kind: 'env' as const, envName };
}

function config(): FleetAuthConfig {
  return {
    schemaVersion: 1,
    activationGeneration: 1,
    canonicalOrigin: 'https://fleet.example.test',
    callbackPath: '/auth/discord/callback',
    provider: {
      kind: 'discord',
      clientId: '123456789012345678',
      scopes: ['identify'],
      clientSecretRef: credential('FLEET_AUTH_DISCORD_CLIENT_SECRET'),
      tokenCustody: 'discard',
    },
    credentials: {
      tokenEncryptionKeyRef: credential('FLEET_AUTH_TOKEN_ENCRYPTION_KEY'),
      sessionPepperRef: credential('FLEET_AUTH_SESSION_PEPPER'),
      assertionPrivateKeyRef: credential('FLEET_AUTH_ASSERTION_PRIVATE_KEY'),
      trustedHostRecoveryCredentialRef: credential('FLEET_AUTH_RECOVERY_CREDENTIAL'),
      runtimeDatabaseUrlRef: credential('FLEET_AUTH_RUNTIME_DATABASE_URL'),
      migrationDatabaseUrlRef: credential('FLEET_AUTH_MIGRATION_DATABASE_URL'),
      backupRestoreDatabaseUrlRef: credential('FLEET_AUTH_BACKUP_DATABASE_URL'),
      authorityFloorRootRef: credential('FLEET_AUTH_AUTHORITY_FLOOR_ROOT'),
    },
    databaseRoles: ROLES,
    verifierKeys: [{
      issuer: 'psfn-fleet-auth',
      kid: 'gateway-startup-test',
      publicKeyPem,
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2099-01-01T00:00:00.000Z',
      status: 'active',
    }],
    ttls: {
      oauthTransactionMs: 300_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 300_000,
      jitGrantMs: 300_000,
      stepUpChallengeMs: 180_000,
      internalAssertionMs: 30_000,
    },
    rolePolicy: {
      disabledActionsByRole: {
        owner: [],
        admin: ['roles.manage'],
        member: ['settings.write', 'roles.manage'],
        guest: ['garden.read', 'settings.read', 'settings.write', 'roles.manage'],
      },
    },
    discordEvidenceMappings: [],
  };
}

async function freshContext(): Promise<GatewayTestContext> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} TO ${quoteIdentifier(ROLES.migration)}`,
    );
  } finally {
    await admin.end();
  }

  const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-gateway-startup-'));
  roots.push(root);
  const systemDataDir = join(root, 'system');
  const authorityFloorRoot = join(root, 'authority');
  const protectedRestoreRoots = ['companion', 'workspace', 'backups'].map(name => join(root, name));
  for (const path of [systemDataDir, authorityFloorRoot, ...protectedRestoreRoots]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const runtimeUrl = roleUrl(database.databaseUrl, ROLES.runtime);
  const migrationUrl = roleUrl(database.databaseUrl, ROLES.migration);
  const backupUrl = roleUrl(database.databaseUrl, ROLES.backupRestore);
  return {
    databaseName: database.databaseName,
    runtimeUrl,
    config: config(),
    credentialVault: createStaticCredentialVault({
      FLEET_AUTH_DISCORD_CLIENT_SECRET: 'discord-client-secret',
      FLEET_AUTH_TOKEN_ENCRYPTION_KEY: 't'.repeat(32),
      FLEET_AUTH_SESSION_PEPPER: 's'.repeat(32),
      FLEET_AUTH_ASSERTION_PRIVATE_KEY: privateKeyPem,
      FLEET_AUTH_RECOVERY_CREDENTIAL: 'r'.repeat(32),
      FLEET_AUTH_RUNTIME_DATABASE_URL: runtimeUrl,
      FLEET_AUTH_MIGRATION_DATABASE_URL: migrationUrl,
      FLEET_AUTH_BACKUP_DATABASE_URL: backupUrl,
      FLEET_AUTH_AUTHORITY_FLOOR_ROOT: authorityFloorRoot,
    }),
    systemDataDir,
    authorityFloorRoot,
    protectedRestoreRoots,
  };
}

async function startEnabled(context: GatewayTestContext): Promise<GatewayFleetAuthPersistence> {
  const persistence = await initializeGatewayFleetAuthPersistence({
    config: context.config,
    credentialVault: context.credentialVault,
    protectedRestoreRoots: context.protectedRestoreRoots,
    lifecycleWitnessRoot: context.systemDataDir,
  });
  if (!persistence) throw new Error('Enabled fleet auth returned no persistence runtime');
  return persistence;
}

async function seedSession(
  context: GatewayTestContext,
  globalAuthEpoch: number,
  principalId = randomUUID(),
): Promise<string> {
  const pool = createPostgresPool(context.runtimeUrl, { max: 1 });
  const sessionId = randomUUID();
  try {
    await pool.query(`
      INSERT INTO fleet_auth.human_principals
        (principal_id, status, authority_generation)
      VALUES ($1, 'active', 1)
      ON CONFLICT (principal_id) DO NOTHING
    `, [principalId]);
    await pool.query(`
      INSERT INTO fleet_auth.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
         authn_version, authz_version, global_auth_epoch, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, $3, $4, 'garden', 'oauth', 1, 1, $5,
              clock_timestamp() + interval '5 minutes', clock_timestamp() + interval '1 hour')
    `, [
      sessionId,
      createHash('sha256').update(`token:${sessionId}`).digest('hex'),
      createHash('sha256').update(`csrf:${sessionId}`).digest('hex'),
      principalId,
      globalAuthEpoch,
    ]);
  } finally {
    await pool.end();
  }
  return principalId;
}

async function sessionCount(context: GatewayTestContext): Promise<number> {
  const pool = createPostgresPool(context.runtimeUrl, { max: 1 });
  try {
    const result = await pool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM fleet_auth.browser_sessions',
    );
    return Number(result.rows[0]?.count ?? '-1');
  } finally {
    await pool.end();
  }
}

async function authorityState(context: GatewayTestContext): Promise<{
  authorityGeneration: number;
  globalAuthEpoch: number;
  restoreCheckpoint: number;
}> {
  const pool = createPostgresPool(context.runtimeUrl, { max: 1 });
  try {
    const result = await pool.query<{
      authority_generation: string;
      global_auth_epoch: string;
      restore_checkpoint: string;
    }>(`
      SELECT authority_generation, global_auth_epoch, restore_checkpoint
      FROM fleet_auth.authority_state
      WHERE singleton = TRUE
    `);
    const row = result.rows[0]!;
    return {
      authorityGeneration: Number(row.authority_generation),
      globalAuthEpoch: Number(row.global_auth_epoch),
      restoreCheckpoint: Number(row.restore_checkpoint),
    };
  } finally {
    await pool.end();
  }
}

async function waitForBlockedBroker(
  context: GatewayTestContext,
  expectedCount = 1,
): Promise<void> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await admin.query<{ waiting: number }>(`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = 'fleet-auth-authority-reconciliation'
          AND wait_event_type = 'Lock'
      `, [context.databaseName]);
      if ((result.rows[0]?.waiting ?? 0) >= expectedCount) return;
      await delay(10);
    }
  } finally {
    await admin.end();
  }
  throw new Error('Timed out waiting for fleet-auth broker reconciliation lock');
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

describe('gateway fleet-auth lifecycle publication', () => {
  it('keeps sessions across simultaneous ordinary enabled restarts', async () => {
    const context = await freshContext();
    const initial = await startEnabled(context);
    await initial.close();
    await seedSession(context, 1);

    const starts = await Promise.allSettled([startEnabled(context), startEnabled(context)]);
    try {
      expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(2);
      expect(await sessionCount(context)).toBe(1);
      expect(await authorityState(context)).toEqual({
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        restoreCheckpoint: 0,
      });
    } finally {
      await Promise.all(starts.map(async result => {
        if (result.status === 'fulfilled') await result.value.close();
      }));
    }
  }, TIMEOUT_MS);

  it('shares one recovery transition when replicas find a floor without a witness', async () => {
    const context = await freshContext();
    const initial = await startEnabled(context);
    await initial.close();
    await seedSession(context, 1);
    const witness = new FleetAuthLifecycleWitnessStore(context.systemDataDir);
    rmSync(witness.path);

    const blockerPool = createPostgresPool(
      roleUrl(context.runtimeUrl, ROLES.backupRestore),
      {
        applicationName: 'fleet-auth-lifecycle-test-blocker',
        max: 1,
      },
    );
    const blocker = await blockerPool.connect();
    let released = false;
    let starts: PromiseSettledResult<GatewayFleetAuthPersistence>[] = [];
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM fleet_auth.authority_state WHERE singleton = TRUE FOR UPDATE');
    const firstStart = startEnabled(context);
    try {
      await waitForBlockedBroker(context);
      const secondStart = startEnabled(context);
      await waitForBlockedBroker(context, 2);
      await blocker.query('COMMIT');
      released = true;

      starts = await Promise.allSettled([firstStart, secondStart]);
      expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(2);
      expect(await sessionCount(context)).toBe(0);
      expect(await authorityState(context)).toEqual({
        authorityGeneration: 2,
        globalAuthEpoch: 2,
        restoreCheckpoint: 1,
      });
      expect(starts[0]?.status).toBe('fulfilled');
      if (starts[0]?.status === 'fulfilled') {
        expect(starts[0].value.authorityFloors.read().trustedHost).toMatchObject({
          authorityGeneration: 2,
          restoreCheckpoint: 1,
          lastLifecycleTransitionId: expect.stringMatching(/^[0-9a-f]{64}$/),
        });
      }
    } finally {
      if (!released) await blocker.query('ROLLBACK').catch(() => undefined);
      await Promise.all(starts.map(async result => {
        if (result.status === 'fulfilled') await result.value.close();
      }));
      blocker.release();
      await blockerPool.end();
    }

    const retry = await startEnabled(context);
    await retry.close();
    expect(await authorityState(context)).toEqual({
      authorityGeneration: 2,
      globalAuthEpoch: 2,
      restoreCheckpoint: 1,
    });
  }, TIMEOUT_MS);

  it('lets disabled beat a stale startup and fences ephemerals on the next retry', async () => {
    const context = await freshContext();
    const initial = await startEnabled(context);
    await initial.close();
    await seedSession(context, 1);

    const blockerPool = createPostgresPool(
      roleUrl(context.runtimeUrl, ROLES.backupRestore),
      {
        applicationName: 'fleet-auth-lifecycle-test-blocker',
        max: 1,
      },
    );
    const blocker = await blockerPool.connect();
    let released = false;
    await blocker.query('BEGIN');
    await blocker.query('SELECT * FROM fleet_auth.authority_state WHERE singleton = TRUE FOR UPDATE');
    const staleOutcome = startEnabled(context).then(
      value => ({ status: 'fulfilled' as const, value }),
      error => ({ status: 'rejected' as const, error }),
    );
    try {
      await waitForBlockedBroker(context);
      const disabled = await initializeGatewayFleetAuthPersistence({
        protectedRestoreRoots: context.protectedRestoreRoots,
        lifecycleWitnessRoot: context.systemDataDir,
      });
      expect(disabled).toBeUndefined();
      await blocker.query('COMMIT');
      released = true;

      const stale = await staleOutcome;
      expect(stale.status).toBe('rejected');
      if (stale.status === 'fulfilled') {
        await stale.value.close();
        throw new Error('Stale enabled startup unexpectedly succeeded');
      }
      expect(String(stale.error)).toMatch(/lifecycle witness changed during enabled startup/i);
      expect(await sessionCount(context)).toBe(1);

      const retry = await startEnabled(context);
      await retry.close();
      expect(await sessionCount(context)).toBe(0);
      expect(await authorityState(context)).toEqual({
        authorityGeneration: 2,
        globalAuthEpoch: 2,
        restoreCheckpoint: 1,
      });
    } finally {
      if (!released) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await blockerPool.end();
    }
  }, TIMEOUT_MS);

  it('recovers without losing a transition after crashes before and after DB reconciliation', async () => {
    const context = await freshContext();
    const initial = await startEnabled(context);
    const floors = initial.authorityFloors;
    await initial.close();
    const principalId = await seedSession(context, 1);
    const witness = new FleetAuthLifecycleWitnessStore(context.systemDataDir);

    witness.recordDisabledIfPresent();
    const beforeDatabase = witness.prepareEnable(floors.read().trustedHost.lineageId);
    const preparedFloor = floors.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: true,
      lifecycleTransitionId: beforeDatabase.lifecycleTransitionId,
    });
    expect(preparedFloor.trustedHost.restoreCheckpoint).toBe(1);
    // Simulated crash: the floor is durable, while DB reconciliation and witness
    // publication have not happened. Startup must retry the same transition.
    const floorRetry = await startEnabled(context);
    await floorRetry.close();
    expect(await sessionCount(context)).toBe(0);
    expect(await authorityState(context)).toEqual({
      authorityGeneration: 2,
      globalAuthEpoch: 2,
      restoreCheckpoint: 1,
    });

    await seedSession(context, 2, principalId);
    witness.recordDisabledIfPresent();
    const afterDatabase = witness.prepareEnable(floors.read().trustedHost.lineageId);
    const reconciledFloor = floors.open({
      activationGeneration: 1,
      databaseHasDurableAuthority: true,
      lifecycleTransitionId: afterDatabase.lifecycleTransitionId,
    });
    const coordinator = createPostgresPool(
      roleUrl(context.runtimeUrl, ROLES.backupRestore),
      { max: 1 },
    );
    try {
      await reconcileFleetAuthAuthorityState(coordinator, reconciledFloor, randomUUID());
    } finally {
      await coordinator.end();
    }
    // Simulated crash: floor and DB are fenced, but the witness is still
    // disabled. Retry must publish without advancing the transition again.
    const databaseRetry = await startEnabled(context);
    await databaseRetry.close();
    expect(await sessionCount(context)).toBe(0);
    expect(await authorityState(context)).toEqual({
      authorityGeneration: 3,
      globalAuthEpoch: 3,
      restoreCheckpoint: 2,
    });
  }, TIMEOUT_MS);
});
