import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FleetAuthAccountRosterEntry } from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import type { PrincipalRow } from './oauth-session-store-types.js';

export interface RosteredFirstOwnerActivationResult {
  activated: boolean;
  principal: PrincipalRow;
  globalAuthEpoch: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Activates the first exact account-roster owner inside the login transaction.
 * The authority-state lock held by the caller serializes competing fresh-fleet
 * callbacks. Existing trusted-host ceremonies retain precedence and therefore
 * remain consumable through the established ceremony procedure.
 */
export async function activateRosteredFirstOwner(
  client: PoolClient,
  input: {
    accountRoster: readonly FleetAuthAccountRosterEntry[];
    principal: PrincipalRow;
    providerSubjectId: string;
    authorityGeneration: number;
    globalAuthEpoch: number;
    now: Date;
  },
): Promise<RosteredFirstOwnerActivationResult> {
  const ownerEntries = input.accountRoster.filter(entry => (
    entry.providerSubjectId === input.providerSubjectId && entry.role === 'owner'
  ));
  if (input.principal.status !== 'pending' || ownerEntries.length === 0) {
    return {
      activated: false,
      principal: input.principal,
      globalAuthEpoch: input.globalAuthEpoch,
    };
  }

  const hasConfiguredContact = ownerEntries.some(entry => entry.contactId !== undefined);
  const existingBinding = hasConfiguredContact
    ? { rows: [{ usable_binding_exists: false }] }
    : await client.query<{ usable_binding_exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
        WHERE binding.principal_id = $1
          AND binding.companion_id = ANY($2::uuid[])
        GROUP BY binding.companion_id
        HAVING count(*) FILTER (
          WHERE binding.state = 'active' AND binding.restore_state = 'live'
        ) = 1
          AND bool_and(
            CASE
              WHEN binding.state = 'active' AND binding.restore_state = 'live'
              THEN NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
                'contact_binding', binding.binding_id::text
              ) AND NOT ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
                binding.companion_id, 'contact', binding.contact_id
              )
              ELSE TRUE
            END
          )
      ) AS usable_binding_exists
    `, [
      input.principal.principal_id,
      ownerEntries.map(entry => entry.companionId),
    ]);
  if (!hasConfiguredContact && !existingBinding.rows[0]?.usable_binding_exists) {
    return {
      activated: false,
      principal: input.principal,
      globalAuthEpoch: input.globalAuthEpoch,
    };
  }

  const blockers = await client.query<{
    active_principal_exists: boolean;
    pending_ceremony_exists: boolean;
  }>(`
    SELECT
      EXISTS (
        SELECT 1
        FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        WHERE status = 'active' AND restore_state = 'live'
      ) AS active_principal_exists,
      EXISTS (
        SELECT 1
        FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE kind = 'first_owner'
          AND status = 'pending'
          AND expected_provider = 'discord'
          AND expected_provider_subject_id = $1
          AND global_auth_epoch = $2
          AND expires_at > clock_timestamp()
      ) AS pending_ceremony_exists
  `, [input.providerSubjectId, input.globalAuthEpoch]);
  const blocker = blockers.rows.at(0);
  if (!blocker) throw new Error('Fleet auth first-owner activation precondition query failed');
  if (blocker.active_principal_exists || blocker.pending_ceremony_exists) {
    return {
      activated: false,
      principal: input.principal,
      globalAuthEpoch: input.globalAuthEpoch,
    };
  }

  const principal = await client.query<PrincipalRow>(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
    SET status = 'active',
        authn_version = authn_version + 1,
        authz_version = authz_version + 1,
        binding_version = binding_version + 1,
        grant_version = grant_version + 1,
        policy_version = policy_version + 1,
        updated_at = $2
    WHERE principal_id = $1
      AND status = 'pending'
      AND restore_state = 'live'
      AND authority_generation = $3
    RETURNING principal_id, status, authn_version, authz_version,
              binding_version, grant_version, policy_version
  `, [input.principal.principal_id, input.now, input.authorityGeneration]);
  const activatedPrincipal = principal.rows.at(0);
  if (!activatedPrincipal || principal.rowCount !== 1) {
    throw new Error('Fleet auth rostered first-owner principal activation lost authority');
  }

  const provider = await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
    SET state = 'active', updated_at = $3
    WHERE provider = 'discord'
      AND subject_id = $1
      AND principal_id = $2
      AND state = 'pending'
      AND restore_state = 'live'
      AND authority_generation = $4
    RETURNING subject_id
  `, [
    input.providerSubjectId,
    input.principal.principal_id,
    input.now,
    input.authorityGeneration,
  ]);
  if (provider.rowCount !== 1) {
    throw new Error('Fleet auth rostered first-owner provider activation lost authority');
  }

  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
    SET revoked_at = COALESCE(revoked_at, $2)
    WHERE principal_id = $1
  `, [input.principal.principal_id, input.now]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
    SET revoked_at = COALESCE(revoked_at, $2)
    WHERE principal_id = $1
  `, [input.principal.principal_id, input.now]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
    WHERE principal_id = $1
  `, [input.principal.principal_id]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
    WHERE principal_id = $1
  `, [input.principal.principal_id]);

  const auditEventId = randomUUID();
  const companionDigests = ownerEntries
    .map(entry => sha256(entry.companionId))
    .sort();
  await client.query(`
    INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      (event_id, actor_context, action, resource, decision, reason_code,
       principal_id, authority_generation, global_auth_epoch, occurred_at,
       decision_id, decision_context)
    VALUES ($1, $2::jsonb, 'authority.first_owner', 'account-roster-bootstrap',
            'allow', 'account_roster_first_owner', $3, $4, $5, $6, $1, $7::jsonb)
  `, [
    auditEventId,
    JSON.stringify({ kind: 'system', boundary: 'rostered_first_owner_activation' }),
    input.principal.principal_id,
    input.authorityGeneration,
    input.globalAuthEpoch,
    input.now,
    JSON.stringify({
      schemaVersion: 1,
      provider: 'discord',
      providerSubjectDigest: sha256(input.providerSubjectId),
      rosterOwnerCompanionDigests: companionDigests,
      authorityGeneration: input.authorityGeneration,
      globalAuthEpoch: input.globalAuthEpoch,
      decision: 'allow',
    }),
  ]);

  return {
    activated: true,
    principal: activatedPrincipal,
    globalAuthEpoch: input.globalAuthEpoch,
  };
}
