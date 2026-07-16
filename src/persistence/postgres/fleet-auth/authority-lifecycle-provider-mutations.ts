import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  PrincipalAuthorityClaim,
  VerifiedFleetAuthLifecycleDecision,
} from './authority-lifecycle-types.js';
import {
  denyLifecycleMutation,
  mergeLifecycleBumps,
  requireOneLifecycleRow,
  type PreparedLifecycleMutation,
} from './authority-lifecycle-mutation-contract.js';
import { revokeExactProviderSubject } from './provider-lifecycle-store.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

async function assertProviderAvailable(client: PoolClient, subjectId: string): Promise<void> {
  const result = await client.query<{ unavailable: boolean }>(`
    SELECT (
      EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        WHERE provider = 'discord' AND subject_id = $1
      ) OR EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
        WHERE provider = 'discord' AND subject_id = $1
      ) OR EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
        WHERE provider = 'discord' AND subject_id = $1
      )
    ) AS unavailable
  `, [subjectId]);
  if (result.rows[0]?.unavailable !== false) {
    denyLifecycleMutation('provider_subject_unavailable');
  }
}

export async function lockCurrentLifecycleProvider(
  client: PoolClient,
  target: PrincipalAuthorityClaim,
  subjectId: string,
): Promise<void> {
  const result = await client.query<{ state: string; restore_state: string }>(`
    SELECT state, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
    WHERE provider = 'discord' AND subject_id = $1 AND principal_id = $2
    FOR UPDATE
  `, [subjectId, target.principalId]);
  const row = requireOneLifecycleRow(result.rows, 'current_provider_mismatch');
  if (row.state !== 'active' || row.restore_state !== 'live') {
    denyLifecycleMutation('current_provider_not_active');
  }
}

export async function prepareProviderLifecycleMutation(
  client: PoolClient,
  decision: Extract<VerifiedFleetAuthLifecycleDecision, { action: `provider.${string}` }>,
): Promise<PreparedLifecycleMutation> {
  const targetId = decision.target.principalId;
  if (decision.actor.principalId !== targetId) {
    denyLifecycleMutation('provider_actor_target_mismatch');
  }
  if (decision.action === 'provider.add' || decision.action === 'provider.relink') {
    await assertProviderAvailable(client, decision.newProvider.subjectId);
    return {
      affectedPrincipalIds: [targetId],
      bumps: mergeLifecycleBumps([[targetId, { authn: true }]]),
      revocations: [],
      apply: async authorityGeneration => {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
            (provider, subject_id, principal_id, state, metadata, authority_generation)
          VALUES ('discord', $1, $2, 'active', $3::jsonb, $4)
        `, [
          decision.newProvider.subjectId,
          targetId,
          JSON.stringify({ proofDigest: decision.newProvider.proofDigest }),
          authorityGeneration,
        ]);
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
            (event_id, provider, subject_id, principal_id, state, event_type,
             authority_generation, payload, recorded_at)
          VALUES ($1, 'discord', $2, $3, 'active', $4, $5, $6::jsonb, $7)
        `, [
          randomUUID(),
          decision.newProvider.subjectId,
          targetId,
          decision.action === 'provider.add' ? 'linked' : 'recovered',
          authorityGeneration,
          JSON.stringify({ decisionId: decision.decisionId }),
          decision.decidedAt,
        ]);
      },
    };
  }

  await lockCurrentLifecycleProvider(
    client,
    decision.target,
    decision.currentProvider.subjectId,
  );
  if (decision.action === 'provider.replace') {
    await assertProviderAvailable(client, decision.newProvider.subjectId);
    return {
      affectedPrincipalIds: [targetId],
      bumps: mergeLifecycleBumps([[targetId, { authn: true }]]),
      revocations: [{
        kind: 'provider_subject',
        resourceId: `discord:${decision.currentProvider.subjectId}`,
      }],
      apply: async authorityGeneration => {
        await revokeExactProviderSubject(client, {
          principalId: targetId,
          subjectId: decision.currentProvider.subjectId,
          authorityGeneration,
          reasonDigest: decision.reasonDigest,
          at: decision.decidedAt,
          eventType: 'replaced',
          payload: { decisionId: decision.decisionId },
        });
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
            (provider, subject_id, principal_id, state, metadata, authority_generation,
             created_at, updated_at)
          VALUES ('discord', $1, $2, 'active', $3::jsonb, $4, $5, $5)
        `, [
          decision.newProvider.subjectId,
          targetId,
          JSON.stringify({ proofDigest: decision.newProvider.proofDigest }),
          authorityGeneration,
          decision.decidedAt,
        ]);
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
            (event_id, provider, subject_id, principal_id, state, event_type,
             authority_generation, payload, recorded_at)
          VALUES ($1, 'discord', $2, $3, 'active', 'linked', $4, $5::jsonb, $6)
        `, [
          randomUUID(),
          decision.newProvider.subjectId,
          targetId,
          authorityGeneration,
          JSON.stringify({ decisionId: decision.decisionId, source: 'provider_replace' }),
          decision.decidedAt,
        ]);
      },
    };
  }

  const remaining = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
    WHERE principal_id = $1 AND provider = 'discord'
      AND subject_id <> $2 AND state IN ('pending', 'active')
      AND restore_state = 'live'
  `, [targetId, decision.currentProvider.subjectId]);
  const suspendsAccount = remaining.rows[0]?.count === '0';
  return {
    affectedPrincipalIds: [targetId],
    bumps: mergeLifecycleBumps([[
      targetId,
      suspendsAccount
        ? { authn: true, authz: true, binding: true, grant: true, policy: true }
        : { authn: true },
    ]]),
    revocations: [{
      kind: 'provider_subject',
      resourceId: `discord:${decision.currentProvider.subjectId}`,
    }],
    apply: async authorityGeneration => {
      await revokeExactProviderSubject(client, {
        principalId: targetId,
        subjectId: decision.currentProvider.subjectId,
        authorityGeneration,
        reasonDigest: decision.reasonDigest,
        at: decision.decidedAt,
        eventType: 'unlinked',
        payload: { decisionId: decision.decisionId },
      });
      if (suspendsAccount) {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
          SET status = 'suspended', updated_at = $2
          WHERE principal_id = $1
        `, [targetId, decision.decidedAt]);
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          SET state = CASE WHEN state = 'revoked' THEN state ELSE 'suspended' END,
              version = version + 1, updated_at = $2
          WHERE principal_id = $1 AND restore_state = 'live'
        `, [targetId, decision.decidedAt]);
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
              version = version + 1, updated_at = $2
          WHERE principal_id = $1 AND restore_state = 'live'
        `, [targetId, decision.decidedAt]);
      }
    },
  };
}
