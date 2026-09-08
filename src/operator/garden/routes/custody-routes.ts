// ── Garden custody chain routes (psfn-framework-ccgdz.7) ──
//
//   GET /api/admin/custody/chain    ?turnId= | ?deliveryRef=
//     "Which admitted message/context caused this egress?" — one generation's
//     custody snapshot, its prompt source manifest, and every delivery record
//     written against it.
//
//   GET /api/admin/custody/sources  ?sourceRef= | ?sourceDigest= [&limit&cursor]
//     "Where did this source's bytes end up?" — the generations that admitted
//     one source, newest first, with what left on each.
//
// Read-only, so no confirmation ceremony and no audit-timeline write: these
// routes change nothing and expose no content. A rejected input is a 400 that
// names the FIELD and its required shape, never the value that was rejected —
// echoing a rejected query string back would put the one thing the seam
// refuses to store into the response.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { parseRequestUrl } from '../request-url.js';
import { exactPath } from '../route-matchers.js';
import {
  CustodyQueryInputError,
  type AdminCustodyQueryService,
} from '../services/custody-query-service.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError } from './shared.js';
import type { AdminApiRoute } from './types.js';

const ADMIN_CUSTODY_CHAIN_API_PATH = '/api/admin/custody/chain';
const ADMIN_CUSTODY_SOURCES_API_PATH = '/api/admin/custody/sources';

const CUSTODY_UNAVAILABLE_ERROR = 'Custody chain backend unavailable';

function settle(
  res: Parameters<AdminApiRoute['handle']>[1],
  payload: Promise<unknown>,
  failureMessage: string,
): void {
  payload.then(
    (value) => { sendJson(res, 200, value, ADMIN_DYNAMIC_JSON_HEADERS); },
    (error: unknown) => {
      // A rejected QUERY is the operator's mistake (400). Anything else is
      // ours, and goes through the sanitizing 500 path so a database message
      // never reaches the page.
      if (error instanceof CustodyQueryInputError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      sendInternalError(res, error, failureMessage);
    },
  );
}

export function buildAdminCustodyRoutes(options: {
  custodyQueryService?: AdminCustodyQueryService | null;
}): AdminApiRoute[] {
  const { custodyQueryService } = options;
  const withService = (
    res: Parameters<AdminApiRoute['handle']>[1],
    run: (service: AdminCustodyQueryService) => void,
  ): void => {
    if (!custodyQueryService) {
      sendJson(res, 503, { error: CUSTODY_UNAVAILABLE_ERROR });
      return;
    }
    run(custodyQueryService);
  };

  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_CUSTODY_CHAIN_API_PATH),
      handle: (req, res, _params, context) => {
        withService(res, (service) => {
          const url = parseRequestUrl(req, ADMIN_CUSTODY_CHAIN_API_PATH);
          settle(
            res,
            service.queryEgressChain(url.searchParams, context),
            'Failed to resolve the custody chain',
          );
        });
      },
    },
    {
      method: 'GET',
      match: exactPath(ADMIN_CUSTODY_SOURCES_API_PATH),
      handle: (req, res, _params, context) => {
        withService(res, (service) => {
          const url = parseRequestUrl(req, ADMIN_CUSTODY_SOURCES_API_PATH);
          settle(
            res,
            service.querySourceEgresses(url.searchParams, context),
            'Failed to resolve the source egress history',
          );
        });
      },
    },
  ];
}
