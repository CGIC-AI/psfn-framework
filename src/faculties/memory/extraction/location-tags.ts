// ── Memory location tagging (S10, psfn-framework-vinz.16) ──
// Tags-based location provenance for memories formed on a placed satellite turn.
// A memory formed while a turn carried a resolved `placeId` (see
// `SatelliteRoutingMetadata.placeId`) gains a `location:<placeId>` entry in its
// EXISTING generic `tags` array — no schema column, no migration, and additive
// to whatever tags the fact already carries. Absent a placeId, nothing is added
// (fail-closed: no fabricated location).

/** Prefix for the tags-based location marker. */
export const LOCATION_TAG_PREFIX = 'location:';

/**
 * Build the location tag for a resolved place, or `undefined` when no place is
 * bound. Fail-closed: a missing/blank placeId yields no tag so a placeless turn
 * never fabricates a location.
 */
export function buildLocationTag(placeId: string | undefined | null): string | undefined {
  const normalized = placeId?.trim();
  if (!normalized) return undefined;
  return `${LOCATION_TAG_PREFIX}${normalized}`;
}

/**
 * Return `tags` with the location marker appended when a place is bound. The
 * result is always a fresh array; the input is never mutated. When no place is
 * bound the tags are returned unchanged (copied). Deduplication/normalization is
 * left to the memory writer's `normalizeMemoryTags`, so the marker is purely
 * additive here.
 */
export function applyLocationTag(
  tags: readonly string[],
  placeId: string | undefined | null,
): string[] {
  const tag = buildLocationTag(placeId);
  return tag ? [...tags, tag] : [...tags];
}
