import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  createImmutableFleetAuthorizationContext,
  evaluateFleetAuthorizationSnapshot,
  type FleetAuthorizationContextStore,
  type FleetAuthorizationDenialReason,
  type FleetAuthorizationRequest,
  type FleetAuthorizationRequestParseResult,
  type FleetAuthorizationSnapshot,
  type FleetAuthorizationStoreDecision,
} from '../../../boundary/gateway/fleet-authorization-context.js';
import type { FleetAuthConfig, FleetAuthRole } from '../../../system/config/fleet-auth-config.js';
import {
  digestDiscordEvidence,
} from '../../../boundary/fleet-auth/discord-evidence-types.js';
import {
  digestDiscordEvidenceConfig,
} from '../../../boundary/fleet-auth/discord-evidence-runtime.js';
import { isCanonicalIsoTimestamp, isRecord } from '../../../shared/utils/types.js';
import { FLEET_AUTH_LOCK_AUTHORITY_STATE_FUNCTION_NAME } from './authority-state-lock-sql.js';
import { FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME } from './companion-authority-lock-sql.js';
import { FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME } from './authority-floor-read-sql.js';
import type { ProviderRevocationAuthorityPort } from './oauth-session-store.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

const AUTHORIZATION_CORRELATION_DIGEST_DOMAIN = 'fleet-authorization:correlation:v1\0';

interface SessionRow {
  record_id: string;
  principal_id: string;
  provider: 'discord' | null;
  provider_subject_id: string | null;
  audience: string;
  assurance: 'oauth' | 'webauthn_uv' | 'break_glass';
  session_authn_version: string;
  session_authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  session_global_auth_epoch: string;
  idle_expires_at: Date;
  absolute_expires_at: Date;
  replaced_by: string | null;
  revoked_at: Date | null;
  principal_status: FleetAuthorizationSnapshot['sessions'][number]['principal']['status'];
  principal_authn_version: string;
  principal_authz_version: string;
  principal_binding_version: string;
  principal_grant_version: string;
  principal_policy_version: string;
  principal_authority_generation: string;
  principal_restore_state: 'live' | 'quarantined';
  merged_into_principal_id: string | null;
  principal_tombstoned: boolean;
}

interface ProviderSubjectRow {
  provider: 'discord';
  subject_id: string;
  state: FleetAuthorizationSnapshot['providerSubjects'][number]['state'];
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
}

interface CompanionRow {
  companion_id: string;
  lifecycle: FleetAuthorizationSnapshot['companions'][number]['lifecycle'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  authority_lineage_id: string | null;
  lineage_floor_current: boolean;
  tombstoned: boolean;
}

interface BindingRow {
  binding_id: string;
  companion_id: string;
  contact_id: string;
  state: FleetAuthorizationSnapshot['bindings'][number]['state'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
}

interface GrantRow {
  grant_id: string;
  companion_id: string;
  role: FleetAuthRole;
  lifecycle: FleetAuthorizationSnapshot['grants'][number]['lifecycle'];
  version: string;
  authority_generation: string;
  restore_state: 'live' | 'quarantined';
  tombstoned: boolean;
}

interface EvidenceRow {
  evidence_id: string;
  principal_id: string;
  provider_subject_id: string;
  companion_id: string;
  guild_id: string;
  channel_id: string | null;
  thread_id: string | null;
  input_digest: string;
  config_digest: string;
  mapping_config_version: string;
  global_auth_epoch: string;
  psfn_evidence_result: boolean;
  discord_permission_result: boolean;
  member_specific_deny_veto: boolean;
  decision_reason: string | null;
  permission_inputs: unknown;
  provenance: unknown;
  lifecycle_state: 'active' | 'revoked' | null;
  lifecycle_global_auth_epoch: string | null;
  expires_at: Date;
}

export interface PostgresFleetAuthorizationContextStoreOptions {
  pool: Pool;
  sessionPepper: string;
  config: FleetAuthConfig;
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  now?: () => Date;
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth authorization context ${field}`);
  }
  return parsed;
}

function auditActor(evidenceRequested: boolean): string {
  return JSON.stringify({
    kind: 'browser_session',
    boundary: 'fleet_authorization_context',
    provider: 'discord',
    evidenceRequested,
  });
}

export class PostgresFleetAuthorizationContextStore implements FleetAuthorizationContextStore {
  private readonly pool: Pool;
  private readonly sessionPepper: string;
  private readonly disabledActionsByRole: FleetAuthConfig['rolePolicy']['disabledActionsByRole'];
  private readonly providerRevocationAuthority: ProviderRevocationAuthorityPort;
  private readonly evidenceConfigDigest: string;
  private readonly evidenceMappingVersion: number;
  private readonly now: () => Date;

  constructor(options: PostgresFleetAuthorizationContextStoreOptions) {
    if (options.sessionPepper.length < 32) {
      throw new Error('Fleet authorization context requires the configured session pepper');
    }
    this.pool = options.pool;
    this.sessionPepper = options.sessionPepper;
    this.disabledActionsByRole = {
      owner: [...options.config.rolePolicy.disabledActionsByRole.owner],
      admin: [...options.config.rolePolicy.disabledActionsByRole.admin],
      member: [...options.config.rolePolicy.disabledActionsByRole.member],
      guest: [...options.config.rolePolicy.disabledActionsByRole.guest],
    };
    this.providerRevocationAuthority = options.providerRevocationAuthority;
    this.evidenceConfigDigest = digestDiscordEvidenceConfig(options.config);
    this.evidenceMappingVersion = options.config.activationGeneration;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(request: FleetAuthorizationRequest): Promise<FleetAuthorizationStoreDecision> {
    const client = await this.pool.connect();
    const correlationDigest = this.digestCorrelation(request.correlationId);
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const snapshot = await this.loadSnapshot(client, request);
      const resolvedAt = this.now();
      let evaluation = evaluateFleetAuthorizationSnapshot({
        request,
        snapshot,
        disabledActionsByRole: this.disabledActionsByRole,
        now: resolvedAt,
      });
      if (evaluation.decision === 'allow'
        && !this.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
          snapshot.authority.authorityGeneration,
        )) {
        evaluation = { decision: 'deny', reasonCode: 'authority_generation_stale' };
      }
      const authorizationEventId = randomUUID();
      await this.insertAudit(client, {
        eventId: authorizationEventId,
        action: request.action,
        resource: `companion:${request.companionId}`,
        decision: evaluation.decision,
        reasonCode: evaluation.decision === 'allow'
          ? 'role_action_allowed'
          : evaluation.reasonCode,
        evidenceRequested: request.discordEvidence !== undefined,
        companionId: request.companionId,
        principalId: evaluation.decision === 'allow'
          ? evaluation.facts.principalId
          : snapshot.sessions.at(0)?.principalId,
        authorityGeneration: snapshot.authority.authorityGeneration,
        globalAuthEpoch: snapshot.authority.globalAuthEpoch,
        correlationDigest,
        occurredAt: resolvedAt,
      });
      await client.query('COMMIT');
      if (evaluation.decision === 'deny') return evaluation;
      const context = createImmutableFleetAuthorizationContext({
        request,
        facts: evaluation.facts,
        authorizationEventId,
        resolvedAt,
        ...(correlationDigest ? { correlationDigest } : {}),
      });
      if (!this.providerRevocationAuthority.sessionAuthorityGenerationIsCurrent(
        snapshot.authority.authorityGeneration,
      )) {
        await this.recordPostCommitAuthorityDenial(client, {
          request,
          principalId: evaluation.facts.principalId,
          ...(correlationDigest ? { correlationDigest } : {}),
        });
        return { decision: 'deny', reasonCode: 'authority_generation_stale' };
      }
      return {
        decision: 'allow',
        context,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      try {
        await this.recordInfrastructureDenial(client, {
          action: request.action,
          companionId: request.companionId,
          correlationDigest,
          evidenceRequested: request.discordEvidence !== undefined,
        });
      } catch (auditError) {
        throw new AggregateError(
          [error, auditError],
          'Fleet authorization failed and its denial audit could not be persisted',
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordRequestDenial(
    input: Extract<FleetAuthorizationRequestParseResult, { ok: false }>,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      await this.insertAudit(client, {
        eventId: randomUUID(),
        action: input.audit.action ?? 'authorization.resolve',
        resource: input.audit.companionId ? `companion:${input.audit.companionId}` : 'fleet',
        decision: 'deny',
        reasonCode: input.reasonCode,
        evidenceRequested: input.audit.evidenceRequested,
        companionId: input.audit.companionId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        correlationDigest: this.digestCorrelation(input.audit.correlationId),
        occurredAt: this.now(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadSnapshot(
    client: PoolClient,
    request: FleetAuthorizationRequest,
  ): Promise<FleetAuthorizationSnapshot> {
    const authority = await this.lockAuthority(client);
    const sessions = await client.query<SessionRow>(`
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
    `, [this.digest(request.sessionToken)]);
    const sessionRows = sessions.rows.map(row => ({
      recordId: row.record_id,
      principalId: row.principal_id,
      provider: row.provider,
      providerSubjectId: row.provider_subject_id,
      audience: row.audience,
      assurance: row.assurance,
      authnVersion: positiveInteger(row.session_authn_version, 'session.authn_version'),
      authzVersion: positiveInteger(row.session_authz_version, 'session.authz_version'),
      bindingVersion: positiveInteger(row.binding_version, 'session.binding_version'),
      grantVersion: positiveInteger(row.grant_version, 'session.grant_version'),
      policyVersion: positiveInteger(row.policy_version, 'session.policy_version'),
      globalAuthEpoch: positiveInteger(row.session_global_auth_epoch, 'session.global_auth_epoch'),
      idleExpiresAt: row.idle_expires_at,
      absoluteExpiresAt: row.absolute_expires_at,
      replacedBy: row.replaced_by,
      revokedAt: row.revoked_at,
      principal: {
        status: row.principal_status,
        authnVersion: positiveInteger(row.principal_authn_version, 'principal.authn_version'),
        authzVersion: positiveInteger(row.principal_authz_version, 'principal.authz_version'),
        bindingVersion: positiveInteger(
          row.principal_binding_version,
          'principal.binding_version',
        ),
        grantVersion: positiveInteger(row.principal_grant_version, 'principal.grant_version'),
        policyVersion: positiveInteger(row.principal_policy_version, 'principal.policy_version'),
        authorityGeneration: positiveInteger(
          row.principal_authority_generation,
          'principal.authority_generation',
        ),
        restoreState: row.principal_restore_state,
        mergedIntoPrincipalId: row.merged_into_principal_id,
        tombstoned: row.principal_tombstoned,
      },
    }));
    const principalId = sessionRows.at(0)?.principalId;
    if (!principalId) {
      return {
        authority,
        sessions: sessionRows,
        providerSubjects: [],
        companions: [],
        bindings: [],
        grants: [],
      };
    }

    const sessionProvider = sessionRows[0]?.provider;
    const sessionProviderSubjectId = sessionRows[0]?.providerSubjectId;
    const subjects = sessionProvider && sessionProviderSubjectId
      ? await client.query<ProviderSubjectRow>(`
      SELECT subject.provider, subject.subject_id, subject.state,
             subject.authority_generation, subject.restore_state,
             EXISTS (
               SELECT 1
               FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones AS tombstone
               WHERE tombstone.provider = subject.provider
                 AND tombstone.subject_id = subject.subject_id
             ) OR ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
               'provider_subject', subject.provider || ':' || subject.subject_id
             ) AS tombstoned
      FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS subject
      WHERE subject.principal_id = $1
        AND subject.provider = $2
        AND subject.subject_id = $3
      FOR UPDATE OF subject
    `, [principalId, sessionProvider, sessionProviderSubjectId])
      : { rows: [] as ProviderSubjectRow[] };
    const companions = await client.query<CompanionRow>(`
      SELECT companion_id, lifecycle, version, authority_generation, restore_state,
             authority_lineage_id, lineage_floor_current, tombstoned
      FROM ${FLEET_AUTH_LOCK_COMPANION_AUTHORITY_FUNCTION_NAME}($1)
    `, [request.companionId]);
    const bindings = await client.query<BindingRow>(`
      SELECT binding_id, companion_id, contact_id, state, version,
             authority_generation, restore_state,
             ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
               'contact_binding', binding.binding_id::text
             ) AS tombstoned
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
      WHERE binding.principal_id = $1 AND binding.companion_id = $2
      ORDER BY binding_id
      FOR UPDATE OF binding
    `, [principalId, request.companionId]);
    const grants = await client.query<GrantRow>(`
      SELECT grant_id, companion_id, role, lifecycle, version,
             authority_generation, restore_state,
             ${FLEET_AUTH_FLOOR_RESOURCE_TOMBSTONED_FUNCTION_NAME}(
               'role_grant', role_grant.grant_id::text
             ) AS tombstoned
      FROM ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role_grant
      WHERE role_grant.principal_id = $1 AND role_grant.companion_id = $2
      ORDER BY grant_id
      FOR UPDATE OF role_grant
    `, [principalId, request.companionId]);
    const evidenceSubject = subjects.rows.length === 1 ? subjects.rows[0] : undefined;
    const evidence = request.discordEvidence && evidenceSubject
      ? await this.loadEvidence(
          client,
          request.discordEvidence.evidenceId,
          principalId,
          evidenceSubject.subject_id,
        )
      : undefined;
    return {
      authority,
      sessions: sessionRows,
      providerSubjects: subjects.rows.map(row => ({
        provider: row.provider,
        subjectId: row.subject_id,
        state: row.state,
        authorityGeneration: positiveInteger(
          row.authority_generation,
          'provider_subject.authority_generation',
        ),
        restoreState: row.restore_state,
        tombstoned: row.tombstoned,
      })),
      companions: companions.rows.map(row => ({
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
      bindings: bindings.rows.map(row => ({
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
      })),
      grants: grants.rows.map(row => ({
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
      ...(evidence ? { evidence } : {}),
    };
  }

  private async loadEvidence(
    client: PoolClient,
    evidenceId: string,
    principalId: string,
    providerSubjectId: string,
  ): Promise<FleetAuthorizationSnapshot['evidence'] | undefined> {
    const result = await client.query<EvidenceRow>(`
      SELECT evidence.evidence_id, evidence.principal_id, evidence.provider_subject_id,
             evidence.companion_id, evidence.guild_id, evidence.channel_id,
             evidence.thread_id, evidence.input_digest, evidence.config_digest,
             evidence.mapping_config_version, evidence.global_auth_epoch,
             evidence.psfn_evidence_result, evidence.discord_permission_result,
             evidence.member_specific_deny_veto, evidence.decision_reason,
             evidence.permission_inputs, evidence.provenance,
             fence.state AS lifecycle_state,
             fence.global_auth_epoch AS lifecycle_global_auth_epoch,
             evidence.expires_at
      FROM ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_snapshots AS evidence
      LEFT JOIN ${FLEET_AUTH_SCHEMA_NAME}.discord_evidence_lifecycle_fences AS fence
        ON fence.principal_id = evidence.principal_id
       AND fence.provider = evidence.provider
       AND fence.provider_subject_id = evidence.provider_subject_id
      WHERE evidence.evidence_id = $1
        AND evidence.principal_id = $2
        AND evidence.provider = 'discord'
        AND evidence.provider_subject_id = $3
      FOR UPDATE OF evidence
    `, [evidenceId, principalId, providerSubjectId]);
    const row = result.rows.at(0);
    if (!row) return undefined;
    return {
      evidenceId: row.evidence_id,
      principalId: row.principal_id,
      providerSubjectId: row.provider_subject_id,
      companionId: row.companion_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      threadId: row.thread_id,
      inputDigest: row.input_digest,
      configDigest: row.config_digest,
      mappingConfigVersion: positiveInteger(
        row.mapping_config_version,
        'evidence.mapping_config_version',
      ),
      globalAuthEpoch: positiveInteger(row.global_auth_epoch, 'evidence.global_auth_epoch'),
      psfnEvidenceResult: row.psfn_evidence_result,
      discordPermissionResult: row.discord_permission_result,
      memberSpecificDenyVeto: row.member_specific_deny_veto,
      decisionReason: row.decision_reason,
      lifecycleState: row.lifecycle_state ?? 'revoked',
      lifecycleGlobalAuthEpoch: row.lifecycle_global_auth_epoch
        ? positiveInteger(row.lifecycle_global_auth_epoch, 'evidence.lifecycle_global_auth_epoch')
        : 0,
      expiresAt: row.expires_at,
      integrityValid: this.evidenceIntegrityIsValid(row, providerSubjectId),
      configCurrent: row.config_digest === this.evidenceConfigDigest
        && positiveInteger(row.mapping_config_version, 'evidence.mapping_config_version')
          === this.evidenceMappingVersion,
    };
  }

  private evidenceIntegrityIsValid(row: EvidenceRow, providerSubjectId: string): boolean {
    if (!isRecord(row.permission_inputs) || !isRecord(row.provenance)) return false;
    try {
      return digestDiscordEvidence(row.permission_inputs) === row.input_digest
        && row.provenance.source === 'discord_oauth_and_bot_observation'
        && row.provenance.provider === 'discord'
        && row.provenance.providerSubjectId === providerSubjectId
        && row.provenance.observationStatus === 'observed'
        && isCanonicalIsoTimestamp(row.provenance.observedAt)
        && isCanonicalIsoTimestamp(row.provenance.oauthObservedAt)
        && typeof row.provenance.observationId === 'string'
        && row.provenance.observationId.length > 0
        && typeof row.provenance.botUserId === 'string'
        && row.provenance.botUserId.length > 0;
    } catch {
      return false;
    }
  }

  private async lockAuthority(client: PoolClient): Promise<FleetAuthorizationSnapshot['authority']> {
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
    eventId: string;
    action: string;
    resource: string;
    decision: 'allow' | 'deny';
    reasonCode: string;
    evidenceRequested: boolean;
    companionId?: string;
    principalId?: string;
    authorityGeneration: number;
    globalAuthEpoch: number;
    correlationDigest?: string;
    occurredAt: Date;
  }): Promise<void> {
    if (input.correlationDigest !== undefined
      && !/^[0-9a-f]{64}$/u.test(input.correlationDigest)) {
      throw new Error('Fleet authorization audit correlation must be a canonical digest');
    }
    await client.query(`
      INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events
        (event_id, actor_context, action, resource, decision, reason_code,
         companion_id, principal_id, authority_generation, global_auth_epoch,
         correlation_id, occurred_at)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      input.eventId,
      auditActor(input.evidenceRequested),
      input.action,
      input.resource,
      input.decision,
      input.reasonCode,
      input.companionId ?? null,
      input.principalId ?? null,
      input.authorityGeneration,
      input.globalAuthEpoch,
      input.correlationDigest ?? null,
      input.occurredAt,
    ]);
  }

  private async recordInfrastructureDenial(client: PoolClient, input: {
    action: string;
    companionId: string;
    correlationDigest?: string;
    evidenceRequested: boolean;
  }): Promise<void> {
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      await this.insertAudit(client, {
        eventId: randomUUID(),
        action: input.action,
        resource: `companion:${input.companionId}`,
        decision: 'deny',
        reasonCode: 'authorization_store_error' satisfies FleetAuthorizationDenialReason,
        evidenceRequested: input.evidenceRequested,
        companionId: input.companionId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        correlationDigest: input.correlationDigest,
        occurredAt: this.now(),
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async recordPostCommitAuthorityDenial(client: PoolClient, input: {
    request: FleetAuthorizationRequest;
    principalId: string;
    correlationDigest?: string;
  }): Promise<void> {
    try {
      await client.query('BEGIN');
      const authority = await this.lockAuthority(client);
      await this.insertAudit(client, {
        eventId: randomUUID(),
        action: input.request.action,
        resource: `companion:${input.request.companionId}`,
        decision: 'deny',
        reasonCode: 'authority_generation_stale' satisfies FleetAuthorizationDenialReason,
        evidenceRequested: input.request.discordEvidence !== undefined,
        companionId: input.request.companionId,
        principalId: input.principalId,
        authorityGeneration: authority.authorityGeneration,
        globalAuthEpoch: authority.globalAuthEpoch,
        correlationDigest: input.correlationDigest,
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

  private digestCorrelation(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    return createHmac('sha256', this.sessionPepper)
      .update(AUTHORIZATION_CORRELATION_DIGEST_DOMAIN)
      .update(value)
      .digest('hex');
  }
}
