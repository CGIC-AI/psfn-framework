import { throwIfNotOk } from './client';
import {
  currentCompanionGardenScope,
  onCompanionScopeChange,
} from '$lib/fleet/companion-scope';

const FLEET_CSRF_PATH = '/v1/fleet-auth/session/csrf';
const FLEET_ESCALATION_GRANT_PATH = '/v1/fleet-auth/escalation/grant';
const FLEET_CSRF_HEADER = 'X-PSFN-CSRF';
export const FLEET_ESCALATION_GRANT_HEADER = 'x-psfn-escalation-grant';
const FLEET_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FLEET_GRANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ESCALATION_REASON_MAX_LENGTH = 512;
const ESCALATION_REASON_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

export interface FleetEscalationGrant {
  grantId: string;
  routeId: string;
  expiresAt: string;
}

export interface FleetEscalationGrantRequest {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  target: string;
  reason: string;
}

function checkedEscalationReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized
    || normalized.length > ESCALATION_REASON_MAX_LENGTH
    || ESCALATION_REASON_CONTROL_CHARS.test(normalized)) {
    throw new Error(
      `An escalation reason of 1-${ESCALATION_REASON_MAX_LENGTH} printable characters is required`,
    );
  }
  return normalized;
}

async function issueFleetCsrfToken(signal: AbortSignal): Promise<string> {
  const response = await fetch(FLEET_CSRF_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    signal,
  });
  await throwIfNotOk(response);
  const payload = await response.json() as { csrfToken?: unknown };
  const candidate = payload.csrfToken;
  if (
    // ubs:ignore — This is a runtime type guard, not a comparison of secret values.
    typeof candidate === 'string'
    && FLEET_CSRF_TOKEN_PATTERN.test(candidate)) {
    return candidate;
  }
  throw new Error('Cluster escalation ceremony unavailable');
}

/**
 * Mints one audited, single-use fleet escalation grant for an exact declared
 * Garden route. Gateway ceremony routes remain raw same-origin requests so
 * they are never rewritten into a companion Garden data prefix.
 */
export async function issueFleetEscalationGrant(
  request: FleetEscalationGrantRequest,
): Promise<FleetEscalationGrant> {
  const scope = currentCompanionGardenScope();
  if (!scope) {
    throw new Error('Audited escalation requires an authorized companion Garden route');
  }
  if (!request.target.startsWith('/') || request.target.startsWith('//')) {
    throw new Error('Audited escalation target must be one root-absolute Garden route');
  }
  const reason = checkedEscalationReason(request.reason);
  const controller = new AbortController();
  const unsubscribe = onCompanionScopeChange((_previousCompanionId, nextCompanionId) => {
    if (nextCompanionId !== scope.companionId) controller.abort();
  });
  try {
    const csrfToken = await issueFleetCsrfToken(controller.signal);
    const response = await fetch(FLEET_ESCALATION_GRANT_PATH, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'include',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        [FLEET_CSRF_HEADER]: csrfToken,
      },
      body: JSON.stringify({
        companionId: scope.companionId,
        method: request.method,
        target: request.target,
        reason,
      }),
    });
    await throwIfNotOk(response);
    const result = await response.json() as {
      grantId?: unknown;
      routeId?: unknown;
      expiresAt?: unknown;
    };
    if (typeof result.grantId !== 'string'
      || !FLEET_GRANT_ID_PATTERN.test(result.grantId)
      || typeof result.routeId !== 'string'
      || !result.routeId
      || typeof result.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(result.expiresAt))) {
      throw new Error('Escalation grant response is malformed');
    }
    return {
      grantId: result.grantId,
      routeId: result.routeId,
      expiresAt: result.expiresAt,
    };
  } finally {
    unsubscribe();
  }
}
