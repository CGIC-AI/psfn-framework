import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../../channels/backplane/http/primitives.js';
import type { ModelUsageQuery } from '../../../shared/telemetry/model-usage.js';
import { parseRequestUrl } from '../request-url.js';
import type { FleetGardenModelUsageAuthority } from '../fleet-transport-client.js';
import type { FleetModelUsageData } from '../services/fleet-model-usage-service.js';
import { parseModelUsageQuery } from './model-usage-query.js';
import { ADMIN_DYNAMIC_JSON_HEADERS } from './shared.js';

const FLEET_MODEL_USAGE_PATH = '/api/admin/fleet-model-usage';
const FLEET_QUERY_FIELDS = new Set([
  'range',
  'timezone',
  'sinceMs',
  'untilMs',
  'bucket',
]);
const FLEET_QUERY_ERROR =
  'Fleet model usage supports only range, timezone, sinceMs, untilMs, and bucket query parameters.';

export interface FleetModelUsageRouteService {
  getFleetModelUsage(
    query: ModelUsageQuery,
    authority?: FleetGardenModelUsageAuthority,
  ): Promise<FleetModelUsageData>;
}

export function handleFleetModelUsageRoute(
  req: IncomingMessage,
  res: ServerResponse,
  service: FleetModelUsageRouteService,
  authority?: FleetGardenModelUsageAuthority,
): void {
  const url = parseRequestUrl(req, FLEET_MODEL_USAGE_PATH);
  if ([...url.searchParams.keys()].some(field => !FLEET_QUERY_FIELDS.has(field))) {
    sendJson(res, 400, { error: FLEET_QUERY_ERROR });
    return;
  }
  const query = parseModelUsageQuery(url.searchParams);
  if (!query.ok) {
    sendJson(res, 400, { error: query.error });
    return;
  }
  const pending = authority
    ? service.getFleetModelUsage(query.value, authority)
    : service.getFleetModelUsage(query.value);
  pending.then(
    payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
    () => sendJson(res, 500, { error: 'Failed to load fleet model usage telemetry' }),
  );
}
