import { createHash, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { denyLifecycleMutation } from './authority-lifecycle-mutation-contract.js';
import type { VerifiedFleetAuthLifecycleDecision } from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactDigest(left: string | null, right: string): boolean {
  return typeof left === 'string' && /^[0-9a-f]{64}$/u.test(left)
    && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

/** Consumes only the exact trusted-host/WebAuthn receipt inside lifecycle COMMIT. */
export async function lockAndConsumeProviderRecoveryCeremony(
  client: PoolClient,
  decision: Extract<VerifiedFleetAuthLifecycleDecision, { action: 'provider.recover' }>,
): Promise<void> {
  const result = await client.query<{
    status: string;
    expected_provider_subject_id: string;
    expected_companion_id: string | null;
    exact_scope: unknown;
    global_auth_epoch: string;
    expires_at: Date;
    credential_floor_generation: string | null;
    prior_credential_id_hash: string | null;
    recovery_receipt_digest: string | null;
    recovery_credential_id_hash: string | null;
    recovery_credential_generation: string | null;
  }>(`
    SELECT status, expected_provider_subject_id, expected_companion_id,
           exact_scope, global_auth_epoch, expires_at,
           credential_floor_generation, prior_credential_id_hash,
           recovery_receipt_digest, recovery_credential_id_hash,
           recovery_credential_generation
    FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
    WHERE ceremony_id = $1 AND nonce_digest = $2
      AND kind = 'provider_recovery' AND protocol_version = 2
    FOR UPDATE
  `, [decision.ceremonyId, digest(decision.recovery.oneTimeCredential)]);
  const row = result.rows.at(0);
  const scope = row && isRecord(row.exact_scope) ? row.exact_scope : undefined;
  const principal = scope && isRecord(scope.principal) ? scope.principal : undefined;
  if (scope) {
    assertNoUnknownKeys(scope, [
      'schemaVersion',
      'action',
      'principalId',
      'currentProviderSubjectId',
      'currentProviderAuthorityGeneration',
      'expectedNewProviderSubjectId',
      'authorityGeneration',
      'globalAuthEpoch',
      'reasonDigest',
      'principal',
      'credentialIdHash',
      'credentialFloorGeneration',
    ], 'providerRecoveryScope');
  }
  if (principal) {
    assertNoUnknownKeys(principal, [
      'principalId',
      'authnVersion',
      'authzVersion',
      'bindingVersion',
      'grantVersion',
      'policyVersion',
    ], 'providerRecoveryScope.principal');
  }
  if (!row || !scope || !principal || row.status !== 'pending'
    || row.expires_at.getTime() <= decision.decidedAt.getTime()
    || row.expires_at.getTime() <= Date.now()
    || row.expected_companion_id !== decision.companionId
    || row.expected_provider_subject_id !== decision.newProvider.subjectId
    || row.global_auth_epoch !== String(decision.globalAuthEpoch)
    || row.credential_floor_generation !== String(decision.recovery.credentialFloorGeneration)
    || typeof row.prior_credential_id_hash !== 'string'
    || !timingSafeStringEqual(
      row.prior_credential_id_hash,
      decision.recovery.credentialIdHash,
    )
    || typeof row.recovery_credential_id_hash !== 'string'
    || !timingSafeStringEqual(
      row.recovery_credential_id_hash,
      decision.recovery.credentialIdHash,
    )
    || row.recovery_credential_generation !== String(decision.recovery.credentialGeneration)
    || !exactDigest(row.recovery_receipt_digest, digest(decision.recovery.webAuthnReceipt))
    || scope.schemaVersion !== 1 || scope.action !== decision.action
    || scope.principalId !== decision.target.principalId
    || scope.currentProviderSubjectId !== decision.unavailableProvider.subjectId
    || scope.currentProviderAuthorityGeneration
      !== decision.unavailableProvider.authorityGeneration
    || scope.expectedNewProviderSubjectId !== decision.newProvider.subjectId
    || scope.authorityGeneration !== decision.authorityGeneration
    || scope.globalAuthEpoch !== decision.globalAuthEpoch
    || scope.reasonDigest !== decision.reasonDigest
    || typeof scope.credentialIdHash !== 'string'
    || !timingSafeStringEqual(scope.credentialIdHash, decision.recovery.credentialIdHash)
    || principal.principalId !== decision.target.principalId
    || principal.authnVersion !== decision.target.authnVersion
    || principal.authzVersion !== decision.target.authzVersion
    || principal.bindingVersion !== decision.target.bindingVersion
    || principal.grantVersion !== decision.target.grantVersion
    || principal.policyVersion !== decision.target.policyVersion) {
    denyLifecycleMutation('provider_recovery_ceremony_invalid');
  }
  const consumed = await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
    SET status = 'consumed', consumed_at = $2
    WHERE ceremony_id = $1 AND status = 'pending'
  `, [decision.ceremonyId, decision.decidedAt]);
  if (consumed.rowCount !== 1) denyLifecycleMutation('provider_recovery_ceremony_replay');
}
