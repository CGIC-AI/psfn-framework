import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  FleetEscalationGrantBinding,
  FleetEscalationGrantStore,
} from '../../../boundary/fleet-auth/escalation.js';
import {
  FLEET_AUTH_ACTIONS,
  findFleetAuthAccountRosterEntry,
  type FleetAuthAccountRosterEntry,
  type FleetAuthAction,
} from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FleetAuthSecretCodec } from './oauth-secret-codec.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import { createPositiveIntegerCoercer } from './row-utils.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

const ACTIONS = new Set<string>(FLEET_AUTH_ACTIONS);
const ASSURANCE_REQUIREMENTS = new Set(['escalated', 'privacy_break_glass']);

interface LockedSession {
  record_id: string;
  principal_id: string;
  principal_status: string;
  authn_version: string;
  authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  session_authn_version: string;
  session_authz_version: string;
  session_binding_version: string;
  session_grant_version: string;
  session_policy_version: string;
  provider: string | null;
  provider_subject_id: string | null;
  provider_state: string | null;
  provider_restore_state: string | null;
  authority_generation: string;
  global_auth_epoch: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  revoked_at: Date | null;
  replaced_by: string | null;
  restore_state: string;
}

interface GrantRow {
  grant_id: string;
  principal_id: string;
  browser_session_id: string;
  companion_id: string;
  action: string;
  route_id: string;
  scope_digest: string;
  assurance_requirement: string;
  expires_at: Date;
}

export interface PostgresFleetEscalationGrantStoreOptions {
  pool: Pool;
  sessionPepper: string;
  tokenEncryptionKey: string;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  /** Boot-frozen admin-unconditional roster; grants may be issued by rostered owners without a completed binding ceremony. */
  accountRoster?: readonly FleetAuthAccountRosterEntry[];
}

const positiveInteger = createPositiveIntegerCoercer('escalation-grant');

function grant(row: GrantRow): FleetEscalationGrantBinding {
  if (!ACTIONS.has(row.action)) throw new Error('Invalid fleet_auth escalation action');
  if (!ASSURANCE_REQUIREMENTS.has(row.assurance_requirement)) {
    throw new Error('Invalid fleet_auth escalation assurance requirement');
  }
  return {
    grantId: row.grant_id,
    principalId: row.principal_id,
    browserSessionId: row.browser_session_id,
    companionId: row.companion_id,
    action: row.action as FleetAuthAction,
    routeId: row.route_id,
    scopeDigest: row.scope_digest,
    assuranceRequirement: row.assurance_requirement as 'escalated' | 'privacy_break_glass',
    expiresAt: row.expires_at,
  };
}

/** Runtime DML is bounded to exact single-use escalation grants; no Pool escapes. */
export class PostgresFleetEscalationGrantStore implements FleetEscalationGrantStore {
  private readonly codec: FleetAuthSecretCodec;

  constructor(private readonly options: PostgresFleetEscalationGrantStoreOptions) {
    this.codec = new FleetAuthSecretCodec(options);
  }

  async createGrant(
    input: Parameters<FleetEscalationGrantStore['createGrant']>[0],
  ): ReturnType<FleetEscalationGrantStore['createGrant']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSession(client, input.token, input.csrfToken, input.now);
      await this.requireCompanionAuthority(client, session, input.binding.companionId);
      const recent = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
        WHERE browser_session_id = $1
          AND created_at > $2::timestamptz - interval '10 minutes'
      `, [session.record_id, input.now]);
      if (positiveInteger(recent.rows.at(0)?.count ?? '0', 'grant rate count', true) >= 20) {
        throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
          'grant_unavailable',
          'Escalation grant rate limit exceeded',
        );
      }
      const inserted = await client.query<GrantRow>(`
        INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants (
          grant_id, principal_id, browser_session_id, companion_id, action,
          route_id, scope_digest, reason_digest, assurance_requirement,
          exact_origin, authz_version, binding_version, grant_version,
          policy_version, global_auth_epoch, created_at, expires_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17
        )
        RETURNING grant_id, principal_id, browser_session_id, companion_id,
                  action, route_id, scope_digest, assurance_requirement, expires_at
      `, [
        input.grantId,
        session.principal_id,
        session.record_id,
        input.binding.companionId,
        input.binding.action,
        input.binding.routeId,
        input.binding.scopeDigest,
        input.binding.reasonDigest,
        input.binding.assuranceRequirement,
        input.exactOrigin,
        session.authz_version,
        session.binding_version,
        session.grant_version,
        session.policy_version,
        session.global_auth_epoch,
        input.now,
        input.expiresAt,
      ]);
      const row = inserted.rows.at(0);
      if (!row) {
        throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
          'grant_unavailable',
          'Escalation grant was not recorded',
        );
      }
      await this.audit(client, {
        action: 'escalation.grant.issue',
        resource: `scope:${input.binding.scopeDigest} route:${input.binding.routeId}`,
        decision: 'allow',
        reason: input.reason,
        companionId: input.binding.companionId,
        principalId: session.principal_id,
        authorityGeneration: session.authority_generation,
        globalAuthEpoch: session.global_auth_epoch,
        correlationId: input.grantId,
        at: input.now,
      });
      await client.query('COMMIT');
      return grant(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeGrant(
    input: Parameters<FleetEscalationGrantStore['consumeGrant']>[0],
  ): ReturnType<FleetEscalationGrantStore['consumeGrant']> {
    const client = await this.options.pool.connect();
    try {
      await client.query('BEGIN');
      await this.lockAuthority(client);
      const session = await this.lockSessionByToken(client, input.token, input.now);
      const result = await client.query<GrantRow>(`
        UPDATE ${FLEET_AUTH_SCHEMA_NAME}.escalation_grants
        SET consumed_at = $2
        WHERE grant_id = $1
          AND principal_id = $3 AND browser_session_id = $4
          AND companion_id = $5 AND action = $6
          AND route_id = $7 AND scope_digest = $8
          AND assurance_requirement = $9
          AND exact_origin = $10
          AND authz_version = $11 AND binding_version = $12
          AND grant_version = $13 AND policy_version = $14
          AND global_auth_epoch = $15
          AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > $2
        RETURNING grant_id, principal_id, browser_session_id, companion_id,
                  action, route_id, scope_digest, assurance_requirement, expires_at
      `, [
        input.grantId,
        input.now,
        session.principal_id,
        session.record_id,
        input.binding.companionId,
        input.binding.action,
        input.binding.routeId,
        input.binding.scopeDigest,
        input.binding.assuranceRequirement,
        input.exactOrigin,
        session.authz_version,
        session.binding_version,
        session.grant_version,
        session.policy_version,
        session.global_auth_epoch,
      ]);
      const row = result.rows.at(0);
      if (!row) {
        throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
          'grant_unavailable',
          'Escalation grant is unavailable',
        );
      }
      await this.audit(client, {
        action: 'escalation.grant.consume',
        resource: `scope:${row.scope_digest} route:${row.route_id}`,
        decision: 'allow',
        reason: row.assurance_requirement,
        companionId: row.companion_id,
        principalId: session.principal_id,
        authorityGeneration: session.authority_generation,
        globalAuthEpoch: session.global_auth_epoch,
        correlationId: row.grant_id,
        at: input.now,
      });
      await client.query('COMMIT');
      return grant(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async lockAuthority(client: PoolClient): Promise<void> {
    await client.query(`SELECT global_auth_epoch FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()`);
  }

  private lockSession(
    client: PoolClient,
    token: string,
    csrfToken: string,
    now: Date,
  ): Promise<LockedSession> {
    return this.lockSessionWithDigest(client, this.codec.digest(token), this.codec.digest(csrfToken), now);
  }

  private lockSessionByToken(
    client: PoolClient,
    token: string,
    now: Date,
  ): Promise<LockedSession> {
    return this.lockSessionWithDigest(client, this.codec.digest(token), undefined, now);
  }

  private async lockSessionWithDigest(
    client: PoolClient,
    tokenDigest: string,
    csrfDigest: string | undefined,
    now: Date,
  ): Promise<LockedSession> {
    const result = await client.query<LockedSession>(`
      SELECT session.record_id, session.principal_id,
             principal.status AS principal_status,
             principal.authn_version, principal.authz_version,
             principal.binding_version, principal.grant_version, principal.policy_version,
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             session.binding_version AS session_binding_version,
             session.grant_version AS session_grant_version,
             session.policy_version AS session_policy_version,
             session.provider, session.provider_subject_id,
             subject.state AS provider_state, subject.restore_state AS provider_restore_state,
             authority.authority_generation, authority.global_auth_epoch,
             session.global_auth_epoch AS session_global_auth_epoch,
             session.idle_expires_at, session.absolute_expires_at,
             session.revoked_at, session.replaced_by, principal.restore_state
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
        ON subject.provider = session.provider
       AND subject.subject_id = session.provider_subject_id
       AND subject.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority ON authority.singleton = TRUE
      WHERE session.token_digest = $1
        AND ($2::text IS NULL OR session.csrf_digest = $2)
      FOR UPDATE OF session, principal, subject
    `, [tokenDigest, csrfDigest ?? null]);
    const row = result.rows.at(0);
    if (!row || row.revoked_at || row.replaced_by
      || row.idle_expires_at.getTime() <= now.getTime()
      || row.absolute_expires_at.getTime() <= now.getTime()
      || row.restore_state !== 'live'
      || row.provider !== 'discord' || !row.provider_subject_id
      || row.provider_state !== 'active' || row.provider_restore_state !== 'live'
      || row.authn_version !== row.session_authn_version
      || row.authz_version !== row.session_authz_version
      || row.binding_version !== row.session_binding_version
      || row.grant_version !== row.session_grant_version
      || row.policy_version !== row.session_policy_version
      || row.global_auth_epoch !== row.session_global_auth_epoch
      || !this.options.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        positiveInteger(row.authority_generation, 'authority_generation'),
      )) {
      throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
        'session_unavailable',
        'Fleet session is unavailable',
      );
    }
    if (row.principal_status !== 'active'
      && !this.rosteredSubject(row.provider_subject_id)) {
      throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
        'session_unavailable',
        'Fleet session is unavailable',
      );
    }
    return row;
  }

  private rosteredSubject(providerSubjectId: string): boolean {
    return (this.options.accountRoster ?? [])
      .some(entry => entry.providerSubjectId === providerSubjectId);
  }

  /**
   * A grant may be issued when the principal either holds an active
   * binding + role grant for the companion, or is admin-unconditionally
   * rostered for it (the roster path never leaves `pending` on live fleets;
   * see hrmrq.22). The gated request that consumes the grant still passes the
   * full broker authorization, so this check bounds issuance, not access.
   */
  private async requireCompanionAuthority(
    client: PoolClient,
    session: LockedSession,
    companionId: string,
  ): Promise<void> {
    if (session.provider_subject_id && findFleetAuthAccountRosterEntry(
      this.options.accountRoster,
      'discord',
      session.provider_subject_id,
      companionId,
    )) {
      return;
    }
    const result = await client.query(`
      SELECT 1
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role
        ON role.principal_id = binding.principal_id
       AND role.companion_id = binding.companion_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.companion_authority_state AS companion
        ON companion.companion_id = binding.companion_id
      WHERE binding.principal_id = $1 AND binding.companion_id = $2
        AND binding.state = 'active' AND binding.restore_state = 'live'
        AND role.lifecycle = 'active' AND role.restore_state = 'live'
        AND companion.lifecycle = 'active' AND companion.restore_state = 'live'
      FOR SHARE OF binding, role, companion
    `, [session.principal_id, companionId]);
    if (result.rowCount !== 1) {
      throw new fleetAuthPersistenceBoundaryValues.FleetEscalationError(
        'grant_unavailable',
        'Companion authority is unavailable',
      );
    }
  }

  private async audit(client: PoolClient, input: {
    action: string;
    resource: string;
    decision: 'allow' | 'deny';
    reason: string;
    companionId: string;
    principalId: string;
    authorityGeneration: string;
    globalAuthEpoch: string;
    correlationId: string;
    at: Date;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events (
        event_id, actor_context, action, resource, decision, reason_code,
        companion_id, principal_id, authority_generation, global_auth_epoch,
        correlation_id, occurred_at
      ) VALUES (
        $1, '{"kind":"fleet_escalation"}'::jsonb, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11
      )
    `, [
      randomUUID(), input.action, input.resource, input.decision,
      input.reason,
      input.companionId, input.principalId, input.authorityGeneration,
      input.globalAuthEpoch, input.correlationId, input.at,
    ]);
  }
}
