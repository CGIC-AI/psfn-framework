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

/**
 * Read-side staleness TTL. A presence row not refreshed within this window is
 * treated as gone (crashed agent / stopped heartbeat). Fifteen minutes trades
 * ghost lifetime against dropping idle-but-alive companions; idle agents fall
 * out of co-presence until their next situated turn refreshes them.
 *
 * The WRITE side applies the same TTL to `since` continuity (see
 * {@link CompanionPresenceStorePort.upsertPresence}): a same-place refresh
 * only preserves `since` while the previous row is still fresh under this
 * TTL. That keeps `since` meaning exactly "start of the current uninterrupted
 * presence window" — the single clock presence-windowed private-room delivery
 * keys on (psfn-framework-s10rm). Defined here (dependency-free) so the
 * Postgres store, the agent presence runtime, and the gateway delivery lane
 * all share one value.
 */
export const DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS = 15 * 60_000;

/** One companion's durable presence row. */
export interface CompanionPresenceRecord {
  /** RFC-4122 UUID of the companion this row belongs to. */
  companionId: string;
  siteId: string;
  placeId: string;
  kind: PlaceKind;
  /**
   * ISO-8601 start of the current uninterrupted presence window at the CURRENT
   * place. Preserved across fresh same-place refreshes; reset by a place
   * change, by a same-place refresh after the previous row went stale (the
   * companion was "gone" in every reader's eyes, so returning opens a NEW
   * window), and by row delete + reinsert (graceful shutdown / restart).
   * Private-room windowed delivery uses this value directly as the join time —
   * there is no second clock (psfn-framework-s10rm).
   */
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
   * Upsert the calling companion's own presence row. A same-place refresh
   * preserves `since` and only bumps `updatedAt` — but ONLY while the previous
   * row is still fresh under the staleness TTL. A stale row (readers already
   * treat it as gone) is re-armed: the refresh becomes a new arrival and
   * `since` resets. A place change always resets `since`.
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
