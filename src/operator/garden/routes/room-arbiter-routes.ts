import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath } from '../route-matchers.js';
import type { AdminRoomArbiterService } from '../services/types.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './shared.js';
import type { AdminApiRoute } from './types.js';

const ROOM_ARBITER_PATH = '/api/admin/room-arbiter';

/**
 * Fleet Command room-state and arbitration telemetry (jp36.8.1). Read-only,
 * content-free projection over the gateway-owned speaking-arbiter shared schema:
 * room episodes (pressure, breaker/suppression state), reservations, egress
 * leases, and per-companion participation. Never returns room or message text.
 */
export function buildAdminRoomArbiterRoutes(options: {
  service: AdminRoomArbiterService;
}): AdminApiRoute[] {
  const { service } = options;
  return [
    {
      method: 'GET',
      match: exactPath(ROOM_ARBITER_PATH),
      handle: (_req, res) => {
        service.getData().then(
          data => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, {
            error: toSanitizedMessage(error, 'Failed to load room arbiter telemetry'),
          }),
        );
      },
    },
  ];
}
