import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CompanionAuthorityLineageFloor,
  FleetAuthAuthorityFloor,
} from './authority-floor.js';
import { companionAuthorityLineageId } from './authority-floor.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function reconcilePendingCompanionReadd(
  client: PoolClient,
  floor: FleetAuthAuthorityFloor,
  auditEventId: string,
): Promise<boolean> {
  const trusted = floor.trustedHost;
  const pending = trusted.tombstones.filter((entry): entry is CompanionAuthorityLineageFloor['entry'] => (
    entry.kind === 'companion_lineage_floor'
      && entry.generation === trusted.authorityGeneration
      && entry.companionReadd !== undefined
  ));
  const marker = pending.at(0);
  if (!marker || pending.length !== 1) return false;
  const readd = marker.companionReadd;
  const authority = await client.query<{
    authority_generation: string;
    global_auth_epoch: string;
    authority_lineage_id: string | null;
  }>(`
    SELECT authority_generation, global_auth_epoch, authority_lineage_id
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
    FOR UPDATE
  `);
  const authorityRow = authority.rows.at(0);
  if (!authorityRow
    || authorityRow.authority_lineage_id !== trusted.lineageId
    || authorityRow.authority_generation !== String(readd.priorAuthorityGeneration)
    || authorityRow.global_auth_epoch !== String(readd.priorGlobalAuthEpoch)
    || marker.generation !== readd.priorAuthorityGeneration + 1) {
    return false;
  }

  const companion = await client.query<{
    companion_id: string;
    lifecycle: string;
    restore_state: string;
    version: string;
  }>(`
    SELECT companion_id, lifecycle, restore_state, version
    FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
    WHERE encode(sha256(convert_to(companion_id::text, 'UTF8')), 'hex') = $1
    FOR UPDATE
  `, [marker.resourceHash]);
  const companionRow = companion.rows.at(0);
  if (!companionRow
    || companionRow.lifecycle !== 'removed'
    || companionRow.restore_state !== 'live'
    || companionRow.version !== String(readd.priorCompanionVersion)) {
    return false;
  }

  const target = await client.query<{
    status: string;
    restore_state: string;
    authn_version: string;
    authz_version: string;
    binding_version: string;
    grant_version: string;
    policy_version: string;
  }>(`
    SELECT status, restore_state, authn_version, authz_version, binding_version,
           grant_version, policy_version
    FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
    WHERE principal_id = $1
    FOR UPDATE
  `, [readd.target.principalId]);
  const targetRow = target.rows.at(0);
  if (!targetRow
    || targetRow.status !== 'active'
    || targetRow.restore_state !== 'live'
    || targetRow.authn_version !== String(readd.target.authnVersion)
    || targetRow.authz_version !== String(readd.target.authzVersion)
    || targetRow.binding_version !== String(readd.target.bindingVersion)
    || targetRow.grant_version !== String(readd.target.grantVersion)
    || targetRow.policy_version !== String(readd.target.policyVersion)) {
    return false;
  }
  const priorAudit = await client.query(`
    SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
    WHERE decision_id = $1
  `, [readd.decisionId]);
  if (priorAudit.rowCount !== 0) return false;

  const lineageId = companionAuthorityLineageId(trusted, marker.resourceHash, marker.generation);
  const nextEpoch = readd.priorGlobalAuthEpoch + 1;
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
    SET lifecycle = 'quarantined', version = version + 1,
        authority_generation = $2, authority_lineage_id = $3,
        lineage_generation = $2, readd_decision_id = $4, updated_at = $5
    WHERE companion_id = $1
  `, [companionRow.companion_id, marker.generation, lineageId, readd.decisionId, marker.revokedAt]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
    SET authz_version = authz_version + 1,
        binding_version = binding_version + 1,
        grant_version = grant_version + 1,
        policy_version = policy_version + 1,
        authority_generation = $2,
        updated_at = $3
    WHERE principal_id = $1
  `, [readd.target.principalId, marker.generation, marker.revokedAt]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    SET authority_generation = $1, global_auth_epoch = $2, updated_at = $3
    WHERE singleton = TRUE
  `, [marker.generation, nextEpoch, marker.revokedAt]);

  for (const table of [
    'browser_sessions',
    'jit_authorization_grants',
    'provider_token_custody',
  ]) {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.${table}
      SET revoked_at = COALESCE(revoked_at, $2)
      WHERE principal_id = $1
    `, [readd.target.principalId, marker.revokedAt]);
  }
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
    SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
    WHERE principal_id = $1
  `, [readd.target.principalId]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
    WHERE principal_id = $1
  `, [readd.target.principalId]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
    WHERE principal_id = $1
  `, [readd.target.principalId]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
    SET status = 'revoked'
    WHERE status = 'pending'
      AND (initiating_principal_id IS NULL OR initiating_principal_id = $1)
  `, [readd.target.principalId]);
  for (const table of [
    'browser_sessions',
    'jit_authorization_grants',
    'step_up_challenges',
    'provider_token_custody',
    'discord_evidence_snapshots',
    'discord_evidence_lifecycle_fences',
  ]) {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.${table}
      SET global_auth_epoch = $3
      WHERE global_auth_epoch = $2 AND principal_id <> $1
    `, [readd.target.principalId, readd.priorGlobalAuthEpoch, nextEpoch]);
  }
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
    SET global_auth_epoch = $3
    WHERE status = 'pending' AND global_auth_epoch = $2
      AND initiating_principal_id IS NOT NULL AND initiating_principal_id <> $1
  `, [readd.target.principalId, readd.priorGlobalAuthEpoch, nextEpoch]);

  await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.lifecycle_decision_receipts
      (receipt_id, decision_id, ceremony_id, action, created_at)
    VALUES ($1, $1, $2, 'companion.readd', $3)
  `, [readd.decisionId, readd.ceremonyId, marker.revokedAt]);
  const resultTarget = {
    principalDigest: digest(readd.target.principalId),
    authnVersion: readd.target.authnVersion,
    authzVersion: readd.target.authzVersion + 1,
    bindingVersion: readd.target.bindingVersion + 1,
    grantVersion: readd.target.grantVersion + 1,
    policyVersion: readd.target.policyVersion + 1,
  };
  const decisionContext = {
    schemaVersion: 2,
    decisionFingerprint: readd.decisionFingerprint,
    recovery: 'non_restored_companion_readd_floor',
    actorDigest: digest(readd.actorPrincipalId),
    targetDigest: digest(readd.target.principalId),
    ceremonyDigest: digest(readd.ceremonyId),
    companion: {
      companionDigest: marker.resourceHash,
      beforeLifecycle: 'removed',
      afterLifecycle: 'quarantined',
      beforeVersion: readd.priorCompanionVersion,
      afterVersion: readd.priorCompanionVersion + 1,
      authorityLineageDigest: digest(lineageId),
      lineageGeneration: marker.generation,
    },
    lifecycleResult: {
      authorityGeneration: marker.generation,
      globalAuthEpoch: nextEpoch,
      target: resultTarget,
    },
  };
  await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       authority_generation, global_auth_epoch, correlation_id, occurred_at,
       decision_id, ceremony_id, reason_digest, decision_context)
    VALUES ($1, $2::jsonb, 'companion.readd', $3, 'allow',
            'lifecycle_transition_reconciled', $4, $5, $6, $7,
            $8, $9, $10, $11::jsonb)
  `, [
    auditEventId,
    JSON.stringify({ kind: 'principal', idDigest: digest(readd.actorPrincipalId) }),
    `lifecycle:companion.readd:${digest(JSON.stringify(decisionContext))}`,
    marker.generation,
    nextEpoch,
    readd.decisionId,
    marker.revokedAt,
    readd.decisionId,
    readd.ceremonyId,
    readd.reasonDigest,
    JSON.stringify(decisionContext),
  ]);
  return true;
}
