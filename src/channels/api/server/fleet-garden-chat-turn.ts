import type { IncomingHttpHeaders } from 'node:http';
import type { FleetGardenChatAdmission } from '../../../boundary/gateway/fleet-sso-router.js';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import type { FleetGardenChatRouting } from './chat-completions.js';

/** Browser headers a fleet Garden chat may carry; identity claims never pass. */
const FLEET_CHAT_BROWSER_HEADERS = new Set([
  'accept',
  'content-type',
  'x-channel-id',
  'x-channel-privacy',
  'x-session-id',
]);

export interface FleetGardenChatTurn {
  readonly headers: IncomingHttpHeaders;
  readonly principal: ApiAuthPrincipal;
  readonly routing: FleetGardenChatRouting;
}

/**
 * Map a gateway-admitted fleet Garden chat onto the ordinary chat-completion
 * turn. Only an SSO principal resolved by the fleet authorization snapshot
 * carries a real canonical contact, and it travels as the server-derived
 * `verifiedContact` routing field (psfn-framework-upwko), never as an
 * X-Canonical-Contact-ID identity claim the agent would challenge. The
 * ADMIN_TOKEN operator's contact is a synthetic capability binding that no
 * contact store holds, so its turns run as the key principal they are
 * (exactly like ADMIN_TOKEN on /v1/chat/completions).
 */
export function buildFleetGardenChatTurn(admission: Pick<
  FleetGardenChatAdmission,
  'request' | 'body' | 'companionId' | 'authorization'
>): FleetGardenChatTurn {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(admission.request.headers)) {
    if (FLEET_CHAT_BROWSER_HEADERS.has(name) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers['content-length'] = String(admission.body.byteLength);
  headers['content-type'] = 'application/json';
  headers['x-user-id'] = admission.authorization.principalId;
  headers['x-user-name'] = 'Fleet operator';
  const sso = admission.authorization.provenance.source === 'gateway_fleet_authorization_snapshot';
  return {
    headers,
    principal: { id: admission.authorization.principalId, mode: 'api_key' },
    routing: {
      companionId: admission.companionId,
      ...(sso
        ? {
            verifiedContact: {
              principalId: admission.authorization.principalId,
              contactId: admission.authorization.contact.contactId,
            },
          }
        : {}),
    },
  };
}
