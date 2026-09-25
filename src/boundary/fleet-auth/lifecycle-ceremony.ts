import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';
import {
  type FleetAuthAction,
  type FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';
import type {
  FleetAuthLifecycleResult,
  PrincipalAuthorityClaim,
  VerifiedFleetAuthLifecycleDecision,
} from '../../persistence/postgres/fleet-auth/authority-lifecycle-types.js';
import type { GatewayFleetAuthAuthorityLifecycleStore } from '../../persistence/postgres/fleet-auth/authority-lifecycle-store.js';
import { FLEET_AUTH_SCHEMA_NAME } from '../../persistence/postgres/fleet-auth/schema.js';
import { fleetAuthRoleAllowsAction } from './role-action-policy.js';
import {
  parseAdminTokenOperatorCeremonyRequest,
  parseFleetAuthLifecycleCeremonyRequest,
  type AdminTokenOperatorCeremonyRequest,
  type FleetAuthLifecycleCeremonyRequest,
} from './lifecycle-ceremony-request.js';

const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

export const FLEET_AUTH_BINDING_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/binding/complete';
export const FLEET_AUTH_PROVIDER_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/provider/complete';
export const FLEET_AUTH_ROLE_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/role/complete';

export interface FleetContactAuthorityPort {
  read(input: {
    companionId: string;
    contactId: string;
    providerSubjectId: string;
  }): Promise<VerifiedDiscordContactAuthoritySnapshot | undefined>;
}

export type FleetLifecycleCeremonyDenialReason =
  | 'session_unavailable'
  | 'target_unavailable'
  | 'contact_authority_unavailable'
  | 'provider_binding_changed';

export interface FleetLifecycleCeremonyDenialAuditPort {
  record(input: {
    request: FleetAuthLifecycleCeremonyRequest;
    reasonCode: FleetLifecycleCeremonyDenialReason;
  }): Promise<void>;
}

interface SessionRow {
  record_id: string;
  principal_id: string;
  status: string;
  authn_version: string;
  authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
  provider: string;
  provider_subject_id: string;
  global_auth_epoch: string;
  authority_generation: string;
  role: string;
  contact_id: string;
}

interface PrincipalRow {
  principal_id: string;
  authn_version: string;
  authz_version: string;
  binding_version: string;
  grant_version: string;
  policy_version: string;
}

/** Records the ADMIN_TOKEN operator's approval before a decision executes. */
export interface AdminTokenLifecycleApprovalPort {
  record(input: {
    decisionId: string;
    ceremonyId: string;
    companionId: string;
    lifecycleAction: AdminTokenOperatorCeremonyRequest['action'];
  }): Promise<{
    authorizationEventId: string;
    authorityGeneration: number;
    globalAuthEpoch: number;
  }>;
}

export class FleetAuthLifecycleCeremonyError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'session_unavailable'
      | 'contact_authority_unavailable'
      | 'denial_audit_failed'
      | 'operator_approval_unavailable'
      | 'lifecycle_denied',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FleetAuthLifecycleCeremonyError';
  }
}

function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new FleetAuthLifecycleCeremonyError(
      'lifecycle_denied',
      `Fleet lifecycle ${field} is corrupt`,
    );
  }
  return parsed;
}

function claim(row: PrincipalRow): PrincipalAuthorityClaim {
  return {
    principalId: row.principal_id,
    authnVersion: positiveInteger(row.authn_version, 'authn_version'),
    authzVersion: positiveInteger(row.authz_version, 'authz_version'),
    bindingVersion: positiveInteger(row.binding_version, 'binding_version'),
    grantVersion: positiveInteger(row.grant_version, 'grant_version'),
    policyVersion: positiveInteger(row.policy_version, 'policy_version'),
  };
}

function actionFor(request: FleetAuthLifecycleCeremonyRequest): FleetAuthAction {
  if (request.action === 'binding.activate') return 'contacts.bind';
  if (request.action.startsWith('role.')) return 'roles.manage';
  return 'provider.link';
}


type LifecycleDecisionApprovalKeys =
  | 'verification' | 'decisionId' | 'ceremonyId' | 'target' | 'authorityGeneration'
  | 'globalAuthEpoch' | 'reasonDigest' | 'decidedAt' | 'actor' | 'actorSession' | 'operator';
type LifecycleDecisionFields = VerifiedFleetAuthLifecycleDecision extends infer Decision
  ? Decision extends unknown ? Omit<Decision, LifecycleDecisionApprovalKeys> : never
  : never;

/** The action-specific fields of a ceremony decision, shared by every approver. */
function lifecycleDecisionFields(
  request: FleetAuthLifecycleCeremonyRequest,
  contactAuthority: VerifiedDiscordContactAuthoritySnapshot | undefined,
): LifecycleDecisionFields {
  if (request.action === 'binding.activate') {
    return {
      action: request.action,
      companionId: request.companionId,
      contactId: request.contactId,
      bindingId: request.bindingId,
      newProvider: request.newProvider,
      contactAuthority: contactAuthority!,
    };
  } else if (request.action === 'provider.replace') {
    return {
      action: request.action,
      companionId: request.companionId,
      contactId: request.contactId,
      currentProvider: request.currentProvider,
      newProvider: request.newProvider,
      contactAuthority: contactAuthority!,
    };
  } else if (request.action === 'role.grant') {
    return {
      action: request.action,
      companionId: request.companionId,
      grantId: request.grantId,
      role: request.role,
    };
  } else if (request.action === 'role.change') {
    return {
      action: request.action,
      companionId: request.companionId,
      grantId: request.grantId,
      newGrantId: request.newGrantId,
      currentRole: request.currentRole,
      role: request.role,
    };
  } else if (request.action === 'role.revoke') {
    return {
      action: request.action,
      companionId: request.companionId,
      grantId: request.grantId,
      currentRole: request.currentRole,
    };
  } else {
    return {
      action: request.action,
      companionId: request.companionId,
      contactId: request.contactId,
      newProvider: request.newProvider,
      contactAuthority: contactAuthority!,
    };
  }
}

export class GatewayFleetAuthLifecycleCeremonyService {
  private readonly origin: string;

  constructor(private readonly options: {
    pool: Pool;
    sessionPepper: string;
    canonicalOrigin: string;
    lifecycle: Pick<GatewayFleetAuthAuthorityLifecycleStore, 'execute'>;
    contactAuthority: FleetContactAuthorityPort;
    denialAudit: FleetLifecycleCeremonyDenialAuditPort;
    /** Durable approval audit for the ADMIN_TOKEN operator; absent -> operator path 503s. */
    adminTokenApproval?: AdminTokenLifecycleApprovalPort;
    now?: () => Date;
  }) {
    const origin = new URL(options.canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.canonicalOrigin) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'Lifecycle origin is invalid');
    }
    this.origin = origin.origin;
  }

  /**
   * Authority mutations complete directly under the authenticated Discord SSO
   * session (operator ruling D2): the session's role must allow the action and
   * every denial is audited. There is no step-up ceremony.
   */
  async complete(input: {
    token: string;
    requestOrigin: string;
    request: unknown;
  }): Promise<FleetAuthLifecycleResult> {
    this.assertOrigin(input.requestOrigin);
    const request = parseFleetAuthLifecycleCeremonyRequest(input.request);
    let session: SessionRow;
    try {
      session = await this.readSession(input.token, request.companionId, actionFor(request));
    } catch (error) {
      await this.auditDenial(request, 'session_unavailable');
      throw error;
    }
    let target: PrincipalAuthorityClaim;
    try {
      if (request.action === 'binding.activate') {
        target = await this.readPrincipal(request.targetPrincipalId, 'pending');
      } else if (request.action === 'role.grant'
        || request.action === 'role.change'
        || request.action === 'role.revoke') {
        target = await this.readPrincipal(request.targetPrincipalId, 'active');
      } else {
        target = claim(session);
      }
    } catch (error) {
      await this.auditDenial(request, 'target_unavailable');
      throw error;
    }
    let contactAuthority: VerifiedDiscordContactAuthoritySnapshot | undefined;
    if (request.action === 'provider.add'
      || request.action === 'provider.relink'
      || request.action === 'provider.replace') {
      if (request.contactId !== session.contact_id
        || (request.action === 'provider.replace'
          && request.currentProvider.subjectId !== session.provider_subject_id)) {
        await this.auditDenial(request, 'provider_binding_changed');
        throw new FleetAuthLifecycleCeremonyError(
          'lifecycle_denied',
          'Provider lifecycle session and contact binding changed',
        );
      }
    }
    contactAuthority = await this.readContactAuthority(request);
    const actor = claim(session);
    const base = {
      verification: 'gateway_verified' as const,
      decisionId: randomUUID(),
      ceremonyId: request.ceremonyId,
      actor,
      actorSession: {
        sessionId: session.record_id,
        authnVersion: actor.authnVersion,
        authzVersion: actor.authzVersion,
        bindingVersion: actor.bindingVersion,
        grantVersion: actor.grantVersion,
        policyVersion: actor.policyVersion,
        provider: 'discord' as const,
        providerSubjectId: session.provider_subject_id,
        globalAuthEpoch: positiveInteger(session.global_auth_epoch, 'global_auth_epoch'),
      },
      target,
      authorityGeneration: positiveInteger(
        session.authority_generation,
        'authority_generation',
      ),
      globalAuthEpoch: positiveInteger(session.global_auth_epoch, 'global_auth_epoch'),
      reasonDigest: digest(request.reason),
      decidedAt: (this.options.now ?? (() => new Date()))(),
    };
    // The store re-validates the assembled decision exactly (fail closed).
    const decision = {
      ...base,
      ...lifecycleDecisionFields(request, contactAuthority),
    } as VerifiedFleetAuthLifecycleDecision;
    try {
      return await this.options.lifecycle.execute(decision);
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError(
        'lifecycle_denied',
        'Fleet lifecycle transition was denied',
        { cause: error },
      );
    }
  }

  private async readSession(
    token: string,
    companionId: string,
    action: FleetAuthAction,
  ): Promise<SessionRow> {
    const result = await this.options.pool.query<SessionRow>(`
      SELECT session.record_id, session.principal_id, principal.status,
             principal.authn_version, principal.authz_version,
             principal.binding_version, principal.grant_version, principal.policy_version,
             session.provider, session.provider_subject_id,
             session.global_auth_epoch, authority.authority_generation, role.role,
             binding.contact_id
      FROM ${FLEET_AUTH_SCHEMA_NAME}.browser_sessions AS session
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.human_principals AS principal
        ON principal.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects AS provider
        ON provider.provider = session.provider
       AND provider.subject_id = session.provider_subject_id
       AND provider.principal_id = session.principal_id
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_contact_bindings AS binding
        ON binding.principal_id = session.principal_id
       AND binding.companion_id = $2
       AND binding.state = 'active' AND binding.restore_state = 'live'
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.principal_role_grants AS role
        ON role.principal_id = session.principal_id
       AND role.companion_id = $2
       AND role.lifecycle = 'active' AND role.restore_state = 'live'
      JOIN ${FLEET_AUTH_SCHEMA_NAME}.authority_state AS authority ON authority.singleton = TRUE
      WHERE session.token_digest = $1
        AND session.revoked_at IS NULL AND session.replaced_by IS NULL
        AND session.idle_expires_at > clock_timestamp()
        AND session.absolute_expires_at > clock_timestamp()
        AND session.authn_version = principal.authn_version
        AND session.authz_version = principal.authz_version
        AND session.binding_version = principal.binding_version
        AND session.grant_version = principal.grant_version
        AND session.policy_version = principal.policy_version
        AND session.global_auth_epoch = authority.global_auth_epoch
        AND principal.status = 'active' AND principal.restore_state = 'live'
        AND provider.state = 'active' AND provider.restore_state = 'live'
    `, [createHmac('sha256', this.options.sessionPepper).update(token).digest('hex'), companionId]);
    if (result.rowCount !== 1) {
      throw new FleetAuthLifecycleCeremonyError(
        'session_unavailable',
        'Exact current lifecycle session is unavailable',
      );
    }
    const row = result.rows[0]!;
    if (row.provider !== 'discord'
      || !SUBJECT_PATTERN.test(row.provider_subject_id)
      || (row.role !== 'owner' && row.role !== 'admin'
        && row.role !== 'member' && row.role !== 'guest')
      || !fleetAuthRoleAllowsAction(row.role as FleetAuthRole, action)) {
      throw new FleetAuthLifecycleCeremonyError(
        'session_unavailable',
        'Session role does not authorize this lifecycle action',
      );
    }
    return row;
  }

  /**
   * The audited ADMIN_TOKEN operator completes a ceremony as its approving
   * authority (psfn-framework-ja7n0). It replaces only the approving
   * companion owner/administrator: the target is the ceremony's subject, every
   * provider proof must still come from the subject's own session-initiated
   * Discord OAuth (enforced by the lifecycle store), and the approval itself is
   * a durable `admin_token_operator` audit row bound to this exact decision.
   */
  async completeAsAdminTokenOperator(input: {
    requestOrigin: string;
    request: unknown;
  }): Promise<FleetAuthLifecycleResult> {
    this.assertOrigin(input.requestOrigin);
    let request: AdminTokenOperatorCeremonyRequest;
    try {
      request = parseAdminTokenOperatorCeremonyRequest(input.request);
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'Lifecycle ceremony request is malformed', {
        cause: error,
      });
    }
    const approval = this.options.adminTokenApproval;
    if (!approval) {
      throw new FleetAuthLifecycleCeremonyError(
        'operator_approval_unavailable',
        'Administrator lifecycle approval is unavailable',
      );
    }
    let target: PrincipalAuthorityClaim;
    try {
      target = await this.readPrincipal(
        request.targetPrincipalId,
        request.action === 'binding.activate' ? 'pending' : 'active',
      );
    } catch (error) {
      await this.auditDenial(request as FleetAuthLifecycleCeremonyRequest, 'target_unavailable');
      throw error;
    }
    const decisionId = randomUUID();
    let approved: Awaited<ReturnType<AdminTokenLifecycleApprovalPort['record']>>;
    try {
      approved = await approval.record({
        decisionId,
        ceremonyId: request.ceremonyId,
        companionId: request.companionId,
        lifecycleAction: request.action,
      });
    } catch (error) {
      // No durable approval evidence, no transition.
      throw new FleetAuthLifecycleCeremonyError(
        'operator_approval_unavailable',
        'Administrator lifecycle approval could not be recorded',
        { cause: error },
      );
    }
    const { ceremonyId, reason, ...fields } = request;
    const { targetPrincipalId: _target, ...actionFields } = fields;
    const decision = {
      verification: 'gateway_verified' as const,
      decisionId,
      ceremonyId,
      operator: {
        kind: 'admin_token_operator' as const,
        authorizationEventId: approved.authorizationEventId,
      },
      target,
      authorityGeneration: approved.authorityGeneration,
      globalAuthEpoch: approved.globalAuthEpoch,
      reasonDigest: digest(reason),
      decidedAt: (this.options.now ?? (() => new Date()))(),
      ...actionFields,
    } as VerifiedFleetAuthLifecycleDecision;
    try {
      return await this.options.lifecycle.execute(decision);
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError(
        'lifecycle_denied',
        'Fleet lifecycle transition was denied',
        { cause: error },
      );
    }
  }

  private async readContactAuthority(
    request: FleetAuthLifecycleCeremonyRequest,
  ): Promise<VerifiedDiscordContactAuthoritySnapshot | undefined> {
    if (request.action !== 'binding.activate'
      && request.action !== 'provider.add'
      && request.action !== 'provider.relink'
      && request.action !== 'provider.replace') {
      return undefined;
    }
    const contactAuthority = await this.options.contactAuthority.read({
      companionId: request.companionId,
      contactId: request.contactId,
      providerSubjectId: request.newProvider.subjectId,
    });
    if (!contactAuthority) {
      await this.auditDenial(request, 'contact_authority_unavailable');
      throw new FleetAuthLifecycleCeremonyError(
        'contact_authority_unavailable',
        'Exact current companion contact authority is unavailable',
      );
    }
    return contactAuthority;
  }

  private async readPrincipal(
    principalId: string,
    requiredStatus: 'active' | 'pending',
  ): Promise<PrincipalAuthorityClaim> {
    const result = await this.options.pool.query<PrincipalRow>(`
      SELECT principal_id, authn_version, authz_version, binding_version,
             grant_version, policy_version
      FROM ${FLEET_AUTH_SCHEMA_NAME}.human_principals
      WHERE principal_id = $1 AND status = $2 AND restore_state = 'live'
    `, [principalId, requiredStatus]);
    if (result.rowCount !== 1) {
      throw new FleetAuthLifecycleCeremonyError(
        'lifecycle_denied',
        'Pending lifecycle target is unavailable',
      );
    }
    return claim(result.rows[0]!);
  }

  private async auditDenial(
    request: FleetAuthLifecycleCeremonyRequest,
    reasonCode: FleetLifecycleCeremonyDenialReason,
  ): Promise<void> {
    try {
      await this.options.denialAudit.record({ request, reasonCode });
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError(
        'denial_audit_failed',
        'Lifecycle denial audit could not be persisted',
        { cause: error },
      );
    }
  }

  private assertOrigin(value: string): void {
    if (value !== this.origin) {
      throw new FleetAuthLifecycleCeremonyError(
        'origin_mismatch',
        'Lifecycle ceremony origin is invalid',
      );
    }
  }
}
