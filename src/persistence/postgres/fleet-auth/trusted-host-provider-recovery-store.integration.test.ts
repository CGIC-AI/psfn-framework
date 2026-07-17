import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrustedHostProviderRecoveryService } from '../../../boundary/fleet-auth/trusted-host-provider-recovery.js';
import { digestFleetAuthVerifiedProviderProof } from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import { GatewayFleetAuthAuthorityLifecycleStore } from './authority-lifecycle-store.js';
import {
  createGatewayAccountAuthorityFencePort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from './schema.js';
import { PostgresTrustedHostProviderRecoveryStore } from './trusted-host-provider-recovery-store.js';

const TIMEOUT_MS = 120_000;
const ORIGIN = 'https://fleet.example.test';
const PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const COMPANION_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CURRENT_SUBJECT = '123456789012345678';
const NEW_SUBJECT = '223456789012345678';
const CREDENTIAL_HASH = 'a'.repeat(64);
const SESSION_PEPPER = 'provider-recovery-session-pepper';
const ENCRYPTION_KEY = randomBytes(32).toString('hex');
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
};
const PASSWORDS = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
} as const;

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
}

function secretDigest(value: string): string {
  return createHmac('sha256', SESSION_PEPPER).update(value).digest('hex');
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role as keyof typeof PASSWORDS]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function freshContext() {
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
  await migrateFleetAuthSchema({
    databaseUrl: migrationUrl,
    roles: ROLES,
  });
  const pool = createPostgresPool(roleUrl(database.databaseUrl, ROLES.backupRestore), { max: 6 });
  const seedPool = createPostgresPool(migrationUrl, { max: 1 });
  const root = mkdtempSync(join(tmpdir(), 'psfn-provider-recovery-'));
  chmodSync(root, 0o700);
  const floors = new FleetAuthAuthorityFloorStore(root);
  const initial = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  await reconcileFleetAuthAuthorityState(pool, initial, randomUUID());
  floors.enrollPasskey({
    credentialIdHash: CREDENTIAL_HASH,
    publicKeyVerifier: 'AQID',
    rpId: 'fleet.example.test',
    principalId: PRINCIPAL_ID,
    expectedProvider: 'discord',
    expectedProviderSubjectId: CURRENT_SUBJECT,
    signCount: 1,
    backupEligible: false,
    backupState: false,
  }, new Date().toISOString());
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
      (companion_id, lifecycle, authority_generation)
    VALUES ($1, 'active', 1)
  `, [COMPANION_ID]);
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      (principal_id, status, authority_generation)
    VALUES ($1, 'active', 1)
  `, [PRINCIPAL_ID]);
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      (provider, subject_id, principal_id, state, authority_generation)
    VALUES ('discord', $1, $2, 'active', 1)
  `, [CURRENT_SUBJECT, PRINCIPAL_ID]);
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      (binding_id, principal_id, companion_id, contact_id, state,
       verification_provenance, authority_generation)
    VALUES ($1, $2, $3, $4, 'active', $5::jsonb, 1)
  `, [
    randomUUID(),
    PRINCIPAL_ID,
    COMPANION_ID,
    randomUUID(),
    JSON.stringify({ source: 'provider_recovery_certification' }),
  ]);
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      (grant_id, principal_id, companion_id, role, lifecycle, authority_generation)
    VALUES ($1, $2, $3, 'owner', 'active', 1)
  `, [randomUUID(), PRINCIPAL_ID, COMPANION_ID]);
  const token = Buffer.alloc(32, 1).toString('base64url');
  const csrfToken = Buffer.alloc(32, 2).toString('base64url');
  await seedPool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions (
      record_id, token_digest, csrf_digest, principal_id, audience, assurance,
      authn_version, authz_version, binding_version, grant_version, policy_version,
      provider, provider_subject_id, global_auth_epoch,
      idle_expires_at, absolute_expires_at
    ) VALUES (
      $1, $2, $3, $4, 'fleet', 'oauth', 1, 1, 1, 1, 1,
      'discord', $5, 1, clock_timestamp() + interval '10 minutes',
      clock_timestamp() + interval '20 minutes'
    )
  `, [SESSION_ID, secretDigest(token), secretDigest(csrfToken), PRINCIPAL_ID, CURRENT_SUBJECT]);
  await seedPool.end();
  return { pool, floors, root, token, csrfToken, migrationUrl };
}

describe('Postgres trusted-host provider recovery', () => {
  it('composes host provenance, exact OAuth, WebAuthn UV, lifecycle fencing, and denial audit', async () => {
    const context = await freshContext();
    try {
      const accountAuthority = createGatewayAccountAuthorityFencePort(context.floors);
      const lifecycle = new GatewayFleetAuthAuthorityLifecycleStore({
        pool: context.pool,
        accountAuthority,
      });
      const store = new PostgresTrustedHostProviderRecoveryStore({
        authorityPool: context.pool,
        sessionPepper: SESSION_PEPPER,
        tokenEncryptionKey: ENCRYPTION_KEY,
        providerRevocationAuthority: accountAuthority,
        passkeyAuthority: context.floors,
      });
      const service = new TrustedHostProviderRecoveryService({
        canonicalOrigin: ORIGIN,
        rpId: 'fleet.example.test',
        ttlMs: 120_000,
        store,
        authority: context.floors,
        webAuthn: {
          startAuthentication: async input => ({ challenge: input.challenge }),
          finishAuthentication: async () => {
            const before = context.floors.readPasskeys();
            const current = before.credentials.find(entry => entry.status === 'current')!;
            const after = context.floors.updateCurrentPasskeySignals({
              credentialIdHash: current.credentialIdHash,
              expectedGeneration: current.generation,
              signCount: current.signCount + 1,
              backupEligible: current.backupEligible,
              backupState: current.backupState,
              at: new Date().toISOString(),
            });
            const verified = after.passkeys.credentials.find(entry => entry.status === 'current')!;
            return { credentialIdHash: verified.credentialIdHash, generation: verified.generation };
          },
        },
        execute: async input => {
          const result = await lifecycle.execute({
            verification: 'gateway_verified',
            action: 'provider.recover',
            decisionId: input.decisionId,
            ceremonyId: input.ceremonyId,
            actor: input.principal,
            actorSession: input.actorSession,
            target: input.principal,
            companionId: input.companionId,
            unavailableProvider: {
              provider: 'discord',
              subjectId: input.currentProviderSubjectId,
              authorityGeneration: input.currentProviderAuthorityGeneration,
            },
            newProvider: input.newProvider,
            recovery: {
              oneTimeCredential: input.oneTimeCredential,
              confirmation: 'provider.recover',
              webAuthnReceipt: input.webAuthnReceipt,
              credentialIdHash: input.credentialIdHash,
              credentialGeneration: input.credentialGeneration,
              credentialFloorGeneration: input.completedCredentialFloorGeneration,
            },
            authorityGeneration: input.authorityGeneration,
            globalAuthEpoch: input.globalAuthEpoch,
            reasonDigest: input.reasonDigest,
            decidedAt: input.decidedAt,
          });
          return {
            decisionId: result.decisionId,
            authorityGeneration: result.authorityGeneration,
            globalAuthEpoch: result.globalAuthEpoch,
          };
        },
      });
      const now = new Date();
      const created = await service.create({
        companionId: COMPANION_ID,
        principalId: PRINCIPAL_ID,
        currentProviderSubjectId: CURRENT_SUBJECT,
        currentProviderAuthorityGeneration: 1,
        expectedNewProviderSubjectId: NEW_SUBJECT,
        reason: 'operator confirmed current subject unavailable',
        expiresAt: new Date(now.getTime() + 120_000),
      });
      const callbackTransactionId = randomUUID();
      const proof = {
        provider: 'discord' as const,
        subjectId: NEW_SUBJECT,
        callbackTransactionId,
        proofDigest: digestFleetAuthVerifiedProviderProof({
          provider: 'discord',
          subjectId: NEW_SUBJECT,
          callbackTransactionId,
        }),
      };
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions (
          transaction_id, state_digest, pkce_verifier_digest, callback_uri,
          return_path, kind, status, global_auth_epoch, created_at, expires_at,
          consumed_at, verified_provider, verified_provider_subject_id,
          lifecycle_ceremony_id, lifecycle_action, lifecycle_proof_role,
          initiating_principal_id, initiating_session_id
        ) VALUES (
          $1, $2, $3, 'https://fleet.example.test/auth/discord/callback',
          '/garden', 'recovery', 'consumed', 1, $4, $5,
          $4, 'discord', $6, $7, 'provider.recover', 'new', $8, $9
        )
      `, [
        callbackTransactionId,
        createHash('sha256').update(randomUUID()).digest('hex'),
        createHash('sha256').update(randomUUID()).digest('hex'),
        now,
        new Date(now.getTime() + 120_000),
        NEW_SUBJECT,
        created.ceremonyId,
        PRINCIPAL_ID,
        SESSION_ID,
      ]);
      const common = {
        oneTimeCredential: created.oneTimeCredential,
        confirmation: 'provider.recover',
        reason: 'operator confirmed current subject unavailable',
        newProvider: proof,
        token: context.token,
        csrfToken: context.csrfToken,
        requestOrigin: ORIGIN,
      };
      await expect(service.start(common)).resolves.toMatchObject({
        ceremonyId: created.ceremonyId,
      });
      await expect(service.finish({ ...common, response: { assertion: true } }))
        .resolves.toMatchObject({ authorityGeneration: 2, globalAuthEpoch: 2 });

      const state = await context.pool.query<{
        ceremony_status: string;
        old_state: string;
        new_state: string;
        session_revoked: boolean;
      }>(`
        SELECT ceremony.status AS ceremony_status,
               old_subject.state AS old_state,
               new_subject.state AS new_state,
               session.revoked_at IS NOT NULL AS session_revoked
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies AS ceremony
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS old_subject
          ON old_subject.subject_id = $2
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS new_subject
          ON new_subject.subject_id = $3
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
          ON session.record_id = $4
        WHERE ceremony.ceremony_id = $1
      `, [created.ceremonyId, CURRENT_SUBJECT, NEW_SUBJECT, SESSION_ID]);
      expect(state.rows[0]).toEqual({
        ceremony_status: 'consumed',
        old_state: 'revoked',
        new_state: 'active',
        session_revoked: true,
      });
      await expect(service.start(common)).rejects.toMatchObject({ code: 'ceremony_unavailable' });
      const audits = await context.pool.query<{ decision: string; serialized: string }>(`
        SELECT decision, row_to_json(event)::text AS serialized
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events AS event
        WHERE action LIKE 'authority.provider_recovery.%'
        ORDER BY occurred_at
      `);
      expect(audits.rows.some(row => row.decision === 'deny')).toBe(true);
      const serialized = audits.rows.map(row => row.serialized).join('\n');
      expect(serialized).not.toContain(created.oneTimeCredential);
      expect(serialized).not.toContain(CURRENT_SUBJECT);
      expect(serialized).not.toContain(NEW_SUBJECT);
    } finally {
      await context.pool.end();
      rmSync(context.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('rolls back the PostgreSQL replacement while retaining the fail-closed external fence', async () => {
    const context = await freshContext();
    try {
      const accountAuthority = createGatewayAccountAuthorityFencePort(context.floors);
      const lifecycle = new GatewayFleetAuthAuthorityLifecycleStore({
        pool: context.pool,
        accountAuthority,
      });
      const callbackTransactionId = randomUUID();
      const ceremonyId = randomUUID();
      const decisionId = randomUUID();
      const oneTimeCredential = Buffer.alloc(32, 6).toString('base64url');
      const webAuthnReceipt = Buffer.alloc(32, 7).toString('base64url');
      const decidedAt = new Date();
      const principal = {
        principalId: PRINCIPAL_ID,
        authnVersion: 1,
        authzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
      };
      const proof = {
        provider: 'discord' as const,
        subjectId: NEW_SUBJECT,
        callbackTransactionId,
        proofDigest: digestFleetAuthVerifiedProviderProof({
          provider: 'discord',
          subjectId: NEW_SUBJECT,
          callbackTransactionId,
        }),
      };
      const reasonDigest = 'b'.repeat(64);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions (
          transaction_id, state_digest, pkce_verifier_digest, callback_uri,
          return_path, kind, status, global_auth_epoch, created_at, expires_at,
          consumed_at, verified_provider, verified_provider_subject_id,
          lifecycle_ceremony_id, lifecycle_action, lifecycle_proof_role,
          initiating_principal_id, initiating_session_id
        ) VALUES (
          $1, $2, $3, 'https://fleet.example.test/auth/discord/callback',
          '/garden', 'recovery', 'consumed', 1, $4, $5,
          $4, 'discord', $6, $7, 'provider.recover', 'new', $8, $9
        )
      `, [
        callbackTransactionId,
        createHash('sha256').update(randomUUID()).digest('hex'),
        createHash('sha256').update(randomUUID()).digest('hex'),
        decidedAt,
        new Date(decidedAt.getTime() + 120_000),
        NEW_SUBJECT,
        ceremonyId,
        PRINCIPAL_ID,
        SESSION_ID,
      ]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies (
          ceremony_id, nonce_digest, kind, expected_provider,
          expected_provider_subject_id, expected_companion_id, exact_scope,
          status, global_auth_epoch, created_at, expires_at, protocol_version,
          webauthn_challenge_digest, webauthn_challenge_ciphertext,
          exact_origin, rp_id, credential_floor_generation,
          prior_credential_id_hash, confirmed_at, recovery_receipt_digest,
          recovery_credential_id_hash, recovery_credential_generation
        ) VALUES (
          $1, $2, 'provider_recovery', 'discord', $3, $4, $5::jsonb,
          'pending', 1, $6, $7, 2, $8, $9,
          $10, $11, 1, $12, $6, $13, $12, 1
        )
      `, [
        ceremonyId,
        createHash('sha256').update(oneTimeCredential).digest('hex'),
        NEW_SUBJECT,
        COMPANION_ID,
        JSON.stringify({
          schemaVersion: 1,
          action: 'provider.recover',
          principalId: PRINCIPAL_ID,
          currentProviderSubjectId: CURRENT_SUBJECT,
          currentProviderAuthorityGeneration: 1,
          expectedNewProviderSubjectId: NEW_SUBJECT,
          authorityGeneration: 1,
          globalAuthEpoch: 1,
          reasonDigest,
          principal,
          credentialIdHash: CREDENTIAL_HASH,
          credentialFloorGeneration: 1,
        }),
        decidedAt,
        new Date(decidedAt.getTime() + 120_000),
        createHash('sha256').update('challenge').digest('hex'),
        Buffer.from('ciphertext'),
        ORIGIN,
        'fleet.example.test',
        CREDENTIAL_HASH,
        createHash('sha256').update(webAuthnReceipt).digest('hex'),
      ]);
      const migration = createPostgresPool(context.migrationUrl, { max: 1 });
      try {
        await migration.query(`
          CREATE FUNCTION ${FLEET_AUTH_SCHEMA_NAME}.fail_provider_recovery_insert()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.subject_id = '${NEW_SUBJECT}' THEN
              RAISE EXCEPTION 'simulated provider recovery activation failure';
            END IF;
            RETURN NEW;
          END;
          $$;
          CREATE TRIGGER fail_provider_recovery_insert
          BEFORE INSERT ON ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          FOR EACH ROW EXECUTE FUNCTION ${FLEET_AUTH_SCHEMA_NAME}.fail_provider_recovery_insert()
        `);
      } finally {
        await migration.end();
      }
      await expect(lifecycle.execute({
        verification: 'gateway_verified',
        action: 'provider.recover',
        decisionId,
        ceremonyId,
        actor: principal,
        actorSession: {
          sessionId: SESSION_ID,
          authnVersion: 1,
          authzVersion: 1,
          bindingVersion: 1,
          grantVersion: 1,
          policyVersion: 1,
          globalAuthEpoch: 1,
          provider: 'discord',
          providerSubjectId: CURRENT_SUBJECT,
        },
        target: principal,
        companionId: COMPANION_ID,
        unavailableProvider: {
          provider: 'discord',
          subjectId: CURRENT_SUBJECT,
          authorityGeneration: 1,
        },
        newProvider: proof,
        recovery: {
          oneTimeCredential,
          confirmation: 'provider.recover',
          webAuthnReceipt,
          credentialIdHash: CREDENTIAL_HASH,
          credentialGeneration: 1,
          credentialFloorGeneration: 1,
        },
        authorityGeneration: 1,
        globalAuthEpoch: 1,
        reasonDigest,
        decidedAt,
      })).rejects.toMatchObject({ reasonCode: 'lifecycle_transition_failed' });

      const database = await context.pool.query<{
        old_state: string;
        new_count: string;
        ceremony_status: string;
        session_revoked: boolean;
      }>(`
        SELECT old_subject.state AS old_state,
               (SELECT count(*)::text FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
                WHERE subject_id = $2) AS new_count,
               ceremony.status AS ceremony_status,
               session.revoked_at IS NOT NULL AS session_revoked
        FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS old_subject
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies AS ceremony
          ON ceremony.ceremony_id = $3
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
          ON session.record_id = $4
        WHERE old_subject.subject_id = $1
      `, [CURRENT_SUBJECT, NEW_SUBJECT, ceremonyId, SESSION_ID]);
      expect(database.rows[0]).toEqual({
        old_state: 'active',
        new_count: '0',
        ceremony_status: 'pending',
        session_revoked: false,
      });
      expect(context.floors.isAccountAuthorityTombstoned(
        'provider_subject',
        `discord:${CURRENT_SUBJECT}`,
      )).toBe(true);
      expect(accountAuthority.sessionAuthorityGenerationIsCurrent(1)).toBe(false);
      expect(context.floors.readPasskeys().credentials[0]).toMatchObject({
        expectedProviderSubjectId: NEW_SUBJECT,
        generation: 2,
      });
    } finally {
      await context.pool.end();
      rmSync(context.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
