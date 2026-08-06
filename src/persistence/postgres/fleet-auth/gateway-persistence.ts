import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  FleetAuthAuthorityFloorStore,
  type FleetAuthAuthorityFloor,
} from './authority-floor.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import {
  executeAccountReapproval,
  type AccountReapprovalRequest,
  type AccountReapprovalResult,
} from './reapproval.js';
import {
  executeCompanionReapproval,
  type CompanionReapprovalRequest,
  type CompanionReapprovalResult,
} from './companion-reapproval.js';
import type {
  AccountAuthorityFencePort,
  ProviderRevocationAuthorityPort,
} from './provider-revocation-authority.js';
import { FLEET_AUTH_RECONCILE_FUNCTION_NAME } from './authority-reconciliation-sql.js';
import { replaceAccountAuthorityFloorProjection } from './authority-floor-projection.js';
import { reconcilePendingCompanionReadd } from './companion-readd-reconciliation.js';
import type { FleetLifecycleCeremonyDenialAuditPort } from '../../../boundary/fleet-auth/lifecycle-ceremony.js';

export async function recordPostgresFleetLifecycleCeremonyDenial(
  pool: Pool,
  input: Parameters<FleetLifecycleCeremonyDenialAuditPort['record']>[0],
): Promise<void> {
  const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
  const eventId = randomUUID();
  const request = input.request;
  const result = await pool.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       companion_id, principal_id, authority_generation, global_auth_epoch,
       occurred_at, decision_id, ceremony_id, reason_digest, decision_context)
    SELECT $1, $2::jsonb, $3, 'lifecycle-ceremony', 'deny', $4,
           $5, NULL, authority_generation, global_auth_epoch,
           clock_timestamp(), $1, $6, $7, $8::jsonb
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
  `, [
    eventId,
    JSON.stringify({ kind: 'fleet_gateway', id: 'lifecycle_ceremony' }),
    request.action,
    input.reasonCode,
    request.companionId,
    request.ceremonyId,
    sha256(request.reason),
    JSON.stringify({
      schemaVersion: 1,
      action: request.action,
      ceremonyDigest: sha256(request.ceremonyId),
      companionDigest: sha256(request.companionId),
      requestDigest: sha256(JSON.stringify(request)),
      ...('targetPrincipalId' in request
        ? { targetPrincipalDigest: sha256(request.targetPrincipalId) }
        : {}),
      decision: 'deny',
      reasonCode: input.reasonCode,
    }),
  ]);
  if (result.rowCount !== 1) {
    throw new Error('Fleet lifecycle denial audit insert failed');
  }
}

function parseStateInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid fleet_auth authority_state.${field}`);
  }
  return parsed;
}

/**
 * Bring restorable database state up to the non-restored floor before any
 * listener can accept authentication. The floor is written first by the
 * trusted-host authority. A database failure therefore leaves authority
 * over-fenced; the next startup retries this transaction.
 */
export async function reconcileFleetAuthAuthorityState(
  pool: Pool,
  floor: FleetAuthAuthorityFloor,
  auditEventId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reconcileFleetAuthAuthorityStateInTransaction(client, floor, auditEventId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Transaction-scoped form used by restore so restored rows, quarantine, epoch
 * advancement, and audit become visible atomically. The caller owns BEGIN,
 * COMMIT, rollback, and any coordinator advisory lock.
 */
export async function reconcileFleetAuthAuthorityStateInTransaction(
  client: PoolClient,
  floor: FleetAuthAuthorityFloor,
  auditEventId: string,
): Promise<void> {
  const trusted = floor.trustedHost;
  // Serialize projection replacement with both reapproval procedures. They
  // lock this singleton before consulting the projection, so no caller can
  // authorize against the prior committed floor while reconciliation swaps it.
  await client.query(`
    SELECT 1
    FROM ${FLEET_AUTH_SCHEMA_NAME}.authority_state
    WHERE singleton = TRUE
    FOR UPDATE
  `);
  await replaceAccountAuthorityFloorProjection(client, trusted);
  if (await reconcilePendingCompanionReadd(client, floor, auditEventId)) return;
  const result = await client.query<{ global_auth_epoch: string }>(`
    SELECT global_auth_epoch
    FROM ${FLEET_AUTH_RECONCILE_FUNCTION_NAME}($1, $2, $3, $4, $5)
  `, [
      trusted.lineageId,
      trusted.authorityGeneration,
      trusted.restoreCheckpoint,
      trusted.activationGeneration,
      auditEventId,
    ]);
  const globalAuthEpoch = result.rows.at(0)?.global_auth_epoch;
  if (!globalAuthEpoch) throw new Error('fleet_auth authority reconciliation returned no state');
  parseStateInteger(globalAuthEpoch, 'global_auth_epoch');
}

/** Gateway-internal bridge from browser revocation to the non-restored floor. */
export function createGatewayProviderRevocationAuthorityPort(
  authorityFloors: FleetAuthAuthorityFloorStore,
): ProviderRevocationAuthorityPort {
  return createGatewayAccountAuthorityFencePort(authorityFloors);
}

export function createGatewayAccountAuthorityFencePort(
  authorityFloors: FleetAuthAuthorityFloorStore,
): AccountAuthorityFencePort {
  // Read on every validation for cross-process advances, while retaining the
  // highest observed generation so this gateway can never accept a regression.
  let observedAuthorityGeneration = authorityFloors.read().trustedHost.authorityGeneration;
  const observeAuthorityGeneration = (): number => {
    observedAuthorityGeneration = Math.max(
      observedAuthorityGeneration,
      authorityFloors.read().trustedHost.authorityGeneration,
    );
    return observedAuthorityGeneration;
  };
  return {
    sessionAuthorityGenerationIsCurrent: authorityGeneration => (
      authorityGeneration === observeAuthorityGeneration()
    ),
    fence: async (input) => {
      const fencedFloor = authorityFloors.revokeAccountAuthority({
        kind: 'provider_subject',
        resourceId: `${input.provider}:${input.subjectId}`,
        reason: input.reasonDigest,
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        fencedFloor.trustedHost.authorityGeneration,
      );
      return {
        authorityGeneration: fencedFloor.trustedHost.authorityGeneration,
        reconcile: async (client) => {
          const state = await client.query<{ global_auth_epoch: string }>(`
            UPDATE ${FLEET_AUTH_SCHEMA_NAME}.authority_state
            SET authority_generation = $1,
                global_auth_epoch = global_auth_epoch + 1,
                updated_at = $2
            WHERE singleton = TRUE AND authority_generation = $1::bigint - 1
            RETURNING global_auth_epoch
          `, [fencedFloor.trustedHost.authorityGeneration, input.at]);
          const row = state.rows.at(0);
          if (!row) {
            throw new Error('fleet_auth authority changed during provider revocation');
          }
          return {
            globalAuthEpoch: parseStateInteger(row.global_auth_epoch, 'global_auth_epoch'),
          };
        },
      };
    },
    fenceMany: async (input) => {
      const fencedFloor = authorityFloors.revokeAccountAuthorities({
        resources: input.resources.map(resource => ({
          ...resource,
          reason: input.reasonDigest,
        })),
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        fencedFloor.trustedHost.authorityGeneration,
      );
      return { authorityGeneration: fencedFloor.trustedHost.authorityGeneration };
    },
    beginCompanionReadd: async input => {
      const lineage = authorityFloors.beginCompanionAuthorityReadd({
        ...input,
        at: input.at.toISOString(),
      });
      observedAuthorityGeneration = Math.max(
        observedAuthorityGeneration,
        lineage.authorityGeneration,
      );
      return lineage;
    },
    findCompanionReadd: companionId => authorityFloors.findCompanionAuthorityReadd(companionId),
  };
}

/**
 * Keep trusted-host reapproval subordinate to the non-restored provider floor.
 * This guard remains authoritative even when a prior database transaction
 * rolled back after publishing its floor tombstone.
 */
export function createGatewayAccountReapprovalAuthority(
  pool: Pool,
  authorityFloors: FleetAuthAuthorityFloorStore,
): (request: AccountReapprovalRequest) => Promise<AccountReapprovalResult> {
  return async (request) => {
    const resources = [
      ['provider_subject', `${request.provider}:${request.providerSubjectId}`],
      ['principal', request.principalId],
      ['companion', request.companionId],
      ['contact_binding', request.bindingId],
      ['role_grant', request.roleGrantId],
    ] as const;
    if (resources.some(([kind, resourceId]) => (
      authorityFloors.isAccountAuthorityTombstoned(kind, resourceId)
    ))) {
      throw new Error('Account authority is permanently tombstoned by non-restored authority');
    }
    return await executeAccountReapproval(pool, request);
  };
}

export function createGatewayCompanionReapprovalAuthority(
  pool: Pool,
  authorityFloors: FleetAuthAuthorityFloorStore,
): (request: CompanionReapprovalRequest) => Promise<CompanionReapprovalResult> {
  return async request => {
    if (!authorityFloors.companionAuthorityLineageIsCurrent({
      companionId: request.companionId,
      lineageId: request.lineageId,
      lineageGeneration: request.lineageGeneration,
    })) {
      throw new Error('Companion authority lineage is not current in non-restored authority');
    }
    return await executeCompanionReapproval(pool, request);
  };
}
