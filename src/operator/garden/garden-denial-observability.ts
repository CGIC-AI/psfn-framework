import type { ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import {
  gardenRequestServiceBoundaryDenial,
  gardenRequestServiceBoundaryDenialCode,
  type GardenRequestContext,
} from './garden-request-context.js';
import {
  hasRecordedGardenDenial,
  recordGardenDenial,
  type GardenDenialLogger,
} from '../../shared/observability/garden-denial-observability.js';

export {
  clearGardenDenialsForTests,
  getGardenDenialBucketCountForTests,
  getGardenDenialsLastHour,
  recordGardenDenial,
  type GardenDenialDetails,
  type GardenDenialLogger,
  type GardenDenialReasonCode,
} from '../../shared/observability/garden-denial-observability.js';

export function observeGardenServiceDenial(
  response: ServerResponse,
  logger: GardenDenialLogger,
  context: GardenRequestContext,
): void {
  if (context.kind !== 'fleet_principal') return;
  if (typeof response.once !== 'function') return;
  response.once('finish', () => {
    if ((response.statusCode !== 400 && response.statusCode !== 403)
      || hasRecordedGardenDenial(response)) {
      return;
    }
    recordGardenDenial(logger, {
      reasonCode: 'garden_service_response_denied',
      status: response.statusCode,
      routeId: context.resource.routeId,
      action: context.action,
      principalId: context.actor.principalId,
      response,
    });
  });
}

export function denyFleetGardenServiceBoundary(
  response: ServerResponse,
  logger: GardenDenialLogger,
  context: GardenRequestContext,
): boolean {
  observeGardenServiceDenial(response, logger, context);
  const denial = gardenRequestServiceBoundaryDenial(context);
  if (!denial) return false;
  recordGardenDenial(logger, {
    reasonCode: gardenRequestServiceBoundaryDenialCode(context)
      ?? 'garden_service_response_denied',
    status: 403,
    routeId: context.resource.routeId,
    action: context.action,
    principalId: context.kind === 'fleet_principal'
      ? context.actor.principalId
      : undefined,
    response,
  });
  sendJson(response, 403, { error: denial });
  return true;
}
