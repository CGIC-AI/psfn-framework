import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FLEET_AUTH_BINDING_COMPLETE_PATH,
  FLEET_AUTH_LIFECYCLE_ASSURANCE_START_PATH,
  FLEET_AUTH_PROVIDER_COMPLETE_PATH,
  FLEET_AUTH_ROLE_COMPLETE_PATH,
  FleetAuthLifecycleCeremonyError,
  parseFleetAuthLifecycleCeremonyRequest,
  type GatewayFleetAuthLifecycleCeremonyService,
} from '../../../boundary/fleet-auth/lifecycle-ceremony.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';

const PATHS = new Set([
  FLEET_AUTH_LIFECYCLE_ASSURANCE_START_PATH,
  FLEET_AUTH_BINDING_COMPLETE_PATH,
  FLEET_AUTH_PROVIDER_COMPLETE_PATH,
  FLEET_AUTH_ROLE_COMPLETE_PATH,
]);

function translate(error: unknown): never {
  if (error instanceof FleetAuthBrokerError) throw error;
  if (error instanceof FleetAuthLifecycleCeremonyError) {
    throw new FleetAuthBrokerError(
      error.code,
      error.code === 'origin_mismatch' ? 403
        : error.code === 'session_unavailable' ? 401
          : error.code === 'denial_audit_failed' ? 503
          : error.code === 'invalid_request' ? 400 : 409,
      error.message,
    );
  }
  throw new FleetAuthBrokerError(
    'invalid_lifecycle_ceremony_request',
    400,
    'Lifecycle ceremony request is malformed',
  );
}

export class FleetAuthLifecycleCeremonyHttpRoutes {
  constructor(private readonly ceremonies: Pick<GatewayFleetAuthLifecycleCeremonyService,
    'startStrongAssurance' | 'complete'>) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && PATHS.has(path);
  }

  async handle(input: {
    request: IncomingMessage;
    response: ServerResponse;
    path: string;
    token: string;
    csrfToken: string;
    requestOrigin: string;
  }): Promise<void> {
    const body = await readJsonBodyWithLimit(input.request, input.response, { maxBytes: 16_384 });
    if (!body.ok) return;
    try {
      if (!isRecord(body.value)) throw new Error('Lifecycle body must be an object');
      if (input.path === FLEET_AUTH_LIFECYCLE_ASSURANCE_START_PATH) {
        assertNoUnknownKeys(body.value, ['request'], 'lifecycleAssuranceStart');
        const started = await this.ceremonies.startStrongAssurance({
          token: input.token,
          csrfToken: input.csrfToken,
          requestOrigin: input.requestOrigin,
          request: body.value.request,
        });
        sendJson(input.response, 200, started, { 'Cache-Control': 'no-store' });
        return;
      }
      assertNoUnknownKeys(body.value, ['request', 'jitGrantId'], 'lifecycleComplete');
      const request = parseFleetAuthLifecycleCeremonyRequest(body.value.request);
      const expectedPath = request.action === 'binding.activate'
        ? FLEET_AUTH_BINDING_COMPLETE_PATH
        : request.action.startsWith('role.')
          ? FLEET_AUTH_ROLE_COMPLETE_PATH
          : FLEET_AUTH_PROVIDER_COMPLETE_PATH;
      if (input.path !== expectedPath) {
        throw new Error('Lifecycle action does not match its exact completion route');
      }
      const completed = await this.ceremonies.complete({
        token: input.token,
        requestOrigin: input.requestOrigin,
        jitGrantId: typeof body.value.jitGrantId === 'string' ? body.value.jitGrantId : '',
        request,
      });
      sendJson(input.response, 200, {
        decisionId: completed.decisionId,
        action: completed.action,
        authorityGeneration: completed.authorityGeneration,
        globalAuthEpoch: completed.globalAuthEpoch,
        reauthenticationRequired: request.action !== 'binding.activate',
      }, { 'Cache-Control': 'no-store' });
    } catch (error) {
      translate(error);
    }
  }
}
