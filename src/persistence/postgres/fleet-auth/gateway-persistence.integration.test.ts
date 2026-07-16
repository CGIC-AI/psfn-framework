import { createHash, createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
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
import {
  GatewayHubDeviceIngressService,
  InMemoryHubDeviceSessionAdmissionStore,
} from '../../../boundary/fleet-auth/hub-device-ingress.js';

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
const hubKeyPair = generateKeyPairSync('ed25519');
const hubPublicKeyPem = hubKeyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KNOWN_COMPANION_ID = '7f87ee85-9fcc-4520-91a8-b728293eca76';

interface GatewayTestContext {
  databaseName: string;
  runtimeUrl: string;
  migrationUrl: string;
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
    hubDeviceAssertions: {
      issuer: 'psfn-satellite-hub',
      audience: 'https://fleet.example.test',
      maxTtlSeconds: 60,
      clockSkewSeconds: 2,
      keys: [{
        kid: 'hub-gateway-startup-test',
        publicKeyPem: hubPublicKeyPem,
        notBefore: '2026-01-01T00:00:00.000Z',
        notAfter: '2099-01-01T00:00:00.000Z',
        status: 'active',
      }],
    },
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

function hubDeviceAssertionToken(input: {
  companionId: string;
  sessionId: string;
  jti: string;
  placeId?: string;
  expiresInSeconds?: number;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(JSON.stringify({
    alg: 'EdDSA',
    typ: 'PSFN-HUB-DEVICE',
    v: 1,
    kid: 'hub-gateway-startup-test',
  })).toString('base64url');
  const encodedClaims = Buffer.from(JSON.stringify({
    iss: 'psfn-satellite-hub',
    device_id: 'office-device',
    enrollment_version: 7,
    enrollment_assurance: 'device_credential',
    place_id: input.placeId ?? 'office',
    aud: 'https://fleet.example.test',
    companion_id: input.companionId,
    session_id: input.sessionId,
    iat: nowSeconds - 1,
    exp: nowSeconds + (input.expiresInSeconds ?? 30),
    jti: input.jti,
  })).toString('base64url');
  const signature = sign(
    null,
    Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii'),
    hubKeyPair.privateKey,
  ).toString('base64url');
  return `${encodedHeader}.${encodedClaims}.${signature}`;
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
    migrationUrl,
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
    knownCompanionIds: [KNOWN_COMPANION_ID],
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
      INSERT INTO fleet_auth.provider_subjects
        (provider, subject_id, principal_id, state, authority_generation)
      VALUES ('discord', '123456789012345678', $1, 'active', 1)
      ON CONFLICT (provider, subject_id) DO NOTHING
    `, [principalId]);
    await pool.query(`
      INSERT INTO fleet_auth.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
         authn_version, authz_version, provider, provider_subject_id,
         global_auth_epoch, idle_expires_at, absolute_expires_at)
      VALUES ($1, $2, $3, $4, 'garden', 'oauth', 1, 1,
              'discord', '123456789012345678', $5,
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

async function seedAttachableHuman(
  context: GatewayTestContext,
  input: { token: string; subjectId: string; companionId?: string },
): Promise<{ principalId: string; sessionId: string }> {
  const companionId = input.companionId ?? KNOWN_COMPANION_ID;
  const migration = createPostgresPool(context.migrationUrl, { max: 1 });
  const runtime = createPostgresPool(context.runtimeUrl, { max: 1 });
  const principalId = randomUUID();
  const sessionId = randomUUID();
  try {
    await migration.query(`
      INSERT INTO fleet_auth.companion_authority_state
        (companion_id, lifecycle, version, authority_generation, restore_state)
      VALUES ($1, 'active', 1, 1, 'live')
      ON CONFLICT (companion_id) DO NOTHING
    `, [companionId]);
    await runtime.query('BEGIN');
    await runtime.query(`
      INSERT INTO fleet_auth.human_principals
        (principal_id, status, authn_version, authz_version, binding_version,
         grant_version, policy_version, authority_generation, restore_state)
      VALUES ($1, 'active', 1, 1, 1, 1, 1, 1, 'live')
    `, [principalId]);
    await runtime.query(`
      INSERT INTO fleet_auth.provider_subjects
        (provider, subject_id, principal_id, state, authority_generation, restore_state)
      VALUES ('discord', $2, $1, 'active', 1, 'live')
    `, [principalId, input.subjectId]);
    await runtime.query(`
      INSERT INTO fleet_auth.principal_contact_bindings
        (binding_id, principal_id, companion_id, contact_id, state,
         verification_provenance, version, authority_generation, restore_state)
      VALUES ($1, $2, $3, $4, 'active', '{"source":"attachment_test"}'::jsonb, 1, 1, 'live')
    `, [randomUUID(), principalId, companionId, `contact/${input.subjectId}`]);
    await runtime.query(`
      INSERT INTO fleet_auth.principal_role_grants
        (grant_id, principal_id, companion_id, role, lifecycle,
         version, authority_generation, restore_state)
      VALUES ($1, $2, $3, 'member', 'active', 1, 1, 'live')
    `, [randomUUID(), principalId, companionId]);
    await runtime.query(`
      INSERT INTO fleet_auth.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, provider, provider_subject_id,
         audience, assurance, authn_version, authz_version, binding_version, grant_version,
         policy_version, global_auth_epoch, idle_expires_at, absolute_expires_at, created_at)
      VALUES ($1, $2, $3, $4, 'discord', $5, 'fleet', 'oauth', 1, 1, 1, 1, 1, 1,
              clock_timestamp() + interval '5 minutes',
              clock_timestamp() + interval '1 hour', clock_timestamp())
    `, [
      sessionId,
      createHmac('sha256', 's'.repeat(32)).update(input.token).digest('hex'),
      createHash('sha256').update(`csrf:${sessionId}`).digest('hex'),
      principalId,
      input.subjectId,
    ]);
    await runtime.query('COMMIT');
    return { principalId, sessionId };
  } catch (error) {
    await runtime.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await Promise.all([migration.end(), runtime.end()]);
  }
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
          AND application_name = 'fleet-auth-authority-coordinator'
          AND wait_event_type = 'Lock'
      `, [context.databaseName]);
      if ((result.rows[0]?.waiting ?? 0) >= expectedCount) return;
      await delay(10);
    }
  } finally {
    await admin.end();
  }
  throw new Error('Timed out waiting for fleet-auth authority coordinator lock');
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
  it('composes authorization resolution only for enabled fleet auth', async () => {
    const context = await freshContext();
    const enabled = await startEnabled(context);
    try {
      await expect(enabled.broker.resolveAuthorizationContext({
        sessionToken: 'S'.repeat(43),
        audience: 'fleet',
        companionId: KNOWN_COMPANION_ID,
        action: 'memory.read.self',
      })).rejects.toMatchObject({ code: 'session_absent' });
    } finally {
      await enabled.close();
    }

    const disabled = await initializeGatewayFleetAuthPersistence({
      knownCompanionIds: [],
      protectedRestoreRoots: context.protectedRestoreRoots,
      lifecycleWitnessRoot: context.systemDataDir,
    });
    expect(disabled).toBeUndefined();
  }, TIMEOUT_MS);

  it('starts Discord evidence authority only when validated mappings enable it', async () => {
    const context = await freshContext();
    const featureOff = await startEnabled(context);
    expect(featureOff.discordEvidence).toBeUndefined();
    expect(featureOff.discordEvidenceLifecycle).toBeUndefined();
    await featureOff.close();

    context.config.provider.scopes = ['identify', 'guilds', 'guilds.members.read'];
    context.config.discordEvidenceMappings = [{
      guildId: '123456789012345678',
      channelId: '223456789012345678',
      companionId: randomUUID(),
      requiredRoleIds: [],
    }];
    const featureOn = await startEnabled(context);
    try {
      expect(featureOn.discordEvidence).toBeDefined();
      expect(featureOn.discordEvidenceLifecycle).toBeDefined();
    } finally {
      await featureOn.close();
    }
  }, TIMEOUT_MS);

  it('binds Hub assertion replay to the session and durably audits sanitized mutation denial', async () => {
    const context = await freshContext();
    const persistence = await startEnabled(context);
    const auditPool = createPostgresPool(context.runtimeUrl, { max: 1 });
    const companionId = randomUUID();
    const jti = randomUUID();
    const sessionA = 'realtime:office-device:session-a';
    const assertion = hubDeviceAssertionToken({ companionId, sessionId: sessionA, jti });
    const expected = {
      deviceId: 'office-device',
      enrollmentVersion: 7,
      enrollmentStatus: 'active' as const,
      companionId,
      placeId: 'office',
    };
    try {
      await expect(persistence.verifyAndConsumeHubDeviceAssertion(assertion, {
        ...expected,
        sessionId: 'realtime:office-device:session-b',
      })).rejects.toThrow(/session binding does not match/);

      const afterMismatch = await auditPool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count
        FROM fleet_auth.hub_device_assertion_replays
        WHERE issuer = $1 AND jti = $2
      `, ['psfn-satellite-hub', jti]);
      expect(afterMismatch.rows[0]?.count).toBe('0');

      const first = await persistence.verifyAndConsumeHubDeviceAssertion(assertion, {
        ...expected,
        sessionId: sessionA,
      });
      await expect(persistence.verifyAndConsumeHubDeviceAssertion(assertion, {
        ...expected,
        sessionId: sessionA,
      })).resolves.toEqual(first);
      expect(first.sessionId).toBe(sessionA);

      const replay = await auditPool.query<{
        replay_count: string;
        mismatch_count: string;
      }>(`
        SELECT replay_count, mismatch_count
        FROM fleet_auth.hub_device_assertion_replays
        WHERE issuer = $1 AND jti = $2
      `, ['psfn-satellite-hub', jti]);
      expect(replay.rows).toEqual([{
        replay_count: '1',
        mismatch_count: '0',
      }]);

      const mutatedAssertion = hubDeviceAssertionToken({
        companionId,
        sessionId: sessionA,
        jti,
        expiresInSeconds: 29,
      });
      await expect(persistence.verifyAndConsumeHubDeviceAssertion(mutatedAssertion, {
        ...expected,
        sessionId: sessionA,
      })).rejects.toThrow(/mutated replay/i);
      const mutatedAudit = await auditPool.query<{
        actor_context: Record<string, unknown>;
        decision: string;
        decision_context: Record<string, unknown>;
      }>(`
        SELECT actor_context, decision, decision_context
        FROM fleet_auth.authorization_audit_events
        WHERE action = 'hub_device_assertion.verify'
          AND reason_code = 'mutated_replay'
      `);
      expect(mutatedAudit.rows).toEqual([{
        actor_context: { kind: 'hub_device_assertion' },
        decision: 'deny',
        decision_context: expect.objectContaining({
          schemaVersion: 1,
          jtiDigest: createHash('sha256').update(jti).digest('hex'),
          acceptedAssertionDigest: createHash('sha256').update(assertion).digest('hex'),
          mutatedAssertionDigest: createHash('sha256').update(mutatedAssertion).digest('hex'),
        }),
      }]);
      const serializedAudit = JSON.stringify(mutatedAudit.rows);
      expect(serializedAudit).not.toContain('office');
      expect(serializedAudit).not.toContain(sessionA);
      expect(serializedAudit).not.toContain(companionId);
      expect(serializedAudit).not.toContain('psfn-satellite-hub');
      expect(serializedAudit).not.toContain('hub-gateway-startup-test');
      expect(serializedAudit).not.toContain('https://fleet.example.test');
      expect(serializedAudit).not.toContain(assertion);
      expect(serializedAudit).not.toContain(assertion.split('.')[2]!);
      expect(serializedAudit).not.toContain(mutatedAssertion.split('.')[2]!);

      const admittedJti = randomUUID();
      const admittedAssertion = hubDeviceAssertionToken({
        companionId,
        sessionId: sessionA,
        jti: admittedJti,
      });
      const sessions = new InMemoryHubDeviceSessionAdmissionStore();
      const ingress = new GatewayHubDeviceIngressService({
        verifyAndConsume: (token, binding) => persistence.verifyAndConsumeHubDeviceAssertion(token, binding),
        enrollmentAuthority: {
          resolve: async input => input.authenticatedConnection,
        },
        attachments: {
          attach: input => persistence.attachHubDeviceHuman(input),
          fenceDevice: input => persistence.fenceHubDeviceAttachment(input),
        },
        sessions,
      });
      const connection = {
        connectionId: 'authenticated-hub-connection',
        ...expected,
        sessionId: sessionA,
      };
      const concurrent = await Promise.all([
        ingress.admit({ assertion: admittedAssertion, connection }),
        ingress.admit({ assertion: admittedAssertion, connection }),
      ]);
      expect(concurrent.map(entry => entry.sessionDisposition).sort()).toEqual(['created', 'retry']);
      expect(concurrent.map(entry => entry.attachment.disposition).sort()).toEqual(['guest_created', 'retry']);
      await expect(ingress.admit({ assertion: admittedAssertion, connection }))
        .resolves.toMatchObject({
          sessionDisposition: 'retry',
          attachment: {
            disposition: 'retry',
            deviceActor: { kind: 'hub_device' },
            actor: { kind: 'guest' },
            channel: { source: 'server', companionId },
          },
        });
      expect(sessions.size).toBe(1);
      await expect(ingress.admit({
        assertion: admittedAssertion,
        connection: { ...connection, connectionId: 'different-authenticated-connection' },
      })).rejects.toMatchObject({ code: 'device_binding_mismatch' });
      expect(sessions.size).toBe(1);
      await expect(ingress.admit({ assertion: admittedAssertion, connection }))
        .rejects.toMatchObject({ code: 'device_fenced' });
      const attachmentLedger = await auditPool.query<{
        assertion_digest: string;
        device_state: string;
        human_state: string;
        retry_count: string;
      }>(`
        SELECT assertion_digest, device_state, human_state, retry_count
        FROM fleet_auth.hub_device_human_attachments
        WHERE assertion_jti = $1
      `, [admittedJti]);
      expect(attachmentLedger.rows).toEqual([{
        assertion_digest: createHash('sha256').update(admittedAssertion).digest('hex'),
        device_state: 'fenced',
        human_state: 'detached',
        retry_count: '2',
      }]);
      const attachmentAudit = await auditPool.query<{
        actor_context: Record<string, unknown>;
        resource: string;
      }>(`
        SELECT actor_context, resource
        FROM fleet_auth.authorization_audit_events
        WHERE action LIKE 'hub_device_human.%'
      `);
      expect(attachmentAudit.rows.length).toBeGreaterThanOrEqual(5);
      const serializedAttachmentAudit = JSON.stringify(attachmentAudit.rows);
      expect(serializedAttachmentAudit).not.toContain('office-device');
      expect(serializedAttachmentAudit).not.toContain(sessionA);
      expect(serializedAttachmentAudit).not.toContain(companionId);
      expect(serializedAttachmentAudit).not.toContain('authenticated-hub-connection');
      expect(serializedAttachmentAudit).not.toContain(admittedAssertion);
      const admissionReplay = await auditPool.query<{ replay_count: string }>(`
        SELECT replay_count
        FROM fleet_auth.hub_device_assertion_replays
        WHERE issuer = $1 AND jti = $2
      `, ['psfn-satellite-hub', admittedJti]);
      expect(admissionReplay.rows).toEqual([{ replay_count: '4' }]);
    } finally {
      await auditPool.end();
      await persistence.close();
    }
  }, TIMEOUT_MS);

  it('binds a current fleet human as a sibling actor and fences human authority independently', async () => {
    const context = await freshContext();
    const persistence = await startEnabled(context);
    const auditPool = createPostgresPool(context.runtimeUrl, { max: 1 });
    const firstToken = 'A'.repeat(43);
    const secondToken = 'B'.repeat(43);
    const providerFenceToken = 'C'.repeat(43);
    const roleFenceToken = 'D'.repeat(43);
    const epochFenceToken = 'E'.repeat(43);
    const firstHuman = await seedAttachableHuman(context, {
      token: firstToken,
      subjectId: '123456789012345679',
    });
    const secondHuman = await seedAttachableHuman(context, {
      token: secondToken,
      subjectId: '123456789012345680',
    });
    const providerFenceHuman = await seedAttachableHuman(context, {
      token: providerFenceToken,
      subjectId: '123456789012345681',
    });
    const roleFenceHuman = await seedAttachableHuman(context, {
      token: roleFenceToken,
      subjectId: '123456789012345682',
    });
    const epochFenceHuman = await seedAttachableHuman(context, {
      token: epochFenceToken,
      subjectId: '123456789012345683',
    });
    const ingress = new GatewayHubDeviceIngressService({
      verifyAndConsume: (token, binding) => persistence.verifyAndConsumeHubDeviceAssertion(token, binding),
      enrollmentAuthority: { resolve: async input => input.authenticatedConnection },
      attachments: {
        attach: input => persistence.attachHubDeviceHuman(input),
        fenceDevice: input => persistence.fenceHubDeviceAttachment(input),
      },
    });
    const sessionId = 'realtime:office-device:human-session';
    const connection = {
      connectionId: 'authenticated-human-hub-connection',
      deviceId: 'office-device',
      enrollmentVersion: 7,
      enrollmentStatus: 'active' as const,
      companionId: KNOWN_COMPANION_ID,
      placeId: 'office',
      sessionId,
    };
    const assertion = hubDeviceAssertionToken({
      companionId: KNOWN_COMPANION_ID,
      sessionId,
      jti: randomUUID(),
    });
    try {
      const attached = await ingress.admit({
        assertion,
        connection,
        human: { kind: 'fleet_browser_session', sessionToken: firstToken },
      });
      expect(attached.attachment).toMatchObject({
        disposition: 'created',
        deviceActor: { kind: 'hub_device', connectionId: connection.connectionId },
        actor: {
          kind: 'human',
          principalId: firstHuman.principalId,
          companionId: KNOWN_COMPANION_ID,
          session: { recordId: firstHuman.sessionId },
        },
        channel: { source: 'server', companionId: KNOWN_COMPANION_ID },
      });
      expect(attached.attachment.deviceActor).not.toBe(attached.attachment.actor);
      expect(Object.isFrozen(attached.attachment.deviceActor)).toBe(true);
      expect(Object.isFrozen(attached.attachment.actor)).toBe(true);

      await expect(ingress.admit({
        assertion,
        connection,
        human: { kind: 'fleet_browser_session', sessionToken: firstToken },
      })).resolves.toMatchObject({ attachment: { disposition: 'retry', actor: { kind: 'human' } } });

      await expect(ingress.admit({
        assertion,
        connection,
        human: { kind: 'fleet_browser_session', sessionToken: secondToken },
      })).rejects.toMatchObject({ code: 'human_binding_mismatch' });
      const humanFence = await auditPool.query<{ device_state: string; human_state: string }>(`
        SELECT device_state, human_state
        FROM fleet_auth.hub_device_human_attachments
        WHERE assertion_jti = $1
      `, [attached.devicePrincipal.jti]);
      expect(humanFence.rows).toEqual([{ device_state: 'active', human_state: 'detached' }]);

      const logoutJti = randomUUID();
      const logoutAssertion = hubDeviceAssertionToken({
        companionId: KNOWN_COMPANION_ID,
        sessionId,
        jti: logoutJti,
      });
      const logoutConnection = { ...connection, connectionId: 'authenticated-logout-connection' };
      await ingress.admit({
        assertion: logoutAssertion,
        connection: logoutConnection,
        human: { kind: 'fleet_browser_session', sessionToken: secondToken },
      });
      await auditPool.query(`
        UPDATE fleet_auth.browser_sessions SET revoked_at = clock_timestamp()
        WHERE record_id = $1
      `, [secondHuman.sessionId]);
      await expect(ingress.admit({
        assertion: logoutAssertion,
        connection: logoutConnection,
        human: { kind: 'fleet_browser_session', sessionToken: secondToken },
      })).resolves.toMatchObject({
        attachment: {
          disposition: 'human_detached',
          deviceActor: { kind: 'hub_device' },
          actor: { kind: 'guest' },
        },
      });
      const logoutFence = await auditPool.query<{ device_state: string; human_state: string }>(`
        SELECT device_state, human_state
        FROM fleet_auth.hub_device_human_attachments
        WHERE assertion_jti = $1
      `, [logoutJti]);
      expect(logoutFence.rows).toEqual([{ device_state: 'active', human_state: 'detached' }]);

      const authorityMigration = createPostgresPool(context.migrationUrl, { max: 1 });
      const fenceCases = [
        {
          token: providerFenceToken,
          human: providerFenceHuman,
          mutate: () => auditPool.query(`
            UPDATE fleet_auth.provider_subjects SET state = 'revoked'
            WHERE principal_id = $1
          `, [providerFenceHuman.principalId]),
        },
        {
          token: roleFenceToken,
          human: roleFenceHuman,
          mutate: () => auditPool.query(`
            UPDATE fleet_auth.principal_role_grants SET lifecycle = 'revoked'
            WHERE principal_id = $1
          `, [roleFenceHuman.principalId]),
        },
        {
          token: epochFenceToken,
          human: epochFenceHuman,
          mutate: () => authorityMigration.query(`
            UPDATE fleet_auth.authority_state SET global_auth_epoch = global_auth_epoch + 1
            WHERE singleton = TRUE
          `),
        },
      ];
      try {
        for (const [index, fenceCase] of fenceCases.entries()) {
          const fenceJti = randomUUID();
          const fenceAssertion = hubDeviceAssertionToken({
            companionId: KNOWN_COMPANION_ID,
            sessionId,
            jti: fenceJti,
          });
          const fenceConnection = {
            ...connection,
            connectionId: `authenticated-authority-fence-${index}`,
          };
          await ingress.admit({
            assertion: fenceAssertion,
            connection: fenceConnection,
            human: { kind: 'fleet_browser_session', sessionToken: fenceCase.token },
          });
          await fenceCase.mutate();
          await expect(ingress.admit({
            assertion: fenceAssertion,
            connection: fenceConnection,
            human: { kind: 'fleet_browser_session', sessionToken: fenceCase.token },
          })).resolves.toMatchObject({
            attachment: {
              disposition: 'human_detached',
              deviceActor: { kind: 'hub_device' },
              actor: { kind: 'guest' },
            },
          });
          await expect(auditPool.query(`
            SELECT device_state, human_state
            FROM fleet_auth.hub_device_human_attachments
            WHERE assertion_jti = $1
          `, [fenceJti])).resolves.toMatchObject({
            rows: [{ device_state: 'active', human_state: 'detached' }],
          });
        }
      } finally {
        await authorityMigration.end();
      }

      const rawAudit = JSON.stringify((await auditPool.query(`
        SELECT actor_context, resource, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE action LIKE 'hub_device_human.%'
      `)).rows);
      expect(rawAudit).not.toContain(firstToken);
      expect(rawAudit).not.toContain(secondToken);
      expect(rawAudit).not.toContain(firstHuman.principalId);
      expect(rawAudit).not.toContain(secondHuman.principalId);
      expect(rawAudit).not.toContain(firstHuman.sessionId);
      expect(rawAudit).not.toContain(secondHuman.sessionId);
      expect(rawAudit).not.toContain(KNOWN_COMPANION_ID);
    } finally {
      await auditPool.end();
      await persistence.close();
    }
  }, TIMEOUT_MS);

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
        knownCompanionIds: [],
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
