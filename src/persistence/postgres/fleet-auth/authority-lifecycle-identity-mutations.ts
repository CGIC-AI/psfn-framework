import type { PoolClient } from 'pg';
import {
  denyLifecycleMutation,
  mergeLifecycleBumps,
  type PreparedLifecycleMutation,
} from './authority-lifecycle-mutation-contract.js';
import { lockCurrentLifecycleProvider } from './authority-lifecycle-provider-mutations.js';
import type { VerifiedFleetAuthLifecycleDecision } from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export async function preparePrincipalMergeMutation(
  client: PoolClient,
  decision: Extract<VerifiedFleetAuthLifecycleDecision, { action: 'principal.merge' }>,
): Promise<PreparedLifecycleMutation> {
  if (decision.actor.principalId !== decision.target.principalId) {
    denyLifecycleMutation('principal_merge_actor_mismatch');
  }
  await lockCurrentLifecycleProvider(
    client,
    decision.target,
    decision.canonicalProvider.subjectId,
  );
  await lockCurrentLifecycleProvider(
    client,
    decision.source,
    decision.sourceProvider.subjectId,
  );
  const existing = await client.query<{ source_principal_id: string }>(`
    SELECT source_principal_id
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
    WHERE source_principal_id = $1 OR source_principal_id = $2
    ORDER BY source_principal_id
  `, [decision.source.principalId, decision.target.principalId]);
  if (existing.rows.length > 0) {
    denyLifecycleMutation('principal_merge_already_aliased');
  }
  const cycle = await client.query<{ cycle: boolean }>(`
    WITH RECURSIVE aliases(source_principal_id, canonical_principal_id) AS (
      SELECT source_principal_id, canonical_principal_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
      WHERE source_principal_id = $1
      UNION ALL
      SELECT next.source_principal_id, next.canonical_principal_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases AS next
      JOIN aliases ON next.source_principal_id = aliases.canonical_principal_id
    )
    SELECT EXISTS (
      SELECT 1 FROM aliases WHERE canonical_principal_id = $2
    ) AS cycle
  `, [decision.target.principalId, decision.source.principalId]);
  if (cycle.rows[0]?.cycle === true) denyLifecycleMutation('principal_merge_cycle');
  return {
    affectedPrincipalIds: [decision.source.principalId, decision.target.principalId].sort(),
    bumps: mergeLifecycleBumps([
      [decision.source.principalId, {
        authn: true, authz: true, binding: true, grant: true, policy: true,
      }],
      [decision.target.principalId, { authz: true, policy: true }],
    ]),
    revocations: [{ kind: 'principal', resourceId: decision.source.principalId }],
    apply: async authorityGeneration => {
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases
          (source_principal_id, canonical_principal_id, decision_id,
           authority_generation, reason_digest, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        decision.source.principalId,
        decision.target.principalId,
        decision.decisionId,
        authorityGeneration,
        decision.reasonDigest,
        decision.decidedAt,
      ]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        SET status = 'revoked', updated_at = $2
        WHERE principal_id = $1
      `, [decision.source.principalId, decision.decidedAt]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        SET state = CASE WHEN state = 'revoked' THEN state ELSE 'suspended' END,
            version = version + 1, updated_at = $2
        WHERE principal_id = $1 AND restore_state = 'live'
      `, [decision.source.principalId, decision.decidedAt]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
            version = version + 1, updated_at = $2
        WHERE principal_id = $1 AND restore_state = 'live'
      `, [decision.source.principalId, decision.decidedAt]);
    },
  };
}
