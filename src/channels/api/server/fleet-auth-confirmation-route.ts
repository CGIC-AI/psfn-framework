import type { IncomingMessage, ServerResponse } from 'node:http';
import { GatewayChildAssertionDeniedError } from '../../../boundary/gateway/fleet-auth-child-assertions.js';
import {
  GatewayFleetConfirmationInvalidError,
  type GatewayFleetConfirmationResolution,
} from '../../../boundary/gateway/fleet-auth-confirmation-resolution.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { readJsonBodyWithLimit, sendJson } from '../../backplane/http/primitives.js';
import {
  MAX_EXCHANGE_BODY_BYTES,
  parseOperatorParentEffectRequest,
} from './fleet-auth-child-assertion-route.js';

const FLEET_AUTH_CONFIRMATION_RESOLVE_PATH =
  '/v1/internal/fleet-auth/confirmations/resolve';
const log = createComponentLogger('FleetAuthConfirmationRoute');

/**
 * Operator-process door for resolving gateway-owned approvals with the exact
 * admitted Fleet Garden parent capability. It accepts no bearer credential:
 * the gateway-signed parent is the only authority.
 */
export class FleetAuthConfirmationResolutionHttpRoute {
  constructor(private readonly resolution: GatewayFleetConfirmationResolution) {}

  matches(method: string | undefined, path: string): boolean {
    return method === 'POST' && path === FLEET_AUTH_CONFIRMATION_RESOLVE_PATH;
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBodyWithLimit(req, res, { maxBytes: MAX_EXCHANGE_BODY_BYTES });
    if (!body.ok) {
      if (body.errorCode !== 'payload_too_large') {
        sendJson(res, 400, { error: 'invalid_confirmation_resolution' });
      }
      return;
    }
    let input: ReturnType<typeof parseOperatorParentEffectRequest>;
    try {
      input = parseOperatorParentEffectRequest(body.value);
    } catch {
      sendJson(res, 400, { error: 'invalid_confirmation_resolution' });
      return;
    }
    try {
      sendJson(res, 200, await this.resolution.resolve(input));
    } catch (error) {
      if (error instanceof GatewayChildAssertionDeniedError) {
        sendJson(res, 403, { error: 'confirmation_resolution_denied' });
        return;
      }
      if (error instanceof GatewayFleetConfirmationInvalidError) {
        sendJson(res, 400, { error: 'invalid_confirmation_resolution' });
        return;
      }
      log.error('Fleet confirmation resolution failed', { error: toErrorMessage(error) });
      sendJson(res, 500, { error: 'confirmation_resolution_failed' });
    }
  }
}
