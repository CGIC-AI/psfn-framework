import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../postgres.js';
import { FleetAuthAuthorityFloorStore } from './authority-floor.js';
import {
  GatewayFleetAuthAuthorityLifecycleStore,
  FleetAuthLifecycleDeniedError,
} from './authority-lifecycle-store.js';
import type { VerifiedFleetAuthLifecycleDecision } from './authority-lifecycle-types.js';
import {
  createGatewayAccountAuthorityFencePort,
  reconcileFleetAuthAuthorityState,
} from './gateway-persistence.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { recordAdminTokenLifecycleApproval } from './admin-token-lifecycle-approval.js';
import { executeOperatorAccountAction } from './operator-account-authority.js';
import { GatewayOperatorAccountAuthorityService } from '../../../boundary/fleet-auth/operator-account-authority.js';
import {
  DIGEST,
  LIFECYCLE_SESSION_PEPPER,
  baseDecision,
  claim,
  executeDecision,
  freshContext,
  keyedLifecycleDigest,
  promoteProviderLifecycleTargetToOwner,
  providerContactScope,
  providerProof,
  registerLifecycleStoreHarness,
  seedActorSession,
  seedDecisionProviderProofs,
  seedOwnerAndTarget,
  sessionFor,
} from './fixtures/authority-lifecycle-store.js';

// Timeout-margin policy (see src/test-support/integration-timeout-registry.json):
// see the registered entry for this file.
const TIMEOUT_MS = 120_000;

registerLifecycleStoreHarness();

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

      // Regression (psfn-framework-5wrp): the actor's Discord snowflake is the
      // enumerable deanonymization oracle. Its audit digest must be keyed HMAC —
      // hashing the known snowflake with plain SHA-256 must NOT reproduce it.
      const actorSession = audit.rows[0]?.decision_context.actorSession as
        Record<string, unknown> | undefined;
      const snowflake = '123456789012345678';
      expect(actorSession?.providerSubjectDigest).toBe(keyedLifecycleDigest(snowflake));
      expect(actorSession?.providerSubjectDigest)
        .not.toBe(createHash('sha256').update(snowflake).digest('hex'));
      // The structural principalId digest stays unkeyed by design (shared with
      // the recovery-reconciliation writer; a non-enumerable UUID).
      const actorClaim = audit.rows[0]?.decision_context.actor as
        Record<string, unknown> | undefined;
      expect(actorClaim?.principalDigest)
        .toBe(createHash('sha256').update(seeded.actorId).digest('hex'));
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
      await promoteProviderLifecycleTargetToOwner(context.pool, seeded);
      const callerForgedProvider = providerProof('423456789012345678');
      const callerForged = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, callerForgedProvider),
        newProvider: callerForgedProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(context.store.execute(callerForged)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });

      const currentCallback = randomUUID();
      const replacementProvider = providerProof('423456789012345678');
      const replacement = {
        ...baseDecision('provider.replace', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, replacementProvider),
        currentProvider: providerProof('223456789012345678', currentCallback),
        newProvider: replacementProvider,
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

  it('rejects OAuth proof reuse across lifecycle action, ceremony, and proof role', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const seededReplacement = providerProof('423456789012345678');
      const seededPurpose = {
        ...baseDecision('provider.replace', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, seededReplacement),
        currentProvider: providerProof('223456789012345678'),
        newProvider: seededReplacement,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, seededPurpose);

      const crossAction = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, seededPurpose.newProvider),
        ceremonyId: seededPurpose.ceremonyId,
        newProvider: seededPurpose.newProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, crossAction)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });

      const crossCeremony = {
        ...seededPurpose,
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, crossCeremony)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });

      const wrongRoleProvider = providerProof('523456789012345678');
      const wrongRole = {
        ...seededPurpose,
        ...providerContactScope(seeded, wrongRoleProvider),
        decisionId: randomUUID(),
        currentProvider: seededPurpose.newProvider,
        newProvider: wrongRoleProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(context.store.execute(wrongRole)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });

      const wrongSessionProvider = providerProof('623456789012345678');
      const wrongSession = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, wrongSessionProvider),
        newProvider: wrongSessionProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, wrongSession);
      const otherSession = await seedActorSession(
        context.pool,
        claim(seeded.targetId),
        '223456789012345678',
        1,
      );
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
        SET initiating_session_id = $2
        WHERE transaction_id = $1
      `, [wrongSession.newProvider.callbackTransactionId, otherSession.sessionId]);
      await expect(context.store.execute(wrongSession)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });
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
        contactAuthority: {
          schemaVersion: 1,
          contactId: 'new-contact',
          channel: 'discord',
          providerSubjectId: '523456789012345678',
          identityVersion: 2,
          verificationId: randomUUID(),
          verificationDigest: 'c'.repeat(64),
          contactAuthorityVersion: 3,
          ownershipState: 'verified',
          restoreState: 'live',
        },
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
      await promoteProviderLifecycleTargetToOwner(context.pool, seeded);
      const addedProvider = providerProof('623456789012345678');
      const add = {
        ...baseDecision('provider.add', claim(seeded.targetId), claim(seeded.targetId)),
        ...providerContactScope(seeded, addedProvider),
        newProvider: addedProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const added = await executeDecision(context, add);
      await seedActorSession(
        context.pool,
        added.target,
        '223456789012345678',
        added.globalAuthEpoch,
      );
      const relinkProvider = providerProof('723456789012345678');
      const relink = {
        ...baseDecision('provider.relink', added.target, added.target),
        ...providerContactScope(seeded, relinkProvider),
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        authorityGeneration: added.authorityGeneration,
        globalAuthEpoch: added.globalAuthEpoch,
        newProvider: relinkProvider,
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

  it('protects the last active owner from a contact.delete of their bound contact', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const remove = {
        ...baseDecision('contact.delete', claim(seeded.actorId), claim(seeded.actorId)),
        companionId: seeded.companionId,
        contactId: seeded.actorContactId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, remove)).rejects.toMatchObject({
        reasonCode: 'last_owner_protected',
      });
      const grant = await context.pool.query<{ lifecycle: string }>(`
        SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE grant_id = $1
      `, [seeded.actorGrantId]);
      expect(grant.rows[0]?.lifecycle).toBe('active');
      const binding = await context.pool.query<{ state: string }>(`
        SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE binding_id = $1
      `, [seeded.actorBindingId]);
      expect(binding.rows[0]?.state).toBe('active');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('protects the last active owner from a contact.merge of their bound contact', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const merge = {
        ...baseDecision('contact.merge', claim(seeded.actorId), claim(seeded.actorId)),
        companionId: seeded.companionId,
        sourceContactId: seeded.actorContactId,
        canonicalContactId: 'canonical-owner-contact',
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, merge)).rejects.toMatchObject({
        reasonCode: 'last_owner_protected',
      });
      const grant = await context.pool.query<{ lifecycle: string }>(`
        SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE grant_id = $1
      `, [seeded.actorGrantId]);
      expect(grant.rows[0]?.lifecycle).toBe('active');
      const binding = await context.pool.query<{ state: string }>(`
        SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE binding_id = $1
      `, [seeded.actorBindingId]);
      expect(binding.rows[0]?.state).toBe('active');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('deletes a non-owner contact and suspends only the member grant', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const remove = {
        ...baseDecision('contact.delete', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        contactId: seeded.targetContactId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, remove);
      const memberBinding = await context.pool.query<{ state: string }>(`
        SELECT state FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE binding_id = $1
      `, [seeded.targetBindingId]);
      expect(memberBinding.rows[0]?.state).toBe('revoked');
      const memberGrant = await context.pool.query<{ lifecycle: string }>(`
        SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE grant_id = $1
      `, [seeded.targetGrantId]);
      expect(memberGrant.rows[0]?.lifecycle).toBe('suspended');
      const ownerGrant = await context.pool.query<{ lifecycle: string }>(`
        SELECT lifecycle FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE grant_id = $1
      `, [seeded.actorGrantId]);
      expect(ownerGrant.rows[0]?.lifecycle).toBe('active');
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

  it('keeps a fresh companion lineage quarantined against backup-role update sequences', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const remove = {
        ...baseDecision('companion.remove', claim(seeded.actorId), claim(seeded.actorId)),
        companionId: seeded.companionId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      const removed = await executeDecision(context, remove);
      const attempt = async (statements: readonly string[]): Promise<void> => {
        const attacker = await context.pool.connect();
        try {
          await attacker.query('BEGIN');
          await expect((async () => {
            for (const statement of statements) {
              await attacker.query(statement, [seeded.companionId]);
            }
          })()).rejects.toThrow(/permission denied|operator_reinstate_companion/i);
        } finally {
          await attacker.query('ROLLBACK');
          attacker.release();
        }
      };
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET lifecycle = 'active' WHERE companion_id = $1`,
      ]);
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET version = version + 1, authority_generation = authority_generation + 1
         WHERE companion_id = $1`,
      ]);
      const attacker = await context.pool.connect();
      try {
        const admittedDecisionId = randomUUID();
        const substitutedDecisionId = randomUUID();
        const lineageId = createHash('sha256').update(randomUUID()).digest('hex');
        const lineageGeneration = removed.authorityGeneration + 1;
        await attacker.query('BEGIN');
        await attacker.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
            (kind, resource_hash, authority_generation, companion_lineage_id,
             companion_readd_decision_id)
          VALUES ('companion_lineage_floor',
                  encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), $2, $3, $4)
        `, [seeded.companionId, lineageGeneration, lineageId, admittedDecisionId]);
        await expect(attacker.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
          SET lifecycle = 'quarantined', version = version + 1,
              authority_generation = $2, authority_lineage_id = $3,
              lineage_generation = $2, readd_decision_id = $4
          WHERE companion_id = $1
        `, [
          seeded.companionId,
          lineageGeneration,
          lineageId,
          substitutedDecisionId,
        ])).rejects.toThrow(/operator_reinstate_companion/i);
      } finally {
        await attacker.query('ROLLBACK');
        attacker.release();
      }
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
      await executeDecision(context, readd);

      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET lifecycle = 'removed' WHERE companion_id = $1`,
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET lifecycle = 'active' WHERE companion_id = $1`,
      ]);
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET lifecycle = 'active' WHERE companion_id = $1`,
      ]);
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET lifecycle = 'removed', authority_lineage_id = NULL,
             lineage_generation = NULL, readd_decision_id = NULL
         WHERE companion_id = $1`,
      ]);
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET version = version + 1 WHERE companion_id = $1`,
      ]);
      await attempt([
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         WHERE companion_id = $1`,
      ]);
      await attempt([
        `UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         SET companion_id = gen_random_uuid() WHERE companion_id = $1`,
      ]);
      await attempt([
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
           (companion_id, lifecycle, version, authority_generation, restore_state)
         SELECT gen_random_uuid(), 'active', version, authority_generation, 'live'
         FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
         WHERE companion_id = $1
         ON CONFLICT (companion_id) DO UPDATE
         SET lifecycle = EXCLUDED.lifecycle, restore_state = EXCLUDED.restore_state`,
      ]);

      const durable = await context.pool.query<{
        lifecycle: string;
        restore_state: string;
        version: string;
        authority_lineage_id: string;
        lineage_generation: string;
        readd_decision_id: string;
      }>(`
        SELECT lifecycle, restore_state, version, authority_lineage_id,
               lineage_generation, readd_decision_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [seeded.companionId]);
      expect(durable.rows[0]).toMatchObject({
        lifecycle: 'quarantined',
        restore_state: 'live',
        version: '3',
        lineage_generation: '3',
        readd_decision_id: readd.decisionId,
      });
      expect(durable.rows[0]?.authority_lineage_id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('reinstates a fresh same-id companion authority after remove and re-add through the audited operator', async () => {
    const context = await freshContext();
    const runtime = createPostgresPool(context.runtimeUrl, { max: 2 });
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
      await executeDecision(context, readd);
      await expect(context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        SET lifecycle = 'active'
        WHERE companion_id = $1
      `, [seeded.companionId])).rejects.toThrow(/operator_reinstate_companion/i);

      const companion = await context.pool.query<{
        version: string;
        authority_lineage_id: string;
        lineage_generation: string;
        readd_decision_id: string;
      }>(`
        SELECT version, authority_lineage_id, lineage_generation, readd_decision_id
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        WHERE companion_id = $1
      `, [seeded.companionId]);
      const companionVersion = Number(companion.rows[0]?.version);
      const reinstate = async (pool: import('pg').Pool, version = companionVersion) => {
        const auditEventId = randomUUID();
        const approval = await recordAdminTokenLifecycleApproval(runtime, {
          decisionId: auditEventId,
          ceremonyId: randomUUID(),
          companionId: seeded.companionId,
          lifecycleAction: 'companion.reinstate',
        });
        return await executeOperatorAccountAction(pool, {
          request: { action: 'companion.reinstate', companionId: seeded.companionId, companionVersion: version },
          approvalEventId: approval.authorizationEventId,
          auditEventId,
        });
      };
      // The backup/restore coordinator never reinstates.
      await expect(reinstate(context.pool)).rejects.toThrow(/permission denied/i);
      const substitutedDecisionId = randomUUID();
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        SET companion_readd_decision_id = $2
        WHERE kind = 'companion_lineage_floor'
          AND resource_hash = encode(sha256(convert_to($1::text, 'UTF8')), 'hex')
      `, [seeded.companionId, substitutedDecisionId]);
      await expect(reinstate(runtime)).rejects.toThrow(/non-restored floor|not admitted/i);
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_floor_tombstone_projection
        SET companion_readd_decision_id = $2
        WHERE kind = 'companion_lineage_floor'
          AND resource_hash = encode(sha256(convert_to($1::text, 'UTF8')), 'hex')
      `, [seeded.companionId, companion.rows[0]!.readd_decision_id]);
      // An approval without its own exact audit identity cannot be spent.
      const stray = await recordAdminTokenLifecycleApproval(runtime, {
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        companionId: seeded.companionId,
        lifecycleAction: 'companion.reinstate',
      });
      await expect(executeOperatorAccountAction(runtime, {
        request: { action: 'companion.reinstate', companionId: seeded.companionId, companionVersion },
        approvalEventId: stray.authorizationEventId,
        auditEventId: randomUUID(),
      })).rejects.toThrow(/approval is missing, stale/i);

      const approved = await reinstate(runtime);
      expect(approved).toMatchObject({ action: 'companion.reinstate', companionId: seeded.companionId });
      // Once live, the same version cannot be reinstated again.
      await expect(reinstate(runtime)).rejects.toThrow(/stale|not a quarantined|approval is missing/i);
      const request = {
        lineageId: companion.rows[0]!.authority_lineage_id,
        lineageGeneration: Number(companion.rows[0]?.lineage_generation),
        companionVersion,
        readdDecisionId: companion.rows[0]!.readd_decision_id,
        auditEventId: approved.auditEventId,
      };

      const durable = await context.pool.query<{
        lifecycle: string;
        version: string;
        authority_lineage_id: string;
        lineage_generation: string;
        active_bindings: string;
        active_grants: string;
        active_sessions: string;
      }>(`
        SELECT companion.lifecycle, companion.version, companion.authority_lineage_id,
               companion.lineage_generation,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
                WHERE companion_id = companion.companion_id AND state = 'active') AS active_bindings,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
                WHERE companion_id = companion.companion_id AND lifecycle = 'active') AS active_grants,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
                WHERE principal_id = ANY($2::uuid[]) AND revoked_at IS NULL) AS active_sessions
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
        WHERE companion.companion_id = $1
      `, [seeded.companionId, [seeded.actorId, seeded.targetId]]);
      expect(durable.rows[0]).toEqual({
        lifecycle: 'active',
        version: String(request.companionVersion + 1),
        authority_lineage_id: request.lineageId,
        lineage_generation: String(request.lineageGeneration),
        active_bindings: '0',
        active_grants: '0',
        active_sessions: '0',
      });
      const audit = await context.pool.query<{
        action: string;
        decision: string;
        reason_code: string;
        companion_id: string;
        authority_generation: string;
        global_auth_epoch: string;
        decision_context: Record<string, unknown>;
      }>(`
        SELECT action, decision, reason_code, companion_id,
               authority_generation, global_auth_epoch, decision_context
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        WHERE event_id = $1
      `, [request.auditEventId]);
      expect(audit.rows[0]).toMatchObject({
        action: 'companion.reinstate',
        decision: 'allow',
        reason_code: 'admin_token_operator_account_lifecycle',
        companion_id: seeded.companionId,
        authority_generation: String(approved.authorityGeneration),
        global_auth_epoch: String(approved.globalAuthEpoch),
        decision_context: {
          schemaVersion: 1,
          action: 'companion.reinstate',
          beforeVersion: request.companionVersion,
          afterVersion: request.companionVersion + 1,
        },
      });

      // Account authority removed with the companion stays tombstoned.
      const service = new GatewayOperatorAccountAuthorityService({
        canonicalOrigin: 'https://fleet.example.test',
        ports: {
          recordApproval: input => recordAdminTokenLifecycleApproval(runtime, input),
          execute: input => executeOperatorAccountAction(runtime, input),
          isAccountAuthorityTombstoned: (kind, id) => (
            new FleetAuthAuthorityFloorStore(context.floorRoot).isAccountAuthorityTombstoned(kind, id)
          ),
        },
      });
      await expect(service.complete({
        requestOrigin: 'https://fleet.example.test',
        request: {
          action: 'principal.reinstate',
          ceremonyId: randomUUID(),
          companionId: seeded.companionId,
          principalId: seeded.actorId,
          bindingId: seeded.actorBindingId,
          roleGrantId: seeded.actorGrantId,
        },
      })).rejects.toThrow(/permanently tombstoned/);

    } finally {
      await Promise.all([context.pool.end(), runtime.end()]);
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('reconciles an exact companion re-add after floor publication loses its acknowledgement', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const floors = new FleetAuthAuthorityFloorStore(context.floorRoot);
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
      const authority = createGatewayAccountAuthorityFencePort(floors);
      const storeWithLostPublicationAck = new GatewayFleetAuthAuthorityLifecycleStore({
        pool: context.pool,
        sessionPepper: LIFECYCLE_SESSION_PEPPER,
        accountAuthority: {
          ...authority,
          beginCompanionReadd: async input => {
            await authority.beginCompanionReadd(input);
            throw new Error('simulated lost floor publication acknowledgement');
          },
        },
      });
      await expect(storeWithLostPublicationAck.execute(readd)).rejects.toMatchObject({
        reasonCode: 'companion_readd_pending_reconciliation',
      });

      const beforeRecovery = await context.pool.query<{
        authority_generation: string;
        global_auth_epoch: string;
        lifecycle: string;
        version: string;
        audit_count: string;
      }>(`
        SELECT authority.authority_generation, authority.global_auth_epoch,
               companion.lifecycle, companion.version,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
                WHERE decision_id = $2) AS audit_count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
          ON companion.companion_id = $1
        WHERE authority.singleton = TRUE
      `, [seeded.companionId, readd.decisionId]);
      expect(beforeRecovery.rows[0]).toEqual({
        authority_generation: '2',
        global_auth_epoch: '2',
        lifecycle: 'removed',
        version: '2',
        audit_count: '0',
      });
      expect(floors.findCompanionAuthorityReadd(seeded.companionId)).toMatchObject({
        lineageGeneration: 3,
        authorityGeneration: 3,
        entry: { companionReadd: { decisionId: readd.decisionId } },
      });

      await reconcileFleetAuthAuthorityState(context.pool, floors.read(), randomUUID());
      const replayed = await context.store.execute(readd);
      expect(replayed).toMatchObject({
        decisionId: readd.decisionId,
        action: 'companion.readd',
        authorityGeneration: 3,
        globalAuthEpoch: 3,
        target: {
          principalId: seeded.actorId,
          authzVersion: removed.target.authzVersion + 1,
          bindingVersion: removed.target.bindingVersion + 1,
          grantVersion: removed.target.grantVersion + 1,
          policyVersion: removed.target.policyVersion + 1,
        },
      });
      await expect(context.store.execute({
        ...readd,
        ceremonyId: randomUUID(),
      })).rejects.toMatchObject({ reasonCode: 'lifecycle_decision_terminal' });

      const recovered = await context.pool.query<{
        lifecycle: string;
        authority_lineage_id: string;
        lineage_generation: string;
        active_bindings: string;
        active_grants: string;
        audit_count: string;
      }>(`
        SELECT companion.lifecycle, companion.authority_lineage_id,
               companion.lineage_generation,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
                WHERE companion_id = companion.companion_id AND state = 'active') AS active_bindings,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
                WHERE companion_id = companion.companion_id AND lifecycle = 'active') AS active_grants,
               (SELECT count(*)::text
                FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
                WHERE decision_id = $2) AS audit_count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
        WHERE companion.companion_id = $1
      `, [seeded.companionId, readd.decisionId]);
      expect(recovered.rows[0]).toMatchObject({
        lifecycle: 'quarantined',
        lineage_generation: '3',
        active_bindings: '0',
        active_grants: '0',
        audit_count: '1',
      });
      expect(recovered.rows[0]?.authority_lineage_id).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('atomically fences sessions, escalation grants, custody, and Discord evidence', async () => {
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
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
          (grant_id, principal_id, browser_session_id, companion_id, action,
           route_id, scope_digest, reason_digest, assurance_requirement,
           exact_origin, authz_version, binding_version, grant_version,
           policy_version, global_auth_epoch, created_at, expires_at)
        VALUES ($1, $2, $3, $4, 'memory.reveal',
                'POST /api/admin/memory/:id/reveal', $5, $6, 'escalated',
                'https://fleet.example.test', 1, 1, 1, 1, 1,
                clock_timestamp(), clock_timestamp() + interval '5 minutes')
      `, [
        randomUUID(), seeded.targetId, sessionId, seeded.companionId,
        'e'.repeat(64), 'f'.repeat(64),
      ]);
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
        escalation_revoked: boolean;
        custody_revoked: boolean;
        evidence_count: string;
      }>(`
        SELECT
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
           WHERE record_id = $1) AS session_revoked,
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
           WHERE browser_session_id = $1) AS escalation_revoked,
          (SELECT revoked_at IS NOT NULL FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
           WHERE principal_id = $2) AS custody_revoked,
          (SELECT count(*)::text FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
           WHERE principal_id = $2) AS evidence_count
      `, [sessionId, seeded.targetId]);
      expect(fenced.rows[0]).toEqual({
        session_revoked: true,
        escalation_revoked: true,
        custody_revoked: true,
        evidence_count: '0',
      });
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('keeps a denied decision terminal when its rejected state later becomes valid', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('role.grant', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        grantId: randomUUID(),
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, decision)).rejects.toBeInstanceOf(
        FleetAuthLifecycleDeniedError,
      );
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = 'revoked'
        WHERE grant_id = $1
      `, [seeded.targetGrantId]);

      await expect(executeDecision(context, decision)).rejects.toMatchObject({
        reasonCode: 'lifecycle_decision_terminal',
      });
      const granted = await context.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE grant_id = $1
      `, [decision.grantId]);
      expect(granted.rows[0]?.count).toBe('0');
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('rejects decision-id reuse after authority reconciliation removes ephemeral receipts', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('role.grant', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        grantId: randomUUID(),
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(executeDecision(context, decision)).rejects.toBeInstanceOf(
        FleetAuthLifecycleDeniedError,
      );
      const floors = new FleetAuthAuthorityFloorStore(context.floorRoot);
      const advanced = floors.revokeAccountAuthority({
        kind: 'contact_binding',
        resourceId: seeded.targetBindingId,
        reason: DIGEST,
        at: new Date().toISOString(),
      });
      await reconcileFleetAuthAuthorityState(context.pool, advanced, randomUUID());
      const receipts = await context.pool.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.lifecycle_decision_receipts
        WHERE decision_id = $1
      `, [decision.decisionId]);
      expect(receipts.rows[0]?.count).toBe('0');

      await expect(context.store.execute(decision)).rejects.toMatchObject({
        reasonCode: 'lifecycle_decision_terminal',
      });
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('publishes immutable source-principal authority before principal merge SQL mutation', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('principal.merge', claim(seeded.actorId), claim(seeded.actorId)),
        source: claim(seeded.targetId),
        canonicalProvider: providerProof('123456789012345678'),
        sourceProvider: providerProof('223456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, decision);
      const floor = new FleetAuthAuthorityFloorStore(context.floorRoot).read();
      expect(floor.trustedHost.tombstones).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'principal' }),
      ]));
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('publishes companion-only floor authority before companion removal SQL mutation', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      const decision = {
        ...baseDecision('companion.remove', claim(seeded.actorId), claim(seeded.actorId)),
        companionId: seeded.companionId,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, decision);
      const floor = new FleetAuthAuthorityFloorStore(context.floorRoot).read();
      expect(floor.trustedHost.tombstones).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'companion' }),
      ]));
      expect(floor.trustedHost.tombstones).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'provider_subject' }),
      ]));
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  it('writes resource-complete redacted audit evidence that distinguishes exact role mutations', async () => {
    const context = await freshContext();
    try {
      const seeded = await seedOwnerAndTarget(context.pool);
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET version = 7
        WHERE grant_id = $1
      `, [seeded.targetGrantId]);
      const decision = {
        ...baseDecision('role.change', claim(seeded.actorId), claim(seeded.targetId)),
        companionId: seeded.companionId,
        grantId: seeded.targetGrantId,
        newGrantId: randomUUID(),
        currentRole: 'member' as const,
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await executeDecision(context, decision);
      const audit = await context.pool.query<{
        resource: string;
        principal_id: string | null;
        companion_id: string | null;
        decision_context: Record<string, unknown>;
      }>(`
        SELECT resource, principal_id, companion_id, decision_context
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        WHERE decision_id = $1
      `, [decision.decisionId]);
      expect(audit.rows[0]).toMatchObject({
        resource: expect.stringMatching(/^lifecycle:role\.change:[0-9a-f]{64}$/u),
        principal_id: null,
        companion_id: null,
        decision_context: {
          action: 'role.change',
          oldRole: 'member',
          newRole: 'admin',
          authorityClaim: { authorityGeneration: 1, globalAuthEpoch: 1 },
          actorSession: expect.objectContaining({
            sessionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            providerSubjectDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          }),
          resourceClaims: expect.objectContaining({
            companionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            grantDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
            replacementGrantDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          }),
        },
      });
      const encoded = JSON.stringify(audit.rows[0]);
      expect(encoded).not.toContain(seeded.actorId);
      expect(encoded).not.toContain(seeded.targetId);
      expect(encoded).not.toContain(seeded.companionId);
      expect(encoded).not.toContain(seeded.targetGrantId);
      const integrationContract = await context.pool.query<{
        actor_authority_generation: string;
        actor_session_epoch: string;
        actor_session_revoked_at: Date | null;
        target_grant_version: string;
        old_resource_version: string;
        new_resource_version: string;
      }>(`
        SELECT
          (SELECT authority_generation::text
           FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
           WHERE principal_id = $1) AS actor_authority_generation,
          (SELECT global_auth_epoch::text
           FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
           WHERE record_id = $2) AS actor_session_epoch,
          (SELECT revoked_at
           FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
           WHERE record_id = $2) AS actor_session_revoked_at,
          (SELECT grant_version::text
           FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
           WHERE principal_id = $3) AS target_grant_version,
          (SELECT version::text
           FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
           WHERE grant_id = $4) AS old_resource_version,
          (SELECT version::text
           FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
           WHERE grant_id = $5) AS new_resource_version
      `, [
        seeded.actorId,
        decision.actorSession.sessionId,
        seeded.targetId,
        seeded.targetGrantId,
        decision.newGrantId,
      ]);
      expect(integrationContract.rows[0]).toEqual({
        actor_authority_generation: '1',
        actor_session_epoch: '2',
        actor_session_revoked_at: null,
        target_grant_version: '2',
        old_resource_version: '8',
        new_resource_version: '8',
      });
    } finally {
      await context.pool.end();
      rmSync(context.floorRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
