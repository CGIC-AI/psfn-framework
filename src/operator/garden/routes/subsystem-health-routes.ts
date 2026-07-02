import { sendJson } from '../../../channels/backplane/http/primitives.js';
import type { AdminSubsystemHealthService } from '../services/subsystem-health-service.js';
import { exactPath } from '../route-matchers.js';
import type { AdminApiRoute } from './types.js';

/**
 * Subsystem-health routes (E5.6). Exposes live background-lane health derived
 * from the event bus (since process start) and scheduler state. When no service
 * is wired the route is honest about the absence rather than fabricating a
 * healthy snapshot.
 */
export function buildAdminSubsystemHealthRoutes(options: {
  subsystemHealth?: AdminSubsystemHealthService | null;
}): AdminApiRoute[] {
  const { subsystemHealth } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/subsystem-health'),
      handle: (_req, res) => {
        if (!subsystemHealth) {
          sendJson(res, 503, { error: 'Subsystem health backend unavailable' });
          return;
        }
        sendJson(res, 200, subsystemHealth.getSnapshot());
      },
    },
  ];
}
