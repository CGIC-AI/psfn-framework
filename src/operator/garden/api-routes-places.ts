// ── Garden places/affordances routes (S10 Workstream F1) ──
// Additive, isolated route module for the operator location surface. Registered
// from buildAdminApiRoutes when a places service is wired. Named "places" (never
// "rooms") to avoid colliding with the existing room-roster surface.
//
//   GET   /api/admin/places                                  — sites + places + affordances + bound satellites
//   GET   /api/admin/places/map                              — Mermaid world-map (flowchart TB) of the above
//   PATCH /api/admin/places/satellites/:satelliteId/binding  — static re-bind of a satellite's placeId
//
// The read is DATA only (Cache-Control: no-store) and is never routed into
// prompt content. The re-bind is the ONLY path that changes a static placeId;
// it fails closed on an unknown satellite or an unknown target place.

import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from './request-body.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  exactPath,
  paramWithSuffix,
} from './route-matchers.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './routes/shared.js';
import type { AdminApiRoute, AdminBodyReader } from './routes/types.js';
import type { AdminPlacesService } from './services/places-service.js';

export function buildAdminPlacesRoutes(options: {
  placesService: AdminPlacesService;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { placesService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/places'),
      handle: (_req, res) => {
        placesService.listPlaces().then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list places') }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/places/map'),
      handle: (_req, res) => {
        placesService.renderMermaidMap().then(
          (mermaid) => sendJson(res, 200, { mermaid }, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to render places map') }),
        );
      },
    },
    {
      method: 'PATCH',
      match: paramWithSuffix('/api/admin/places/satellites/', 'satelliteId', '/binding'),
      handle: (req, res, { satelliteId }) => {
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) {
            sendJson(res, 400, { error: parsed.error });
            return;
          }
          if (!isRecord(parsed.value)) {
            sendJson(res, 400, { error: 'Re-bind payload must be a JSON object' });
            return;
          }
          const rawPlaceId = parsed.value.placeId;
          if (rawPlaceId !== null && typeof rawPlaceId !== 'string') {
            sendJson(res, 400, { error: 'placeId must be a string (target place) or null (unbind)' });
            return;
          }
          placesService.rebindSatellite({ satelliteId, placeId: rawPlaceId }).then(
            (result) => sendJson(res, 200, result, ADMIN_DYNAMIC_JSON_HEADERS),
            (error) => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to re-bind satellite') }),
          );
        });
      },
    },
  ];
}
