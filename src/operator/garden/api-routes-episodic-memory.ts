import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseRequestUrl } from './request-url.js';
import {
  exactPath,
  paramWithSuffix,
  prefixedParamPath,
  type RouteMatcher,
  type RouteParams,
} from './route-matchers.js';
import type { AdminEpisodicMemoryService } from './services/types.js';

interface AdminApiRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  match: RouteMatcher;
  handle: (req: IncomingMessage, res: ServerResponse, params: RouteParams) => void;
}

const EPISODIC_MEMORY_UNAVAILABLE_ERROR = 'Episodic memory backend unavailable';

function toSanitizedMessage(value: unknown, fallback: string): string {
  const normalized = value instanceof Error
    ? value.message.trim()
    : String(value ?? '').trim();
  return normalized || fallback;
}

function withEpisodicService(
  service: AdminEpisodicMemoryService | null | undefined,
  res: ServerResponse,
  callback: (service: AdminEpisodicMemoryService) => void,
): void {
  if (!service) {
    sendJson(res, 503, { error: EPISODIC_MEMORY_UNAVAILABLE_ERROR });
    return;
  }
  callback(service);
}

export function buildAdminEpisodicMemoryRoutes(options: {
  episodicMemoryService?: AdminEpisodicMemoryService | null;
}): AdminApiRoute[] {
  const { episodicMemoryService } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/episodic-memory/episodes'),
      handle: (req, res) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          const url = parseRequestUrl(req, '/api/admin/episodic-memory/episodes');
          service.listEpisodes(url.searchParams).then(
            payload => sendJson(res, 200, payload),
            error => sendJson(res, 400, {
              error: toSanitizedMessage(error, 'Failed to list episodic episodes'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath('/api/admin/episodic-memory/threads'),
      handle: (req, res) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          const url = parseRequestUrl(req, '/api/admin/episodic-memory/threads');
          service.listThreads(url.searchParams).then(
            payload => sendJson(res, 200, payload),
            error => sendJson(res, 400, {
              error: toSanitizedMessage(error, 'Failed to list episodic threads'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/episodic-memory/episodes/', 'id', '/arcs'),
      handle: (req, res, { id }) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          const url = parseRequestUrl(req, `/api/admin/episodic-memory/episodes/${encodeURIComponent(id)}/arcs`);
          service.listEpisodeArcs(id, url.searchParams).then(
            (payload) => {
              if (!payload) {
                sendJson(res, 404, { error: 'Episodic episode not found' });
                return;
              }
              sendJson(res, 200, payload);
            },
            error => sendJson(res, 400, {
              error: toSanitizedMessage(error, 'Failed to list episodic episode arcs'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: paramWithSuffix('/api/admin/episodic-memory/episodes/', 'id', '/provenance'),
      handle: (_req, res, { id }) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          service.getEpisodeProvenance(id).then(
            (payload) => {
              if (!payload) {
                sendJson(res, 404, { error: 'Episodic episode not found' });
                return;
              }
              sendJson(res, 200, payload);
            },
            error => sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load episodic episode provenance'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/episodic-memory/episodes/', 'id'),
      handle: (_req, res, { id }) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          service.getEpisodeDetail(id).then(
            (detail) => {
              if (!detail) {
                sendJson(res, 404, { error: 'Episodic episode not found' });
                return;
              }
              sendJson(res, 200, detail);
            },
            error => sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load episodic episode detail'),
            }),
          );
        });
      },
    },
    {
      method: 'GET',
      match: prefixedParamPath('/api/admin/episodic-memory/threads/', 'threadId'),
      handle: (_req, res, { threadId }) => {
        withEpisodicService(episodicMemoryService, res, (service) => {
          service.getThreadDetail(threadId).then(
            (detail) => {
              if (!detail) {
                sendJson(res, 404, { error: 'Episodic thread not found' });
                return;
              }
              sendJson(res, 200, detail);
            },
            error => sendJson(res, 500, {
              error: toSanitizedMessage(error, 'Failed to load episodic thread detail'),
            }),
          );
        });
      },
    },
  ];
}
