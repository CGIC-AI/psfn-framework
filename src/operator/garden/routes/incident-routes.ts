import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { AdminIncidentTimelineService } from '../services/incident-timeline-service.js';
import { exactPath } from '../route-matchers.js';
import type { AdminApiRoute } from './types.js';

const log = createComponentLogger('AdminIncidentRoutes');

/**
 * Correlated runtime incidents (bead psfn-framework-7qeo1.24.6), reconstructed
 * from the persisted health stream under the same incident id the operator
 * alert carried.
 *
 * Deliberately its own route rather than a field on the subsystem-health
 * snapshot: that snapshot is an in-memory projection that always answers, while
 * this one reads Postgres. Folding them together would let a health-stream
 * fault take down the whole subsystem-health page, and the honest alternative —
 * returning a healthy-looking snapshot with the incidents silently missing — is
 * exactly the fabricated state the Garden charter forbids.
 */
export function buildAdminIncidentRoutes(options: {
  incidents?: AdminIncidentTimelineService | null;
}): AdminApiRoute[] {
  const { incidents } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/incidents'),
      handle: (_req, res) => {
        if (!incidents) {
          sendJson(res, 503, { error: 'Incident timeline backend unavailable' });
          return;
        }
        void incidents.getSnapshot()
          .then(snapshot => sendJson(res, 200, snapshot))
          .catch((error: unknown) => {
            log.error('Incident timeline snapshot failed', { error: String(error) });
            sendJson(res, 503, { error: 'Incident timeline backend unavailable' });
          });
      },
    },
  ];
}
