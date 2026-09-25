// psfn-framework-ja7n0: the audited ADMIN_TOKEN operator is the approving
// authority of the binding, provider-link and role ceremonies against real
// PostgreSQL. It replaces only the approving companion owner/administrator:
// every provider proof must still be the SUBJECT's own session-initiated
// Discord OAuth, the approval is a durable `admin_token_operator` audit row
// bound to exactly one decision and authority snapshot, and everything else
// fails closed.
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../postgres.js';
import { recordAdminTokenLifecycleApproval } from './admin-token-lifecycle-approval.js';
import type {
  PrincipalAuthorityClaim,
  VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import {
  DIGEST,
  claim,
  freshContext,
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

type Context = Awaited<ReturnType<typeof freshContext>>;
type OperatorAction = 'binding.activate' | 'provider.add' | 'role.grant' | 'role.change';

async function operatorBase(
  context: Context,
  input: {
    action: OperatorAction;
    companionId: string;
    target: PrincipalAuthorityClaim;
  },
) {
  const decisionId = randomUUID();
  const ceremonyId = randomUUID();
  // The gateway records approvals through its fleet-auth runtime pool.
  const runtime = createPostgresPool(context.runtimeUrl, { max: 1 });
  let approved: Awaited<ReturnType<typeof recordAdminTokenLifecycleApproval>>;
  try {
    approved = await recordAdminTokenLifecycleApproval(runtime, {
      decisionId,
      ceremonyId,
      companionId: input.companionId,
      lifecycleAction: input.action,
    });
  } finally {
    await runtime.end();
  }
  return {
    verification: 'gateway_verified' as const,
    action: input.action,
    decisionId,
    ceremonyId,
    operator: {
      kind: 'admin_token_operator' as const,
      authorizationEventId: approved.authorizationEventId,
    },
    target: input.target,
    authorityGeneration: approved.authorityGeneration,
    globalAuthEpoch: approved.globalAuthEpoch,
    reasonDigest: DIGEST,
    decidedAt: new Date(),
  };
}

async function seedPendingSubject(context: Context, subjectId: string) {
  const pendingId = randomUUID();
  await context.pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      (principal_id, status, authority_generation)
    VALUES ($1, 'pending', 1)
  `, [pendingId]);
  await context.pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      (provider, subject_id, principal_id, state, authority_generation)
    VALUES ('discord', $2, $1, 'pending', 1)
  `, [pendingId, subjectId]);
  // The pending subject signs in with Discord and holds its own session.
  const session = await seedActorSession(context.pool, claim(pendingId), subjectId, 1);
  return { pendingId, session };
}

function bindingFields(companionId: string, subjectId: string) {
  return {
    companionId,
    contactId: 'operator-approved-contact',
    bindingId: randomUUID(),
    newProvider: providerProof(subjectId),
    contactAuthority: {
      schemaVersion: 1 as const,
      contactId: 'operator-approved-contact',
      channel: 'discord' as const,
      providerSubjectId: subjectId,
      identityVersion: 2,
      verificationId: randomUUID(),
      verificationDigest: 'c'.repeat(64),
      contactAuthorityVersion: 3,
      ownershipState: 'verified' as const,
      restoreState: 'live' as const,
    },
  };
}

async function withContext(run: (context: Context) => Promise<void>): Promise<void> {
  const context = await freshContext();
  try {
    await run(context);
  } finally {
    await context.pool.end();
    rmSync(context.floorRoot, { recursive: true, force: true });
  }
}

describe('ADMIN_TOKEN operator approval of lifecycle ceremonies', () => {
  it('activates a binding on the subject\'s own proof, audited as admin_token_operator', async () => {
    await withContext(async (context) => {
      const seeded = await seedOwnerAndTarget(context.pool);
      const { pendingId, session } = await seedPendingSubject(context, '523456789012345678');
      const decision = {
        ...await operatorBase(context, {
          action: 'binding.activate',
          companionId: seeded.companionId,
          target: claim(pendingId),
        }),
        ...bindingFields(seeded.companionId, '523456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, decision, {
        principalId: pendingId,
        sessionId: session.sessionId,
      });
      const result = await context.store.execute(decision);
      expect(result.target).toMatchObject({ principalId: pendingId, bindingVersion: 2 });

      const audit = await context.pool.query<{ actor_context: Record<string, string> }>(`
        SELECT actor_context
        FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        WHERE decision_id = $1 AND decision = 'allow'
      `, [decision.decisionId]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0]?.actor_context).toMatchObject({
        kind: 'admin_token_operator',
        boundary: 'fleet_auth_lifecycle',
        authorizationEventId: decision.operator.authorizationEventId,
      });
    });
  }, TIMEOUT_MS);

  it('refuses a binding whose provider proof was not initiated by the subject itself', async () => {
    await withContext(async (context) => {
      const seeded = await seedOwnerAndTarget(context.pool);
      const { pendingId } = await seedPendingSubject(context, '533456789012345678');
      const decision = {
        ...await operatorBase(context, {
          action: 'binding.activate',
          companionId: seeded.companionId,
          target: claim(pendingId),
        }),
        ...bindingFields(seeded.companionId, '533456789012345678'),
      } satisfies VerifiedFleetAuthLifecycleDecision;
      // The owner's browser ran the Discord OAuth: that is not the subject's proof.
      await seedDecisionProviderProofs(context.pool, decision, {
        principalId: seeded.actorId,
        sessionId: sessionFor(seeded.actorId).sessionId,
      });
      await expect(context.store.execute(decision)).rejects.toMatchObject({
        reasonCode: 'provider_callback_proof_invalid',
      });
    });
  }, TIMEOUT_MS);

  it('links a provider for a non-owner subject on its own proof', async () => {
    await withContext(async (context) => {
      const seeded = await seedOwnerAndTarget(context.pool);
      const addedProvider = providerProof('643456789012345678');
      const decision = {
        ...await operatorBase(context, {
          action: 'provider.add',
          companionId: seeded.companionId,
          target: claim(seeded.targetId),
        }),
        ...providerContactScope(seeded, addedProvider),
        newProvider: addedProvider,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await seedDecisionProviderProofs(context.pool, decision, {
        principalId: seeded.targetId,
        sessionId: sessionFor(seeded.targetId).sessionId,
      });
      await context.store.execute(decision);
      const subjects = await context.pool.query<{ subject_id: string }>(`
        SELECT subject_id FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        WHERE principal_id = $1 AND state = 'active' ORDER BY subject_id
      `, [seeded.targetId]);
      expect(subjects.rows.map(row => row.subject_id)).toContain('643456789012345678');
    });
  }, TIMEOUT_MS);

  it('grants an owner role, and a stale or foreign approval cannot approve the next decision', async () => {
    await withContext(async (context) => {
      const seeded = await seedOwnerAndTarget(context.pool);
      const grantId = randomUUID();
      const grant = {
        ...await operatorBase(context, {
          action: 'role.grant',
          companionId: seeded.companionId,
          target: claim(seeded.targetId),
        }),
        companionId: seeded.companionId,
        grantId,
        role: 'owner' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      // The member grant must end before an owner grant can be issued.
      await context.pool.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = 'revoked' WHERE grant_id = $1
      `, [seeded.targetGrantId]);
      const granted = await context.store.execute(grant);

      // Reusing the first approval for a new decision is refused.
      const change = {
        ...grant,
        action: 'role.change' as const,
        decisionId: randomUUID(),
        ceremonyId: randomUUID(),
        target: granted.target,
        authorityGeneration: granted.authorityGeneration,
        globalAuthEpoch: granted.globalAuthEpoch,
        grantId,
        newGrantId: randomUUID(),
        currentRole: 'owner' as const,
        role: 'admin' as const,
      } satisfies VerifiedFleetAuthLifecycleDecision;
      await expect(context.store.execute(change)).rejects.toMatchObject({
        reasonCode: 'operator_approval_audit_invalid',
      });

      // An approval recorded for another action cannot be spent on this one.
      const foreign = await operatorBase(context, {
        action: 'binding.activate',
        companionId: seeded.companionId,
        target: granted.target,
      });
      await expect(context.store.execute({
        ...change,
        decisionId: foreign.decisionId,
        ceremonyId: foreign.ceremonyId,
        operator: foreign.operator,
      })).rejects.toMatchObject({ reasonCode: 'operator_approval_audit_invalid' });

      // A fresh exact approval succeeds.
      const fresh = await operatorBase(context, {
        action: 'role.change',
        companionId: seeded.companionId,
        target: granted.target,
      });
      await expect(context.store.execute({
        ...change,
        ...fresh,
        action: 'role.change',
      })).resolves.toMatchObject({ action: 'role.change' });
    });
  }, TIMEOUT_MS);
});
