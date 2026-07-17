import { createCompanionId } from '../../shared/routing/companion-id.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

/**
 * Canonical builder for the one Companion UI WebSocket path a browser may open
 * for a companion. The active companion is expressed ONLY by which of these
 * URLs the client opens — never by a header, body, or cookie. Mirrors the
 * server-side matcher in `companion-ui-websocket.ts`
 * (`/companion-ui/companions/<uuid>/ws`).
 */
export function compileCompanionUiWebSocketPath(companionId: unknown): string {
  if (!isRfc4122Uuid(companionId)) {
    throw new Error('Companion UI WebSocket path requires an RFC-4122 companion ID');
  }
  const canonicalCompanionId = createCompanionId(companionId, 'Companion UI WebSocket companionId');
  return `/companion-ui/companions/${canonicalCompanionId}/ws`;
}
