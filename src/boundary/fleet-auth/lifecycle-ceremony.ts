import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import {
  findFleetAuthAccountRosterEntry,
  type FleetAuthAccountRosterEntry,
  type FleetAuthAction,
  type FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';
import type {
  FleetAuthLifecycleResult,
  PrincipalAuthorityClaim,
  VerifiedFleetAuthLifecycleDecision,
  VerifiedProviderProof,
} from '../../persistence/postgres/fleet-auth/authority-lifecycle-types.js';
import type { GatewayFleetAuthAuthorityLifecycleStore } from '../../persistence/postgres/fleet-auth/authority-lifecycle-store.js';
import { FLEET_AUTH_SCHEMA_NAME } from '../../persistence/postgres/fleet-auth/schema.js';
import type { FleetJitRequestBinding, FleetJitStepUpCoordinator } from './jit-step-up.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import { fleetAuthRoleAllowsAction } from './role-action-policy.js';

const SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export const FLEET_AUTH_LIFECYCLE_ASSURANCE_START_PATH =
  '/v1/fleet-auth/lifecycle/assurance/start';
export const FLEET_AUTH_BINDING_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/binding/complete';
export const FLEET_AUTH_PROVIDER_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/provider/complete';
export const FLEET_AUTH_ROLE_COMPLETE_PATH =
  '/v1/fleet-auth/lifecycle/role/complete';

type SupportedLifecycleAction =
  | 'binding.activate'
  | 'provider.add'
  | 'provider.relink'
  | 'provider.replace'
  | 'role.grant'
  | 'role.change'
  | 'role.revoke';

interface CeremonyBase {
  action: SupportedLifecycleAction;
  ceremonyId: string;
  companionId: string;
  reason: string;
}

export type FleetAuthLifecycleCeremonyRequest =
  | (CeremonyBase & {
      action: 'binding.activate';
      targetPrincipalId: string;
      contactId: string;
      bindingId: string;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'provider.add' | 'provider.relink';
      contactId: string;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'provider.replace';
      contactId: string;
      currentProvider: VerifiedProviderProof;
      newProvider: VerifiedProviderProof;
    })
  | (CeremonyBase & {
      action: 'role.grant';
      targetPrincipalId: string;
      grantId: string;
      role: FleetAuthRole;
    })
  | (CeremonyBase & {
      action: 'role.change';
      targetPrincipalId: string;
      grantId: string;
      newGrantId: string;
      currentRole: FleetAuthRole;
      role: FleetAuthRole;
    })
  | (CeremonyBase & {
      action: 'role.revoke';
      targetPrincipalId: string;
      grantId: string;
      currentRole: FleetAuthRole;
    });

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
  | 'provider_binding_changed'
  | 'strong_assurance_denied'
  | 'strong_assurance_binding_changed';

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

export class FleetAuthLifecycleCeremonyError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'session_unavailable'
      | 'contact_authority_unavailable'
      | 'denial_audit_failed'
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

function providerProof(value: unknown, field: string): VerifiedProviderProof {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertNoUnknownKeys(
    value,
    ['provider', 'subjectId', 'callbackTransactionId', 'proofDigest'],
    field,
  );
  if (value.provider !== 'discord'
    || typeof value.subjectId !== 'string'
    || !SUBJECT_PATTERN.test(value.subjectId)
    || typeof value.callbackTransactionId !== 'string'
    || !isRfc4122Uuid(value.callbackTransactionId)
    || typeof value.proofDigest !== 'string'
    || !DIGEST_PATTERN.test(value.proofDigest)) {
    throw new Error(`${field} is invalid`);
  }
  return value as unknown as VerifiedProviderProof;
}

function boundedReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('reason must be a string');
  const reason = value.trim();
  if (!reason || reason.length > 512 || /[\u0000-\u001f\u007f]/u.test(reason)) {
    throw new Error('reason is invalid');
  }
  return reason;
}

function contactId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('contactId is invalid');
  }
  return value;
}

function role(value: unknown, field: string): FleetAuthRole {
  if (value !== 'owner' && value !== 'admin' && value !== 'member' && value !== 'guest') {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

export function parseFleetAuthLifecycleCeremonyRequest(
  input: unknown,
): FleetAuthLifecycleCeremonyRequest {
  if (!isRecord(input)) throw new Error('Lifecycle ceremony request must be an object');
  const common = ['action', 'ceremonyId', 'companionId', 'reason'] as const;
  if (typeof input.ceremonyId !== 'string' || !isRfc4122Uuid(input.ceremonyId)
    || typeof input.companionId !== 'string' || !isRfc4122Uuid(input.companionId)) {
    throw new Error('Lifecycle ceremony scope is invalid');
  }
  const reason = boundedReason(input.reason);
  if (input.action === 'binding.activate') {
    assertNoUnknownKeys(input, [
      ...common,
      'targetPrincipalId',
      'contactId',
      'bindingId',
      'newProvider',
    ], 'lifecycleCeremony');
    if (typeof input.targetPrincipalId !== 'string' || !isRfc4122Uuid(input.targetPrincipalId)
      || typeof input.bindingId !== 'string' || !isRfc4122Uuid(input.bindingId)
      || typeof input.contactId !== 'string' || !input.contactId
      || input.contactId.length > 256) {
      throw new Error('Binding activation scope is invalid');
    }
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: input.targetPrincipalId,
      contactId: input.contactId,
      bindingId: input.bindingId,
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'provider.add' || input.action === 'provider.relink') {
    assertNoUnknownKeys(input, [...common, 'contactId', 'newProvider'], 'lifecycleCeremony');
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      contactId: contactId(input.contactId),
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'provider.replace') {
    assertNoUnknownKeys(
      input,
      [...common, 'contactId', 'currentProvider', 'newProvider'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      contactId: contactId(input.contactId),
      currentProvider: providerProof(input.currentProvider, 'currentProvider'),
      newProvider: providerProof(input.newProvider, 'newProvider'),
    };
  }
  if (input.action === 'role.grant') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'role'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId: uuid(input.grantId, 'grantId'),
      role: role(input.role, 'role'),
    };
  }
  if (input.action === 'role.change') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'newGrantId', 'currentRole', 'role'],
      'lifecycleCeremony',
    );
    const currentRole = role(input.currentRole, 'currentRole');
    const newRole = role(input.role, 'role');
    const grantId = uuid(input.grantId, 'grantId');
    const newGrantId = uuid(input.newGrantId, 'newGrantId');
    if (currentRole === newRole || grantId === newGrantId) {
      throw new Error('Role change must replace both role and grant identity');
    }
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId,
      newGrantId,
      currentRole,
      role: newRole,
    };
  }
  if (input.action === 'role.revoke') {
    assertNoUnknownKeys(
      input,
      [...common, 'targetPrincipalId', 'grantId', 'currentRole'],
      'lifecycleCeremony',
    );
    return {
      action: input.action,
      ceremonyId: input.ceremonyId,
      companionId: input.companionId,
      reason,
      targetPrincipalId: uuid(input.targetPrincipalId, 'targetPrincipalId'),
      grantId: uuid(input.grantId, 'grantId'),
      currentRole: role(input.currentRole, 'currentRole'),
    };
  }
  throw new Error('Lifecycle ceremony action is unknown');
}

function canonicalRequest(request: FleetAuthLifecycleCeremonyRequest): Uint8Array {
  return Buffer.from(JSON.stringify(request), 'utf8');
}

function compiledTargetBody(request: FleetAuthLifecycleCeremonyRequest): Uint8Array {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    ceremonyDigest: digest(request.ceremonyId),
    lifecycleRequestDigest: digest(canonicalRequest(request)),
  }), 'utf8');
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

function completePathFor(request: FleetAuthLifecycleCeremonyRequest): string {
  if (request.action === 'binding.activate') return FLEET_AUTH_BINDING_COMPLETE_PATH;
  if (request.action.startsWith('role.')) return FLEET_AUTH_ROLE_COMPLETE_PATH;
  return FLEET_AUTH_PROVIDER_COMPLETE_PATH;
}

export class GatewayFleetAuthLifecycleCeremonyService {
  private readonly origin: string;
  private readonly stepUpRoster: readonly FleetAuthAccountRosterEntry[];

  constructor(private readonly options: {
    pool: Pool;
    sessionPepper: string;
    canonicalOrigin: string;
    lifecycle: Pick<GatewayFleetAuthAuthorityLifecycleStore, 'execute'>;
    jitStepUp: Pick<FleetJitStepUpCoordinator, 'startWebAuthn' | 'consumeGrant'>;
    contactAuthority: FleetContactAuthorityPort;
    denialAudit: FleetLifecycleCeremonyDenialAuditPort;
    /** Admin-unconditional roster; consulted only when the opt-in below is set. */
    accountRoster?: readonly FleetAuthAccountRosterEntry[];
    /** Explicit owner-file opt-in: a rostered OWNER satisfies webauthn_uv step-up. */
    accountRosterSatisfiesStepUp?: boolean;
    now?: () => Date;
  }) {
    const origin = new URL(options.canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.canonicalOrigin) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'Lifecycle origin is invalid');
    }
    this.origin = origin.origin;
    this.stepUpRoster = options.accountRosterSatisfiesStepUp === true
      ? Object.freeze((options.accountRoster ?? []).map(entry => Object.freeze({ ...entry })))
      : Object.freeze([]);
  }

  /**
   * True only when the explicit opt-in is on AND the session's token-verified
   * Discord subject is rostered as OWNER for exactly this companion. Default
   * (opt-in absent or false) is an empty roster, so this always returns false
   * and the WebAuthn step-up path below stays byte-for-byte unchanged.
   */
  private rosterSatisfiesStepUp(providerSubjectId: string, companionId: string): boolean {
    const entry = findFleetAuthAccountRosterEntry(
      this.stepUpRoster,
      'discord',
      providerSubjectId,
      companionId,
    );
    return entry !== undefined && entry.role === 'owner';
  }

  async startStrongAssurance(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    request: unknown;
  }): ReturnType<FleetJitStepUpCoordinator['startWebAuthn']> {
    this.assertOrigin(input.requestOrigin);
    const request = parseFleetAuthLifecycleCeremonyRequest(input.request);
    try {
      await this.readSession(input.token, request.companionId, actionFor(request));
    } catch (error) {
      await this.auditDenial(request, 'session_unavailable');
      throw error;
    }
    try {
      return await this.options.jitStepUp.startWebAuthn({
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
        binding: this.binding(request),
      });
    } catch (error) {
      await this.auditDenial(request, 'strong_assurance_denied');
      throw error;
    }
  }

  async complete(input: {
    token: string;
    requestOrigin: string;
    jitGrantId: string;
    request: unknown;
  }): Promise<FleetAuthLifecycleResult> {
    this.assertOrigin(input.requestOrigin);
    if (!isRfc4122Uuid(input.jitGrantId)) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'JIT grant is invalid');
    }
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
      target = request.action === 'binding.activate'
        ? await this.readPrincipal(request.targetPrincipalId, 'pending')
        : request.action.startsWith('role.')
          ? await this.readPrincipal(request.targetPrincipalId, 'active')
          : claim(session);
    } catch (error) {
      await this.auditDenial(request, 'target_unavailable');
      throw error;
    }
    let contactAuthority: VerifiedDiscordContactAuthoritySnapshot | undefined;
    if (request.action.startsWith('provider.')) {
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
    if (request.action === 'binding.activate' || request.action.startsWith('provider.')) {
      contactAuthority = await this.options.contactAuthority.read({
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
    }
    if (!this.rosterSatisfiesStepUp(session.provider_subject_id, request.companionId)) {
      let grant: Awaited<ReturnType<FleetJitStepUpCoordinator['consumeGrant']>>;
      try {
        grant = await this.options.jitStepUp.consumeGrant({
          grantId: input.jitGrantId,
          token: input.token,
          requestOrigin: input.requestOrigin,
          binding: this.binding(request),
        });
      } catch (error) {
        await this.auditDenial(request, 'strong_assurance_denied');
        throw error;
      }
      if (grant.assurance !== 'webauthn_uv'
        || grant.principalId !== session.principal_id
        || grant.browserSessionId !== session.record_id) {
        await this.auditDenial(request, 'strong_assurance_binding_changed');
        throw new FleetAuthLifecycleCeremonyError(
          'lifecycle_denied',
          'Lifecycle strong assurance binding changed',
        );
      }
    }
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
    let decision: VerifiedFleetAuthLifecycleDecision;
    if (request.action === 'binding.activate') {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        contactId: request.contactId,
        bindingId: request.bindingId,
        newProvider: request.newProvider,
        contactAuthority: contactAuthority!,
      };
    } else if (request.action === 'provider.replace') {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        contactId: request.contactId,
        currentProvider: request.currentProvider,
        newProvider: request.newProvider,
        contactAuthority: contactAuthority!,
      };
    } else if (request.action === 'role.grant') {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        grantId: request.grantId,
        role: request.role,
      };
    } else if (request.action === 'role.change') {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        grantId: request.grantId,
        newGrantId: request.newGrantId,
        currentRole: request.currentRole,
        role: request.role,
      };
    } else if (request.action === 'role.revoke') {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        grantId: request.grantId,
        currentRole: request.currentRole,
      };
    } else {
      decision = {
        ...base,
        action: request.action,
        companionId: request.companionId,
        contactId: request.contactId,
        newProvider: request.newProvider,
        contactAuthority: contactAuthority!,
      };
    }
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

  private binding(request: FleetAuthLifecycleCeremonyRequest): FleetJitRequestBinding {
    const bytes = compiledTargetBody(request);
    const target = compileGatewayGardenRequestTarget({
      rawTarget: completePathFor(request),
      method: 'POST',
      companionId: createCompanionId(request.companionId),
      body: bytes,
    });
    return {
      target,
      subjectScopeDigest: digest(JSON.stringify({
        ceremonyId: request.ceremonyId,
        companionId: request.companionId,
        action: request.action,
        ...('targetPrincipalId' in request
          ? { targetPrincipalId: request.targetPrincipalId, contactId: request.contactId }
          : {}),
      })),
      purpose: `fleet-auth lifecycle ${request.action}`,
      memoryRevision: 1,
      classifierEvidenceDigest: digest('fleet-auth-lifecycle-policy-v1'),
    };
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
