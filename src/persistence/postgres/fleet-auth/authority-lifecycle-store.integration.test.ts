import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  GatewayFleetAuthAuthorityLifecycleStore,
  FleetAuthLifecycleDeniedError,
} from './authority-lifecycle-store.js';
import {
  digestVerifiedProviderProof,
  type ActorSessionAuthorityClaim,
  type PrincipalAuthorityClaim,
  type VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';
import {
  createGatewayAccountAuthorityFencePort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from './schema.js';

const TIMEOUT_MS = 120_000;
const DIGEST = 'a'.repeat(64);
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

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
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
    store: new GatewayFleetAuthAuthorityLifecycleStore({
      pool,
      accountAuthority: createGatewayAccountAuthorityFencePort(floors),
    }),
  };
}

function claim(principalId: string): PrincipalAuthorityClaim {
  return {
    principalId,
    authnVersion: 1,
    authzVersion: 1,
    bindingVersion: 1,
    grantVersion: 1,
    policyVersion: 1,
  };
}

function providerProof(subjectId: string, callbackTransactionId = randomUUID()) {
  const proof = { provider: 'discord' as const, subjectId, callbackTransactionId };
  return { ...proof, proofDigest: digestVerifiedProviderProof(proof) };
}

function decisionProofs(
  decision: VerifiedFleetAuthLifecycleDecision,
): Array<ReturnType<typeof providerProof>> {
  if (decision.action === 'principal.merge') {
    return [decision.canonicalProvider, decision.sourceProvider];
  }
  const result: Array<ReturnType<typeof providerProof>> = [];
  if ('currentProvider' in decision) {
    result.push(decision.currentProvider);
  }
  if ('newProvider' in decision) {
    result.push(decision.newProvider);
  }
  return result;
}

async function seedDecisionProviderProofs(
  pool: import('pg').Pool,
  decision: VerifiedFleetAuthLifecycleDecision,
): Promise<void> {
  for (const proof of decisionProofs(decision)) {
    const prior = await pool.query(`
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
      WHERE transaction_id = $1
    `, [proof.callbackTransactionId]);
    if (prior.rowCount === 1) continue;
    await pool.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        (transaction_id, state_digest, pkce_verifier_digest, callback_uri,
         return_path, kind, status, global_auth_epoch, created_at, expires_at,
         consumed_at, verified_provider, verified_provider_subject_id)
      VALUES ($1, $2, $3, 'https://fleet.example.test/auth/discord/callback',
              '/garden', 'provider_link', 'consumed', $4, $5, $6, $7, $8, $9)
    `, [
      proof.callbackTransactionId,
      createHash('sha256').update(randomUUID()).digest('hex'),
      createHash('sha256').update(randomUUID()).digest('hex'),
      decision.globalAuthEpoch,
      new Date(decision.decidedAt.getTime() - 2_000),
      new Date(decision.decidedAt.getTime() + 300_000),
      new Date(decision.decidedAt.getTime() - 1_000),
      proof.provider,
      proof.subjectId,
    ]);
  }
}

async function executeDecision(
  context: Awaited<ReturnType<typeof freshContext>>,
  decision: VerifiedFleetAuthLifecycleDecision,
) {
  await seedDecisionProviderProofs(context.pool, decision);
  return await context.store.execute(decision);
}

function sessionFor(principalId: string): ActorSessionAuthorityClaim {
  const session = actorSessions.get(principalId);
  if (!session) throw new Error(`Actor session not seeded for ${principalId}`);
  return session;
}

async function seedActorSession(
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

function baseDecision(
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

async function seedOwnerAndTarget(pool: import('pg').Pool) {
  const actorId = randomUUID();
  const targetId = randomUUID();
  const companionId = randomUUID();
  const actorContactId = randomUUID();
  const targetContactId = randomUUID();
  await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
      (companion_id, lifecycle, authority_generation)
    VALUES ($1, 'active', 1)
  `, [companionId]);
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
    targetContactId,
    actorBindingId,
    targetBindingId,
    actorGrantId,
    targetGrantId,
  };
}

describe('gateway fleet-auth authority lifecycle store', () => {
  it('rejects stale authority after rollback and persists exactly one redacted denial audit', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('role.grant', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        grantId: randomUUID(),
        role: 'admin' as const,
        actorSession: {
          ...sessionFor(seeded.actorId),
          globalAuthEpoch: 999,
        },
        globalAuthEpoch: 999,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, decision)).rejects.toBeInstanceOf(
        FleetAuthLifecycleDeniedError,
      );
      const audit = await context.pool.query<{
        decision: string;
        reason_digest: string;
        decision_context: Record<string, unknown>;
      }>(`
        SELECT decision, reason_digest, decision_context
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        WHERE action = 'role.grant'
      `);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]).toMatchObject({ decision: 'deny', reason_digest: DIGEST });
      expect(JSON.stringify(audit.rows[0]?.decision_context)).not.toContain('223456789012345678');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('revokes the exact proved provider without selecting or revoking another provider', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('provider.unlink', claim(seeded.targetId), claim(seeded.targetId)),
        currentProvider: providerProof('223456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const result = await executeDecision(context, decision);
      expect(result.globalAuthEpoch).toBe(2);
      const subjects = await context.pool.query<{ subject_id: string; state: string }>(`
        SELECT subject_id, state FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        WHERE principal_id = $1 ORDER BY subject_id
      `, [seeded.targetId]);
      expect(subjects.rows).toEqual([
        { subject_id: '223456789012345678', state: 'revoked' },
        { subject_id: '323456789012345678', state: 'active' },
      ]);
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('serializes provider replacement proof replay and never accepts a current-subject substitution', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const callerForged = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        newProvider: providerProof('423456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(context.store.execute(callerForged)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });

      const currentCallback = randomUUID();
      const replacement = {
        ...baseDecision('provider.replace', claim(seeded.targetId), claim(seeded.targetId)),
        currentProvider: providerProof('223456789012345678', currentCallback),
        newProvider: providerProof('423456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, replacement);
      const outcomes = await Promise.allSettled([
        context.store.execute(replacement),
        context.store.execute(replacement),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);

      const substituted = {
        ...replacement,
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        authorityGeneration: 2,
        globalAuthEpoch: 2,
        actor: { ...claim(seeded.targetId), authnVersion: 2 },
        target: { ...claim(seeded.targetId), authnVersion: 2 },
        currentProvider: providerProof('323456789012345678', currentCallback),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      substituted.actorSession = await seedActorSession(
        context.pool,
        substituted.actor,
        '423456789012345678',
        substituted.globalAuthEpoch,
      );
      await expect(executeDecision(context, substituted)).rejects.toBeInstanceOf(
        FleetAuthLifecycleDeniedError,
      );
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('activates the ordinary post-owner binding only for an exact pending provider proof', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const pendingId = randomUUID();
      const bindingId = randomUUID();
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
        VALUES ($1, 'pending', 1)
      `, [pendingId]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
        VALUES ('discord', '523456789012345678', $1, 'pending', 1)
      `, [pendingId]);
      const decision = {
        ...baseDecision('binding.activate', claim(seeded.actorId), claim(pendingId)),
        companionId: seeded.companionId,
        contactId: 'new-contact',
        bindingId,
        newProvider: providerProof('523456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const result = await executeDecision(context, decision);
      expect(result.target).toMatchObject({
        principalId: pendingId,
        authnVersion: 2,
        authzVersion: 2,
        bindingVersion: 2,
        policyVersion: 2,
      });
      const binding = await context.pool.query<{ state: string }>(`
        SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE binding_id = $1
      `, [bindingId]);
      expect(binding.rows[0]?.state).toBe('active');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('adds and relinks new exact provider subjects without disturbing existing subjects', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const add = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        newProvider: providerProof('623456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const added = await executeDecision(context, add);
      await seedActorSession(
        context.pool,
        added.target,
        '223456789012345678',
        added.globalAuthEpoch,
      );
      const relink = {
        ...baseDecision('provider.relink', added.target, added.target),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        authorityGeneration: added.authorityGeneration,
        globalAuthEpoch: added.globalAuthEpoch,
        newProvider: providerProof('723456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, relink);
      const subjects = await context.pool.query<{ subject_id: string; state: string }>(`
        SELECT subject_id, state
        FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        WHERE principal_id = $1 ORDER BY subject_id
      `, [seeded.targetId]);
      expect(subjects.rows).toEqual([
        { subject_id: '223456789012345678', state: 'active' },
        { subject_id: '323456789012345678', state: 'active' },
        { subject_id: '623456789012345678', state: 'active' },
        { subject_id: '723456789012345678', state: 'active' },
      ]);
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('grants, changes with a fresh grant identity, and revokes a bound role', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const principalId = randomUUID();
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          (principal_id, status, authority_generation)
        VALUES ($1, 'active', 1)
      `, [principalId]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
          (provider, subject_id, principal_id, state, authority_generation)
        VALUES ('discord', '823456789012345678', $1, 'active', 1)
      `, [principalId]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation)
        VALUES ($1, $2, $3, 'role-target', 'active', '{"kind":"verified"}', 1)
      `, [randomUUID(), principalId, seeded.companionId]);
      const initialGrantId = randomUUID();
      const grant = {
        ...baseDecision('role.grant', claim(seeded.actorId), claim(principalId)),
        companionId: seeded.companionId,
        grantId: initialGrantId,
        role: 'member' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const granted = await executeDecision(context, grant);
      await seedActorSession(
        context.pool,
        claim(seeded.actorId),
        '123456789012345678',
        granted.globalAuthEpoch,
      );
      const replacementGrantId = randomUUID();
      const change = {
        ...baseDecision('role.change', claim(seeded.actorId), granted.target),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        authorityGeneration: granted.authorityGeneration,
        globalAuthEpoch: granted.globalAuthEpoch,
        companionId: seeded.companionId,
        grantId: initialGrantId,
        newGrantId: replacementGrantId,
        currentRole: 'member' as const,
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const changed = await executeDecision(context, change);
      await seedActorSession(
        context.pool,
        claim(seeded.actorId),
        '123456789012345678',
        changed.globalAuthEpoch,
      );
      const revoke = {
        ...baseDecision('role.revoke', claim(seeded.actorId), changed.target),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        authorityGeneration: changed.authorityGeneration,
        globalAuthEpoch: changed.globalAuthEpoch,
        companionId: seeded.companionId,
        grantId: replacementGrantId,
        currentRole: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, revoke);
      const grants = await context.pool.query<{ grant_id: string; lifecycle: string }>(`
        SELECT grant_id, lifecycle
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE principal_id = $1 ORDER BY created_at, grant_id
      `, [principalId]);
      expect(grants.rows).toEqual(expect.arrayContaining([
        { grant_id: initialGrantId, lifecycle: 'revoked' },
        { grant_id: replacementGrantId, lifecycle: 'revoked' },
      ]));
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('rejects restored principals, live-role conflicts, and last-owner removal', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const conflictingGrant = {
        ...baseDecision('role.grant', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        grantId: randomUUID(),
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, conflictingGrant)).rejects.toBeInstanceOf(
        FleetAuthLifecycleDeniedError,
      );

      const lastOwner = {
        ...baseDecision('role.revoke', claim(seeded.actorId), claim(seeded.actorId)),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        companionId: seeded.companionId,
        grantId: seeded.actorGrantId,
        currentRole: 'owner' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, lastOwner)).rejects.toMatchObject({
        reasonCode: 'last_owner_protected',
      });

      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        SET status = 'quarantined', restore_state = 'quarantined'
        WHERE principal_id = $1
      `, [seeded.targetId]);
      const restored = {
        ...conflictingGrant,
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, restored)).rejects.toMatchObject({
        reasonCode: 'principal_restored_or_missing',
      });
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('fences a contact merge without silently transferring its binding or role', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const merge = {
        ...baseDecision('contact.merge', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        sourceContactId: seeded.targetContactId,
        canonicalContactId: 'canonical-contact',
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, merge);
      const binding = await context.pool.query<{ contact_id: string; state: string }>(`
        SELECT contact_id, state
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE binding_id = $1
      `, [seeded.targetBindingId]);
      expect(binding.rows[0]).toEqual({
        contact_id: seeded.targetContactId,
        state: 'revoked',
      });
      const canonical = await context.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE companion_id = $1 AND contact_id = 'canonical-contact'
      `, [seeded.companionId]);
      expect(canonical.rows[0]?.count).toBe('0');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('merges principals as an immutable alias without unioning roles, contacts, or provider ownership', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('principal.merge', claim(seeded.actorId), claim(seeded.actorId)),
        source: claim(seeded.targetId),
        canonicalProvider: providerProof('123456789012345678'),
        sourceProvider: providerProof('223456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const result = await executeDecision(context, decision);
      expect(result.globalAuthEpoch).toBe(2);
      const alias = await context.pool.query<{
        source_principal_id: string;
        canonical_principal_id: string;
      }>(`
        SELECT source_principal_id, canonical_principal_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
      `);
      expect(alias.rows).toEqual([{
        source_principal_id: seeded.targetId,
        canonical_principal_id: seeded.actorId,
      }]);
      const grants = await context.pool.query<{
        principal_id: string;
        role: string;
        lifecycle: string;
      }>(`
        SELECT principal_id, role, lifecycle
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        ORDER BY principal_id
      `);
      expect(grants.rows).toEqual(expect.arrayContaining([
        { principal_id: seeded.actorId, role: 'owner', lifecycle: 'active' },
        { principal_id: seeded.targetId, role: 'member', lifecycle: 'suspended' },
      ]));
      const providers = await context.pool.query<{ principal_id: string; count: string }>(`
        SELECT principal_id, count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        GROUP BY principal_id ORDER BY principal_id
      `);
      expect(providers.rows).toEqual(expect.arrayContaining([
        { principal_id: seeded.actorId, count: '1' },
        { principal_id: seeded.targetId, count: '2' },
      ]));
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('serializes inverse concurrent merges so no cycle can be committed', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const actorToTarget = {
        ...baseDecision('principal.merge', claim(seeded.targetId), claim(seeded.targetId)),
        source: claim(seeded.actorId),
        canonicalProvider: providerProof('223456789012345678'),
        sourceProvider: providerProof('123456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const targetToActor = {
        ...baseDecision('principal.merge', claim(seeded.actorId), claim(seeded.actorId)),
        source: claim(seeded.targetId),
        canonicalProvider: providerProof('123456789012345678'),
        sourceProvider: providerProof('223456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, actorToTarget);
      await seedDecisionProviderProofs(context.pool, targetToActor);
      const outcomes = await Promise.allSettled([
        context.store.execute(actorToTarget),
        context.store.execute(targetToActor),
      ]);
      expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
      const aliases = await context.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
      `);
      expect(aliases.rows[0]?.count).toBe('1');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('removes a companion and permits only a quarantined re-add without authority restoration', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const remove = {
        ...baseDecision('companion.remove', claim(seeded.actorId), claim(seeded.actorId)),
        companionId: seeded.companionId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const removed = await executeDecision(context, remove);
      await seedActorSession(
        context.pool,
        removed.target,
        '123456789012345678',
        removed.globalAuthEpoch,
      );
      const readd = {
        ...baseDecision('companion.readd', removed.target, removed.target),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        companionId: seeded.companionId,
        globalAuthEpoch: removed.globalAuthEpoch,
        authorityGeneration: removed.authorityGeneration,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const readded = await executeDecision(context, readd);
      expect(readded.globalAuthEpoch).toBe(3);
      const companion = await context.pool.query<{ lifecycle: string }>(`
        SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [seeded.companionId]);
      expect(companion.rows[0]?.lifecycle).toBe('quarantined');
      const active = await context.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE companion_id = $1 AND lifecycle = 'active'
      `, [seeded.companionId]);
      expect(active.rows[0]?.count).toBe('0');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('atomically fences sessions, JIT grants, challenges, custody, and Discord evidence', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const sessionId = randomUUID();
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
          (record_id, token_digest, csrf_digest, principal_id, audience, assurance,
           authn_version, authz_version, binding_version, grant_version, policy_version,
           provider, provider_subject_id, global_auth_epoch, idle_expires_at,
           absolute_expires_at)
        VALUES ($1, $2, $3, $4, 'fleet', 'oauth', 1, 1, 1, 1, 1,
                'discord', '223456789012345678', 1,
                clock_timestamp() + interval '10 minutes',
                clock_timestamp() + interval '20 minutes')
      `, [sessionId, 'b'.repeat(64), 'c'.repeat(64), seeded.targetId]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
          (challenge_id, principal_id, browser_session_id, challenge_digest,
           kind, action, resource_digest, global_auth_epoch, expires_at)
        VALUES ($1, $2, $3, $4, 'discord_possession', 'contact.unlink', $5, 1,
                clock_timestamp() + interval '5 minutes')
      `, [randomUUID(), seeded.targetId, sessionId, 'd'.repeat(64), 'e'.repeat(64)]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
          (grant_id, principal_id, browser_session_id, companion_id, subject_scope,
           action, resource_selector, purpose, assurance, memory_revision,
           classifier_evidence_digest, authz_version, binding_version,
           grant_version, policy_version, global_auth_epoch, expires_at)
        VALUES ($1, $2, $3, $4, '{}', 'contact.unlink', '{}', 'test',
                'discord_possession', 1, $5, 1, 1, 1, 1, 1,
                clock_timestamp() + interval '5 minutes')
      `, [randomUUID(), seeded.targetId, sessionId, seeded.companionId, 'f'.repeat(64)]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
          (custody_id, principal_id, provider_subject_id, encrypted_token,
           key_version, global_auth_epoch, expires_at)
        VALUES ($1, $2, '223456789012345678', decode('aa', 'hex'), 1, 1,
                clock_timestamp() + interval '5 minutes')
      `, [randomUUID(), seeded.targetId]);
      await context.pool.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
          (principal_id, provider_subject_id, lifecycle_id, state,
           mutation_generation, global_auth_epoch)
        VALUES ($1, '223456789012345678', $2, 'active', 1, 1)
      `, [seeded.targetId, randomUUID()]);

      const decision = {
        ...baseDecision('contact.unlink', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        contactId: seeded.targetContactId,
        bindingId: seeded.targetBindingId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, decision);
      const fenced = await context.pool.query<{
        session_revoked: boolean;
        challenge_status: string;
        jit_revoked: boolean;
        custody_revoked: boolean;
        evidence_count: string;
      }>(`
        SELECT
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
           WHERE record_id = $1) AS session_revoked,
          (SELECT status FROM ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
           WHERE browser_session_id = $1) AS challenge_status,
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
           WHERE browser_session_id = $1) AS jit_revoked,
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
           WHERE principal_id = $2) AS custody_revoked,
          (SELECT count(*)::text FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
           WHERE principal_id = $2) AS evidence_count
      `, [sessionId, seeded.targetId]);
      expect(fenced.rows[0]).toEqual({
        session_revoked: true,
        challenge_status: 'revoked',
        jit_revoked: true,
        custody_revoked: true,
        evidence_count: '0',
      });
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
