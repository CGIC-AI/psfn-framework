import type { SubstrateMessage } from '../../../shared/contracts/runtime.js';

/**
 * Resolve the gateway-authoritative place carried by a turn.
 *
 * Companion room routing is already the logical place boundary, so it takes
 * precedence over a satellite binding when both are present. Empty or absent
 * place ids never fabricate location state.
 */
export function resolveMessagePlaceId(message: Pick<SubstrateMessage, 'routing'>): string | undefined {
  const roomPlaceId = message.routing?.room?.placeId.trim();
  if (roomPlaceId) return roomPlaceId;
  const satellitePlaceId = message.routing?.satellite?.placeId?.trim();
  return satellitePlaceId || undefined;
}
