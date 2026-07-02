// ── Garden room roster routes (E4.1) ──
// Additive, isolated route module for the operator room surface. Registered from
// buildAdminApiRoutes when a rooms service is wired. Two read-only endpoints:
//   GET /api/admin/rooms                      — known rooms + member counts + activity
//   GET /api/admin/rooms/:channelId/roster    — paginated member list for one room
// The roster is DATA only and is never routed into prompt content.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseRequestUrl } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type { AdminRoomsService } from './services/rooms-service.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function buildAdminRoomRoutes(options: {
  roomsService: AdminRoomsService;
}): AdminApiRoute[] {
  const { roomsService } = options;

  const respondWithError = (res: ServerResponse, error: unknown): void => {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  };

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/rooms'),
      handle: (req, res) => {
        const url = parseRequestUrl(req, '/api/admin/rooms');
        roomsService.listRooms(url.searchParams).then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => respondWithError(res, error),
        );
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/rooms/', 'channelId', '/roster'),
      handle: (req, res, { channelId }) => {
        const url = parseRequestUrl(req, '/api/admin/rooms');
        roomsService.getRoomRoster(channelId, url.searchParams).then(
          (data) => sendJson(res, 200, data, ADMIN_DYNAMIC_JSON_HEADERS),
          (error) => respondWithError(res, error),
        );
      },
    },
  ];
}
