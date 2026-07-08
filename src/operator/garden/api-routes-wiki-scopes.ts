// ── Garden wiki scope-delineation routes (S10 vinz.28) ──
// Additive, isolated wiki routes that expose the scope dimension (personal vs
// shared_world:<siteId>) and the operator-owned publication/import operations.
// Registered BEFORE the `/api/admin/wiki/:id` param route so the fixed paths
// (`/scopes`, `/shared-world/...`) are not swallowed by the id matcher.
//
//   GET  /api/admin/wiki/scopes                              — enumerate scopes + counts
//   GET  /api/admin/wiki/shared-world/:siteId                — list a site's shared docs (?id= reads one)
//   POST /api/admin/wiki/shared-world/:siteId/publish        — run places→wiki publication
//   POST /api/admin/wiki/shared-world/:siteId/import         — bulk import (personal-fact guarded)
//
// admin-ui/ owns the UI (bead .30). These are operator-token gated like every
// /api/admin/* route. NO companion ever reaches a shared-world write here.

import { sendJson } from '../../channels/backplane/http/primitives.js';
import { parseAdminJsonBody } from './request-body.js';
import { isRecord } from '../../shared/utils/types.js';
import { exactPath, paramWithSuffix, prefixedParamPath } from './route-matchers.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, toSanitizedMessage } from './routes/shared.js';
import { parseRequestUrl } from './request-url.js';
import type { AdminApiRoute, AdminBodyReader } from './routes/types.js';
import type { AdminWikiService } from './services/types.js';

const WIKI_UNAVAILABLE_ERROR = 'Wiki backend unavailable';
const SHARED_WORLD_PREFIX = '/api/admin/wiki/shared-world/';

export function buildAdminWikiScopeRoutes(options: {
  wikiService?: AdminWikiService | null;
  withBody: AdminBodyReader;
}): AdminApiRoute[] {
  const { wikiService, withBody } = options;

  return [
    {
      method: 'GET',
      match: exactPath('/api/admin/wiki/scopes'),
      handle: (_req, res) => {
        if (!wikiService) { sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR }); return; }
        wikiService.listWikiScopes().then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list wiki scopes') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(SHARED_WORLD_PREFIX, 'siteId', '/publish'),
      handle: (_req, res, { siteId }) => {
        if (!wikiService) { sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR }); return; }
        wikiService.publishSharedWorldSite(siteId).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to publish shared-world wiki') }),
        );
      },
    },
    {
      method: 'POST',
      match: paramWithSuffix(SHARED_WORLD_PREFIX, 'siteId', '/import'),
      handle: (req, res, { siteId }) => {
        if (!wikiService) { sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR }); return; }
        withBody(req, res, (body) => {
          const parsed = parseAdminJsonBody(body);
          if (!parsed.ok) { sendJson(res, 400, { error: parsed.error }); return; }
          if (!isRecord(parsed.value)) {
            sendJson(res, 400, { error: 'Import payload must be a JSON object' });
            return;
          }
          const directory = parsed.value.directory;
          if (typeof directory !== 'string' || !directory.trim()) {
            sendJson(res, 400, { error: 'directory (string) is required' });
            return;
          }
          const dryRun = parsed.value.dryRun === true;
          wikiService.importSharedWorldDirectory(siteId, { directory: directory.trim(), dryRun }).then(
            payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
            error => sendJson(res, 400, { error: toSanitizedMessage(error, 'Failed to import shared-world wiki') }),
          );
        });
      },
    },
    {
      method: 'GET',
      // Bare siteId only — exclude any deeper path (/publish, /import) so those
      // POST routes above own them and a slash never leaks into the siteId.
      match: prefixedParamPath(SHARED_WORLD_PREFIX, 'siteId', {
        exclude: path => path.slice(SHARED_WORLD_PREFIX.length).includes('/'),
      }),
      handle: (req, res, { siteId }) => {
        if (!wikiService) { sendJson(res, 503, { error: WIKI_UNAVAILABLE_ERROR }); return; }
        const url = parseRequestUrl(req, `${SHARED_WORLD_PREFIX}${siteId}`);
        const docId = url.searchParams.get('id')?.trim();
        if (docId) {
          wikiService.getSharedWorldWikiDocument(siteId, docId).then(
            (document) => {
              if (!document) { sendJson(res, 404, { error: 'Wiki document not found' }); return; }
              sendJson(res, 200, document, ADMIN_DYNAMIC_JSON_HEADERS);
            },
            error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to load shared-world wiki document') }),
          );
          return;
        }
        wikiService.listSharedWorldWikiDocuments(siteId).then(
          payload => sendJson(res, 200, payload, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, 500, { error: toSanitizedMessage(error, 'Failed to list shared-world wiki documents') }),
        );
      },
    },
  ];
}
