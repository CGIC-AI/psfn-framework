import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FleetAuthorizationDeniedError } from '../../../boundary/gateway/fleet-authorization-context.js';
import { digestDiscordEvidenceConfig } from '../../../boundary/fleet-auth/discord-evidence-runtime.js';
import { digestDiscordEvidence } from '../../../boundary/fleet-auth/discord-evidence-types.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import {
  createPostgresFleetAuthorizationContextResolver,
} from './authorization-context.js';
import { PostgresFleetAuthorizationContextStore } from './authorization-context-store.js';
import { createPostgresFleetPortalAuthorization } from './portal-authorization-store.js';
import {
  createGatewayProviderRevocationAuthorityPort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import { migrateFleetAuthSchema, type FleetAuthDatabaseRoles } from './schema.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import type { ProviderRevocationAuthorityPort } from './oauth-session-store.js';

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_context_runtime',
  migration: 'fleet_context_migration',
  backupRestore: 'fleet_context_backup',
};
const PASSWORDS = {
  fleet_context_runtime: 'runtime-password',
  fleet_context_migration: 'migration-password',
  fleet_context_backup: 'backup-password',
} as const;
const SESSION_PEPPER = 'fleet-context-session-pepper-32-bytes';
const SESSION_TOKEN = 'S'.repeat(43);
const SUBJECT_ID = '123456789012345678';
const OTHER_SUBJECT_ID = '123456789012345679';
const COMPANION_ID = '7f87ee85-9fcc-4520-91a8-b728293eca76';
const PORTAL_COMPANION_B = '8f87ee85-9fcc-4520-91a8-b728293eca77';
const PORTAL_COMPANION_C = '9f87ee85-9fcc-4520-91a8-b728293eca78';
const CONTACT_ID = 'contact/shared-id';
const EVIDENCE_IDENTIFIER = '64a1d054-22dd-4e76-9bb3-3ac0d33c63c5';
const CORRELATION_DIGEST_DOMAIN = 'fleet-authorization:correlation:v1\0';

function digestCorrelation(value: string): string {
  return createHmac('sha256', SESSION_PEPPER)
    .update(CORRELATION_DIGEST_DOMAIN)
    .update(value)
    .digest('hex');
}

let harness: PostgresTestHarness | null = null;
const floorRoots: string[] = [];

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

function fleetConfig(): FleetAuthConfig {
  return {
    schemaVersion: 1,
    activationGeneration: 1,
    canonicalOrigin: 'https://fleet.example.test',
    callbackPath: '/auth/discord/callback',
    provider: {
      kind: 'discord',
      clientId: SUBJECT_ID,
      scopes: ['identify', 'guilds', 'guilds.members.read'],
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
    verifierKeys: [],
    hubDeviceAssertions: {
      issuer: 'fleet-gateway',
      audience: 'fleet-agent',
      maxTtlSeconds: 30,
      clockSkewSeconds: 1,
      keys: [],
    },
    ttls: {
      oauthTransactionMs: 300_000,
      sessionIdleMs: 1_800_000,
      sessionAbsoluteMs: 28_800_000,
      discordEvidenceMs: 60_000,
      jitGrantMs: 300_000,
      stepUpChallengeMs: 300_000,
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
    discordEvidenceMappings: [{
      guildId: '223456789012345678',
      channelId: '323456789012345678',
      companionId: COMPANION_ID,
      requiredRoleIds: ['523456789012345678'],
    }],
  };
}

async function createContextRuntime(options: {
  now?: () => Date;
  config?: FleetAuthConfig;
  runtimePoolMax?: number;
  configureProviderAuthority?: (
    authority: ProviderRevocationAuthorityPort,
    floors: FleetAuthAuthorityFloorStore,
  ) => ProviderRevocationAuthorityPort;
} = {}): Promise<{
  databaseName: string;
  runtime: Pool;
  coordinator: Pool;
  migration: Pool;
  resolver: ReturnType<typeof createPostgresFleetAuthorizationContextResolver>;
  portalAuthorization: ReturnType<typeof createPostgresFleetPortalAuthorization>;
  principalId: string;
}> {
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
  const migrationUrl = roleUrl(database.databaseUrl, ROLES.migration);
  await migrateFleetAuthSchema({ databaseUrl: migrationUrl, roles: ROLES });
  const migration = createPostgresPool(migrationUrl, { max: 1, allowExitOnIdle: true });
  const runtime = createPostgresPool(roleUrl(database.databaseUrl, ROLES.runtime), {
    applicationName: 'fleet-auth-context-resolver-test',
    max: options.runtimePoolMax ?? 4,
    allowExitOnIdle: true,
  });
  const coordinator = createPostgresPool(roleUrl(database.databaseUrl, ROLES.backupRestore), {
    max: 2,
    allowExitOnIdle: true,
  });
  const floorRoot = mkdtempSync(join(tmpdir(), 'fleet-auth-context-floor-'));
  floorRoots.push(floorRoot);
  const floors = new FleetAuthAuthorityFloorStore(floorRoot);
  const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  await reconcileFleetAuthAuthorityState(coordinator, floor, randomUUID());
  const baseAuthority = createGatewayProviderRevocationAuthorityPort(floors);
  const authority = options.configureProviderAuthority
    ? options.configureProviderAuthority(baseAuthority, floors)
    : baseAuthority;
  const principalId = randomUUID();
  const now = new Date();
  await migration.query(`
    INSERT INTO fleet_auth.companion_authority_state
      (companion_id, lifecycle, version, authority_generation, restore_state)
    VALUES ($1, 'active', 1, 1, 'live')
  `, [COMPANION_ID]);
  const seeder = await runtime.connect();
  try {
    await seeder.query('BEGIN');
    await seeder.query(`
      INSERT INTO fleet_auth.human_principals
        (principal_id, status, authn_version, authz_version, authority_generation, restore_state)
      VALUES ($1, 'active', 1, 1, 1, 'live')
    `, [principalId]);
    await seeder.query(`
      INSERT INTO fleet_auth.provider_subjects
        (provider, subject_id, principal_id, state, authority_generation, restore_state)
      VALUES ('discord', $2, $1, 'active', 1, 'live')
    `, [principalId, SUBJECT_ID]);
    await seeder.query(`
      INSERT INTO fleet_auth.principal_contact_bindings
        (binding_id, principal_id, companion_id, contact_id, state,
         verification_provenance, version, authority_generation, restore_state)
      VALUES ($1, $2, $3, 'contact/shared-id', 'active',
              '{"source":"integration_test"}'::jsonb, 1, 1, 'live')
    `, [randomUUID(), principalId, COMPANION_ID]);
    await seeder.query(`
      INSERT INTO fleet_auth.principal_role_grants
        (grant_id, principal_id, companion_id, role, lifecycle,
         version, authority_generation, restore_state)
      VALUES ($1, $2, $3, 'member', 'active', 1, 1, 'live')
    `, [randomUUID(), principalId, COMPANION_ID]);
    await seeder.query(`
      INSERT INTO fleet_auth.browser_sessions
        (record_id, token_digest, csrf_digest, principal_id, provider, provider_subject_id,
         audience, assurance,
         authn_version, authz_version, binding_version, policy_version, global_auth_epoch,
         idle_expires_at, absolute_expires_at, created_at)
      VALUES ($1, $2, $3, $4, 'discord', $5, 'fleet', 'oauth', 1, 1, 1, 1, 1, $6, $7, $8)
    `, [
      randomUUID(),
      createHmac('sha256', SESSION_PEPPER).update(SESSION_TOKEN).digest('hex'),
      'a'.repeat(64),
      principalId,
      SUBJECT_ID,
      new Date(now.getTime() + 300_000),
      new Date(now.getTime() + 3_600_000),
      now,
    ]);
    await seeder.query('COMMIT');
  } catch (error) {
    await seeder.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    seeder.release();
  }
  const resolver = createPostgresFleetAuthorizationContextResolver({
    pool: runtime,
    sessionPepper: SESSION_PEPPER,
    config: options.config ?? fleetConfig(),
    knownCompanionIds: [COMPANION_ID, PORTAL_COMPANION_B, PORTAL_COMPANION_C],
    providerRevocationAuthority: authority,
    ...(options.now ? { now: options.now } : {}),
  });
  const portalAuthorization = createPostgresFleetPortalAuthorization({
    pool: runtime,
    sessionPepper: SESSION_PEPPER,
    config: options.config ?? fleetConfig(),
    knownCompanionIds: [COMPANION_ID, PORTAL_COMPANION_B, PORTAL_COMPANION_C],
    providerRevocationAuthority: authority,
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    databaseName: database.databaseName,
    runtime,
    coordinator,
    migration,
    principalId,
    resolver,
    portalAuthorization,
  };
}

async function seedPortalCompanion(input: {
  runtime: Pool;
  migration: Pool;
  principalId: string;
  companionId: string;
  role: 'owner' | 'admin' | 'member' | 'guest';
  lifecycle?: 'active' | 'removed' | 'quarantined';
}): Promise<void> {
  await input.migration.query(`
    INSERT INTO fleet_auth.companion_authority_state
      (companion_id, lifecycle, version, authority_generation, restore_state)
    VALUES ($1, $2, 1, 1, 'live')
  `, [input.companionId, input.lifecycle ?? 'active']);
  await input.runtime.query(`
    INSERT INTO fleet_auth.principal_contact_bindings
      (binding_id, principal_id, companion_id, contact_id, state,
       verification_provenance, version, authority_generation, restore_state)
    VALUES ($1, $2, $3, $4, 'active',
            '{"source":"portal_integration_test"}'::jsonb, 1, 1, 'live')
  `, [randomUUID(), input.principalId, input.companionId, `contact/${input.companionId}`]);
  await input.runtime.query(`
    INSERT INTO fleet_auth.principal_role_grants
      (grant_id, principal_id, companion_id, role, lifecycle,
       version, authority_generation, restore_state)
    VALUES ($1, $2, $3, $4, 'active', 1, 1, 'live')
  `, [randomUUID(), input.principalId, input.companionId, input.role]);
}

async function waitForBlockedContextResolution(databaseName: string): Promise<void> {
  if (!harness) throw new Error('Postgres harness unavailable');
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const result = await admin.query<{ waiting: number }>(`
        SELECT COUNT(*)::int AS waiting
        FROM pg_stat_activity
        WHERE datname = $1
          AND application_name = 'fleet-auth-context-resolver-test'
          AND wait_event_type = 'Lock'
      `, [databaseName]);
      if ((result.rows[0]?.waiting ?? 0) > 0) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally {
    await admin.end();
  }
  throw new Error('Timed out waiting for fleet authorization context lock');
}

async function seedPositiveEvidence(input: {
  runtime: Pool;
  principalId: string;
  expiresAt: Date;
}): Promise<string> {
  const evidenceId = randomUUID();
  const fetchedAt = new Date(input.expiresAt.getTime() - 60_000);
  const permissionInputs = {
    oauthGuildMembership: {},
    observation: {},
    target: {},
  };
  await input.runtime.query(`
    INSERT INTO fleet_auth.discord_evidence_lifecycle_fences
      (principal_id, provider, provider_subject_id, lifecycle_id, state,
       mutation_generation, global_auth_epoch)
    VALUES ($1, 'discord', $2, $3, 'active', 0, 1)
  `, [input.principalId, SUBJECT_ID, randomUUID()]);
  await input.runtime.query(`
    INSERT INTO fleet_auth.discord_evidence_snapshots
      (evidence_id, principal_id, provider, provider_subject_id, companion_id,
       guild_id, channel_id, thread_id, permission_inputs,
       discord_permission_result, member_specific_deny_veto, psfn_evidence_result,
       decision_reason, input_digest, config_digest, mapping_config_version,
       provenance, global_auth_epoch, fetched_at, expires_at)
    VALUES ($1, $2, 'discord', $3, $4, '223456789012345678',
            '323456789012345678', NULL,
            '{"oauthGuildMembership":{},"observation":{},"target":{}}'::jsonb,
            TRUE, FALSE, TRUE, NULL, $5, $6, 1,
            $7::jsonb, 1, $8, $9)
  `, [
    evidenceId,
    input.principalId,
    SUBJECT_ID,
    COMPANION_ID,
    digestDiscordEvidence(permissionInputs),
    digestDiscordEvidenceConfig(fleetConfig()),
    JSON.stringify({
      source: 'discord_oauth_and_bot_observation',
      provider: 'discord',
      providerSubjectId: SUBJECT_ID,
      observationStatus: 'observed',
      observedAt: fetchedAt.toISOString(),
      oauthObservedAt: fetchedAt.toISOString(),
      observationId: 'observation-lock-expiry',
      botUserId: '423456789012345678',
    }),
    fetchedAt,
    input.expiresAt,
  ]);
  return evidenceId;
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

afterAll(async () => {
  await harness?.stop();
  for (const root of floorRoots) rmSync(root, { recursive: true, force: true });
}, TIMEOUT_MS);

describe('Postgres fleet authorization context snapshot', () => {
  it('uses the exact provider subject recorded by the session when a principal has multiple live providers', async () => {
    const { runtime, coordinator, migration, resolver, principalId } = await createContextRuntime();
    try {
      await runtime.query(`
        INSERT INTO fleet_auth.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation, restore_state)
        VALUES ('discord', $2, $1, 'active', 1, 'live')
      `, [principalId, OTHER_SUBJECT_ID]);

      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).resolves.toMatchObject({
        providerSubject: { provider: 'discord', subjectId: SUBJECT_ID },
      });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('resolves one current companion-local authority snapshot and durably audits redacted allow/deny decisions', async () => {
    const { runtime, coordinator, migration, resolver, principalId } = await createContextRuntime();
    try {
      const context = await resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: SESSION_TOKEN,
      });
      expect(context).toMatchObject({
        principalId,
        companionId: COMPANION_ID,
        providerSubject: { provider: 'discord', subjectId: SUBJECT_ID },
        contact: { contactId: 'contact/shared-id', bindingVersion: 1 },
        operator: { role: 'member', grantVersion: 1 },
        authorization: { action: 'memory.read.self', decision: 'allow' },
        authority: { authorityGeneration: 1, globalAuthEpoch: 1 },
        session: {
          provider: 'discord',
          providerSubjectId: SUBJECT_ID,
          grantVersion: 1,
        },
        provenance: {
          source: 'gateway_fleet_authorization_snapshot',
          correlationId: digestCorrelation(SESSION_TOKEN),
        },
      });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.contact)).toBe(true);

      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        role: 'owner',
        trustLevel: 'ultimate',
      })).rejects.toMatchObject({ code: 'malformed_request' });

      const audit = await runtime.query<{
        decision: string;
        reason_code: string;
        actor_context: unknown;
        correlation_id: string | null;
      }>(`
        SELECT decision, reason_code, actor_context, correlation_id
        FROM fleet_auth.authorization_audit_events
        WHERE action IN ('memory.read.self', 'authorization.resolve')
        ORDER BY occurred_at, event_id
      `);
      expect(audit.rows).toEqual([
        {
          decision: 'allow',
          reason_code: 'role_action_allowed',
          actor_context: {
            kind: 'browser_session',
            boundary: 'fleet_authorization_context',
            provider: 'discord',
            evidenceRequested: false,
          },
          correlation_id: digestCorrelation(SESSION_TOKEN),
        },
        {
          decision: 'deny',
          reason_code: 'malformed_request',
          actor_context: {
            kind: 'browser_session',
            boundary: 'fleet_authorization_context',
            provider: 'discord',
            evidenceRequested: false,
          },
          correlation_id: null,
        },
      ]);
      expect(JSON.stringify(audit.rows)).not.toContain(SESSION_TOKEN);
      expect(JSON.stringify(audit.rows)).not.toContain('contact/shared-id');
      expect(JSON.stringify(audit.rows)).not.toContain(SUBJECT_ID);
      expect(digestCorrelation(SESSION_TOKEN)).not.toBe(
        createHmac('sha256', SESSION_PEPPER).update(SESSION_TOKEN).digest('hex'),
      );
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('uses principal-wide invalidation counters independently from row-local versions', async () => {
    const { runtime, coordinator, migration, resolver } = await createContextRuntime();
    try {
      await runtime.query(`
        UPDATE fleet_auth.principal_contact_bindings SET version = 17
        WHERE companion_id = $1
      `, [COMPANION_ID]);
      await runtime.query(`
        UPDATE fleet_auth.principal_role_grants SET version = 23
        WHERE companion_id = $1
      `, [COMPANION_ID]);

      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).resolves.toMatchObject({
        contact: { bindingVersion: 17 },
        operator: { grantVersion: 23 },
        session: { bindingVersion: 1, grantVersion: 1, policyVersion: 1 },
      });

      await runtime.query(`
        UPDATE fleet_auth.human_principals SET grant_version = grant_version + 1
      `);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).rejects.toMatchObject({ code: 'grant_version_stale' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('keeps an unaffected session valid across an unrelated central authority advance', async () => {
    const { runtime, coordinator, migration, resolver } = await createContextRuntime({
      configureProviderAuthority: authority => ({
        sessionAuthorityGenerationIsCurrent: () => true,
        fence: input => authority.fence(input),
      }),
    });
    try {
      await migration.query(`
        UPDATE fleet_auth.authority_state
        SET authority_generation = 2, global_auth_epoch = 2
        WHERE singleton = TRUE
      `);
      await runtime.query(`
        UPDATE fleet_auth.browser_sessions SET global_auth_epoch = 2
      `);

      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).resolves.toMatchObject({
        authority: { authorityGeneration: 2, globalAuthEpoch: 2 },
      });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('denies immutable merged-source aliases', async () => {
    const { runtime, coordinator, migration, resolver, principalId } = await createContextRuntime();
    const canonicalPrincipalId = randomUUID();
    try {
      await migration.query(`
        INSERT INTO fleet_auth.human_principals
          (principal_id, status, authn_version, authz_version, authority_generation, restore_state)
        VALUES ($1, 'active', 1, 1, 1, 'live')
      `, [canonicalPrincipalId]);
      await migration.query(`
        INSERT INTO fleet_auth.principal_merge_aliases
          (source_principal_id, canonical_principal_id, decision_id,
           authority_generation, reason_digest, restore_state)
        VALUES ($1, $2, $3, 1, $4, 'live')
      `, [principalId, canonicalPrincipalId, randomUUID(), 'a'.repeat(64)]);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).rejects.toMatchObject({ code: 'principal_merged' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('denies removed companion authority before consuming binding or grant rows', async () => {
    const { runtime, coordinator, migration, resolver } = await createContextRuntime();
    try {
      await migration.query(`
        UPDATE fleet_auth.companion_authority_state SET lifecycle = 'removed'
        WHERE companion_id = $1
      `, [COMPANION_ID]);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).rejects.toMatchObject({ code: 'companion_not_active' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('denies exact resource rows carried behind the non-restored tombstone floor', async () => {
    const { runtime, coordinator, migration, resolver } = await createContextRuntime();
    try {
      const binding = await runtime.query<{ binding_id: string }>(`
        SELECT binding_id FROM fleet_auth.principal_contact_bindings
        WHERE companion_id = $1
      `, [COMPANION_ID]);
      const bindingId = binding.rows[0]?.binding_id;
      if (!bindingId) throw new Error('context fixture binding is missing');
      await migration.query(`
        INSERT INTO fleet_auth.authority_floor_tombstone_projection
          (kind, resource_hash, authority_generation)
        VALUES ('contact_binding', $1, 1)
      `, [createHash('sha256').update(bindingId).digest('hex')]);

      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
      })).rejects.toMatchObject({ code: 'binding_tombstoned' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('serializes with authority mutation and commits denial audit after the competing transaction', async () => {
    const { databaseName, runtime, coordinator, migration, resolver, principalId } =
      await createContextRuntime({ runtimePoolMax: 1 });
    const mutator = await migration.connect();
    try {
      await mutator.query('BEGIN');
      await mutator.query(`SELECT * FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const pendingResolution = resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: 'correlation-race',
      });
      await waitForBlockedContextResolution(databaseName);
      await mutator.query(`
        UPDATE fleet_auth.human_principals
        SET authz_version = authz_version + 1, updated_at = clock_timestamp()
        WHERE principal_id = $1
      `, [principalId]);
      await mutator.query('COMMIT');

      await expect(pendingResolution).rejects.toEqual(
        expect.objectContaining<FleetAuthorizationDeniedError>({ code: 'session_authz_stale' }),
      );
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation('correlation-race')]);
      expect(audit.rows).toEqual([{ decision: 'deny', reason_code: 'session_authz_stale' }]);
    } finally {
      await mutator.query('ROLLBACK').catch(() => undefined);
      mutator.release();
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('does not replay a committed authorization when its post-commit denial audit fails', async () => {
    const { runtime, coordinator, migration } = await createContextRuntime();
    let authorityChecks = 0;
    const store = new PostgresFleetAuthorizationContextStore({
      pool: runtime,
      sessionPepper: SESSION_PEPPER,
      config: fleetConfig(),
      providerRevocationAuthority: {
        sessionAuthorityGenerationIsCurrent: () => {
          authorityChecks += 1;
          return authorityChecks === 1;
        },
      } as unknown as ProviderRevocationAuthorityPort,
    });
    const postCommitFailure = Object.assign(
      new Error('post-commit audit serialization failure'),
      { code: '40001' },
    );
    let postCommitAttempts = 0;
    const testSeam = store as unknown as {
      recordPostCommitAuthorityDenial: () => Promise<void>;
    };
    testSeam.recordPostCommitAuthorityDenial = async () => {
      postCommitAttempts += 1;
      throw postCommitFailure;
    };
    try {
      await expect(store.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: 'correlation-post-commit-failure',
      })).rejects.toBe(postCommitFailure);
      expect(authorityChecks).toBe(2);
      expect(postCommitAttempts).toBe(1);
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation('correlation-post-commit-failure')]);
      expect(audit.rows).toEqual(expect.arrayContaining([
        { decision: 'allow', reason_code: 'role_action_allowed' },
        { decision: 'deny', reason_code: 'authorization_store_error' },
      ]));
      expect(audit.rows).toHaveLength(2);
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('captures decision time after an authority lock wait and denies an expired session', async () => {
    const initialNow = new Date();
    let decisionNow = initialNow;
    const {
      databaseName,
      runtime,
      coordinator,
      migration,
      resolver,
    } = await createContextRuntime({ now: () => decisionNow });
    const blocker = await runtime.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT * FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const pendingResolution = resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: 'correlation-session-lock-expiry',
      });
      await waitForBlockedContextResolution(databaseName);
      decisionNow = new Date(initialNow.getTime() + 10 * 60_000);
      await blocker.query('COMMIT');
      released = true;

      await expect(pendingResolution).rejects.toMatchObject({ code: 'session_expired' });
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation('correlation-session-lock-expiry')]);
      expect(audit.rows).toEqual([{ decision: 'deny', reason_code: 'session_expired' }]);
    } finally {
      if (!released) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('captures decision time after all evidence locks and denies evidence that expired while waiting', async () => {
    const initialNow = new Date();
    let decisionNow = initialNow;
    const {
      databaseName,
      runtime,
      coordinator,
      migration,
      resolver,
      principalId,
    } = await createContextRuntime({ now: () => decisionNow });
    const evidenceExpiresAt = new Date(initialNow.getTime() + 30_000);
    const evidenceId = await seedPositiveEvidence({ runtime, principalId, expiresAt: evidenceExpiresAt });
    const blocker = await runtime.connect();
    let released = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT * FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const pendingResolution = resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        discordEvidence: { evidenceId },
        correlationId: 'correlation-evidence-lock-expiry',
      });
      await waitForBlockedContextResolution(databaseName);
      decisionNow = new Date(evidenceExpiresAt.getTime() + 1);
      await blocker.query('COMMIT');
      released = true;

      await expect(pendingResolution).rejects.toMatchObject({ code: 'evidence_stale' });
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation('correlation-evidence-lock-expiry')]);
      expect(audit.rows).toEqual([{ decision: 'deny', reason_code: 'evidence_stale' }]);
    } finally {
      if (!released) await blocker.query('ROLLBACK').catch(() => undefined);
      blocker.release();
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('locks session provenance and lifecycle rows in deterministic authority order', async () => {
    const {
      databaseName,
      runtime,
      coordinator,
      migration,
      resolver,
      principalId,
    } = await createContextRuntime();
    const evidenceId = await seedPositiveEvidence({
      runtime,
      principalId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const sessionDigest = createHmac('sha256', SESSION_PEPPER)
      .update(SESSION_TOKEN)
      .digest('hex');
    let stage = 0;
    const assertPrecedes = async (input: {
      blockerPool: Pool;
      blockerSql: string;
      blockerParams: unknown[];
      probePool: Pool;
      probeSql: string;
      probeParams: unknown[];
    }): Promise<void> => {
      stage += 1;
      const blocker = await input.blockerPool.connect();
      const probe = await input.probePool.connect();
      let pendingResolution: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(input.blockerSql, input.blockerParams);
        pendingResolution = resolver.resolve({
          sessionToken: SESSION_TOKEN,
          audience: 'fleet',
          companionId: COMPANION_ID,
          action: 'memory.read.self',
          discordEvidence: { evidenceId },
          correlationId: `correlation-lock-order-${stage}`,
        });
        await waitForBlockedContextResolution(databaseName);
        await probe.query('BEGIN');
        await expect(probe.query(input.probeSql, input.probeParams)).resolves.toBeDefined();
        await probe.query('ROLLBACK');
        await blocker.query('COMMIT');
        await expect(pendingResolution).resolves.toMatchObject({
          providerSubject: { subjectId: SUBJECT_ID },
        });
      } finally {
        await probe.query('ROLLBACK').catch(() => undefined);
        await blocker.query('ROLLBACK').catch(() => undefined);
        probe.release();
        blocker.release();
        await pendingResolution?.catch(() => undefined);
      }
    };
    try {
      await assertPrecedes({
        blockerPool: runtime,
        blockerSql: `SELECT 1 FROM fleet_auth.browser_sessions
          WHERE token_digest = $1 FOR UPDATE`,
        blockerParams: [sessionDigest],
        probePool: runtime,
        probeSql: `SELECT 1 FROM fleet_auth.provider_subjects
          WHERE provider = 'discord' AND subject_id = $1 FOR UPDATE NOWAIT`,
        probeParams: [SUBJECT_ID],
      });
      await assertPrecedes({
        blockerPool: runtime,
        blockerSql: `SELECT 1 FROM fleet_auth.provider_subjects
          WHERE provider = 'discord' AND subject_id = $1 FOR UPDATE`,
        blockerParams: [SUBJECT_ID],
        probePool: coordinator,
        probeSql: `SELECT 1 FROM fleet_auth.companion_authority_state
          WHERE companion_id = $1 FOR UPDATE NOWAIT`,
        probeParams: [COMPANION_ID],
      });
      await assertPrecedes({
        blockerPool: coordinator,
        blockerSql: `SELECT 1 FROM fleet_auth.companion_authority_state
          WHERE companion_id = $1 FOR UPDATE`,
        blockerParams: [COMPANION_ID],
        probePool: runtime,
        probeSql: `SELECT 1 FROM fleet_auth.principal_contact_bindings
          WHERE companion_id = $1 FOR UPDATE NOWAIT`,
        probeParams: [COMPANION_ID],
      });
      await assertPrecedes({
        blockerPool: runtime,
        blockerSql: `SELECT 1 FROM fleet_auth.principal_contact_bindings
          WHERE companion_id = $1 FOR UPDATE`,
        blockerParams: [COMPANION_ID],
        probePool: runtime,
        probeSql: `SELECT 1 FROM fleet_auth.principal_role_grants
          WHERE companion_id = $1 FOR UPDATE NOWAIT`,
        probeParams: [COMPANION_ID],
      });
      await assertPrecedes({
        blockerPool: runtime,
        blockerSql: `SELECT 1 FROM fleet_auth.principal_role_grants
          WHERE companion_id = $1 FOR UPDATE`,
        blockerParams: [COMPANION_ID],
        probePool: runtime,
        probeSql: `SELECT 1 FROM fleet_auth.discord_evidence_snapshots
          WHERE evidence_id = $1 FOR UPDATE NOWAIT`,
        probeParams: [evidenceId],
      });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('rechecks the non-restored authority after commit and appends a durable stale denial', async () => {
    let authorityChecks = 0;
    const {
      runtime,
      coordinator,
      migration,
      resolver,
    } = await createContextRuntime({
      configureProviderAuthority: (authority, floors) => ({
        sessionAuthorityGenerationIsCurrent: (authorityGeneration) => {
          authorityChecks += 1;
          if (authorityChecks === 2) {
            floors.revokeAccountAuthority({
              kind: 'provider_subject',
              resourceId: `discord:${SUBJECT_ID}`,
              reason: 'post-commit authorization race',
              at: new Date().toISOString(),
            });
          }
          return authority.sessionAuthorityGenerationIsCurrent(authorityGeneration);
        },
        fence: input => authority.fence(input),
      }),
    });
    try {
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: CONTACT_ID,
      })).rejects.toMatchObject({ code: 'authority_generation_stale' });
      expect(authorityChecks).toBe(2);
      const audit = await runtime.query<{
        decision: string;
        reason_code: string;
        actor_context: unknown;
        correlation_id: string;
      }>(`
        SELECT decision, reason_code, actor_context, correlation_id
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
        ORDER BY occurred_at, event_id
      `, [digestCorrelation(CONTACT_ID)]);
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ decision: 'allow', reason_code: 'role_action_allowed' }),
        expect.objectContaining({ decision: 'deny', reason_code: 'authority_generation_stale' }),
      ]));
      expect(JSON.stringify(audit.rows)).not.toContain(SESSION_TOKEN);
      expect(JSON.stringify(audit.rows)).not.toContain(SUBJECT_ID);
      expect(JSON.stringify(audit.rows)).not.toContain(CONTACT_ID);
      expect(new Set(audit.rows.map(row => row.correlation_id)))
        .toEqual(new Set([digestCorrelation(CONTACT_ID)]));
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('never returns allow when the post-commit stale-authority denial audit fails', async () => {
    let authorityChecks = 0;
    const { runtime, coordinator, migration, resolver } = await createContextRuntime({
      configureProviderAuthority: authority => ({
        sessionAuthorityGenerationIsCurrent: () => {
          authorityChecks += 1;
          return authorityChecks === 1;
        },
        fence: input => authority.fence(input),
      }),
    });
    try {
      await migration.query(`
        CREATE OR REPLACE FUNCTION fleet_auth.reject_stale_context_denial_audit()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.decision = 'deny' AND NEW.reason_code = 'authority_generation_stale' THEN
            RAISE EXCEPTION 'injected post-commit stale denial audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_stale_context_denial_audit
          BEFORE INSERT ON fleet_auth.authorization_audit_events
          FOR EACH ROW EXECUTE FUNCTION fleet_auth.reject_stale_context_denial_audit()
      `);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: 'correlation-post-commit-audit-failure',
      })).rejects.toThrow(/injected post-commit stale denial audit failure/u);
      expect(authorityChecks).toBe(2);
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
        ORDER BY occurred_at, event_id
      `, [digestCorrelation('correlation-post-commit-audit-failure')]);
      expect(audit.rows).toHaveLength(2);
      expect(audit.rows).toEqual(expect.arrayContaining([
        { decision: 'allow', reason_code: 'role_action_allowed' },
        { decision: 'deny', reason_code: 'authorization_store_error' },
      ]));
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('fails closed on ambiguous active bindings and preserves the denial receipt', async () => {
    const { runtime, coordinator, migration, resolver, principalId } = await createContextRuntime();
    try {
      await runtime.query(`
        INSERT INTO fleet_auth.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, version, authority_generation, restore_state)
        VALUES ($1, $2, $3, 'contact/second', 'active',
                '{"source":"ambiguity_test"}'::jsonb, 1, 1, 'live')
      `, [randomUUID(), principalId, COMPANION_ID]);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: EVIDENCE_IDENTIFIER,
      })).rejects.toMatchObject({ code: 'binding_ambiguous' });
      const audit = await runtime.query<{
        decision: string;
        reason_code: string;
        correlation_id: string;
      }>(`
        SELECT decision, reason_code, correlation_id
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation(EVIDENCE_IDENTIFIER)]);
      expect(audit.rows).toEqual([{
        decision: 'deny',
        reason_code: 'binding_ambiguous',
        correlation_id: digestCorrelation(EVIDENCE_IDENTIFIER),
      }]);
      expect(JSON.stringify(audit.rows)).not.toContain(EVIDENCE_IDENTIFIER);
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('binds positive Discord evidence exactly and exposes only bounded immutable provenance', async () => {
    const { runtime, coordinator, migration, resolver, principalId } = await createContextRuntime();
    const evidenceId = randomUUID();
    const fetchedAt = new Date();
    const permissionInputs = {
      oauthGuildMembership: {},
      observation: {},
      target: {},
    };
    const evidenceConfig = fleetConfig();
    try {
      await runtime.query(`
        INSERT INTO fleet_auth.discord_evidence_lifecycle_fences
          (principal_id, provider, provider_subject_id, lifecycle_id, state,
           mutation_generation, global_auth_epoch)
        VALUES ($1, 'discord', $2, $3, 'active', 0, 1)
      `, [principalId, SUBJECT_ID, randomUUID()]);
      await runtime.query(`
        INSERT INTO fleet_auth.discord_evidence_snapshots
          (evidence_id, principal_id, provider, provider_subject_id, companion_id,
           guild_id, channel_id, thread_id, permission_inputs,
           discord_permission_result, member_specific_deny_veto, psfn_evidence_result,
           decision_reason, input_digest, config_digest, mapping_config_version,
           provenance, global_auth_epoch, fetched_at, expires_at)
        VALUES ($1, $2, 'discord', $3, $4, '223456789012345678',
                '323456789012345678', NULL,
                '{"oauthGuildMembership":{},"observation":{},"target":{}}'::jsonb,
                TRUE, FALSE, TRUE, NULL, $5, $6, 1,
                $7::jsonb, 1, $8, $9)
      `, [
        evidenceId,
        principalId,
        SUBJECT_ID,
        COMPANION_ID,
        digestDiscordEvidence(permissionInputs),
        digestDiscordEvidenceConfig(evidenceConfig),
        JSON.stringify({
          source: 'discord_oauth_and_bot_observation',
          provider: 'discord',
          providerSubjectId: SUBJECT_ID,
          observationStatus: 'observed',
          observedAt: fetchedAt.toISOString(),
          oauthObservedAt: fetchedAt.toISOString(),
          observationId: 'observation-1',
          botUserId: '423456789012345678',
        }),
        fetchedAt,
        new Date(fetchedAt.getTime() + 60_000),
      ]);
      const context = await resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        discordEvidence: { evidenceId },
      });
      expect(context.discordEvidence).toMatchObject({
        evidenceId,
        guildId: '223456789012345678',
        channelId: '323456789012345678',
        mappingConfigVersion: 1,
        globalAuthEpoch: 1,
      });
      expect(typeof context.discordEvidence?.expiresAt).toBe('string');
      expect(context.discordEvidence).not.toHaveProperty('permissionInputs');
      expect(context.discordEvidence).not.toHaveProperty('role');
      expect(Object.isFrozen(context.discordEvidence)).toBe(true);

      await runtime.query(`
        UPDATE fleet_auth.discord_evidence_snapshots
        SET companion_id = $2
        WHERE evidence_id = $1
      `, [evidenceId, '59b00741-2f3e-4f45-b359-9d95fe84bad0']);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        discordEvidence: { evidenceId },
      })).rejects.toMatchObject({ code: 'evidence_misbound' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('rolls back a failed allow and commits a separate infrastructure-denial audit', async () => {
    const { runtime, coordinator, migration, resolver } = await createContextRuntime();
    try {
      await migration.query(`
        CREATE OR REPLACE FUNCTION fleet_auth.reject_context_allow_audit()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          IF NEW.decision = 'allow' AND NEW.action = 'memory.read.self' THEN
            RAISE EXCEPTION 'injected authorization allow audit failure';
          END IF;
          RETURN NEW;
        END;
        $$;
        CREATE TRIGGER reject_context_allow_audit
          BEFORE INSERT ON fleet_auth.authorization_audit_events
          FOR EACH ROW EXECUTE FUNCTION fleet_auth.reject_context_allow_audit()
      `);
      await expect(resolver.resolve({
        sessionToken: SESSION_TOKEN,
        audience: 'fleet',
        companionId: COMPANION_ID,
        action: 'memory.read.self',
        correlationId: SUBJECT_ID,
      })).rejects.toThrow(/injected authorization allow audit failure/u);
      const audit = await runtime.query<{
        decision: string;
        reason_code: string;
        correlation_id: string;
      }>(`
        SELECT decision, reason_code, correlation_id
        FROM fleet_auth.authorization_audit_events
        WHERE correlation_id = $1
      `, [digestCorrelation(SUBJECT_ID)]);
      expect(audit.rows).toEqual([{
        decision: 'deny',
        reason_code: 'authorization_store_error',
        correlation_id: digestCorrelation(SUBJECT_ID),
      }]);
      expect(JSON.stringify(audit.rows)).not.toContain(SUBJECT_ID);
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);
});

describe('Postgres fleet portal batch authorization', () => {
  it('returns one privacy-bounded batch from current manifest authority and canonical role policy', async () => {
    const {
      runtime,
      coordinator,
      migration,
      portalAuthorization,
      principalId,
    } = await createContextRuntime();
    try {
      await seedPortalCompanion({
        runtime,
        migration,
        principalId,
        companionId: PORTAL_COMPANION_B,
        role: 'admin',
      });
      await seedPortalCompanion({
        runtime,
        migration,
        principalId,
        companionId: PORTAL_COMPANION_C,
        role: 'owner',
        lifecycle: 'removed',
      });

      const result = await portalAuthorization.resolve({ sessionToken: SESSION_TOKEN });
      expect(result).toEqual({
        companions: [
          { companionId: COMPANION_ID, gardenLinkEligible: false },
          { companionId: PORTAL_COMPANION_B, gardenLinkEligible: true },
        ],
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PORTAL_COMPANION_C);
      expect(serialized).not.toContain(principalId);
      expect(serialized).not.toContain(SUBJECT_ID);
      expect(serialized).not.toContain(CONTACT_ID);
      expect(serialized).not.toContain('admin');
      const audit = await runtime.query<{
        action: string;
        resource: string;
        decision: string;
        reason_code: string;
        companion_id: string | null;
      }>(`
        SELECT action, resource, decision, reason_code, companion_id
        FROM fleet_auth.authorization_audit_events
        WHERE resource = 'fleet_portal'
      `);
      expect(audit.rows).toEqual([{
        action: 'companion.read',
        resource: 'fleet_portal',
        decision: 'allow',
        reason_code: 'portal_projection_allowed',
        companion_id: null,
      }]);
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('removes ambiguous, revoked, quarantined, and disabled companion authority independently', async () => {
    const config = fleetConfig();
    config.rolePolicy.disabledActionsByRole.member.push('companion.read');
    config.rolePolicy.disabledActionsByRole.admin.push('garden.read');
    const {
      runtime,
      coordinator,
      migration,
      portalAuthorization,
      principalId,
    } = await createContextRuntime({ config });
    try {
      await seedPortalCompanion({
        runtime,
        migration,
        principalId,
        companionId: PORTAL_COMPANION_B,
        role: 'admin',
      });
      await seedPortalCompanion({
        runtime,
        migration,
        principalId,
        companionId: PORTAL_COMPANION_C,
        role: 'owner',
      });
      await runtime.query(`
        INSERT INTO fleet_auth.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, version, authority_generation, restore_state)
        VALUES ($1, $2, $3, 'contact/collision', 'active',
                '{"source":"portal_collision"}'::jsonb, 1, 1, 'live')
      `, [randomUUID(), principalId, PORTAL_COMPANION_C]);

      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [{ companionId: PORTAL_COMPANION_B, gardenLinkEligible: false }],
      });

      await runtime.query(`
        UPDATE fleet_auth.principal_contact_bindings
        SET state = 'revoked'
        WHERE principal_id = $1 AND companion_id = $2
      `, [principalId, PORTAL_COMPANION_B]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [],
      });
      await runtime.query(`
        UPDATE fleet_auth.principal_contact_bindings
        SET state = 'active'
        WHERE principal_id = $1 AND companion_id = $2
      `, [principalId, PORTAL_COMPANION_B]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [{ companionId: PORTAL_COMPANION_B, gardenLinkEligible: false }],
      });

      await runtime.query(`
        UPDATE fleet_auth.principal_role_grants
        SET lifecycle = 'revoked'
        WHERE principal_id = $1 AND companion_id = $2
      `, [principalId, PORTAL_COMPANION_B]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [],
      });
      await runtime.query(`
        UPDATE fleet_auth.principal_role_grants
        SET lifecycle = 'active'
        WHERE principal_id = $1 AND companion_id = $2
      `, [principalId, PORTAL_COMPANION_B]);
      await runtime.query(`
        DELETE FROM fleet_auth.principal_contact_bindings
        WHERE principal_id = $1 AND companion_id = $2 AND contact_id = 'contact/collision'
      `, [principalId, PORTAL_COMPANION_C]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [
          { companionId: PORTAL_COMPANION_B, gardenLinkEligible: false },
          { companionId: PORTAL_COMPANION_C, gardenLinkEligible: true },
        ],
      });
      await runtime.query(`
        UPDATE fleet_auth.principal_contact_bindings
        SET restore_state = 'quarantined'
        WHERE principal_id = $1 AND companion_id = $2
      `, [principalId, PORTAL_COMPANION_C]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [{ companionId: PORTAL_COMPANION_B, gardenLinkEligible: false }],
      });

      await migration.query(`
        UPDATE fleet_auth.companion_authority_state
        SET lifecycle = 'quarantined'
        WHERE companion_id = $1
      `, [PORTAL_COMPANION_B]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN })).resolves.toEqual({
        companions: [],
      });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('denies stale session counters, epoch changes, and merged principals before returning entries', async () => {
    for (const mutation of [
      `UPDATE fleet_auth.human_principals SET authz_version = authz_version + 1`,
      `UPDATE fleet_auth.authority_state SET global_auth_epoch = global_auth_epoch + 1`,
    ]) {
      const {
        runtime,
        coordinator,
        migration,
        portalAuthorization,
      } = await createContextRuntime();
      try {
        await migration.query(mutation);
        await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN }))
          .rejects.toBeInstanceOf(FleetAuthorizationDeniedError);
      } finally {
        await coordinator.end();
        await migration.end();
        await runtime.end();
      }
    }

    const {
      runtime,
      coordinator,
      migration,
      portalAuthorization,
      principalId,
    } = await createContextRuntime();
    try {
      const canonicalPrincipalId = randomUUID();
      await migration.query(`
        INSERT INTO fleet_auth.human_principals
          (principal_id, status, authn_version, authz_version, authority_generation, restore_state)
        VALUES ($1, 'active', 1, 1, 1, 'live')
      `, [canonicalPrincipalId]);
      await migration.query(`
        INSERT INTO fleet_auth.principal_merge_aliases
          (source_principal_id, canonical_principal_id, decision_id,
           authority_generation, reason_digest, restore_state)
        VALUES ($1, $2, $3, 1, $4, 'live')
      `, [principalId, canonicalPrincipalId, randomUUID(), 'b'.repeat(64)]);
      await expect(portalAuthorization.resolve({ sessionToken: SESSION_TOKEN }))
        .rejects.toMatchObject({ code: 'principal_merged' });
    } finally {
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('fails closed when a competing authority mutation invalidates the one-shot snapshot', async () => {
    const {
      databaseName,
      runtime,
      coordinator,
      migration,
      portalAuthorization,
      principalId,
    } = await createContextRuntime();
    const mutator = await runtime.connect();
    try {
      await mutator.query('BEGIN');
      await mutator.query(`SELECT * FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
      const pendingProjection = portalAuthorization.resolve({ sessionToken: SESSION_TOKEN });
      await waitForBlockedContextResolution(databaseName);
      await mutator.query(`
        UPDATE fleet_auth.human_principals
        SET authz_version = authz_version + 1, updated_at = clock_timestamp()
        WHERE principal_id = $1
      `, [principalId]);
      await mutator.query('COMMIT');
      await expect(pendingProjection).rejects.toMatchObject({ code: 'authorization_store_error' });
      const audit = await runtime.query<{ decision: string; reason_code: string }>(`
        SELECT decision, reason_code
        FROM fleet_auth.authorization_audit_events
        WHERE resource = 'fleet_portal'
      `);
      expect(audit.rows).toEqual([{
        decision: 'deny',
        reason_code: 'authorization_store_error',
      }]);
    } finally {
      await mutator.query('ROLLBACK').catch(() => undefined);
      mutator.release();
      await coordinator.end();
      await migration.end();
      await runtime.end();
    }
  }, TIMEOUT_MS);
});
