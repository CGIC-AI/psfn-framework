import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  ChildAssertionAuthorityDecision,
  ChildAssertionAuthorityInput,
  GatewayChildAssertionAuthorityPort,
} from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import type { FleetAuthConfig, FleetAuthRole } from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME } from './companion-authority-lock-sql.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';

interface CurrentAuthorityRow {
  authority_generation: string;
  global_auth_epoch: string;
}

interface ParentAuditRow extends CurrentAuthorityRow {
  principal_id: string;
  action: string;
  companion_id: string;
  decision: 'allow' | 'deny';
}

interface CurrentGrantRow {
  role: FleetAuthRole;
  session_count: string;
  provider_count: string;
  binding_count: string;
  grant_count: string;
}

function positiveInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export class PostgresChildAssertionAuthority implements GatewayChildAssertionAuthorityPort {
  private readonly disabledActionsByRole: FleetAuthConfig['rolePolicy']['disabledActionsByRole'];

  constructor(
    private readonly pool: Pool,
    config: Pick<FleetAuthConfig, 'rolePolicy'>,
    private readonly providerRevocationAuthority: ProviderRevocationAuthorityPort,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.disabledActionsByRole = {
      owner: [...config.rolePolicy.disabledActionsByRole.owner],
      admin: [...config.rolePolicy.disabledActionsByRole.admin],
      member: [...config.rolePolicy.disabledActionsByRole.member],
      guest: [...config.rolePolicy.disabledActionsByRole.guest],
    };
  }

  async reauthorize(
    input: ChildAssertionAuthorityInput,
  ): Promise<ChildAssertionAuthorityDecision> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const authority = await this.lockAuthority(client);
      await client.query(
        `SELECT * FROM ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}($1)`,
        [input.parent.companionId],
      );
      const parentAudit = await this.loadParentAudit(client, input);
      const current = parentAudit
        ? await this.loadCurrentGrant(client, input, parentAudit.principal_id)
        : undefined;
      const versions = input.parent.versions;
      const authorityExact = authority.authorityGeneration === versions.authorityGeneration
        && authority.globalAuthEpoch === versions.globalAuthEpoch;
      const parentExact = parentAudit?.decision === 'allow'
        && parentAudit.action === input.parent.action
        && parentAudit.companion_id === input.parent.companionId
        && positiveInteger(parentAudit.authority_generation) === versions.authorityGeneration
        && positiveInteger(parentAudit.global_auth_epoch) === versions.globalAuthEpoch;
      const currentExact = current !== undefined
        && current.session_count === '1'
        && current.provider_count === '1'
        && current.binding_count === '1'
        && current.grant_count === '1'
        && !this.disabledActionsByRole[current.role].includes(input.childTarget.action);
      const decisionId = randomUUID();
      const allowed = authorityExact && parentExact && currentExact;
      const externalAuthorityCurrent = this.providerRevocationAuthority
        .sessionAuthorityGenerationIsCurrent(authority.authorityGeneration);
      await this.insertAudit(client, {
        eventId: decisionId,
        input,
        authority,
        decision: allowed && externalAuthorityCurrent ? 'allow' : 'deny',
        principalId: parentAudit?.principal_id,
        reasonCode: allowed && externalAuthorityCurrent
          ? 'child_authority_reauthorized'
          : 'child_authority_denied',
      });
      await client.query('COMMIT');
      if (!allowed || !externalAuthorityCurrent) return { decision: 'deny' };
      if (!this.providerRevocationAuthority
        .sessionAuthorityGenerationIsCurrent(authority.authorityGeneration)) {
        await client.query('BEGIN');
        const postCommitAuthority = await this.lockAuthority(client);
        await this.insertAudit(client, {
          eventId: randomUUID(),
          input,
          authority: postCommitAuthority,
          decision: 'deny',
          principalId: parentAudit.principal_id,
          reasonCode: 'child_authority_generation_stale',
        });
        await client.query('COMMIT');
        return { decision: 'deny' };
      }
      return {
        decision: 'allow',
        decisionId,
        versions: Object.freeze({ ...versions }),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<{
    authorityGeneration: number;
    globalAuthEpoch: number;
  }> {
    const result = await client.query<CurrentAuthorityRow>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const row = result.rows.at(0);
    const authorityGeneration = row && positiveInteger(row.authority_generation);
    const globalAuthEpoch = row && positiveInteger(row.global_auth_epoch);
    if (!authorityGeneration || !globalAuthEpoch) {
      throw new Error('fleet_auth authority_state singleton is missing or invalid');
    }
    return { authorityGeneration, globalAuthEpoch };
  }

  private async loadParentAudit(
    client: PoolClient,
    input: ChildAssertionAuthorityInput,
  ): Promise<ParentAuditRow | undefined> {
    const result = await client.query<ParentAuditRow>(`
      SELECT principal_id, action, companion_id, decision,
             authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
      WHERE event_id = $1
        AND resource = $2
        AND principal_id IS NOT NULL
    `, [input.parent.decisionId, `companion:${input.parent.companionId}`]);
    return result.rows.at(0);
  }

  private async loadCurrentGrant(
    client: PoolClient,
    input: ChildAssertionAuthorityInput,
    principalId: string,
  ): Promise<CurrentGrantRow | undefined> {
    const versions = input.parent.versions;
    const result = await client.query<CurrentGrantRow>(`
      SELECT role_grant.role,
        (SELECT count(*)::text
         FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
         JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
           ON principal.principal_id = session.principal_id
         LEFT JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases AS alias
           ON alias.source_principal_id = principal.principal_id
         WHERE session.principal_id = $1
           AND session.audience = 'fleet'
           AND session.authn_version = $3
           AND session.authz_version = $4
           AND session.binding_version = $5
           AND session.grant_version = $6
           AND session.policy_version = $7
           AND session.global_auth_epoch = $8
           AND session.revoked_at IS NULL
           AND session.replaced_by IS NULL
           AND session.idle_expires_at > $9
           AND session.absolute_expires_at > $9
           AND principal.status = 'active'
           AND principal.restore_state = 'live'
           AND principal.authn_version = $3
           AND principal.authz_version = $4
           AND principal.binding_version = $5
           AND principal.grant_version = $6
           AND principal.policy_version = $7
           AND principal.authority_generation = $2
           AND alias.source_principal_id IS NULL
           AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
             'principal', principal.principal_id::text
           )) AS session_count,
        (SELECT count(*)::text
         FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
         WHERE subject.principal_id = $1
           AND subject.state = 'active'
           AND subject.restore_state = 'live'
           AND subject.authority_generation = $2
           AND NOT EXISTS (
             SELECT 1 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones AS tombstone
             WHERE tombstone.provider = subject.provider
               AND tombstone.subject_id = subject.subject_id
           )
           AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
             'provider_subject', subject.provider || ':' || subject.subject_id
           )
           AND NOT ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
             $10::uuid, 'provider_subject', subject.subject_id
           )
           AND EXISTS (
             SELECT 1
             FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS provider_session
             WHERE provider_session.principal_id = $1
               AND provider_session.provider = subject.provider
               AND provider_session.provider_subject_id = subject.subject_id
               AND provider_session.authn_version = $3
               AND provider_session.authz_version = $4
               AND provider_session.binding_version = $5
               AND provider_session.grant_version = $6
               AND provider_session.policy_version = $7
               AND provider_session.global_auth_epoch = $8
               AND provider_session.revoked_at IS NULL
               AND provider_session.replaced_by IS NULL
               AND provider_session.idle_expires_at > $9
               AND provider_session.absolute_expires_at > $9
           )) AS provider_count,
        (SELECT count(*)::text
         FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
         WHERE binding.principal_id = $1
           AND binding.companion_id = $10
           AND binding.state = 'active'
           AND binding.restore_state = 'live'
           AND binding.version = $5
           AND binding.authority_generation = $2
           AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
             'contact_binding', binding.binding_id::text
           )
           AND NOT ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
             binding.companion_id, 'contact', binding.contact_id
           )) AS binding_count,
        count(*)::text AS grant_count
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
      JOIN ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}($10) AS companion
        ON companion.companion_id = role_grant.companion_id
      WHERE role_grant.principal_id = $1
        AND role_grant.companion_id = $10
        AND role_grant.lifecycle = 'active'
        AND role_grant.restore_state = 'live'
        AND role_grant.version = $6
        AND role_grant.authority_generation = $2
        AND NOT ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
          'role_grant', role_grant.grant_id::text
        )
        AND companion.lifecycle = 'active'
        AND companion.restore_state = 'live'
        AND companion.authority_generation = $2
        AND (companion.authority_lineage_id IS NULL OR companion.lineage_floor_current)
        AND (NOT companion.tombstoned OR companion.lineage_floor_current)
      GROUP BY role_grant.role
    `, [
      principalId,
      versions.authorityGeneration,
      versions.sessionAuthnVersion,
      versions.sessionAuthzVersion,
      versions.bindingVersion,
      versions.grantVersion,
      versions.policyVersion,
      versions.globalAuthEpoch,
      this.now(),
      input.parent.companionId,
    ]);
    return result.rows.length === 1 ? result.rows[0] : undefined;
  }

  private async insertAudit(client: PoolClient, input: {
    eventId: string;
    input: ChildAssertionAuthorityInput;
    authority: { authorityGeneration: number; globalAuthEpoch: number };
    decision: 'allow' | 'deny';
    principalId?: string;
    reasonCode: string;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         occurred_at, decision_context)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
    `, [
      input.eventId,
      JSON.stringify({
        kind: 'operator_process',
        operatorIdDigest: digest(input.input.operator.operatorId),
      }),
      input.input.childTarget.action,
      `companion:${input.input.childTarget.companionId}`,
      input.decision,
      input.reasonCode,
      input.input.childTarget.companionId,
      input.principalId ?? null,
      input.authority.authorityGeneration,
      input.authority.globalAuthEpoch,
      this.now(),
      JSON.stringify({
        schemaVersion: 1,
        parentDecisionDigest: digest(input.input.parent.decisionId),
        parentTargetDigest: input.input.parent.targetDigest,
        childTargetDigest: input.input.childTarget.targetDigest,
      }),
    ]);
  }
}
