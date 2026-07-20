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
  readonly provider: 'discord';
  readonly providerSubjectId: string;
  readonly contactId: string;
  readonly contactBindingId: string;
  readonly role: 'owner' | 'admin' | 'member' | 'guest';
  readonly operatorGrantId: string;
  readonly sessionRecordId: string;
  readonly sessionAssurance: 'oauth' | 'webauthn_uv' | 'break_glass';
}

export interface LegacyGardenActorContext {
  readonly kind: 'legacy_operator';
  readonly actorId: 'legacy-token:operator';
}

export interface PublicGardenActorContext {
  readonly kind: 'public';
  readonly actorId: 'public:anonymous';
}

export type GardenActorContext =
  | FleetGardenActorContext
  | LegacyGardenActorContext
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

export interface LegacyGardenRequestContext extends GardenRequestContextBase {
  readonly kind: 'legacy_token';
  readonly requestId: null;
  readonly decisionId: null;
  readonly versions: null;
  readonly actor: LegacyGardenActorContext;
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
  | LegacyGardenRequestContext
  | PublicGardenRequestContext;

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

export function createLegacyGardenRequestContext(input: {
  authorization: GardenRouteAuthorization;
  routeId: string;
  companionId?: string;
  pathParams: Readonly<Record<string, string>>;
  query: Readonly<Record<string, readonly string[]>>;
}): LegacyGardenRequestContext {
  return Object.freeze({
    kind: 'legacy_token',
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
    actor: Object.freeze({ kind: 'legacy_operator', actorId: 'legacy-token:operator' }),
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

/**
 * Legacy services that still expose unpartitioned session or alternate-memory
 * stores are not safe to call for a fleet principal. They remain fail closed
 * until their own subject selectors are explicit. Session reads and episodic
 * memory pass only through their subject-scoped projections (88u3); route
 * recovery, CogSec remediation, group memory, and shard review stay denied.
 */
export function gardenRequestServiceBoundaryDenial(
  context: GardenRequestContext,
): string | null {
  if (context.kind !== 'fleet_principal') return null;
  if (context.resource.area === 'sessions') {
    if (isSubjectBoundSessionRoute(context)) return null;
    return 'Fleet session access requires a subject-bound session projection';
  }
  if (context.resource.area === 'memory'
    && !context.resource.routeId.includes('/api/admin/memory')
    && !context.resource.routeId.endsWith(' /memory')
    && !isSubjectAuthorizedEpisodicRoute(context)
    && privacyBreakGlassResourceKindForRoute(context.resource.routeId) !== 'memory') {
    return 'Fleet memory access requires the subject-authorized memory service';
  }
  return null;
}
