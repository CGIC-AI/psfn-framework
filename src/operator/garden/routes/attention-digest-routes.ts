import { sendJson } from '../../../channels/backplane/http/primitives.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { AdminAttentionDigestService } from '../services/attention-digest-service.js';
import { exactPath } from '../route-matchers.js';
import type { AdminApiRoute } from './types.js';

const log = createComponentLogger('AdminAttentionDigestRoutes');

const ADMIN_ATTENTION_DIGEST_API_PATH = '/api/admin/attention-digest';

/**
 * Per-companion "what's broken" digest (bead psfn-framework-vcq8v.8). The fleet
 * page fans out to this route across every companion the operator's session
 * may reach. Sections degrade individually inside the body; the route itself
 * answers 503 only when no digest service is composed, never a fabricated
 * healthy body.
 */
export function buildAdminAttentionDigestRoutes(options: {
  attentionDigest?: AdminAttentionDigestService | null;
}): AdminApiRoute[] {
  const { attentionDigest } = options;
  return [
    {
      method: 'GET',
      match: exactPath(ADMIN_ATTENTION_DIGEST_API_PATH),
      handle: (_req, res) => {
        if (!attentionDigest) {
          sendJson(res, 503, { error: 'Attention digest backend unavailable' });
          return;
        }
        void attentionDigest.getDigest()
          .then(digest => sendJson(res, 200, digest))
          .catch((error: unknown) => {
            log.error('Attention digest failed', { error: String(error) });
            sendJson(res, 503, { error: 'Attention digest backend unavailable' });
          });
      },
    },
  ];
}
