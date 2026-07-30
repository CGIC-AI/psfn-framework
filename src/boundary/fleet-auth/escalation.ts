import { createHash, randomUUID } from 'node:crypto';
import type { FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { CompiledGardenRequestTarget } from './request-capability-target.js';

/**
 * Audited SSO escalation (operator rulings D1/D2, 2026-07-30).
 *
 * There is no step-up ceremony and no second authentication factor: the
 * Discord SSO session *is* the identity. Escalation is an explicit, audited
 * action — the authenticated admin states a reason for opening a gated
 * surface (another human's sensitive memory, a cogsec remediation action, a
 * privacy break-glass confirmation), a single-use grant with a bounded TTL is
 * recorded together with an audit event naming actor, scope, and reason, and
 * the exact gated request then consumes that grant.
 */

export class FleetEscalationError extends Error {
  constructor(
    readonly code:
      | 'invalid_request'
      | 'origin_mismatch'
      | 'not_escalation_surface'
      | 'session_unavailable'
      | 'grant_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'FleetEscalationError';
  }
}

export type FleetEscalationTarget = Pick<CompiledGardenRequestTarget,
  | 'companionId'
  | 'action'
  | 'resource'
  | 'authorization'>;

export interface FleetEscalationRequestBinding {
  /** Compiled from the declared Garden route, never from browser authority fields. */
  target: FleetEscalationTarget;
  /** Operator-stated reason; recorded verbatim in the audit trail. */
  reason: string;
}

export interface FleetEscalationDurableBinding {
  companionId: string;
  action: FleetAuthAction;
  routeId: string;
  scopeDigest: string;
  reasonDigest: string;
  assuranceRequirement: 'escalated' | 'privacy_break_glass';
}

export interface FleetEscalationGrantBinding {
  grantId: string;
  principalId: string;
  browserSessionId: string;
  companionId: string;
  action: FleetAuthAction;
  routeId: string;
  scopeDigest: string;
  assuranceRequirement: 'escalated' | 'privacy_break_glass';
  expiresAt: Date;
}

export interface FleetEscalationGrantStore {
  createGrant(input: {
    grantId: string;
    token: string;
    csrfToken: string;
    exactOrigin: string;
    binding: FleetEscalationDurableBinding;
    reason: string;
    now: Date;
    expiresAt: Date;
  }): Promise<FleetEscalationGrantBinding>;
  consumeGrant(input: {
    grantId: string;
    token: string;
    exactOrigin: string;
    binding: Omit<FleetEscalationDurableBinding, 'reasonDigest'>;
    now: Date;
  }): Promise<FleetEscalationGrantBinding>;
}

export interface FleetEscalationCoordinatorOptions {
  canonicalOrigin: string;
  grantTtlMs: number;
  store: FleetEscalationGrantStore;
  now?: () => Date;
  randomUuid?: () => string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function checkedEscalationReason(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new FleetEscalationError('invalid_request', 'Escalation reason is invalid');
  }
  return normalized;
}

/**
 * Body- and query-independent scope binding: the grant authorizes one exact
 * route resource (including path params such as the memory id) for one
 * companion, regardless of how the eventual request body is serialized.
 */
export function escalationScopeDigest(target: FleetEscalationTarget): string {
  return digest(JSON.stringify({
    companionId: target.companionId,
    action: target.action,
    routeId: target.resource.routeId,
    pathParams: Object.fromEntries(
      Object.entries(target.resource.pathParams).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  }));
}

function assuranceRequirementOf(
  target: FleetEscalationTarget,
): 'escalated' | 'privacy_break_glass' {
  const assurance = target.authorization.requirements.assurance;
  if (assurance !== 'escalated' && assurance !== 'privacy_break_glass') {
    throw new FleetEscalationError(
      'not_escalation_surface',
      'This route is not an escalation surface',
    );
  }
  if (target.authorization.action !== target.action) {
    throw new FleetEscalationError('invalid_request', 'Escalation target is inconsistent');
  }
  return assurance;
}

/**
 * Gateway-only orchestration for audited escalation grants. It accepts a
 * compiled route target, never browser-supplied action or resource strings,
 * and leaves all session/role/epoch checks transactional in the store.
 */
export class FleetEscalationCoordinator {
  private readonly origin: string;

  constructor(private readonly options: FleetEscalationCoordinatorOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.canonicalOrigin);
    } catch {
      throw new FleetEscalationError('invalid_request', 'Escalation canonical origin is invalid');
    }
    if (parsed.protocol !== 'https:' || parsed.origin !== options.canonicalOrigin
      || !Number.isSafeInteger(options.grantTtlMs) || options.grantTtlMs < 30_000
      || options.grantTtlMs > 3_600_000) {
      throw new FleetEscalationError('invalid_request', 'Escalation configuration is invalid');
    }
    this.origin = parsed.origin;
  }

  async issueGrant(input: {
    token: string;
    csrfToken: string;
    requestOrigin: string;
    binding: FleetEscalationRequestBinding;
  }): Promise<{ grantId: string; expiresAt: Date; routeId: string }> {
    this.assertOrigin(input.requestOrigin);
    const assuranceRequirement = assuranceRequirementOf(input.binding.target);
    if (!isRfc4122Uuid(input.binding.target.companionId)) {
      throw new FleetEscalationError('invalid_request', 'Escalation companion id is invalid');
    }
    const reason = checkedEscalationReason(input.binding.reason);
    const grantId = (this.options.randomUuid ?? randomUUID)();
    if (!isRfc4122Uuid(grantId)) {
      throw new FleetEscalationError('invalid_request', 'Escalation UUID source returned invalid output');
    }
    const now = (this.options.now ?? (() => new Date()))();
    const created = await this.options.store.createGrant({
      grantId,
      token: input.token,
      csrfToken: input.csrfToken,
      exactOrigin: this.origin,
      binding: {
        companionId: input.binding.target.companionId,
        action: input.binding.target.action,
        routeId: input.binding.target.resource.routeId,
        scopeDigest: escalationScopeDigest(input.binding.target),
        reasonDigest: digest(reason),
        assuranceRequirement,
      },
      reason,
      now,
      expiresAt: new Date(now.getTime() + this.options.grantTtlMs),
    });
    return {
      grantId: created.grantId,
      expiresAt: created.expiresAt,
      routeId: created.routeId,
    };
  }

  async consumeGrant(input: {
    grantId: string;
    token: string;
    requestOrigin: string;
    target: FleetEscalationTarget;
  }): Promise<FleetEscalationGrantBinding> {
    this.assertOrigin(input.requestOrigin);
    if (!isRfc4122Uuid(input.grantId)) {
      throw new FleetEscalationError('grant_unavailable', 'Escalation grant is unavailable');
    }
    const assuranceRequirement = assuranceRequirementOf(input.target);
    const now = (this.options.now ?? (() => new Date()))();
    return await this.options.store.consumeGrant({
      grantId: input.grantId,
      token: input.token,
      exactOrigin: this.origin,
      binding: {
        companionId: input.target.companionId,
        action: input.target.action,
        routeId: input.target.resource.routeId,
        scopeDigest: escalationScopeDigest(input.target),
        assuranceRequirement,
      },
      now,
    });
  }

  private assertOrigin(requestOrigin: string): void {
    if (requestOrigin !== this.origin) {
      throw new FleetEscalationError('origin_mismatch', 'Escalation request origin mismatch');
    }
  }
}
