import { sendJson } from '../../../channels/backplane/http/primitives.js';
import type { AdminPartnerAffectShadowService } from '../services/partner-affect-shadow-service.js';
import { exactPath } from '../route-matchers.js';
import { parseRequestUrl } from '../request-url.js';
import { ADMIN_DYNAMIC_JSON_HEADERS } from './shared.js';
import type { AdminApiRoute } from './types.js';

const SHADOW_PATH = '/api/admin/partner-affect/shadow';
const OBSERVATIONS_PATH = '/api/admin/partner-affect/observations';

/**
 * Read-only Partner Affect shadow inspection routes (docs/partner-affect.md
 * slice 1, psfn-framework-qeid). Surfaces the deterministic shadow estimate
 * (per-family freshness, coverage, missingness, conflicts) and recent
 * accepted/suppressed observation records for evaluation. When no service is
 * wired the routes are honest about the absence rather than fabricating an
 * empty-but-healthy shadow state.
 */
export function buildAdminPartnerAffectShadowRoutes(options: {
  partnerAffectShadow?: AdminPartnerAffectShadowService | null;
}): AdminApiRoute[] {
  const { partnerAffectShadow } = options;

  return [
    {
      method: 'GET',
      match: exactPath(SHADOW_PATH),
      handle: (_req, res) => {
        if (!partnerAffectShadow) {
          sendJson(res, 503, { error: 'Partner affect shadow backend unavailable' });
          return;
        }
        partnerAffectShadow.getShadowSnapshot().then(
          snapshot => sendJson(res, 200, snapshot, ADMIN_DYNAMIC_JSON_HEADERS),
          () => sendJson(res, 500, { error: 'Failed to load partner affect shadow snapshot' }),
        );
      },
    },
    {
      method: 'GET',
      match: exactPath(OBSERVATIONS_PATH),
      handle: (req, res) => {
        if (!partnerAffectShadow) {
          sendJson(res, 503, { error: 'Partner affect shadow backend unavailable' });
          return;
        }
        const url = parseRequestUrl(req, OBSERVATIONS_PATH);
        const rawLimit = url.searchParams.get('limit');
        let limit: number | undefined;
        if (rawLimit !== null) {
          const parsed = Number(rawLimit);
          if (!Number.isSafeInteger(parsed) || parsed < 1) {
            sendJson(res, 400, { error: 'limit must be a positive integer' });
            return;
          }
          limit = parsed;
        }
        partnerAffectShadow.listObservations(limit).then(
          page => sendJson(res, 200, page, ADMIN_DYNAMIC_JSON_HEADERS),
          error => sendJson(res, error instanceof Error && error.message.includes('limit') ? 400 : 500, {
            error: error instanceof Error
              ? error.message
              : 'Failed to load partner affect shadow observations',
          }),
        );
      },
    },
  ];
}
