import type { MessageRoutingMetadata } from '../../shared/contracts/runtime.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';

/**
 * Resolve the one authoritative ICP root carried by a live or generated turn.
 * Both fields are inspected so durable lineage can never be shadowed by a
 * conflicting live correlation or silently relabelled as independent.
 */
export function resolveIcpOriginRootInitiationId(
  routing: MessageRoutingMetadata | undefined,
): string | undefined {
  const liveRoot: unknown = routing?.icpCorrelation?.rootInitiationId;
  const durableRoot: unknown = routing?.originIcpRootInitiationId;

  if (liveRoot !== undefined && (typeof liveRoot !== 'string' || !isRfc4122Uuid(liveRoot))) {
    throw new Error('Message routing has malformed ICP root lineage (live)');
  }
  if (durableRoot !== undefined
    && (typeof durableRoot !== 'string' || !isRfc4122Uuid(durableRoot))) {
    throw new Error('Message routing has malformed ICP root lineage (durable)');
  }
  if (liveRoot !== undefined && durableRoot !== undefined && liveRoot !== durableRoot) {
    throw new Error('Message routing has conflicting ICP root lineage');
  }
  return liveRoot ?? durableRoot;
}
