// Shared fixtures for the fleet-auth authority lifecycle store integration
// suites (real containerized PostgreSQL). Extracted so the ADMIN_TOKEN
// operator-approval suite (psfn-framework-ja7n0) reuses the exact seeding.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import {
  isLifecycleOAuthAction,
  lifecycleOAuthKindFor,
  type LifecycleOAuthProofRole,
} from '../../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../../postgres.js';
import { FleetAuthAuthorityFloorStore } from '../authority-floor.js';
import { FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN } from '../authority-lifecycle-audit.js';
import { GatewayFleetAuthAuthorityLifecycleStore } from '../authority-lifecycle-store.js';
import {
  digestVerifiedProviderProof,
  type ActorSessionAuthorityClaim,
  type PrincipalAuthorityClaim,
  type VerifiedFleetAuthLifecycleDecision,
  type VerifiedProviderProof,
} from '../authority-lifecycle-types.js';
import {
  createGatewayAccountAuthorityFencePort,
  reconcileFleetAuthAuthorityState,
} from '../gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from '../schema.js';

const TIMEOUT_MS = 120_000;
export const DIGEST = 'a'.repeat(64);
export const LIFECYCLE_SESSION_PEPPER = 'lifecycle-audit-session-pepper-32bytes';

/** Keyed lifecycle audit digest mirroring the store's HMAC scheme. */
export function keyedLifecycleDigest(value: string): string {
  return createHmac('sha256', LIFECYCLE_SESSION_PEPPER)
    .update(FLEET_AUTH_LIFECYCLE_AUDIT_DIGEST_DOMAIN)
    .update(value)
    .digest('hex');
}
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
const actorSessions = new Map<string, ActorSessionAuthorityClaim>();

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: string): string {
  const password = (PASSWORDS as Readonly<Record<string, string>>)[role];
  if (!password) throw new Error(`No fixture password for role ${role}`);
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/** Register the shared containerized PostgreSQL harness for a lifecycle store suite. */
export function registerLifecycleStoreHarness(): void {
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
}

export async function freshContext() {
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
  const backupUrl = roleUrl(database.databaseUrl, ROLES.backupRestore);
  await migrateFleetAuthSchema({ databaseUrl: migrationUrl, roles: ROLES });
  const pool = createPostgresPool(backupUrl, { max: 6 });
  const floorRoot = mkdtempSync(join(tmpdir(), 'psfn-lifecycle-authority-'));
  chmodSync(floorRoot, 0o700);
  const floors = new FleetAuthAuthorityFloorStore(floorRoot);
  const floor = floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  await reconcileFleetAuthAuthorityState(pool, floor, randomUUID());
  return {
    pool,
    floorRoot,
    floors,
    runtimeUrl: roleUrl(database.databaseUrl, ROLES.runtime),
    store: new GatewayFleetAuthAuthorityLifecycleStore({
      pool,
      accountAuthority: createGatewayAccountAuthorityFencePort(floors),
      sessionPepper: LIFECYCLE_SESSION_PEPPER,
    }),
  };
}

export function claim(principalId: string): PrincipalAuthorityClaim {
  return {
    principalId,
    authnVersion: 1,
    authzVersion: 1,
    bindingVersion: 1,
    grantVersion: 1,
    policyVersion: 1,
  };
}

export function providerProof(
  subjectId: string,
  callbackTransactionId: string = randomUUID(),
): VerifiedProviderProof {
  const proof = { provider: 'discord' as const, subjectId, callbackTransactionId };
  return { ...proof, proofDigest: digestVerifiedProviderProof(proof) };
}

function decisionProofs(
  decision: VerifiedFleetAuthLifecycleDecision,
): Array<{ role: LifecycleOAuthProofRole; proof: VerifiedProviderProof }> {
  if (decision.action === 'principal.merge') {
    return [
      { role: 'canonical', proof: decision.canonicalProvider },
      { role: 'source', proof: decision.sourceProvider },
    ];
  }
  const result: Array<{
    role: LifecycleOAuthProofRole;
    proof: VerifiedProviderProof;
  }> = [];
  if ('currentProvider' in decision) {
    result.push({ role: 'current', proof: decision.currentProvider });
  }
  if ('newProvider' in decision) {
    result.push({ role: 'new', proof: decision.newProvider });
  }
  return result;
}

export async function seedDecisionProviderProofs(
  pool: import('pg').Pool,
  decision: VerifiedFleetAuthLifecycleDecision,
  /** Who initiated the OAuth proof; defaults to the principal actor's session. */
  initiator?: { principalId: string; sessionId: string },
): Promise<void> {
  const proofInitiator = initiator ?? {
    principalId: decision.actor!.principalId,
    sessionId: decision.actorSession!.sessionId,
  };
  const action = decision.action;
  if (!isLifecycleOAuthAction(action)) return;
  for (const { role, proof } of decisionProofs(decision)) {
    const prior = await pool.query(`
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
      WHERE transaction_id = $1
    `, [proof.callbackTransactionId]);
    if (prior.rowCount === 1) continue;
    await pool.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        (transaction_id, state_digest, pkce_verifier_digest, callback_uri,
         return_path, kind, status, global_auth_epoch, created_at, expires_at,
         consumed_at, verified_provider, verified_provider_subject_id,
         lifecycle_ceremony_id, lifecycle_action, lifecycle_proof_role,
         initiating_principal_id, initiating_session_id)
      VALUES ($1, $2, $3, 'https://fleet.example.test/auth/discord/callback',
              '/garden', $4, 'consumed', $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15)
    `, [
      proof.callbackTransactionId,
      createHash('sha256').update(randomUUID()).digest('hex'),
      createHash('sha256').update(randomUUID()).digest('hex'),
      lifecycleOAuthKindFor(action, role),
      decision.globalAuthEpoch,
      new Date(decision.decidedAt.getTime() - 2_000),
      new Date(decision.decidedAt.getTime() + 300_000),
      new Date(decision.decidedAt.getTime() - 1_000),
      proof.provider,
      proof.subjectId,
      decision.ceremonyId,
      decision.action,
      role,
      proofInitiator.principalId,
      proofInitiator.sessionId,
    ]);
  }
}

export async function executeDecision(
  context: Awaited<ReturnType<typeof freshContext>>,
  decision: VerifiedFleetAuthLifecycleDecision,
) {
  await seedDecisionProviderProofs(context.pool, decision);
  return await context.store.execute(decision);
}

export function sessionFor(principalId: string): ActorSessionAuthorityClaim {
  const session = actorSessions.get(principalId);
  if (!session) throw new Error(`Actor session not seeded for ${principalId}`);
  return session;
}

export async function seedActorSession(
  pool: import('pg').Pool,
  actor: PrincipalAuthorityClaim,
  providerSubjectId: string,
  globalAuthEpoch: number,
): Promise<ActorSessionAuthorityClaim> {
  const session: ActorSessionAuthorityClaim = {
    sessionId: randomUUID(),
    authnVersion: actor.authnVersion,
    authzVersion: actor.authzVersion,
    bindingVersion: actor.bindingVersion,
    grantVersion: actor.grantVersion,
    policyVersion: actor.policyVersion,
    globalAuthEpoch,
    provider: 'discord',
    providerSubjectId,
  };
  const tokenDigest = createHash('sha256').update(randomUUID()).digest('hex');
  const csrfDigest = createHash('sha256').update(randomUUID()).digest('hex');
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
      (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
       authn_version, authz_version, binding_version, grant_version, policy_version,
       provider, provider_subject_id, global_auth_epoch, idle_expires_at,
       absolute_expires_at)
    VALUES ($1, $2, $3, $4, 'fleet', 'oauth', $5, $6, $7, $8, $9,
            'discord', $10, $11, clock_timestamp() + interval '10 minutes',
            clock_timestamp() + interval '20 minutes')
  `, [
    session.sessionId,
    tokenDigest,
    csrfDigest,
    actor.principalId,
    actor.authnVersion,
    actor.authzVersion,
    actor.bindingVersion,
    actor.grantVersion,
    actor.policyVersion,
    providerSubjectId,
    globalAuthEpoch,
  ]);
  actorSessions.set(actor.principalId, session);
  return session;
}

export function baseDecision(
  action: VerifiedFleetAuthLifecycleDecision['action'],
  actor: PrincipalAuthorityClaim,
  target: PrincipalAuthorityClaim,
) {
  return {
    verification: 'gateway_verified' as const,
    action,
    decisionId: randomUUID(),
    ceremonyId: randomUUID(),
    actor,
    actorSession: sessionFor(actor.principalId),
    target,
    authorityGeneration: 1,
    globalAuthEpoch: 1,
    reasonDigest: DIGEST,
    decidedAt: new Date(),
  };
}

export function providerContactScope(
  seeded: { companionId: string; targetContactId: string },
  newProvider: VerifiedProviderProof,
) {
  return {
    companionId: seeded.companionId,
    contactId: seeded.targetContactId,
    contactAuthority: {
      schemaVersion: 1 as const,
      contactId: seeded.targetContactId,
      channel: 'discord' as const,
      providerSubjectId: newProvider.subjectId,
      identityVersion: 2,
      verificationId: randomUUID(),
      verificationDigest: 'b'.repeat(64),
      contactAuthorityVersion: 3,
      ownershipState: 'verified' as const,
      restoreState: 'live' as const,
    },
  };
}

export async function promoteProviderLifecycleTargetToOwner(
  pool: import('pg').Pool,
  seeded: { targetGrantId: string },
): Promise<void> {
  await pool.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    SET role = 'owner'
    WHERE grant_id = $1
  `, [seeded.targetGrantId]);
}

export async function seedOwnerAndTarget(pool: import('pg').Pool) {
  if (!harness) throw new Error('Postgres harness unavailable');
  const actorId = randomUUID();
  const targetId = randomUUID();
  const companionId = randomUUID();
  const actorContactId = randomUUID();
  const targetContactId = randomUUID();
  const database = await pool.query<{ current_database: string }>(
    'SELECT current_database() AS current_database',
  );
  const databaseName = database.rows.at(0)?.current_database;
  if (!databaseName) throw new Error('Lifecycle fixture database identity is unavailable');
  const ownerUrl = new URL(harness.adminDatabaseUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = createPostgresPool(roleUrl(ownerUrl.toString(), ROLES.migration), { max: 1 });
  try {
    await owner.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        (companion_id, lifecycle, authority_generation)
      VALUES ($1, 'active', 1)
    `, [companionId]);
  } finally {
    await owner.end();
  }
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      (principal_id, status, authority_generation)
    VALUES ($1, 'active', 1), ($2, 'active', 1)
  `, [actorId, targetId]);
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      (provider, subject_id, principal_id, state, authority_generation)
    VALUES ('discord', '123456789012345678', $1, 'active', 1),
           ('discord', '223456789012345678', $2, 'active', 1),
           ('discord', '323456789012345678', $2, 'active', 1)
  `, [actorId, targetId]);
  const actorBindingId = randomUUID();
  const targetBindingId = randomUUID();
  const actorGrantId = randomUUID();
  const targetGrantId = randomUUID();
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      (binding_id, principal_id, companion_id, contact_id,
       state, verification_provenance, authority_generation)
    VALUES ($1, $2, $3, $4, 'active', '{"kind":"verified"}', 1),
           ($5, $6, $3, $7, 'active', '{"kind":"verified"}', 1)
  `, [
    actorBindingId,
    actorId,
    companionId,
    actorContactId,
    targetBindingId,
    targetId,
    targetContactId,
  ]);
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      (grant_id, principal_id, companion_id, role, lifecycle, authority_generation)
    VALUES ($1, $2, $3, 'owner', 'active', 1),
           ($4, $5, $3, 'member', 'active', 1)
  `, [
    actorGrantId,
    actorId,
    companionId,
    targetGrantId,
    targetId,
  ]);
  await seedActorSession(pool, claim(actorId), '123456789012345678', 1);
  await seedActorSession(pool, claim(targetId), '223456789012345678', 1);
  return {
    actorId,
    targetId,
    companionId,
    actorContactId,
    targetContactId,
    actorBindingId,
    targetBindingId,
    actorGrantId,
    targetGrantId,
  };
}
