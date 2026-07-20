import {
  resolveTwinPlaceOf,
  type PlacesRegistryConfig,
} from '../../shared/contracts/places-registry.js';

/**
 * Session-scoped seam for a partner's explicit narrative location assertion.
 *
 * Extraction is intentionally outside this class: an intake/NLP layer may set
 * a known physical placeId after interpreting a statement, while the turn path
 * receives only validated owner-file identifiers. The state is keyed by the
 * logical session id so an assertion in one conversation never leaks into
 * another. A new logical session naturally starts without an override.
 */
export class SessionPresenceOverrideState {
  private readonly physicalPlaceIdBySessionId = new Map<string, string>();

  constructor(private readonly placesRegistry: PlacesRegistryConfig | undefined) {}

  /**
   * Set or clear the asserted physical place for one logical session.
   * Fails closed unless the place is physical and has a configured virtual
   * twin; accepting an unmapped assertion would make the chat turn fall back
   * to a physical-room claim.
   */
  set(logicalSessionId: string, physicalPlaceId: string | null): void {
    const sessionId = logicalSessionId.trim();
    if (!sessionId) {
      throw new Error('Session presence override requires a logical session id');
    }
    if (physicalPlaceId === null) {
      this.physicalPlaceIdBySessionId.delete(sessionId);
      return;
    }

    const normalizedPlaceId = physicalPlaceId.trim();
    const place = this.placesRegistry?.places.find(
      (candidate) => candidate.placeId === normalizedPlaceId,
    );
    if (!place) {
      throw new Error(`Session presence override references unknown placeId "${normalizedPlaceId}"`);
    }
    if (place.kind !== 'physical') {
      throw new Error(`Session presence override placeId "${normalizedPlaceId}" must name a physical place`);
    }
    if (!resolveTwinPlaceOf(this.placesRegistry, normalizedPlaceId)) {
      throw new Error(`Session presence override placeId "${normalizedPlaceId}" has no virtual twin`);
    }
    this.physicalPlaceIdBySessionId.set(sessionId, normalizedPlaceId);
  }

  resolvePhysicalPlaceId(logicalSessionId: string): string | undefined {
    const sessionId = logicalSessionId.trim();
    return sessionId ? this.physicalPlaceIdBySessionId.get(sessionId) : undefined;
  }
}
