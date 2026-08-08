import type { PoolClient } from 'pg';
import {
  isLifecycleOAuthAction,
  lifecycleOAuthKindFor,
  type LifecycleOAuthProofRole,
} from '../../../shared/contracts/fleet-auth-lifecycle-oauth.js';
import { denyLifecycleMutation } from './authority-lifecycle-mutation-contract.js';
import type {
  VerifiedFleetAuthLifecycleDecision,
  VerifiedProviderProof,
} from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export interface PurposeBoundProviderProof {
  role: LifecycleOAuthProofRole;
  proof: VerifiedProviderProof;
}

export function lifecycleProviderProofs(
  decision: VerifiedFleetAuthLifecycleDecision,
): PurposeBoundProviderProof[] {
  const result: PurposeBoundProviderProof[] = [];
  if ('currentProvider' in decision) {
    result.push({ role: 'current', proof: decision.currentProvider });
  }
  if ('newProvider' in decision) result.push({ role: 'new', proof: decision.newProvider });
  if ('canonicalProvider' in decision) {
    result.push({ role: 'canonical', proof: decision.canonicalProvider });
  }
  if ('sourceProvider' in decision) {
    result.push({ role: 'source', proof: decision.sourceProvider });
  }
  return result;
}

export async function lockAndValidateLifecycleProviderProofs(
  client: PoolClient,
  decision: VerifiedFleetAuthLifecycleDecision,
): Promise<void> {
  if (!isLifecycleOAuthAction(decision.action)) return;
  for (const { role, proof } of lifecycleProviderProofs(decision)) {
    const result = await client.query<{ transaction_id: string }>(`
      SELECT transaction.transaction_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions AS transaction
      WHERE transaction.transaction_id = $1
        AND transaction.status = 'consumed'
        AND transaction.consumed_at IS NOT NULL
        AND transaction.consumed_at <= $2
        AND $2 <= clock_timestamp()
        AND transaction.expires_at > clock_timestamp()
        AND transaction.global_auth_epoch = $3
        AND transaction.verified_provider = $4
        AND transaction.verified_provider_subject_id = $5
        AND transaction.lifecycle_ceremony_id = $6
        AND transaction.lifecycle_action = $7
        AND transaction.lifecycle_proof_role = $8
        AND transaction.initiating_principal_id = $9
        AND transaction.initiating_session_id = $10
        AND transaction.kind = $11
      FOR UPDATE OF transaction
    `, [
      proof.callbackTransactionId,
      decision.decidedAt,
      decision.globalAuthEpoch,
      proof.provider,
      proof.subjectId,
      decision.ceremonyId,
      decision.action,
      role,
      decision.actor.principalId,
      decision.actorSession.sessionId,
      lifecycleOAuthKindFor(decision.action, role),
    ]);
    if (result.rowCount !== 1) denyLifecycleMutation('provider_callback_proof_invalid');
  }
}
