import type { PlaceKind } from '../../shared/contracts/places-registry.js';

// ── Cross-companion presence store port (sprint 10, W5a) ──
//
// The `companion_presence` table in the SHARED Postgres schema is the durable
// authority for "which companion is at which place" across a cluster. Each
// agent process writes ITS OWN row only; everyone reads everyone's rows.
//
// Privacy invariant (sprint-10 doc §8): NOTHING personal ever goes through
// this port — presence is companion id + place coordinates + timestamps, full
// stop. Do not add fields that carry conversational or personal state.

/**
 * Lowercase RFC-4122 UUID (versions 1-5), mirroring the companion-id format
 * enforced by the fleet manifest (`companions-config.ts`). Presence rows key
 * on a `UUID` column, so a non-UUID companion id fails closed here rather
 * than as an opaque database type error.
 */
export const COMPANION_PRESENCE_COMPANION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** One companion's durable presence row. */
export interface CompanionPresenceRecord {
  /** RFC-4122 UUID of the companion this row belongs to. */
  companionId: string;
  siteId: string;
  placeId: string;
  kind: PlaceKind;
  /** ISO-8601 arrival time at the CURRENT place (preserved across refreshes). */
  since: string;
  /**
   * ISO-8601 freshness beat. Readers treat rows whose `updatedAt` is older
   * than their staleness TTL as gone — a crashed agent never leaves a
   * permanent ghost (graceful shutdown deletes the row outright).
   */
  updatedAt: string;
}

export interface CompanionPresenceUpsertInput {
  companionId: string;
  siteId: string;
  placeId: string;
  kind: PlaceKind;
}

export interface CompanionPresenceStorePort {
  /**
   * Upsert the calling companion's own presence row. Same-place refreshes
   * preserve `since` and only bump `updatedAt`; a place change resets `since`.
   */
  upsertPresence(input: CompanionPresenceUpsertInput): Promise<CompanionPresenceRecord>;
  /** All presence rows at a place (including stale ones — TTL is read policy). */
  listByPlace(siteId: string, placeId: string): Promise<CompanionPresenceRecord[]>;
  /** Every presence row in the cluster. */
  listAll(): Promise<CompanionPresenceRecord[]>;
  /** Remove a companion's row (graceful shutdown). Returns whether a row existed. */
  deletePresence(companionId: string): Promise<boolean>;
  /** Release the underlying connection pool. */
  close(): Promise<void>;
}
