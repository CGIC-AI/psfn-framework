import type { PoolClient } from 'pg';
import {
  denyLifecycleMutation as deny,
  mergeLifecycleBumps as bumps,
  requireOneLifecycleRow as one,
  type PreparedLifecycleMutation,
} from './authority-lifecycle-mutation-contract.js';
import { preparePrincipalMergeMutation } from './authority-lifecycle-identity-mutations.js';
import { prepareProviderLifecycleMutation } from './authority-lifecycle-provider-mutations.js';
import type { VerifiedFleetAuthLifecycleDecision } from './authority-lifecycle-types.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

async function assertCompanion(
  client: PoolClient,
  companionId: string,
  expected: 'active' | 'removed',
): Promise<{ version: number }> {
  const result = await client.query<{ lifecycle: string; restore_state: string; version: string }>(`
    SELECT lifecycle, restore_state, version
    FROM ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
    WHERE companion_id = $1
    FOR UPDATE
  `, [companionId]);
  const row = one(result.rows, 'companion_authority_missing');
  if (row.lifecycle !== expected || row.restore_state !== 'live') {
    deny('companion_authority_unavailable');
  }
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) deny('companion_version_invalid');
  return { version };
}

async function assertCompanionAdministrator(
  client: PoolClient,
  actorId: string,
  companionId: string,
  allowSuspendedOwner = false,
): Promise<void> {
  const result = await client.query<{ role: string; lifecycle: string; restore_state: string }>(`
    SELECT role, lifecycle, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    WHERE principal_id = $1 AND companion_id = $2
      AND role IN ('owner', 'admin')
    FOR UPDATE
  `, [actorId, companionId]);
  const allowed = result.rows.some(row => row.restore_state === 'live'
    && (row.lifecycle === 'active'
      || (allowSuspendedOwner && row.role === 'owner' && row.lifecycle === 'suspended')));
  if (!allowed) deny('actor_not_companion_administrator');
}

async function assertCompanionOwner(
  client: PoolClient,
  actorId: string,
  companionId: string,
): Promise<void> {
  const result = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      WHERE principal_id = $1 AND companion_id = $2
        AND role = 'owner' AND lifecycle = 'active' AND restore_state = 'live'
    ) AS present
  `, [actorId, companionId]);
  if (result.rows[0]?.present !== true) deny('actor_not_companion_owner');
}

async function lockGrant(
  client: PoolClient,
  decision: Extract<
    VerifiedFleetAuthLifecycleDecision,
    { action: 'role.change' | 'role.revoke' }
  >,
): Promise<{ version: string } > {
  const result = await client.query<{ role: string; lifecycle: string; restore_state: string; version: string }>(`
    SELECT role, lifecycle, restore_state, version
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    WHERE grant_id = $1 AND principal_id = $2 AND companion_id = $3
    FOR UPDATE
  `, [decision.grantId, decision.target.principalId, decision.companionId]);
  const row = one(result.rows, 'role_grant_mismatch');
  if (row.role !== decision.currentRole || row.lifecycle !== 'active'
    || row.restore_state !== 'live') {
    deny('role_grant_stale');
  }
  return row;
}

async function assertNotLastOwner(
  client: PoolClient,
  companionId: string,
  grantId: string,
  currentRole: string,
): Promise<void> {
  if (currentRole !== 'owner') return;
  const result = await client.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    WHERE companion_id = $1 AND role = 'owner' AND lifecycle = 'active'
      AND restore_state = 'live' AND grant_id <> $2
  `, [companionId, grantId]);
  if (result.rows[0]?.count === '0') deny('last_owner_protected');
}

async function prepareBindingActivation(
  client: PoolClient,
  decision: Extract<VerifiedFleetAuthLifecycleDecision, { action: 'binding.activate' }>,
): Promise<PreparedLifecycleMutation> {
  await assertCompanion(client, decision.companionId, 'active');
  await assertCompanionAdministrator(client, decision.actor.principalId, decision.companionId);
  const provider = await client.query<{ state: string; restore_state: string }>(`
    SELECT state, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
    WHERE provider = 'discord' AND subject_id = $1 AND principal_id = $2
    FOR UPDATE
  `, [decision.newProvider.subjectId, decision.target.principalId]);
  const providerRow = one(provider.rows, 'binding_provider_mismatch');
  if (providerRow.state !== 'pending' || providerRow.restore_state !== 'live') {
    deny('binding_provider_not_pending');
  }
  const conflict = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      WHERE companion_id = $1 AND contact_id = $2
        AND state IN ('active', 'pending')
      FOR UPDATE
    ) AS present
  `, [decision.companionId, decision.contactId]);
  if (conflict.rows[0]?.present !== false) deny('contact_binding_conflict');
  return {
    affectedPrincipalIds: [decision.target.principalId],
    bumps: bumps([[
      decision.target.principalId,
      { authn: true, authz: true, binding: true, policy: true },
    ]]),
    revocations: [],
    apply: async authorityGeneration => {
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
        SET state = 'active', authority_generation = $3, updated_at = $4
        WHERE provider = 'discord' AND subject_id = $1 AND principal_id = $2
      `, [
        decision.newProvider.subjectId,
        decision.target.principalId,
        authorityGeneration,
        decision.decidedAt,
      ]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
        SET status = 'active', updated_at = $2
        WHERE principal_id = $1
      `, [decision.target.principalId, decision.decidedAt]);
      await client.query(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
          (binding_id, principal_id, companion_id, contact_id, state,
           verification_provenance, authority_generation, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'active', $5::jsonb, $6, $7, $7)
      `, [
        decision.bindingId,
        decision.target.principalId,
        decision.companionId,
        decision.contactId,
        JSON.stringify({
          kind: 'verified_lifecycle_binding',
          decisionId: decision.decisionId,
          proofDigest: decision.newProvider.proofDigest,
          contactAuthorityVersion: decision.contactAuthority.contactAuthorityVersion,
          identityVersion: decision.contactAuthority.identityVersion,
          verificationId: decision.contactAuthority.verificationId,
          verificationDigest: decision.contactAuthority.verificationDigest,
        }),
        authorityGeneration,
        decision.decidedAt,
      ]);
    },
  };
}

async function prepareRoleMutation(
  client: PoolClient,
  decision: Extract<VerifiedFleetAuthLifecycleDecision, { action: `role.${string}` }>,
): Promise<PreparedLifecycleMutation> {
  await assertCompanion(client, decision.companionId, 'active');
  await assertCompanionAdministrator(client, decision.actor.principalId, decision.companionId);
  if ((decision.action === 'role.grant' && decision.role === 'owner')
    || (decision.action !== 'role.grant'
      && (decision.currentRole === 'owner'
        || (decision.action === 'role.change' && decision.role === 'owner')))) {
    await assertCompanionOwner(client, decision.actor.principalId, decision.companionId);
  }
  const targetId = decision.target.principalId;
  const binding = await client.query<{ present: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      WHERE principal_id = $1 AND companion_id = $2
        AND state = 'active' AND restore_state = 'live'
    ) AS present
  `, [targetId, decision.companionId]);
  if (binding.rows[0]?.present !== true) deny('role_target_binding_missing');
  const versionBumps = bumps([[
    targetId,
    { authz: true, grant: true, policy: true },
  ]]);
  if (decision.action === 'role.grant') {
    const existing = await client.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        WHERE principal_id = $1 AND companion_id = $2
          AND lifecycle IN ('active', 'pending')
        FOR UPDATE
      ) AS present
    `, [targetId, decision.companionId]);
    if (existing.rows[0]?.present !== false) deny('live_role_grant_exists');
    return {
      affectedPrincipalIds: [targetId],
      bumps: versionBumps,
      revocations: [],
      apply: async authorityGeneration => {
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
            (grant_id, principal_id, companion_id, role, lifecycle,
             authority_generation, created_at, updated_at)
          VALUES ($1, $2, $3, $4, 'active', $5, $6, $6)
        `, [
          decision.grantId,
          targetId,
          decision.companionId,
          decision.role,
          authorityGeneration,
          decision.decidedAt,
        ]);
      },
    };
  }

  const grant = await lockGrant(client, decision);
  await assertNotLastOwner(
    client,
    decision.companionId,
    decision.grantId,
    decision.currentRole,
  );
  if (decision.action === 'role.change') {
    return {
      affectedPrincipalIds: [targetId],
      bumps: versionBumps,
      revocations: [{ kind: 'role_grant', resourceId: decision.grantId }],
      apply: async authorityGeneration => {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          SET lifecycle = 'revoked', version = version + 1,
              authority_generation = $2, updated_at = $3
          WHERE grant_id = $1
        `, [decision.grantId, authorityGeneration, decision.decidedAt]);
        await client.query(`
          INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
            (grant_id, principal_id, companion_id, role, lifecycle, version,
             authority_generation, created_at, updated_at)
          VALUES ($1, $2, $3, $4, 'active', $5::bigint + 1, $6, $7, $7)
        `, [
          decision.newGrantId,
          targetId,
          decision.companionId,
          decision.role,
          grant.version,
          authorityGeneration,
          decision.decidedAt,
        ]);
      },
    };
  }
  return {
    affectedPrincipalIds: [targetId],
    bumps: versionBumps,
    revocations: [{ kind: 'role_grant', resourceId: decision.grantId }],
    apply: async authorityGeneration => {
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = 'revoked', version = $2::bigint + 1,
            authority_generation = $3, updated_at = $4
        WHERE grant_id = $1
      `, [decision.grantId, grant.version, authorityGeneration, decision.decidedAt]);
    },
  };
}

async function lockBinding(
  client: PoolClient,
  decision: Extract<
    VerifiedFleetAuthLifecycleDecision,
    { action: 'binding.conflict_suspend' | 'contact.unlink' }
  >,
): Promise<{ state: string; restore_state: string }> {
  const result = await client.query<{ state: string; restore_state: string }>(`
    SELECT state, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
    WHERE binding_id = $1 AND principal_id = $2
      AND companion_id = $3 AND contact_id = $4
    FOR UPDATE
  `, [
    decision.bindingId,
    decision.target.principalId,
    decision.companionId,
    decision.contactId,
  ]);
  const row = one(result.rows, 'contact_binding_mismatch');
  if (row.restore_state !== 'live' || !['active', 'pending', 'conflict'].includes(row.state)) {
    deny('contact_binding_unavailable');
  }
  return row;
}

async function prepareExactBindingMutation(
  client: PoolClient,
  decision: Extract<
    VerifiedFleetAuthLifecycleDecision,
    { action: 'binding.conflict_suspend' | 'contact.unlink' }
  >,
): Promise<PreparedLifecycleMutation> {
  await assertCompanion(client, decision.companionId, 'active');
  await assertCompanionAdministrator(client, decision.actor.principalId, decision.companionId);
  await lockBinding(client, decision);
  const revoke = decision.action === 'contact.unlink';
  if (revoke) {
    const ownerGrant = await client.query<{ grant_id: string; role: string }>(`
      SELECT grant_id, role
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      WHERE principal_id = $1 AND companion_id = $2
        AND lifecycle = 'active' AND restore_state = 'live'
      FOR UPDATE
    `, [decision.target.principalId, decision.companionId]);
    const owner = ownerGrant.rows.find(row => row.role === 'owner');
    if (owner) {
      await assertNotLastOwner(client, decision.companionId, owner.grant_id, owner.role);
    }
  }
  return {
    affectedPrincipalIds: [decision.target.principalId],
    bumps: bumps([[
      decision.target.principalId,
      { authz: true, binding: true, grant: revoke, policy: true },
    ]]),
    revocations: revoke
      ? [{ kind: 'contact_binding', resourceId: decision.bindingId }]
      : [],
    apply: async authorityGeneration => {
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        SET state = $2, version = version + 1, authority_generation = $3,
            updated_at = $4
        WHERE binding_id = $1
      `, [
        decision.bindingId,
        revoke ? 'revoked' : 'suspended',
        authorityGeneration,
        decision.decidedAt,
      ]);
      if (revoke) {
        await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
          SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
              version = version + 1, authority_generation = $3, updated_at = $4
          WHERE principal_id = $1 AND companion_id = $2 AND restore_state = 'live'
        `, [
          decision.target.principalId,
          decision.companionId,
          authorityGeneration,
          decision.decidedAt,
        ]);
      }
    },
  };
}

async function prepareContactMutation(
  client: PoolClient,
  decision: Extract<
    VerifiedFleetAuthLifecycleDecision,
    { action: 'contact.merge' | 'contact.delete' }
  >,
): Promise<PreparedLifecycleMutation> {
  await assertCompanion(client, decision.companionId, 'active');
  await assertCompanionAdministrator(client, decision.actor.principalId, decision.companionId);
  const sourceContact = decision.action === 'contact.merge'
    ? decision.sourceContactId
    : decision.contactId;
  const bindings = await client.query<{
    binding_id: string;
    principal_id: string;
    state: string;
    restore_state: string;
  }>(`
    SELECT binding_id, principal_id, state, restore_state
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
    WHERE companion_id = $1 AND contact_id = $2
    ORDER BY principal_id, binding_id
    FOR UPDATE
  `, [decision.companionId, sourceContact]);
  const live = bindings.rows.filter(row => row.restore_state === 'live'
    && row.state !== 'revoked');
  if (live.length === 0 || live.some(row => row.principal_id !== decision.target.principalId)) {
    deny('contact_binding_scope_mismatch');
  }
  if (decision.action === 'contact.merge') {
    const collision = await client.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        WHERE companion_id = $1 AND contact_id = $2
          AND state IN ('active', 'pending')
        FOR UPDATE
      ) AS present
    `, [decision.companionId, decision.canonicalContactId]);
    if (collision.rows[0]?.present === true) deny('canonical_contact_collision');
  }
  const ownerGrant = await client.query<{ grant_id: string; role: string }>(`
    SELECT grant_id, role
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    WHERE principal_id = $1 AND companion_id = $2
      AND lifecycle = 'active' AND restore_state = 'live'
    FOR UPDATE
  `, [decision.target.principalId, decision.companionId]);
  const owner = ownerGrant.rows.find(row => row.role === 'owner');
  if (owner) {
    await assertNotLastOwner(client, decision.companionId, owner.grant_id, owner.role);
  }
  const bindingIds = live.map(row => row.binding_id);
  return {
    affectedPrincipalIds: [decision.target.principalId],
    bumps: bumps([[
      decision.target.principalId,
      { authz: true, binding: true, grant: true, policy: true },
    ]]),
    revocations: bindingIds.map(resourceId => ({ kind: 'contact_binding', resourceId })),
    apply: async authorityGeneration => {
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        SET state = 'revoked', version = version + 1,
            authority_generation = $2, updated_at = $3
        WHERE binding_id = ANY($1::uuid[])
      `, [bindingIds, authorityGeneration, decision.decidedAt]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
            version = version + 1, authority_generation = $3, updated_at = $4
        WHERE principal_id = $1 AND companion_id = $2 AND restore_state = 'live'
      `, [
        decision.target.principalId,
        decision.companionId,
        authorityGeneration,
        decision.decidedAt,
      ]);
    },
  };
}

async function prepareCompanionMutation(
  client: PoolClient,
  decision: Extract<
    VerifiedFleetAuthLifecycleDecision,
    { action: 'companion.remove' | 'companion.readd' }
  >,
): Promise<PreparedLifecycleMutation> {
  const expected = decision.action === 'companion.remove' ? 'active' : 'removed';
  const companion = await assertCompanion(client, decision.companionId, expected);
  await assertCompanionAdministrator(
    client,
    decision.actor.principalId,
    decision.companionId,
    decision.action === 'companion.readd',
  );
  const principals = await client.query<{ principal_id: string }>(`
    SELECT DISTINCT principal_id
    FROM (
      SELECT principal_id FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
      WHERE companion_id = $1
      UNION
      SELECT principal_id FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
      WHERE companion_id = $1
    ) AS affected
    ORDER BY principal_id
  `, [decision.companionId]);
  const principalIds = decision.action === 'companion.remove'
    ? principals.rows.map(row => row.principal_id)
    : [decision.target.principalId];
  if (!principalIds.includes(decision.target.principalId)) {
    principalIds.push(decision.target.principalId);
    principalIds.sort();
  }
  return {
    affectedPrincipalIds: principalIds,
    bumps: bumps(principalIds.map(principalId => [
      principalId,
      { authz: true, binding: true, grant: true, policy: true },
    ])),
    revocations: decision.action === 'companion.remove'
      ? [{ kind: 'companion', resourceId: decision.companionId }]
      : [],
    ...(decision.action === 'companion.readd'
      ? { companionReadd: { companionId: decision.companionId, priorVersion: companion.version } }
      : {}),
    apply: async (authorityGeneration, companionLineage) => {
      if (decision.action === 'companion.readd') {
        if (!companionLineage) deny('companion_lineage_floor_missing');
        const updated = await client.query(`
          UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
          SET lifecycle = 'quarantined', version = version + 1,
              authority_generation = $3, authority_lineage_id = $4,
              lineage_generation = $5, readd_decision_id = $6, updated_at = $7
          WHERE companion_id = $1 AND version = $2
            AND lifecycle = 'removed' AND restore_state = 'live'
        `, [
          decision.companionId,
          companion.version,
          authorityGeneration,
          companionLineage.lineageId,
          companionLineage.lineageGeneration,
          decision.decisionId,
          decision.decidedAt,
        ]);
        if (updated.rowCount !== 1) deny('companion_readd_state_changed');
        return;
      }
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state
        SET lifecycle = 'removed', version = version + 1,
            authority_generation = $2, updated_at = $3
        WHERE companion_id = $1
      `, [decision.companionId, authorityGeneration, decision.decidedAt]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
        SET state = CASE WHEN state = 'revoked' THEN state ELSE 'suspended' END,
            version = version + 1, authority_generation = $2, updated_at = $3
        WHERE companion_id = $1 AND restore_state = 'live'
      `, [decision.companionId, authorityGeneration, decision.decidedAt]);
      await client.query(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
        SET lifecycle = CASE WHEN lifecycle = 'revoked' THEN lifecycle ELSE 'suspended' END,
            version = version + 1, authority_generation = $2, updated_at = $3
        WHERE companion_id = $1 AND restore_state = 'live'
      `, [decision.companionId, authorityGeneration, decision.decidedAt]);
    },
  };
}

export async function prepareLifecycleMutation(
  client: PoolClient,
  decision: VerifiedFleetAuthLifecycleDecision,
): Promise<PreparedLifecycleMutation> {
  switch (decision.action) {
    case 'binding.activate':
      return await prepareBindingActivation(client, decision);
    case 'provider.add':
    case 'provider.relink':
    case 'provider.replace':
    case 'provider.unlink':
      return await prepareProviderLifecycleMutation(client, decision);
    case 'role.grant':
    case 'role.change':
    case 'role.revoke':
      return await prepareRoleMutation(client, decision);
    case 'binding.conflict_suspend':
    case 'contact.unlink':
      return await prepareExactBindingMutation(client, decision);
    case 'contact.merge':
    case 'contact.delete':
      return await prepareContactMutation(client, decision);
    case 'companion.remove':
    case 'companion.readd':
      return await prepareCompanionMutation(client, decision);
    case 'principal.merge':
      return await preparePrincipalMergeMutation(client, decision);
  }
}
