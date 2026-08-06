import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  FleetAuthorizationDenialReason,
  FleetAuthorizationSnapshot,
} from '../../../boundary/gateway/fleet-authorization-context.js';
import type {
  FleetPortalAuthorizationBatchRequest,
  FleetPortalAuthorizationBatchStore,
  FleetPortalAuthorizationBatchStoreDecision,
} from '../../../boundary/gateway/fleet-portal-authorization.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import type {
  FleetAuthAccountRosterEntry,
  FleetAuthConfig,
  FleetAuthRole,
} from '../../../system/config/fleet-auth-config.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME } from './companion-authority-lock-sql.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';
import {
  createPositiveIntegerCoercer,
  mapFleetAuthSessionRow,
  type FleetAuthSessionRow,
} from './row-utils.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';
import { fleetAuthPersistenceBoundaryValues } from './boundary-values-port.js';

const positiveInteger = createPositiveIntegerCoercer('portal-authorization');

interface PortalProviderSubjectRow {
  companion_id: string;
  provider: 'discord';
  subject_id: string;
  state: FleetAuthorizationSnapshot['providerSubjects'][number]['state'];
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
  contact_authority_fenced: boolean;
}

interface PortalCompanionRow {
  companion_id: string;
  lifecycle: FleetAuthorizationSnapshot['companions'][number]['lifecycle'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  authority_lineage_id: string | null;
  lineage_floor_current: boolean;
  tombstoned: boolean;
}

interface PortalBindingRow {
  binding_id: string;
  companion_id: string;
  contact_id: string;
  state: FleetAuthorizationSnapshot['bindings'][number]['state'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
  contact_authority_fenced: boolean;
}

interface PortalGrantRow {
  grant_id: string;
  companion_id: string;
  role: FleetAuthRole;
  lifecycle: FleetAuthorizationSnapshot['grants'][number]['lifecycle'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
}

interface PortalSnapshot {
  companionId: string;
  snapshot: FleetAuthorizationSnapshot;
}

export interface PostgresFleetPortalAuthorizationStoreOptions {
  pool: Pool;
  sessionPepper: string;
  config: FleetAuthConfig;
  knownCompanionIds: readonly string[];
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  now?: () => Date;
}

export function mapPortalAuthorizationSessionRow(
  row: FleetAuthSessionRow,
): FleetAuthorizationSnapshot['sessions'][number] {
  return mapFleetAuthSessionRow(row, 'portal-authorization');
}

export class PostgresFleetPortalAuthorizationStore
implements FleetPortalAuthorizationBatchStore {
  private readonly pool: Pool;
  private readonly sessionPepper: string;
  private readonly disabledActionsByRole: FleetAuthConfig['rolePolicy']['disabledActionsByRole'];
  private readonly accountRoster: readonly FleetAuthAccountRosterEntry[];
  private readonly knownCompanionIds: readonly string[];
  private readonly providerRevocationAuthority: ProviderRevocationAuthorityPort;
  private readonly now: () => Date;

  constructor(options: PostgresFleetPortalAuthorizationStoreOptions) {
    if (options.sessionPepper.length < 32) {
      throw new Error('Fleet portal authorization requires the configured session pepper');
    }
    const knownCompanionIds = [...options.knownCompanionIds].sort();
    if (knownCompanionIds.length === 0
      || knownCompanionIds.length > 256
      || knownCompanionIds.some(companionId => !isRfc4122Uuid(companionId))
      || new Set(knownCompanionIds).size !== knownCompanionIds.length) {
      throw new Error('Fleet portal authorization requires 1-256 unique RFC-4122 companions');
    }
    const knownCompanionIdSet = new Set(knownCompanionIds);
    for (const entry of options.config.accountRoster ?? []) {
      if (!knownCompanionIdSet.has(entry.companionId)) {
        throw new Error(
          `Fleet auth accountRoster references unknown companion ${entry.companionId}`,
        );
      }
    }
    this.pool = options.pool;
    this.sessionPepper = options.sessionPepper;
    this.disabledActionsByRole = {
      owner: [...options.config.rolePolicy.disabledActionsByRole.owner],
      admin: [...options.config.rolePolicy.disabledActionsByRole.admin],
      member: [...options.config.rolePolicy.disabledActionsByRole.member],
      guest: [...options.config.rolePolicy.disabledActionsByRole.guest],
    };
    this.accountRoster = Object.freeze(
      (options.config.accountRoster ?? []).map(entry => Object.freeze({ ...entry })),
    );
    this.knownCompanionIds = Object.freeze(knownCompanionIds);
    this.providerRevocationAuthority = options.providerRevocationAuthority;
    this.now = options.now ?? (() => new Date());
  }

  async resolveBatch(
    request: FleetPortalAuthorizationBatchRequest,
  ): Promise<FleetPortalAuthorizationBatchStoreDecision> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const snapshots = await this.loadSnapshots(client, request.sessionToken);
      const resolvedAt = this.now();
      const representative = snapshots[0]!;
      const sessionEvaluation = fleetAuthPersistenceBoundaryValues
        .evaluateFleetAuthorizationSessionSnapshot({
        snapshot: representative.snapshot,
        now: resolvedAt,
      });
      // Admin-unconditional roster fallback: when the shared session gauntlet
      // or the authority-generation gate denies, a session whose token-verified
      // Discord subject is rostered still resolves — but strictly to its
      // rostered companions. Non-rostered sessions keep the unchanged denial.
      const rosterCompanions = this.rosterAuthorizedCompanions(
        snapshots,
        request.sessionToken,
        resolvedAt,
      );
      const generationCurrent = this.providerRevocationAuthority
        .sessionAuthorityGenerationIsCurrent(
          representative.snapshot.authority.authorityGeneration,
        );
      let decision: FleetPortalAuthorizationBatchStoreDecision;
      let rosterFallback = false;
      if (sessionEvaluation.decision === 'deny' || !generationCurrent) {
        if (rosterCompanions.length > 0) {
          rosterFallback = true;
          decision = { decision: 'allow', companions: rosterCompanions };
        } else {
          decision = sessionEvaluation.decision === 'deny'
            ? sessionEvaluation
            : { decision: 'deny', reasonCode: 'authority_generation_stale' };
        }
      } else {
        decision = { decision: 'allow', companions: this.authorizedCompanions(
          snapshots,
          request.sessionToken,
          resolvedAt,
        ) };
      }
      await this.insertAudit(client, {
        decision: decision.decision,
        reasonCode: decision.decision === 'allow'
          ? rosterFallback
            ? 'roster_portal_projection_allowed'
            : 'portal_projection_allowed'
          : decision.reasonCode,
        principalId: sessionEvaluation.decision === 'allow'
          ? sessionEvaluation.session.principalId
          : representative.snapshot.sessions.at(0)?.principalId,
        authority: representative.snapshot.authority,
        occurredAt: resolvedAt,
      });
      await client.query('COMMIT');
      if (decision.decision === 'deny') return decision;
      if (!rosterFallback
        && !this.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
          representative.snapshot.authority.authorityGeneration,
        )) {
        if (rosterCompanions.length > 0) {
          // The generation went stale post-commit: degrade to the rostered
          // companions only instead of locking the rostered admin out. Record
          // the narrower result so the earlier full-projection allow is not
          // the last event an audit consumer sees.
          await this.recordPostCommitRosterDegradation(
            client,
            sessionEvaluation.decision === 'allow'
              ? sessionEvaluation.session.principalId
              : undefined,
          );
          return {
            decision: 'allow',
            companions: Object.freeze(
              rosterCompanions.map(companion => Object.freeze(companion)),
            ),
          };
        }
        await this.recordPostCommitAuthorityDenial(
          client,
          sessionEvaluation.decision === 'allow'
            ? sessionEvaluation.session.principalId
            : undefined,
        );
        return { decision: 'deny', reasonCode: 'authority_generation_stale' };
      }
      return {
        decision: 'allow',
        companions: Object.freeze(decision.companions.map(companion => Object.freeze(companion))),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      try {
        await this.recordInfrastructureDenial(client);
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          'Fleet portal authorization failed and its denial audit could not be persisted',
        );
      }
      if (isRecord(error) && error.code === '40001') {
        return { decision: 'deny', reasonCode: 'authorization_store_error' };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private authorizedCompanions(
    snapshots: readonly PortalSnapshot[],
    sessionToken: string,
    resolvedAt: Date,
  ): Extract<FleetPortalAuthorizationBatchStoreDecision, { decision: 'allow' }>['companions'] {
    return snapshots.flatMap(({ companionId, snapshot }) => {
      const evaluation = fleetAuthPersistenceBoundaryValues.evaluateFleetAuthorizationSnapshot({
        request: {
          sessionToken,
          audience: 'fleet',
          companionId,
          action: 'companion.read',
        },
        snapshot,
        disabledActionsByRole: this.disabledActionsByRole,
        now: resolvedAt,
        accountRoster: this.accountRoster,
      });
      if (evaluation.decision === 'deny') return [];
      const role = evaluation.facts.operator.role;
      return [this.projectCompanion(companionId, role)];
    });
  }

  /**
   * Roster-only projection used when the shared session gauntlet or the
   * authority-generation gate denies the batch. Each companion is admitted
   * solely through the admin-unconditional roster evaluation, so a denied
   * non-rostered session can never widen back into the full companion list.
   */
  private rosterAuthorizedCompanions(
    snapshots: readonly PortalSnapshot[],
    sessionToken: string,
    resolvedAt: Date,
  ): Extract<FleetPortalAuthorizationBatchStoreDecision, { decision: 'allow' }>['companions'] {
    if (this.accountRoster.length === 0) return [];
    return snapshots.flatMap(({ companionId, snapshot }) => {
      const evaluation = fleetAuthPersistenceBoundaryValues.evaluateAccountRosterAuthorization({
        request: {
          sessionToken,
          audience: 'fleet',
          companionId,
          action: 'companion.read',
        },
        snapshot,
        accountRoster: this.accountRoster,
        disabledActionsByRole: this.disabledActionsByRole,
        now: resolvedAt,
      });
      if (!evaluation) return [];
      return [this.projectCompanion(companionId, evaluation.facts.operator.role)];
    });
  }

  private projectCompanion(
    companionId: string,
    role: FleetAuthRole,
  ): { companionId: string; gardenLinkEligible: boolean } {
    return {
      companionId,
      gardenLinkEligible: fleetAuthPersistenceBoundaryValues
        .fleetAuthRoleAllowsAction(role, 'garden.read')
        && !this.disabledActionsByRole[role].includes('garden.read'),
    };
  }

  private async loadSnapshots(client: PoolClient, sessionToken: string): Promise<PortalSnapshot[]> {
    const authority = await this.lockAuthority(client);
    const sessions = await client.query<FleetAuthSessionRow>(`
      SELECT session.record_id, session.principal_id, session.provider,
             session.provider_subject_id, session.audience, session.assurance,
             session.authn_version AS session_authn_version,
             session.authz_version AS session_authz_version,
             session.binding_version, session.grant_version, session.policy_version,
             session.global_auth_epoch AS session_global_auth_epoch,
             session.idle_expires_at, session.absolute_expires_at,
             session.replaced_by, session.revoked_at,
             principal.status AS principal_status,
             principal.authn_version AS principal_authn_version,
             principal.authz_version AS principal_authz_version,
             principal.binding_version AS principal_binding_version,
             principal.grant_version AS principal_grant_version,
             principal.policy_version AS principal_policy_version,
             principal.authority_generation AS principal_authority_generation,
             principal.restore_state AS principal_restore_state,
             alias.canonical_principal_id AS merged_into_principal_id,
             ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
               'principal', principal.principal_id::text
             ) AS principal_tombstoned
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      LEFT JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_merge_aliases AS alias
        ON alias.source_principal_id = principal.principal_id
      WHERE session.token_digest = $1
      FOR UPDATE OF session, principal
    `, [this.digest(sessionToken)]);
    const sessionRows = sessions.rows.map(mapPortalAuthorizationSessionRow);
    const principalId = sessionRows.at(0)?.principalId;
    const sessionProvider = sessionRows.at(0)?.provider;
    const sessionProviderSubjectId = sessionRows.at(0)?.providerSubjectId;
    const subjects = principalId && sessionProvider && sessionProviderSubjectId
      ? await client.query<PortalProviderSubjectRow>(`
        SELECT requested.companion_id, subject.provider, subject.subject_id, subject.state,
               subject.authority_generation, subject.restore_state,
               EXISTS (
                 SELECT 1
                 FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones AS tombstone
                 WHERE tombstone.provider = subject.provider
                   AND tombstone.subject_id = subject.subject_id
               ) OR ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
                 'provider_subject', subject.provider || ':' || subject.subject_id
               ) AS tombstoned,
               ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
                 requested.companion_id, 'provider_subject', subject.subject_id
               ) AS contact_authority_fenced
        FROM unnest($4::uuid[]) AS requested(companion_id)
        JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
          ON subject.principal_id = $1
         AND subject.provider = $2
         AND subject.subject_id = $3
        ORDER BY requested.companion_id
        FOR UPDATE OF subject
      `, [principalId, sessionProvider, sessionProviderSubjectId, this.knownCompanionIds])
      : { rows: [] as PortalProviderSubjectRow[] };
    const companions = await client.query<PortalCompanionRow>(`
      SELECT locked.companion_id, locked.lifecycle, locked.version,
             locked.authority_generation, locked.restore_state,
             locked.authority_lineage_id, locked.lineage_floor_current,
             locked.tombstoned
      FROM unnest($1::uuid[]) AS requested(companion_id)
      CROSS JOIN LATERAL ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}(
        requested.companion_id
      ) AS locked
      ORDER BY requested.companion_id
    `, [this.knownCompanionIds]);
    const bindings = principalId
      ? await client.query<PortalBindingRow>(`
        SELECT binding_id, companion_id, contact_id, state, version,
               authority_generation, restore_state,
               ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
                 'contact_binding', binding.binding_id::text
               ) AS tombstoned,
               ${FLEET_AUTH_SCHEMA_NAME}.contact_authority_resource_fenced(
                 binding.companion_id, 'contact', binding.contact_id
               ) AS contact_authority_fenced
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
        WHERE binding.principal_id = $1 AND binding.companion_id = ANY($2::uuid[])
        ORDER BY binding.companion_id, binding.binding_id
        FOR UPDATE OF binding
      `, [principalId, this.knownCompanionIds])
      : { rows: [] as PortalBindingRow[] };
    const grants = principalId
      ? await client.query<PortalGrantRow>(`
        SELECT grant_id, companion_id, role, lifecycle, version,
               authority_generation, restore_state,
               ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
                 'role_grant', role_grant.grant_id::text
               ) AS tombstoned
        FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
        WHERE role_grant.principal_id = $1 AND role_grant.companion_id = ANY($2::uuid[])
        ORDER BY role_grant.companion_id, role_grant.grant_id
        FOR UPDATE OF role_grant
      `, [principalId, this.knownCompanionIds])
      : { rows: [] as PortalGrantRow[] };

    return this.knownCompanionIds.map(companionId => ({
      companionId,
      snapshot: {
        authority,
        sessions: sessionRows,
        providerSubjects: subjects.rows
          .filter(row => row.companion_id === companionId)
          .map(row => ({
            provider: row.provider,
            subjectId: row.subject_id,
            state: row.state,
            authorityGeneration: positiveInteger(
              row.authority_generation,
              'provider_subject.authority_generation',
            ),
            restoreState: row.restore_state,
            tombstoned: row.tombstoned,
            contactAuthorityFenced: row.contact_authority_fenced,
          })),
        companions: companions.rows
          .filter(row => row.companion_id === companionId)
          .map(row => ({
            companionId: row.companion_id,
            lifecycle: row.lifecycle,
            version: positiveInteger(row.version, 'companion.version'),
            authorityGeneration: positiveInteger(
              row.authority_generation,
              'companion.authority_generation',
            ),
            restoreState: row.restore_state,
            hasAuthorityLineage: row.authority_lineage_id !== null,
            lineageFloorCurrent: row.lineage_floor_current,
            tombstoned: row.tombstoned,
          })),
        bindings: bindings.rows
          .filter(row => row.companion_id === companionId)
          .map(row => ({
            bindingId: row.binding_id,
            companionId: row.companion_id,
            contactId: row.contact_id,
            state: row.state,
            version: positiveInteger(row.version, 'binding.version'),
            authorityGeneration: positiveInteger(
              row.authority_generation,
              'binding.authority_generation',
            ),
            restoreState: row.restore_state,
            tombstoned: row.tombstoned,
            contactAuthorityFenced: row.contact_authority_fenced,
          })),
        grants: grants.rows
          .filter(row => row.companion_id === companionId)
          .map(row => ({
            grantId: row.grant_id,
            companionId: row.companion_id,
            role: row.role,
            lifecycle: row.lifecycle,
            version: positiveInteger(row.version, 'grant.version'),
            authorityGeneration: positiveInteger(
              row.authority_generation,
              'grant.authority_generation',
            ),
            restoreState: row.restore_state,
            tombstoned: row.tombstoned,
          })),
      },
    }));
  }

  private async lockAuthority(
    client: PoolClient,
  ): Promise<FleetAuthorizationSnapshot['authority']> {
    const result = await client.query<{
      authority_generation: string;
      global_auth_epoch: string;
    }>(`
      SELECT authority_generation, global_auth_epoch
      FROM ${FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME}()
    `);
    const row = result.rows.at(0);
    if (!row) throw new Error('fleet_auth authority_state singleton is missing');
    return {
      authorityGeneration: positiveInteger(row.authority_generation, 'authority_generation'),
      globalAuthEpoch: positiveInteger(row.global_auth_epoch, 'global_auth_epoch'),
    };
  }

  private async insertAudit(client: PoolClient, input: {
    decision: 'allow' | 'deny';
    reasonCode: string;
    principalId?: string;
    authority: FleetAuthorizationSnapshot['authority'];
    occurredAt: Date;
  }): Promise<void> {
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         correlation_id, occurred_at)
      VALUES ($1, $2::jsonb, 'companion.read', 'fleet_portal', $3, $4,
              NULL, $5, $6, $7, NULL, $8)
    `, [
      randomUUID(),
      JSON.stringify({
        kind: 'browser_session',
        boundary: 'fleet_portal_authorization',
        provider: 'discord',
        evidenceRequested: false,
      }),
      input.decision,
      input.reasonCode,
      input.principalId ?? null,
      input.authority.authorityGeneration,
      input.authority.globalAuthEpoch,
      input.occurredAt,
    ]);
  }

  private async recordInfrastructureDenial(client: PoolClient): Promise<void> {
    await client.query('BEGIN');
    try {
      await this.insertAudit(client, {
        decision: 'deny',
        reasonCode: 'authorization_store_error' satisfies FleetAuthorizationDenialReason,
        authority: await this.lockAuthority(client),
        occurredAt: this.now(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async recordPostCommitAuthorityDenial(
    client: PoolClient,
    principalId: string | undefined,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await this.insertAudit(client, {
        decision: 'deny',
        reasonCode: 'authority_generation_stale' satisfies FleetAuthorizationDenialReason,
        principalId,
        authority: await this.lockAuthority(client),
        occurredAt: this.now(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async recordPostCommitRosterDegradation(
    client: PoolClient,
    principalId: string | undefined,
  ): Promise<void> {
    await client.query('BEGIN');
    try {
      await this.insertAudit(client, {
        decision: 'allow',
        reasonCode: 'roster_portal_projection_post_commit_degraded',
        principalId,
        authority: await this.lockAuthority(client),
        occurredAt: this.now(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private digest(value: string): string {
    return createHmac('sha256', this.sessionPepper).update(value).digest('hex');
  }
}
