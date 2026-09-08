// ── Garden Blind Reviewer state route (psfn-framework-33xah) ──
//
//   GET /api/admin/cogsec/blind-review
//     "Is the blind reviewer actually working?" — window census, the change
//     gate the next pass would face, retry/backoff state, and the effective
//     cadence. Counts, bounds and booleans only; never evidence, never a
//     digest, never a finding (findings are already CogSec cases).
//
// Read-only, so no confirmation ceremony and no audit-timeline write. The route
// takes no query parameters at all: there is nothing here to filter, and a
// parameter-free read cannot be turned into a probe.

import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { exactPath } from '../route-matchers.js';
import type { AdminBlindReviewService } from '../services/blind-review-service.js';
import { ADMIN_DYNAMIC_JSON_HEADERS, sendInternalError } from './shared.js';
import type { AdminApiRoute } from './types.js';

const ADMIN_BLIND_REVIEW_API_PATH = '/api/admin/cogsec/blind-review';

/**
 * Absent service means this process composed no Garden reviewer projection at
 * all. That is a different answer from "enabled but unwired", which the service
 * itself reports as a `status`, so it gets the explicit 503 rather than a
 * healthy-looking empty body.
 */
const BLIND_REVIEW_UNAVAILABLE_ERROR = 'Blind reviewer projection unavailable';

export function buildAdminBlindReviewRoutes(options: {
  blindReviewService?: AdminBlindReviewService | null;
}): AdminApiRoute[] {
  const { blindReviewService } = options;
  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_BLIND_REVIEW_API_PATH),
      handle: (_req, res) => {
        if (!blindReviewService) {
          sendJson(res, 503, { error: BLIND_REVIEW_UNAVAILABLE_ERROR });
          return;
        }
        blindReviewService.getState().then(
          (state) => { sendJson(res, 200, state, ADMIN_DYNAMIC_JSON_HEADERS); },
          (error: unknown) => {
            sendInternalError(res, error, 'Failed to read the blind reviewer state');
          },
        );
      },
    },
  ];
}
