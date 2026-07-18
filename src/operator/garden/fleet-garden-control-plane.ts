// ── Fleet Garden control plane ──
// The one deep admission seam for the fleet-scoped Garden (docs/
// garden-control-plane.md). Callers hand it a raw companion-scoped request;
// it hides companion resolution, capability verification, replay consumption,
// context binding, immutable target-registry resolution, and failure
// normalization behind one interface.
//
// Invariants enforced here:
// - every admitted request carries exactly one immutable, server-derived
//   companion target parsed from the canonical route — never from a header,
//   body field, cookie, or browser switcher state;
// - unknown, malformed, unauthorized, mismatched, stale, and replayed
//   selections deny (generically, without revealing companion existence)
//   BEFORE the target registry is consulted;
// - route target, signed capability, audience, and authenticated context must
//   be equal for the same companion or the request denies with no fallback;
// - there is no process-global mutable "current companion": each admit() call
//   constructs its own frozen route-derived binding, so simultaneous requests
//   for companions A and B cannot cross;
// - ADMIN_TOKEN (or any legacy shared-token authority) has no seam here: the
//   control plane only accepts fleet-principal capability material, and
//   admission rejects requests that carry bearer/cookie caller authority.

import type { IncomingHttpHeaders } from 'node:http';
import {
  CompanionScopedGardenRouteError,
  parseCompanionScopedGardenRoute,
  type CompanionScopedGardenRoute,
} from '../../boundary/fleet-auth/fleet-sso-transport.js';
import type { RequestCapabilityReplayPort } from '../../boundary/fleet-auth/request-capability-replay.js';
import type {
  RequestCapabilityVerifier,
  VerifiedRequestCapability,
} from '../../boundary/fleet-auth/request-capability.js';
import type { CompiledGardenRequestTarget } from '../../boundary/fleet-auth/request-capability-target.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  admitFleetGardenRequest,
  type FleetPrincipalGardenAdmission,
  type GardenCapabilityContext,
} from './garden-admission.js';
import {
  createFleetGardenRequestContext,
  createPublicGardenRequestContext,
  requireCompanionBoundFleetGardenContext,
  type FleetGardenRequestContext,
  type PublicGardenRequestContext,
} from './garden-request-context.js';
import {
  FleetGardenTargetRegistry,
  type FleetGardenTargetIdentity,
  type FleetGardenTargetReadiness,
} from './fleet-garden-target-registry.js';

export interface FleetGardenControlPlaneOptions {
  /** Immutable routing identity for every reachable companion target. */
  readonly registry: FleetGardenTargetRegistry;
  readonly verifier: RequestCapabilityVerifier;
  readonly replay: RequestCapabilityReplayPort;
}

export interface FleetGardenControlPlaneRequest {
  /** The origin-form companion-scoped request target exactly as received. */
  readonly rawTarget: string;
  readonly method: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface FleetGardenAdmittedPrincipalRequest {
  readonly decision: 'allow';
  readonly kind: 'fleet_principal';
  readonly companionId: CompanionId;
  readonly route: CompanionScopedGardenRoute;
  readonly target: CompiledGardenRequestTarget<Buffer>;
  readonly verified: VerifiedRequestCapability;
  readonly context: FleetGardenRequestContext;
  readonly authority: {
    readonly token: string;
    readonly context: GardenCapabilityContext;
  };
  /** Resolved only after capability verification succeeded. */
  readonly upstream: FleetGardenTargetIdentity;
}

export interface FleetGardenAdmittedPublicRequest {
  readonly decision: 'allow';
  readonly kind: 'public';
  readonly companionId: CompanionId;
  readonly route: CompanionScopedGardenRoute;
  readonly target: CompiledGardenRequestTarget<Buffer>;
  readonly context: PublicGardenRequestContext;
  /** Public routes carry no verified authority and never resolve an agent target. */
  readonly upstream: null;
}

export interface FleetGardenDeniedRequest {
  readonly decision: 'deny';
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 503;
  readonly message: string;
}

export type FleetGardenControlPlaneAdmission =
  | FleetGardenAdmittedPrincipalRequest
  | FleetGardenAdmittedPublicRequest
  | FleetGardenDeniedRequest;

export interface FleetGardenReadiness {
  readonly status: 'ready' | 'unready';
  readonly targets: readonly FleetGardenTargetReadiness[];
}

function deny(
  status: FleetGardenDeniedRequest['status'],
  message: string,
): FleetGardenDeniedRequest {
  return Object.freeze({ decision: 'deny', status, message });
}

export class FleetGardenControlPlane {
  private readonly registry: FleetGardenTargetRegistry;
  private readonly verifier: RequestCapabilityVerifier;
  private readonly replay: RequestCapabilityReplayPort;

  constructor(options: FleetGardenControlPlaneOptions) {
    if (!(options.registry instanceof FleetGardenTargetRegistry)) {
      throw new Error('Fleet Garden control plane requires an immutable target registry');
    }
    this.registry = options.registry;
    this.verifier = options.verifier;
    this.replay = options.replay;
  }

  /**
   * Admit one companion-scoped Garden request. The companion binding is
   * derived exclusively from the canonical route, verified against the signed
   * capability and authenticated context, and only then resolved against the
   * immutable target registry.
   */
  async admit(input: FleetGardenControlPlaneRequest): Promise<FleetGardenControlPlaneAdmission> {
    let route: CompanionScopedGardenRoute | undefined;
    try {
      route = parseCompanionScopedGardenRoute(input.rawTarget);
    } catch (error) {
      if (error instanceof CompanionScopedGardenRouteError) {
        // Malformed and unknown selections are indistinguishable at this edge.
        return deny(404, 'Not found');
      }
      throw error;
    }
    if (!route) return deny(404, 'Not found');

    // Per-request frozen binding: the only companion this admission can ever
    // authorize is the one named by the canonical route.
    const admission: FleetPrincipalGardenAdmission = Object.freeze({
      kind: 'fleet-principal' as const,
      audience: 'operator' as const,
      companionId: route.companionId,
      verifier: this.verifier,
      replay: this.replay,
    });
    const admitted = await admitFleetGardenRequest({
      admission,
      rawTarget: route.innerTarget,
      method: input.method,
      headers: input.headers,
      body: input.body,
    });
    if (admitted.decision === 'deny') return admitted;

    if (!admitted.verified || !admitted.authority) {
      // Only declared always-public routes are admissible without verified
      // authority, and they never resolve an agent target.
      if (admitted.target.authorization.publicAccess !== 'always') {
        return deny(403, 'Fleet Garden capability required');
      }
      return Object.freeze({
        decision: 'allow' as const,
        kind: 'public' as const,
        companionId: route.companionId,
        route,
        target: admitted.target,
        context: createPublicGardenRequestContext(admitted.target),
        upstream: null,
      });
    }

    // Exact equality across route target, signed target, audience, and
    // authenticated context — a mismatch denies with no transport fallback.
    let context: FleetGardenRequestContext;
    try {
      context = requireCompanionBoundFleetGardenContext(
        createFleetGardenRequestContext({
          target: admitted.target,
          verified: admitted.verified,
        }),
        route.companionId,
      );
    } catch {
      return deny(403, 'Invalid Fleet Garden capability');
    }

    // Only after verification does the selection touch the target registry.
    let upstream: FleetGardenTargetIdentity;
    try {
      upstream = this.registry.resolve(route.companionId);
    } catch {
      return deny(404, 'Not found');
    }

    return Object.freeze({
      decision: 'allow' as const,
      kind: 'fleet_principal' as const,
      companionId: route.companionId,
      route,
      target: admitted.target,
      verified: admitted.verified,
      context,
      authority: admitted.authority,
      upstream,
    });
  }

  /**
   * Readiness derived from the registry's separate health state: every
   * registered companion is reported independently, and one healthy process
   * is never evidence that the complete target registry is usable.
   */
  probe(): FleetGardenReadiness {
    const targets = this.registry.readiness();
    return Object.freeze({
      status: targets.every(target => target.health.status === 'ready') ? 'ready' : 'unready',
      targets,
    });
  }
}
