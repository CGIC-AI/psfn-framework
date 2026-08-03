import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FleetAuthAccountRosterEntry } from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import type { PrincipalRow } from './oauth-session-store-types.js';
import { FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_NAME } from './rostered-first-owner-companion-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export interface RosteredFirstOwnerActivationResult {
  activated: boolean;
  principal: PrincipalRow;
}

interface MaterializedOwnerMapping {
  companionId: string;
  contactId: string;
  insertBinding: boolean;
  insertGrant: boolean;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function unchanged(principal: PrincipalRow): RosteredFirstOwnerActivationResult {
  return { activated: false, principal };
}

async function resolveOwnerMappings(
  client: PoolClient,
  principalId: string,
  entries: readonly FleetAuthAccountRosterEntry[],
): Promise<MaterializedOwnerMapping[] | undefined> {
  const companionIds = entries.map(entry => entry.companionId);
  const bindings = await client.query<{
    companion_id: string;
    contact_id: string;
    state: string;
    restore_state: string;
    tombstoned: boolean;
    fenced: boolean;
  }>(`
    SELECT binding.companion_id, binding.contact_id, binding.state,
           binding.restore_state,
           ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
             'contact_binding', binding.binding_id::text
           ) AS tombstoned,
           ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
             binding.companion_id, 'contact', binding.contact_id
           ) AS fenced
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
    WHERE binding.principal_id = $1
      AND binding.companion_id = ANY($2::uuid[])
    FOR UPDATE OF binding
  `, [principalId, companionIds]);
  const grants = await client.query<{
    companion_id: string;
    role: string;
    lifecycle: string;
    restore_state: string;
    tombstoned: boolean;
  }>(`
    SELECT role_grant.companion_id, role_grant.role, role_grant.lifecycle,
           role_grant.restore_state,
           ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
             'role_grant', role_grant.grant_id::text
           ) AS tombstoned
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
    WHERE role_grant.principal_id = $1
      AND role_grant.companion_id = ANY($2::uuid[])
    FOR UPDATE OF role_grant
  `, [principalId, companionIds]);

  const mappings: MaterializedOwnerMapping[] = [];
  for (const entry of entries) {
    const companionBindings = bindings.rows.filter(row => row.companion_id === entry.companionId);
    const activeBindings = companionBindings.filter(row => (
      row.state === 'active' && row.restore_state === 'live'
    ));
    let contactId: string;
    let insertBinding = false;
    if (companionBindings.length === 0) {
      if (!entry.contactId) return undefined;
      contactId = entry.contactId;
      insertBinding = true;
    } else {
      const binding = activeBindings.length === 1 ? activeBindings[0] : undefined;
      if (!binding || binding.tombstoned || binding.fenced) return undefined;
      if (entry.contactId && entry.contactId !== binding.contact_id) return undefined;
      contactId = binding.contact_id;
    }

    const companionGrants = grants.rows.filter(row => row.companion_id === entry.companionId);
    const activeOwnerGrants = companionGrants.filter(row => (
      row.role === 'owner'
      && row.lifecycle === 'active'
      && row.restore_state === 'live'
      && !row.tombstoned
    ));
    if (companionGrants.length > 0 && activeOwnerGrants.length !== 1) return undefined;
    mappings.push({
      companionId: entry.companionId,
      contactId,
      insertBinding,
      insertGrant: companionGrants.length === 0,
    });
  }
  return mappings;
}

/**
 * Materializes and activates the first exact account-roster owner inside the
 * login transaction. The caller's authority-state lock serializes competing
 * callbacks and existing trusted-host ceremonies retain precedence.
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
    return unchanged(input.principal);
  }
  const mappings = await resolveOwnerMappings(
    client,
    input.principal.principal_id,
    ownerEntries,
  );
  if (!mappings) return unchanged(input.principal);

  const blockers = await client.query<{
    active_principal_exists: boolean;
    pending_ceremony_exists: boolean;
  }>(`
    SELECT
      EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        WHERE status = 'active' AND restore_state = 'live'
      ) AS active_principal_exists,
      EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.trusted_host_ceremonies
        WHERE kind = 'first_owner'
          AND status = 'pending'
          AND global_auth_epoch = $1
          AND expires_at > clock_timestamp()
      ) AS pending_ceremony_exists
  `, [input.globalAuthEpoch]);
  const blocker = blockers.rows.at(0);
  if (!blocker) throw new Error('Fleet auth first-owner activation precondition query failed');
  if (blocker.active_principal_exists || blocker.pending_ceremony_exists) {
    return unchanged(input.principal);
  }

  await client.query(
    `SELECT ${FLEET_AUTH_REGISTER_ROSTERED_FIRST_OWNER_COMPANIONS_FUNCTION_NAME}($1, $2, $3::uuid[])`,
    [
      input.principal.principal_id,
      input.providerSubjectId,
      mappings.map(mapping => mapping.companionId),
    ],
  );
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
    WHERE provider = 'discord' AND subject_id = $1 AND principal_id = $2
      AND state = 'pending' AND restore_state = 'live' AND authority_generation = $4
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

  for (const mapping of mappings) {
    if (mapping.insertBinding) {
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5::jsonb, $6, $7, $7)
      `, [
        randomUUID(),
        input.principal.principal_id,
        mapping.companionId,
        mapping.contactId,
        JSON.stringify({
          kind: 'account_roster_first_owner',
          providerSubjectDigest: sha256(input.providerSubjectId),
        }),
        input.authorityGeneration,
        input.now,
      ]);
    }
    if (mapping.insertGrant) {
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          (grant_id, principal_id, companion_id, role, lifecycle,
           authority_generation, created_at, updated_at)
        VALUES ($1, $2, $3, 'owner', 'active', $4, $5, $5)
      `, [
        randomUUID(),
        input.principal.principal_id,
        mapping.companionId,
        input.authorityGeneration,
        input.now,
      ]);
    }
  }

  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
    SET revoked_at = COALESCE(revoked_at, $2) WHERE principal_id = $1
  `, [input.principal.principal_id, input.now]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
    SET revoked_at = COALESCE(revoked_at, $2) WHERE principal_id = $1
  `, [input.principal.principal_id, input.now]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots WHERE principal_id = $1
  `, [input.principal.principal_id]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences WHERE principal_id = $1
  `, [input.principal.principal_id]);

  const auditEventId = randomUUID();
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
      rosterOwnerCompanionDigests: mappings.map(mapping => sha256(mapping.companionId)).sort(),
      materializedBindingCount: mappings.filter(mapping => mapping.insertBinding).length,
      materializedGrantCount: mappings.filter(mapping => mapping.insertGrant).length,
      authorityGeneration: input.authorityGeneration,
      globalAuthEpoch: input.globalAuthEpoch,
      decision: 'allow',
    }),
  ]);
  return { activated: true, principal: activatedPrincipal };
}
