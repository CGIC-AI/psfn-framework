import {
  FLEET_AUTH_ACTIONS,
  type FleetAuthAction,
  type FleetAuthConfig,
  type FleetAuthRole,
} from '../../system/config/fleet-auth-config.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

export type FleetAuthorizationDenialReason =
  | 'malformed_request'
  | 'unknown_action'
  | 'unknown_companion'
  | 'wrong_audience'
  | 'session_absent'
  | 'session_ambiguous'
  | 'session_revoked'
  | 'session_replaced'
  | 'session_expired'
  | 'session_authn_stale'
  | 'session_authz_stale'
  | 'session_epoch_stale'
  | 'principal_not_active'
  | 'principal_not_live'
  | 'authority_generation_stale'
  | 'provider_subject_absent'
  | 'provider_subject_ambiguous'
  | 'provider_subject_not_active'
  | 'provider_subject_not_live'
  | 'provider_subject_tombstoned'
  | 'binding_absent'
  | 'binding_ambiguous'
  | 'binding_not_active'
  | 'binding_not_live'
  | 'binding_version_stale'
  | 'role_absent'
  | 'role_ambiguous'
  | 'role_not_active'
  | 'role_not_live'
  | 'policy_version_stale'
  | 'role_action_denied'
  | 'evidence_absent'
  | 'evidence_misbound'
  | 'evidence_not_positive'
  | 'evidence_stale'
  | 'authorization_store_error';

export interface FleetAuthorizationRequest {
  sessionToken: string;
  audience: 'fleet';
  companionId: string;
  action: FleetAuthAction;
  discordEvidence?: { evidenceId: string };
  correlationId?: string;
}

export type FleetAuthorizationRequestParseResult =
  | { ok: true; request: FleetAuthorizationRequest }
  | {
      ok: false;
      reasonCode: FleetAuthorizationDenialReason;
      audit: {
        action?: FleetAuthAction;
        companionId?: string;
        correlationId?: string;
        evidenceRequested: boolean;
      };
    };

export interface FleetAuthorizationSnapshot {
  authority: {
    authorityGeneration: number;
    globalAuthEpoch: number;
  };
  sessions: Array<{
    recordId: string;
    principalId: string;
    audience: string;
    assurance: 'oauth' | 'webauthn_uv' | 'break_glass';
    authnVersion: number;
    authzVersion: number;
    bindingVersion: number;
    policyVersion: number;
    globalAuthEpoch: number;
    idleExpiresAt: Date;
    absoluteExpiresAt: Date;
    replacedBy: string | null;
    revokedAt: Date | null;
    principal: {
      status: 'pending' | 'active' | 'suspended' | 'revoked' | 'quarantined';
      authnVersion: number;
      authzVersion: number;
      authorityGeneration: number;
      restoreState: 'live' | 'quarantined';
    };
  }>;
  providerSubjects: Array<{
    provider: 'discord';
    subjectId: string;
    state: 'pending' | 'active' | 'suspended' | 'revoked' | 'quarantined';
    authorityGeneration: number;
    restoreState: 'live' | 'quarantined';
    tombstoned: boolean;
  }>;
  bindings: Array<{
    bindingId: string;
    companionId: string;
    contactId: string;
    state: 'pending' | 'active' | 'conflict' | 'suspended' | 'revoked' | 'quarantined';
    version: number;
    authorityGeneration: number;
    restoreState: 'live' | 'quarantined';
  }>;
  grants: Array<{
    grantId: string;
    companionId: string;
    role: FleetAuthRole;
    lifecycle: 'pending' | 'active' | 'suspended' | 'revoked' | 'quarantined';
    version: number;
    authorityGeneration: number;
    restoreState: 'live' | 'quarantined';
  }>;
  evidence?: {
    evidenceId: string;
    principalId: string;
    providerSubjectId: string;
    companionId: string;
    guildId: string;
    channelId: string | null;
    threadId: string | null;
    inputDigest: string;
    configDigest: string;
    mappingConfigVersion: number;
    globalAuthEpoch: number;
    psfnEvidenceResult: boolean;
    discordPermissionResult: boolean;
    memberSpecificDenyVeto: boolean;
    decisionReason: string | null;
    lifecycleState: 'active' | 'revoked';
    lifecycleGlobalAuthEpoch: number;
    expiresAt: Date;
    integrityValid: boolean;
    configCurrent: boolean;
  };
}

export interface FleetAuthorizationFacts {
  principalId: string;
  providerSubjectId: string;
  companionId: string;
  contact: {
    bindingId: string;
    contactId: string;
    bindingVersion: number;
  };
  operator: {
    grantId: string;
    role: FleetAuthRole;
    grantVersion: number;
  };
  session: {
    recordId: string;
    audience: 'fleet';
    assurance: 'oauth' | 'webauthn_uv' | 'break_glass';
    authnVersion: number;
    authzVersion: number;
    bindingVersion: number;
    policyVersion: number;
  };
  authority: {
    authorityGeneration: number;
    globalAuthEpoch: number;
  };
  discordEvidence?: Omit<NonNullable<FleetAuthorizationSnapshot['evidence']>,
    'principalId' | 'providerSubjectId' | 'companionId' | 'psfnEvidenceResult'
    | 'discordPermissionResult' | 'memberSpecificDenyVeto' | 'decisionReason'
    | 'lifecycleState' | 'lifecycleGlobalAuthEpoch' | 'integrityValid' | 'configCurrent'>;
}

export type FleetAuthorizationEvaluation =
  | { decision: 'allow'; facts: FleetAuthorizationFacts }
  | { decision: 'deny'; reasonCode: FleetAuthorizationDenialReason };

export interface FleetAuthorizationContext {
  readonly principalId: string;
  readonly providerSubject: Readonly<{
    provider: 'discord';
    subjectId: string;
  }>;
  readonly companionId: string;
  readonly contact: Readonly<{
    bindingId: string;
    contactId: string;
    bindingVersion: number;
  }>;
  readonly operator: Readonly<{
    grantId: string;
    role: FleetAuthRole;
    grantVersion: number;
  }>;
  readonly session: Readonly<FleetAuthorizationFacts['session']>;
  readonly authorization: Readonly<{
    action: FleetAuthAction;
    decision: 'allow';
  }>;
  readonly authority: Readonly<FleetAuthorizationFacts['authority']>;
  readonly discordEvidence?: Readonly<{
    evidenceId: string;
    guildId: string;
    channelId: string | null;
    threadId: string | null;
    inputDigest: string;
    configDigest: string;
    mappingConfigVersion: number;
    globalAuthEpoch: number;
    expiresAt: string;
  }>;
  readonly provenance: Readonly<{
    source: 'gateway_fleet_authorization_snapshot';
    authorizationEventId: string;
    resolvedAt: string;
    correlationId?: string;
  }>;
}

export type FleetAuthorizationStoreDecision =
  | { decision: 'allow'; context: FleetAuthorizationContext }
  | { decision: 'deny'; reasonCode: FleetAuthorizationDenialReason };

export interface FleetAuthorizationContextStore {
  resolve(request: FleetAuthorizationRequest): Promise<FleetAuthorizationStoreDecision>;
  recordRequestDenial(input: Extract<FleetAuthorizationRequestParseResult, { ok: false }>): Promise<void>;
}

export class FleetAuthorizationDeniedError extends Error {
  readonly status = 403;

  constructor(readonly code: FleetAuthorizationDenialReason) {
    super('Fleet authorization context was denied');
    this.name = 'FleetAuthorizationDeniedError';
  }
}

export class GatewayFleetAuthorizationContextResolver {
  private readonly knownCompanionIds: ReadonlySet<string>;

  constructor(
    private readonly store: FleetAuthorizationContextStore,
    knownCompanionIds: readonly string[],
  ) {
    if (knownCompanionIds.length === 0 || knownCompanionIds.some(id => !isRfc4122Uuid(id))) {
      throw new Error('Fleet authorization context resolver requires known RFC-4122 companion IDs');
    }
    this.knownCompanionIds = new Set(knownCompanionIds);
    if (this.knownCompanionIds.size !== knownCompanionIds.length) {
      throw new Error('Fleet authorization context resolver companion IDs must be unique');
    }
  }

  async resolve(input: unknown): Promise<FleetAuthorizationContext> {
    const parsed = parseFleetAuthorizationRequest(input, this.knownCompanionIds);
    if (parsed.ok === false) {
      await this.store.recordRequestDenial(parsed);
      throw new FleetAuthorizationDeniedError(parsed.reasonCode);
    }
    const decision = await this.store.resolve(parsed.request);
    if (decision.decision === 'deny') {
      throw new FleetAuthorizationDeniedError(decision.reasonCode);
    }
    return decision.context;
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length
    && [...expected].sort().every((key, index) => keys[index] === key);
}

function isSafeCorrelationId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseFleetAuthorizationRequest(
  input: unknown,
  knownCompanionIds: ReadonlySet<string>,
): FleetAuthorizationRequestParseResult {
  const knownActions = new Set<string>(FLEET_AUTH_ACTIONS);
  const candidateAction = isRecord(input) && typeof input.action === 'string'
    && knownActions.has(input.action) ? input.action as FleetAuthAction : undefined;
  const candidateCompanionId = isRecord(input) && isRfc4122Uuid(input.companionId)
    && knownCompanionIds.has(input.companionId)
    ? input.companionId : undefined;
  const candidateCorrelationId = isRecord(input) && isSafeCorrelationId(input.correlationId)
    ? input.correlationId : undefined;
  const audit = {
    ...(candidateAction ? { action: candidateAction } : {}),
    ...(candidateCompanionId ? { companionId: candidateCompanionId } : {}),
    ...(candidateCorrelationId ? { correlationId: candidateCorrelationId } : {}),
    evidenceRequested: isRecord(input) && input.discordEvidence !== undefined,
  };
  if (!isRecord(input)
    || !hasExactKeys(
      input,
      ['sessionToken', 'audience', 'companionId', 'action',
        ...(input.discordEvidence === undefined ? [] : ['discordEvidence']),
        ...(input.correlationId === undefined ? [] : ['correlationId'])],
    )
    || typeof input.sessionToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.sessionToken)
    || !isRfc4122Uuid(input.companionId)
    || (input.correlationId !== undefined && !isSafeCorrelationId(input.correlationId))) {
    return { ok: false, reasonCode: 'malformed_request', audit };
  }
  if (input.audience !== 'fleet') {
    return { ok: false, reasonCode: 'wrong_audience', audit };
  }
  if (typeof input.action !== 'string' || !knownActions.has(input.action)) {
    return { ok: false, reasonCode: 'unknown_action', audit };
  }
  if (!knownCompanionIds.has(input.companionId)) {
    return { ok: false, reasonCode: 'unknown_companion', audit };
  }
  let discordEvidence: FleetAuthorizationRequest['discordEvidence'];
  if (input.discordEvidence !== undefined) {
    if (!isRecord(input.discordEvidence)
      || !hasExactKeys(input.discordEvidence, ['evidenceId'])
      || !isRfc4122Uuid(input.discordEvidence.evidenceId)) {
      return { ok: false, reasonCode: 'malformed_request', audit };
    }
    discordEvidence = { evidenceId: input.discordEvidence.evidenceId };
  }
  return {
    ok: true,
    request: {
      sessionToken: input.sessionToken,
      audience: 'fleet',
      companionId: input.companionId,
      action: input.action as FleetAuthAction,
      ...(discordEvidence ? { discordEvidence } : {}),
      ...(typeof input.correlationId === 'string' ? { correlationId: input.correlationId } : {}),
    },
  };
}

function deny(reasonCode: FleetAuthorizationDenialReason): FleetAuthorizationEvaluation {
  return { decision: 'deny', reasonCode };
}

function roleAllowsAction(role: FleetAuthRole, action: FleetAuthAction): boolean {
  switch (role) {
    case 'owner': {
      const allowedActions: readonly FleetAuthAction[] = [
        'companion.read',
        'garden.read',
        'settings.read',
        'settings.write',
        'tools.execute',
        'contacts.bind',
        'roles.manage',
        'memory.read.self',
        'memory.jit.self',
        'devices.manage',
        'provider.link',
      ];
      return allowedActions.includes(action);
    }
    case 'admin':
      return action === 'companion.read'
        || action === 'garden.read'
        || action === 'settings.read'
        || action === 'settings.write'
        || action === 'tools.execute'
        || action === 'contacts.bind'
        || action === 'roles.manage'
        || action === 'memory.read.self'
        || action === 'memory.jit.self'
        || action === 'devices.manage';
    case 'member':
      return action === 'companion.read'
        || action === 'memory.read.self'
        || action === 'memory.jit.self';
    case 'guest':
      return action === 'companion.read';
  }
}

export function evaluateFleetAuthorizationSnapshot(input: {
  request: FleetAuthorizationRequest;
  snapshot: FleetAuthorizationSnapshot;
  disabledActionsByRole: FleetAuthConfig['rolePolicy']['disabledActionsByRole'];
  now: Date;
}): FleetAuthorizationEvaluation {
  const { request, snapshot, now } = input;
  if (snapshot.sessions.length === 0) return deny('session_absent');
  if (snapshot.sessions.length !== 1) return deny('session_ambiguous');
  const session = snapshot.sessions[0]!;
  if (session.audience !== 'fleet') return deny('wrong_audience');
  if (session.revokedAt !== null) return deny('session_revoked');
  if (session.replacedBy !== null) return deny('session_replaced');
  if (session.idleExpiresAt.getTime() <= now.getTime()
    || session.absoluteExpiresAt.getTime() <= now.getTime()) return deny('session_expired');
  if (session.principal.status !== 'active') return deny('principal_not_active');
  if (session.principal.restoreState !== 'live') return deny('principal_not_live');
  if (session.authnVersion !== session.principal.authnVersion) return deny('session_authn_stale');
  if (session.authzVersion !== session.principal.authzVersion) return deny('session_authz_stale');
  if (session.globalAuthEpoch !== snapshot.authority.globalAuthEpoch) return deny('session_epoch_stale');
  if (session.principal.authorityGeneration !== snapshot.authority.authorityGeneration) {
    return deny('authority_generation_stale');
  }

  const activeSubjects = snapshot.providerSubjects.filter(subject => (
    subject.state === 'active' && subject.restoreState === 'live'
  ));
  if (activeSubjects.length === 0) {
    if (snapshot.providerSubjects.length === 0) return deny('provider_subject_absent');
    if (snapshot.providerSubjects.some(subject => subject.tombstoned)) {
      return deny('provider_subject_tombstoned');
    }
    if (snapshot.providerSubjects.some(subject => subject.restoreState !== 'live')) {
      return deny('provider_subject_not_live');
    }
    return deny('provider_subject_not_active');
  }
  if (activeSubjects.length !== 1) return deny('provider_subject_ambiguous');
  const subject = activeSubjects[0]!;
  if (subject.tombstoned) return deny('provider_subject_tombstoned');
  if (subject.authorityGeneration !== snapshot.authority.authorityGeneration) {
    return deny('authority_generation_stale');
  }

  const companionBindings = snapshot.bindings.filter(binding => (
    binding.companionId === request.companionId
  ));
  const activeBindings = companionBindings.filter(binding => (
    binding.state === 'active' && binding.restoreState === 'live'
  ));
  if (activeBindings.length === 0) {
    if (companionBindings.length === 0) return deny('binding_absent');
    if (companionBindings.some(binding => binding.restoreState !== 'live')) {
      return deny('binding_not_live');
    }
    return deny('binding_not_active');
  }
  if (activeBindings.length !== 1) return deny('binding_ambiguous');
  const binding = activeBindings[0]!;
  if (binding.authorityGeneration !== snapshot.authority.authorityGeneration) {
    return deny('authority_generation_stale');
  }
  if (binding.version !== session.bindingVersion) return deny('binding_version_stale');

  const companionGrants = snapshot.grants.filter(grant => grant.companionId === request.companionId);
  const activeGrants = companionGrants.filter(grant => (
    grant.lifecycle === 'active' && grant.restoreState === 'live'
  ));
  if (activeGrants.length === 0) {
    if (companionGrants.length === 0) return deny('role_absent');
    if (companionGrants.some(grant => grant.restoreState !== 'live')) return deny('role_not_live');
    return deny('role_not_active');
  }
  if (activeGrants.length !== 1) return deny('role_ambiguous');
  const grant = activeGrants[0]!;
  if (grant.authorityGeneration !== snapshot.authority.authorityGeneration) {
    return deny('authority_generation_stale');
  }
  if (grant.version !== session.policyVersion) return deny('policy_version_stale');
  if (!roleAllowsAction(grant.role, request.action)
    || input.disabledActionsByRole[grant.role].includes(request.action)) {
    return deny('role_action_denied');
  }

  const evidence = snapshot.evidence;
  if (request.discordEvidence && !evidence) return deny('evidence_absent');
  if (evidence) {
    if ((request.discordEvidence && evidence.evidenceId !== request.discordEvidence.evidenceId)
      || evidence.principalId !== session.principalId
      || evidence.providerSubjectId !== subject.subjectId
      || evidence.companionId !== request.companionId) return deny('evidence_misbound');
    if (!evidence.psfnEvidenceResult
      || !evidence.discordPermissionResult
      || evidence.memberSpecificDenyVeto
      || evidence.decisionReason !== null
      || !evidence.integrityValid) return deny('evidence_not_positive');
    if (evidence.lifecycleState !== 'active'
      || !evidence.configCurrent
      || evidence.globalAuthEpoch !== snapshot.authority.globalAuthEpoch
      || evidence.lifecycleGlobalAuthEpoch !== snapshot.authority.globalAuthEpoch
      || evidence.expiresAt.getTime() <= now.getTime()) return deny('evidence_stale');
  }

  return {
    decision: 'allow',
    facts: {
      principalId: session.principalId,
      providerSubjectId: subject.subjectId,
      companionId: request.companionId,
      contact: {
        bindingId: binding.bindingId,
        contactId: binding.contactId,
        bindingVersion: binding.version,
      },
      operator: {
        grantId: grant.grantId,
        role: grant.role,
        grantVersion: grant.version,
      },
      session: {
        recordId: session.recordId,
        audience: 'fleet',
        assurance: session.assurance,
        authnVersion: session.authnVersion,
        authzVersion: session.authzVersion,
        bindingVersion: session.bindingVersion,
        policyVersion: session.policyVersion,
      },
      authority: { ...snapshot.authority },
      ...(evidence ? {
        discordEvidence: {
          evidenceId: evidence.evidenceId,
          guildId: evidence.guildId,
          channelId: evidence.channelId,
          threadId: evidence.threadId,
          inputDigest: evidence.inputDigest,
          configDigest: evidence.configDigest,
          mappingConfigVersion: evidence.mappingConfigVersion,
          globalAuthEpoch: evidence.globalAuthEpoch,
          expiresAt: evidence.expiresAt,
        },
      } : {}),
    },
  };
}

export function createImmutableFleetAuthorizationContext(input: {
  request: FleetAuthorizationRequest;
  facts: FleetAuthorizationFacts;
  authorizationEventId: string;
  resolvedAt: Date;
}): FleetAuthorizationContext {
  const context: FleetAuthorizationContext = {
    principalId: input.facts.principalId,
    providerSubject: Object.freeze({
      provider: 'discord',
      subjectId: input.facts.providerSubjectId,
    }),
    companionId: input.facts.companionId,
    contact: Object.freeze({ ...input.facts.contact }),
    operator: Object.freeze({ ...input.facts.operator }),
    session: Object.freeze({ ...input.facts.session }),
    authorization: Object.freeze({ action: input.request.action, decision: 'allow' }),
    authority: Object.freeze({ ...input.facts.authority }),
    ...(input.facts.discordEvidence
      ? {
          discordEvidence: Object.freeze({
            ...input.facts.discordEvidence,
            expiresAt: input.facts.discordEvidence.expiresAt.toISOString(),
          }),
        }
      : {}),
    provenance: Object.freeze({
      source: 'gateway_fleet_authorization_snapshot',
      authorizationEventId: input.authorizationEventId,
      resolvedAt: input.resolvedAt.toISOString(),
      ...(input.request.correlationId ? { correlationId: input.request.correlationId } : {}),
    }),
  };
  return Object.freeze(context);
}
