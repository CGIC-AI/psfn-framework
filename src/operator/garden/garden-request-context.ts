import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import type {
  RequestCapabilityAuthorityVersions,
  VerifiedRequestCapability,
} from '../../boundary/fleet-auth/request-capability.js';
import type {
  CompiledGardenRequestTarget,
} from '../../boundary/fleet-auth/request-capability-target.js';
import type {
  GardenRouteAuthorization,
  GardenSubjectRelation,
} from '../../boundary/fleet-auth/garden-route-authorization.js';
import { privacyBreakGlassResourceKindForRoute } from '../../shared/contracts/privacy-break-glass.js';
import type { ContactMutationAuditMetadata } from '../../core/contacts/types.js';

export interface GardenRequestResourceContext {
  readonly routeId: string;
  readonly scope: CompiledGardenRequestTarget['resource']['scope'];
  readonly area: CompiledGardenRequestTarget['resource']['area'];
  readonly companionId: string | null;
  readonly pathParams: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, readonly string[]>>;
}

export interface FleetGardenActorContext {
  readonly kind: 'fleet_principal';
  readonly principalId: string;
  readonly provider: 'discord' | 'testing_harness';
  readonly providerSubjectId: string;
  readonly contactId: string;
  readonly contactBindingId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  readonly operatorGrantId: string;
  readonly sessionRecordId: string;
  readonly sessionAssurance: 'oauth' | 'escalated' | 'break_glass';
  /**
   * D1 deployment access mode (signed by the gateway from the boot-frozen
   * account roster): `sole_admin` deployments have exactly one rostered human
   * and are never subject-gated; `multi_admin` keeps the subject boundary.
   */
  readonly accessMode: 'sole_admin' | 'multi_admin';
}

export interface StandaloneGardenActorContext {
  readonly kind: 'standalone_operator';
  readonly actorId: 'standalone-token:operator';
}

export interface PublicGardenActorContext {
  readonly kind: 'public';
  readonly actorId: 'public:anonymous';
}

export type GardenActorContext =
  | FleetGardenActorContext
  | StandaloneGardenActorContext
  | PublicGardenActorContext;

interface GardenRequestContextBase {
  readonly actor: GardenActorContext;
  readonly action: FleetAuthAction;
  readonly resource: GardenRequestResourceContext;
  readonly subjectRelation: GardenSubjectRelation;
  readonly authorization: GardenRouteAuthorization;
}

export interface FleetGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'fleet_principal';
  readonly requestId: string;
  readonly decisionId: string;
  readonly authorizationEventId: string;
  readonly resolvedAt: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly actor: FleetGardenActorContext;
}

export interface StandaloneGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'standalone_token';
  readonly requestId: null;
  readonly decisionId: null;
  readonly versions: null;
  readonly actor: StandaloneGardenActorContext;
}

export interface PublicGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'public';
  readonly requestId: null;
  readonly decisionId: null;
  readonly versions: null;
  readonly actor: PublicGardenActorContext;
}

export type GardenRequestContext =
  | FleetGardenRequestContext
  | StandaloneGardenRequestContext
  | PublicGardenRequestContext;

export const FLEET_GARDEN_CONTACT_OPERATOR_ACTOR = 'operator:fleet-garden';

export interface FleetGardenContactMutationActor {
  readonly actorId: typeof FLEET_GARDEN_CONTACT_OPERATOR_ACTOR;
  readonly auditMetadata: ContactMutationAuditMetadata;
}

/** Provider identity is audit attribution, never an actor or authority selector. */
export function resolveFleetGardenContactMutationActor(
  context: GardenRequestContext,
): FleetGardenContactMutationActor | null {
  if (context.kind !== 'fleet_principal'
    || context.actor.provider !== 'discord'
    || context.actor.role !== 'owner') return null;
  const required = [context.actor.providerSubjectId, context.actor.principalId,
    context.requestId, context.decisionId, context.authorizationEventId,
    context.actor.operatorGrantId, context.actor.sessionRecordId, context.actor.contactBindingId];
  if (required.some(value => !value.trim())) return null;
  return Object.freeze({
    actorId: FLEET_GARDEN_CONTACT_OPERATOR_ACTOR,
    auditMetadata: Object.freeze({
      source: 'fleet_garden', provider: 'discord',
      providerSubjectId: context.actor.providerSubjectId,
      principalId: context.actor.principalId, requestId: context.requestId,
      decisionId: context.decisionId, authorizationEventId: context.authorizationEventId,
      operatorGrantId: context.actor.operatorGrantId,
      sessionRecordId: context.actor.sessionRecordId,
      contactBindingId: context.actor.contactBindingId,
    }),
  });
}

function freezeResource(target: CompiledGardenRequestTarget): GardenRequestResourceContext {
  return Object.freeze({
    routeId: target.resource.routeId,
    scope: target.resource.scope,
    area: target.resource.area,
    companionId: target.resource.companionId,
    pathParams: Object.freeze({ ...target.resource.pathParams }),
    query: Object.freeze(Object.fromEntries(
      Object.entries(target.resource.query).map(([key, values]) => [key, Object.freeze([...values])]),
    )),
  });
}

export function createFleetGardenRequestContext(input: {
  target: CompiledGardenRequestTarget;
  verified: VerifiedRequestCapability;
}): FleetGardenRequestContext {
  const { target, verified } = input;
  if (verified.companionId !== target.companionId
    || verified.action !== target.action
    || verified.authContext.companionId !== target.companionId) {
    throw new Error('Fleet Garden request context does not match the admitted target');
  }
  const actor: FleetGardenActorContext = Object.freeze({
    kind: 'fleet_principal',
    principalId: verified.authContext.principalId,
    provider: verified.authContext.provider,
    providerSubjectId: verified.authContext.providerSubjectId,
    contactId: verified.authContext.contactId,
    contactBindingId: verified.authContext.contactBindingId,
    role: verified.authContext.role,
    operatorGrantId: verified.authContext.operatorGrantId,
    sessionRecordId: verified.authContext.sessionRecordId,
    sessionAssurance: verified.authContext.sessionAssurance,
    accessMode: verified.authContext.fleetAccessMode,
  });
  return Object.freeze({
    kind: 'fleet_principal',
    requestId: verified.requestId,
    decisionId: verified.decisionId,
    authorizationEventId: verified.authContext.authorizationEventId,
    resolvedAt: verified.authContext.resolvedAt,
    versions: Object.freeze({ ...verified.versions }),
    issuedAt: verified.issuedAt,
    expiresAt: verified.expiresAt,
    actor,
    action: target.action,
    resource: freezeResource(target),
    subjectRelation: target.authorization.subjectRelation,
    authorization: target.authorization,
  });
}

export function createPublicGardenRequestContext(
  target: CompiledGardenRequestTarget,
): PublicGardenRequestContext {
  const common = {
    requestId: null,
    decisionId: null,
    versions: null,
    action: target.action,
    resource: freezeResource(target),
    subjectRelation: target.authorization.subjectRelation,
    authorization: target.authorization,
  } as const;
  return Object.freeze({
    ...common,
    kind: 'public',
    actor: Object.freeze({ kind: 'public', actorId: 'public:anonymous' }),
  });
}

export function createStandaloneGardenRequestContext(input: {
  authorization: GardenRouteAuthorization;
  routeId: string;
  companionId?: string;
  pathParams: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
}): StandaloneGardenRequestContext {
  return Object.freeze({
    kind: 'standalone_token',
    requestId: null,
    decisionId: null,
    versions: null,
    action: input.authorization.action,
    resource: Object.freeze({
      routeId: input.routeId,
      scope: input.authorization.resource.scope,
      area: input.authorization.resource.area,
      companionId: input.companionId ?? null,
      pathParams: Object.freeze({ ...input.pathParams }),
      query: Object.freeze(Object.fromEntries(
        Object.entries(input.query).map(([key, values]) => [key, Object.freeze([...values])]),
      )),
    }),
    subjectRelation: input.authorization.subjectRelation,
    authorization: input.authorization,
    actor: Object.freeze({ kind: 'standalone_operator', actorId: 'standalone-token:operator' }),
  });
}

export function requireFleetGardenRequestContext(
  context: GardenRequestContext,
): FleetGardenRequestContext {
  if (context.kind !== 'fleet_principal') {
    throw new Error('This Garden operation requires a trusted fleet principal context');
  }
  return context;
}

/**
 * Require a fleet principal context whose admitted resource is bound to one
 * exact companion target. Fleet control-plane callers use this after
 * admission so a context created for companion A can never be applied to a
 * request routed at companion B — the route selection, the signed capability,
 * and the authenticated context must all name the same companion.
 */
export function requireCompanionBoundFleetGardenContext(
  context: GardenRequestContext,
  companionId: string,
): FleetGardenRequestContext {
  const fleet = requireFleetGardenRequestContext(context);
  if (!companionId || fleet.resource.companionId !== companionId) {
    throw new Error('Fleet Garden request context is bound to a different companion target');
  }
  return fleet;
}

/**
 * Session routes served through the subject-bound session projection (88u3).
 * Every id listed here MUST be handled by a session service that scopes rows
 * to the request's authenticated `actor.contactId`; anything else in the
 * sessions area (route recovery, CogSec remediation, session-recovery pages)
 * stays on the unpartitioned service and remains fail closed.
 */
const SUBJECT_BOUND_SESSION_ROUTE_IDS: ReadonlySet<string> = new Set([
  'GET /api/admin/sessions',
  'GET /api/admin/sessions/:channelId',
  'GET /api/admin/sessions/:channelId/detail',
  'GET /api/admin/sessions/:channelId/search',
  'GET /api/admin/sessions/:channelId/turns/:turnId',
  'GET /sessions',
  'HEAD /sessions',
]);

/**
 * Episodic-memory reads served through the subject-authorized episodic store
 * (88u3): the episodic admin service filters every episode, arc, and thread to
 * the request's authenticated `actor.contactId` via `participantContactIds`.
 */
const SUBJECT_AUTHORIZED_EPISODIC_ROUTE_IDS: ReadonlySet<string> = new Set([
  'GET /api/admin/episodic-memory/episodes',
  'GET /api/admin/episodic-memory/episodes/:id',
  'GET /api/admin/episodic-memory/episodes/:id/arcs',
  'GET /api/admin/episodic-memory/episodes/:id/provenance',
  'GET /api/admin/episodic-memory/threads',
  'GET /api/admin/episodic-memory/threads/:threadId',
  'GET /episodic-memory',
  'HEAD /episodic-memory',
]);

/**
 * Biographical review routes whose service filters every claim through the
 * authenticated contact subject (including relational co-subject claims).
 * Keep this exact allowlist separate from the broad memory route family so a
 * newly declared route cannot bypass the service boundary accidentally.
 */
const SUBJECT_AUTHORIZED_BIOGRAPHICAL_ROUTE_IDS: ReadonlySet<string> = new Set([
  'GET /api/admin/biographical-claims',
  'GET /api/admin/biographical-claims/:claimId',
  'POST /api/admin/biographical-claims/:claimId/review',
  'GET /biographical-profile',
  'HEAD /biographical-profile',
]);

/**
 * A request-local subject relation is the explicit selector the projected
 * services key their row scoping on; `current_companion`/`none` routes carry
 * no subject and must never reach a subject-scoped service.
 */
function hasExplicitSubjectRelation(context: GardenRequestContext): boolean {
  return context.subjectRelation === 'self' || context.subjectRelation === 'self_or_co_subject';
}

function isSubjectBoundSessionRoute(context: GardenRequestContext): boolean {
  return SUBJECT_BOUND_SESSION_ROUTE_IDS.has(context.resource.routeId)
    && hasExplicitSubjectRelation(context);
}

function isSubjectAuthorizedEpisodicRoute(context: GardenRequestContext): boolean {
  if (!hasExplicitSubjectRelation(context)) return false;
  return SUBJECT_AUTHORIZED_EPISODIC_ROUTE_IDS.has(context.resource.routeId);
}

function isSubjectAuthorizedBiographicalRoute(context: GardenRequestContext): boolean {
  if (!hasExplicitSubjectRelation(context)) return false;
  return SUBJECT_AUTHORIZED_BIOGRAPHICAL_ROUTE_IDS.has(context.resource.routeId);
}

/**
 * Legacy services that still expose unpartitioned session or alternate-memory
 * stores are not safe to call for a fleet principal. They remain fail closed
 * until their own subject selectors are explicit. Session reads and episodic
 * memory pass only through their subject-scoped projections (88u3); route
 * recovery, CogSec remediation, group memory, and shard review stay denied.
 */
/**
 * D1 helper: true when the signed fleet actor is the deployment's sole
 * rostered admin (admin-class role + `sole_admin` access mode). Such an actor
 * is never subject-partitioned from their own deployment's data.
 */
export function soleAdminFleetActor(
  context: Pick<FleetGardenRequestContext, 'actor'>,
): boolean {
  return (context.actor.role === 'owner' || context.actor.role === 'admin')
    && context.actor.accessMode === 'sole_admin';
}

export function gardenRequestServiceBoundaryDenial(
  context: GardenRequestContext,
): string | null {
  if (context.kind !== 'fleet_principal') return null;
  // D1 sole-admin doctrine: with exactly one rostered human there is no other
  // subject to protect — the SSO admin reaches every Garden service. The
  // high-intimacy body escalation and the companion-privacy break-glass
  // boundary are enforced downstream and are unaffected by this bypass.
  if (soleAdminFleetActor(context)) return null;
  if (context.resource.area === 'sessions') {
    if (isSubjectBoundSessionRoute(context)) return null;
    return 'Fleet session access requires a subject-bound session projection';
  }
  if (context.resource.area === 'memory'
    && !context.resource.routeId.includes('/api/admin/memory')
    && !context.resource.routeId.endsWith(' /memory')
    && !isSubjectAuthorizedEpisodicRoute(context)
    && !isSubjectAuthorizedBiographicalRoute(context)
    && privacyBreakGlassResourceKindForRoute(context.resource.routeId) !== 'memory') {
    return 'Fleet memory access requires the subject-authorized memory service';
  }
  return null;
}

export function gardenRequestServiceBoundaryDenialCode(
  context: GardenRequestContext,
): 'subject_bound_session_required' | 'subject_authorized_memory_required' | null {
  const denial = gardenRequestServiceBoundaryDenial(context);
  if (!denial) return null;
  return context.resource.area === 'sessions'
    ? 'subject_bound_session_required'
    : 'subject_authorized_memory_required';
}
