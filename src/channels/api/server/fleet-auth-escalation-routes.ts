import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FleetEscalationError,
  type FleetEscalationCoordinator,
} from '../../../boundary/fleet-auth/escalation.js';
import { compileGatewayGardenRequestTarget } from '../../../boundary/fleet-auth/request-capability-target.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  LOWERCASE_RFC4122_COMPANION_ID_PATTERN,
  createCompanionId,
} from '../../../shared/routing/companion-id.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';

export const FLEET_AUTH_ESCALATION_GRANT_PATH = '/v1/fleet-auth/escalation/grant';

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof FleetEscalationError) {
    const status = error.code === 'origin_mismatch' ? 403
      : error.code === 'not_escalation_surface' ? 404
        : error.code === 'invalid_request' ? 400
          : error.code === 'session_unavailable' ? 401
            : 409;
    throw new FleetAuthBrokerError(error.code, status, error.message);
  }
  throw new FleetAuthBrokerError('invalid_escalation_request', 400, 'Escalation request is malformed');
}

/**
 * Strict same-origin HTTP adapter for issuing audited escalation grants
 * (operator rulings D1/D2): an authenticated Discord-SSO admin names one
 * exact escalation surface and a reason; the coordinator/store record the
 * grant plus its audit event. All authority stays in the coordinator/store.
 */
export class FleetAuthEscalationHttpRoutes {
  constructor(private readonly coordinator: Pick<FleetEscalationCoordinator, 'issueGrant'>) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && path === FLEET_AUTH_ESCALATION_GRANT_PATH;
  }

  async handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    path: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    const body = await readJsonBodyWithLimit(input.request, input.response, {
      maxBytes: 64_000,
    });
    if (!body.ok) return;
    try {
      if (!isRecord(body.value)) throw new Error('Escalation body must be an object');
      assertNoUnknownKeys(body.value, ['companionId', 'method', 'target', 'reason'], 'escalationGrant');
      const companionId = requiredString(body.value, 'companionId');
      const method = requiredString(body.value, 'method');
      const rawTarget = requiredString(body.value, 'target');
      const reason = requiredString(body.value, 'reason');
      if (!LOWERCASE_RFC4122_COMPANION_ID_PATTERN.test(companionId)) {
        throw new Error('Escalation companion id is malformed');
      }
      // The grant is bound to the route resource (escalationScopeDigest), never
      // to a request body, so a canonical placeholder body satisfies routes
      // whose body policy is `required` without pinning any body bytes.
      const target = compileGatewayGardenRequestTarget({
        rawTarget,
        method,
        companionId: createCompanionId(companionId),
        body: Buffer.from('{}', 'utf8'),
      });
      const issued = await this.coordinator.issueGrant({
        token: input.token,
        csrfToken: input.csrfToken,
        requestOrigin: input.requestOrigin,
        binding: { target, reason },
      });
      sendJson(input.response, 200, {
        grantId: issued.grantId,
        routeId: issued.routeId,
        expiresAt: issued.expiresAt.toISOString(),
      }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      translate(error);
    }
  }
}
