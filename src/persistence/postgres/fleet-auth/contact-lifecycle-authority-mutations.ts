import type { PoolClient } from 'pg';
import type { ContactAuthorityLifecycleRequest } from '../../../shared/contracts/contact-authority-lifecycle.js';
import type { AccountAuthorityTombstoneKind } from './authority-floor.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

export interface ContactAuthorityAffectedRow {
  binding_id: string;
  principal_id: string;
  provider_subject_id: string | null;
}

export interface ContactAuthorityFloorResource {
  kind: Exclude<AccountAuthorityTombstoneKind, 'companion_lineage_floor'>;
  resourceId: string;
}

function contactFloorResource(companionId: string, contactId: string): string {
  return `contact:${companionId}:${contactId}`;
}

function providerFloorResource(companionId: string, subjectId: string): string {
  return `provider_subject:${companionId}:discord:${subjectId}`;
}

export async function lockContactLifecycleAffectedAuthority(
  client: PoolClient,
  companionId: string,
  request: ContactAuthorityLifecycleRequest,
): Promise<ContactAuthorityAffectedRow[]> {
  const result = await client.query<ContactAuthorityAffectedRow>(`
    SELECT binding.binding_id, binding.principal_id,
           (
             SELECT subject.subject_id
             FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
             WHERE subject.principal_id = binding.principal_id
               AND subject.provider = 'discord'
               AND subject.restore_state = 'live'
               AND subject.state IN ('active', 'pending')
               AND ($3::text IS NULL OR subject.subject_id = $3)
             ORDER BY subject.subject_id
             LIMIT 1
           ) AS provider_subject_id
    FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
    WHERE binding.companion_id = $1 AND binding.contact_id = $2
      AND binding.restore_state = 'live'
      AND binding.state IN ('active', 'pending')
      AND ($3::text IS NULL OR EXISTS (
        SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS exact_subject
        WHERE exact_subject.principal_id = binding.principal_id
          AND exact_subject.provider = 'discord'
          AND exact_subject.subject_id = $3
          AND exact_subject.restore_state = 'live'
          AND exact_subject.state IN ('active', 'pending')
      ))
    ORDER BY binding.binding_id
    FOR UPDATE OF binding
  `, [companionId, request.contactId, request.providerSubjectId ?? null]);
  return result.rows;
}

export function contactLifecycleFloorResources(
  companionId: string,
  request: ContactAuthorityLifecycleRequest,
  affected: ContactAuthorityAffectedRow[],
): ContactAuthorityFloorResource[] {
  const resources = new Map<string, ContactAuthorityFloorResource>();
  const add = (
    kind: Exclude<AccountAuthorityTombstoneKind, 'companion_lineage_floor'>,
    resourceId: string,
  ): void => {
    resources.set(`${kind}:${resourceId}`, { kind, resourceId });
  };
  add('contact_authority_fence', contactFloorResource(companionId, request.contactId));
  if (request.providerSubjectId && request.action === 'contact.discord_unlink') {
    add('contact_authority_fence', providerFloorResource(companionId, request.providerSubjectId));
  }
  for (const row of affected) {
    add('contact_binding', row.binding_id);
    if (row.provider_subject_id && request.action === 'contact.discord_unlink') {
      add('provider_subject', `discord:${row.provider_subject_id}`);
    }
  }
  return [...resources.values()];
}

export async function applyContactLifecycleDestructiveFence(options: {
  client: PoolClient;
  companionId: string;
  request: ContactAuthorityLifecycleRequest;
  affected: ContactAuthorityAffectedRow[];
  authorityGeneration: number;
  nextEpoch: number;
  now: () => Date;
}): Promise<void> {
  const { client, request, affected, authorityGeneration, nextEpoch, now } = options;
  const principalIds = [...new Set(affected.map(row => row.principal_id))];
  const bindingIds = [...new Set(affected.map(row => row.binding_id))];
  const subjectIds = [...new Set(affected.flatMap(row => (
    row.provider_subject_id ? [row.provider_subject_id] : []
  )))];
  const suspended = request.action === 'contact.identity_conflict';
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings
    SET state = $2, version = version + 1, authority_generation = $3, updated_at = $4
    WHERE binding_id = ANY($1::uuid[])
  `, [bindingIds, suspended ? 'conflict' : 'revoked', authorityGeneration, now()]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants
    SET lifecycle = $2, version = version + 1,
        authority_generation = $3, updated_at = $4
    WHERE principal_id = ANY($1::uuid[]) AND companion_id = $5
      AND lifecycle IN ('active', 'pending')
  `, [
    principalIds,
    suspended ? 'suspended' : 'revoked',
    authorityGeneration,
    now(),
    options.companionId,
  ]);
  if (subjectIds.length > 0
    && (request.action === 'contact.discord_unlink'
      || request.action === 'contact.identity_conflict')) {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
      SET state = $2, authority_generation = $3, updated_at = $4
      WHERE provider = 'discord' AND subject_id = ANY($1::text[])
    `, [subjectIds, suspended ? 'suspended' : 'revoked', authorityGeneration, now()]);
  }
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.human_principals
    SET authz_version = authz_version + 1,
        binding_version = binding_version + 1,
        grant_version = grant_version + 1,
        policy_version = policy_version + 1,
        authority_generation = $2, updated_at = $3
    WHERE principal_id = ANY($1::uuid[]) AND restore_state = 'live'
  `, [principalIds, authorityGeneration, now()]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions
    SET revoked_at = COALESCE(revoked_at, $2)
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds, now()]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.jit_authorization_grants
    SET revoked_at = COALESCE(revoked_at, $2)
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds, now()]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.step_up_challenges
    SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.provider_token_custody
    SET revoked_at = COALESCE(revoked_at, $2)
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds, now()]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds]);
  await client.query(`
    DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences
    WHERE principal_id = ANY($1::uuid[])
  `, [principalIds]);
  await client.query(`
    UPDATE ${FLEET_AUTH_SCHEMA_NAME}.oauth_transactions
    SET status = 'revoked'
    WHERE status = 'pending'
      AND (initiating_principal_id IS NULL
        OR initiating_principal_id = ANY($1::uuid[]))
  `, [principalIds]);
  for (const table of [
    'browser_sessions', 'jit_authorization_grants', 'step_up_challenges',
    'provider_token_custody', 'discord_evidence_snapshots',
    'discord_evidence_lifecycle_fences',
  ]) {
    await client.query(`
      UPDATE ${FLEET_AUTH_SCHEMA_NAME}.${table}
      SET global_auth_epoch = $2
      WHERE global_auth_epoch = $1
        AND NOT (principal_id = ANY($3::uuid[]))
    `, [nextEpoch - 1, nextEpoch, principalIds]);
  }
}
