import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  COMPANION_PRESENCE_COMPANION_ID_PATTERN,
  DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS,
  type CompanionPresenceRecord,
  type CompanionPresenceStorePort,
} from './companion-presence-store-port.js';
import {
  resolveSituatedPlaceRef,
  type CoPresentCompanion,
  type SituatedPlaceRef,
} from './substrate-agent/runtime-context-sections/situated-presence.js';

// ── Cross-companion presence runtime (sprint 10, W5a) ──
//
// Multi-companion only (never constructed flag-off). Owns three jobs around
// the shared `companion_presence` table:
//
//  1. WRITER — when a turn is situated at a place (satellite-place binding),
//     upsert this companion's own row. Every situated turn refreshes
//     `updated_at` (the freshness beat other agents key staleness off);
//     the store preserves `since` across same-place refreshes.
//  2. CO-PRESENCE READ — cache who else is at the current place so the
//     situated-presence context section can render "Also here: …"
//     synchronously during prompt assembly.
//  3. CO-LOCATION EVENT — a companion observed at our place that was not
//     there on the previous refresh (including everyone already present when
//     WE arrive somewhere) emits `presence.companion.co_located` exactly once
//     per arrival, never on refreshes of an already-known companion.
//  4. DELIBERATE MOVE (vinz.26, contract s10wm) — self-invoked virtual
//     navigation via the world tool writes through recordDeliberateMove with
//     full arrival semantics; it is the ONLY presence write not derived from a
//     turn's own routing, and the only one that throws on write failure.
//
// Departure model (documented decision): graceful shutdown deletes our own
// row; there is no explicit "leave" write on non-situated turns (a Discord DM
// turn does not mean the emanation left the room). Crashed agents are covered
// by the read-side staleness TTL — rows whose `updated_at` is older than the
// TTL are treated as gone.

const log = createComponentLogger('CompanionPresence');

// Re-exported for existing import sites (gateway delivery lane, tests). The
// constant now lives in the dependency-free store port so the Postgres store
// can apply the same TTL to write-side `since` continuity.
export { DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS };

/** This companion's own current presence window (join time at its place). */
export interface OwnPresenceWindow {
  place: SituatedPlaceRef;
  /** Epoch ms of the presence row's `since` — the join time, the ONE clock. */
  sinceMs: number;
}

/** Narrow view of the turn seam: what pre-turn execution calls per turn. */
export interface CompanionPresenceTurnPort {
  /**
   * Observe the turn's situated place: write our own row and refresh the
   * co-presence snapshot (emitting co-location events for new arrivals).
   * Never throws — presence is auxiliary world state and must not take down
   * the turn; failures are logged at error level (not swallowed silently).
   *
   * Dual presence (vinz.29): `situatedFallbackPlaceId` is the turn's resolved
   * situated fallback (mindspace twin of the last-known physical room, or a
   * deliberate virtual-move overlay). It is honored only when the turn itself
   * carries no place AND the fallback resolves to a VIRTUAL place — a
   * mindspace-foregrounded turn is presence (kind 'virtual') at that twin. A
   * physical fallback is never written: physical arrivals require the turn's
   * own satellite binding (a plain-chat turn must not look like walking into
   * a physical room).
   */
  observeTurnPlace(message: SubstrateMessage, situatedFallbackPlaceId?: string): Promise<void>;
  /**
   * Heartbeat-driven liveness beat: re-upsert our own row at the last known
   * situated place so an idle-but-alive emanation does not fall out of
   * siblings' co-presence via the read-side staleness TTL. A refresh is NOT an
   * arrival — it never emits co-location events and never re-reads co-presence.
   * No current place (never situated / unsituated) is a no-op. Never throws —
   * presence is auxiliary world state and must not take down the heartbeat.
   */
  refreshOwnPresence(): Promise<void>;
  /**
   * Deliberate self-invoked navigation (world tool `move`, vinz.26 / contract
   * s10wm): write our own row at `place` and run full arrival semantics
   * (co-presence refresh + `presence.companion.co_located` for everyone already
   * there). Unlike {@link observeTurnPlace}, the presence write IS the action
   * here, so a failed own-row upsert THROWS (fail closed — the move did not
   * happen and the caller must report it). A failure in the auxiliary
   * co-presence read after a successful write is logged, not thrown: the move
   * itself succeeded. The written place becomes the heartbeat-refresh target.
   */
  recordDeliberateMove(place: SituatedPlaceRef): Promise<void>;
  /** Cached co-present companions for the given place; [] when unknown. */
  getCoPresent(place: SituatedPlaceRef): ReadonlyArray<CoPresentCompanion>;
}

export interface CompanionPresenceRuntimeOptions {
  store: CompanionPresenceStorePort;
  /** This agent's own companion id — must be a lowercase RFC-4122 UUID. */
  companionId: string;
  eventBus: EventBus;
  /** Places soft-registry; without it no turn ever resolves a situated place. */
  placesRegistry?: PlacesRegistryConfig;
  /** Read-side staleness TTL override (tests). */
  staleTtlMs?: number;
  /** Clock override (tests). */
  now?: () => Date;
}

function placeKeyOf(place: SituatedPlaceRef): string {
  return `${place.siteId}\u0000${place.placeId}`;
}

export class CompanionPresenceRuntime implements CompanionPresenceTurnPort {
  private readonly store: CompanionPresenceStorePort;
  private readonly companionId: string;
  private readonly eventBus: EventBus;
  private readonly placesRegistry: PlacesRegistryConfig | undefined;
  private readonly staleTtlMs: number;
  private readonly now: () => Date;

  /** Place key of the most recent successful refresh. */
  private currentPlaceKey: string | null = null;
  /**
   * Full ref of the most recent situated place we successfully wrote our own
   * row at. Drives the heartbeat refresh (which has no turn message to resolve
   * a place from). Set only after a successful own-row upsert.
   */
  private currentPlace: SituatedPlaceRef | null = null;
  /**
   * Epoch ms of our own row's `since` as returned by the last successful
   * upsert. Null when unknown (never written, write failed, or shut down) —
   * the private-room window gate fails closed on null and serves nothing.
   */
  private ownSinceMs: number | null = null;
  /**
   * Epoch ms of our own row's `updated_at` (freshness beat) as returned by the
   * last successful upsert. Null when unknown (never written, write failed, or
   * shut down). The private-room window gate treats our row exactly as siblings
   * do — a value older than the read-side staleness TTL means a stalled
   * heartbeat / hung agent, so the window fails closed (stale reads as absent).
   */
  private ownUpdatedAtMs: number | null = null;
  /** Companion ids known co-present at `currentPlaceKey` (arrival dedupe set). */
  private knownCoPresentIds = new Set<string>();
  /** Render snapshot served synchronously to the situated context section. */
  private coPresentSnapshot: CoPresentCompanion[] = [];

  constructor(options: CompanionPresenceRuntimeOptions) {
    const companionId = options.companionId.trim();
    if (!COMPANION_PRESENCE_COMPANION_ID_PATTERN.test(companionId)) {
      // Fail closed at startup: multi-companion presence keys on UUID
      // companion ids (fleet-manifest contract); a non-UUID COMPANION_ID
      // deployment must not silently run without presence.
      throw new Error(
        'Companion presence requires COMPANION_ID to be a lowercase RFC-4122 UUID '
        + `in multi-companion mode, got ${JSON.stringify(options.companionId)}`,
      );
    }
    this.store = options.store;
    this.companionId = companionId;
    this.eventBus = options.eventBus;
    this.placesRegistry = options.placesRegistry;
    this.staleTtlMs = options.staleTtlMs ?? DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS;
    this.now = options.now ?? (() => new Date());
  }

  async observeTurnPlace(message: SubstrateMessage, situatedFallbackPlaceId?: string): Promise<void> {
    // The turn's OWN binding always wins (physical satellite turns). The
    // fallback is consulted only for placeless turns, and only a VIRTUAL
    // fallback place is accepted: a mindspace turn is a genuine presence beat
    // at the twin (kind 'virtual'), while a physical fallback (active
    // emanation with no twin configured) is deliberately dropped — a plain
    // chat turn must never register as an arrival at a physical room.
    const turnPlace = resolveSituatedPlaceRef(message, this.placesRegistry);
    const fallbackPlace = !turnPlace && situatedFallbackPlaceId
      ? resolveSituatedPlaceRef(message, this.placesRegistry, situatedFallbackPlaceId)
      : undefined;
    const place = turnPlace ?? (fallbackPlace?.kind === 'virtual' ? fallbackPlace : undefined);
    if (!place) return;
    try {
      const record = await this.store.upsertPresence({
        companionId: this.companionId,
        siteId: place.siteId,
        placeId: place.placeId,
        kind: place.kind,
      });
      // Our own row is now written here: record the place so the heartbeat
      // refresh can keep it fresh between situated turns, and its `since` so
      // the private-room window gate serves exactly our current window.
      this.currentPlace = place;
      this.ownSinceMs = Date.parse(record.since);
      this.ownUpdatedAtMs = Date.parse(record.updatedAt);
      await this.refreshCoPresence(place);
    } catch (error) {
      // Fail closed for the window gate: an unknown own-row state must not
      // serve history, so the cached window is dropped until the next
      // successful write.
      this.ownSinceMs = null;
      this.ownUpdatedAtMs = null;
      // Deliberate: presence is auxiliary world state — a shared-schema
      // failure is surfaced loudly here but never fails the turn.
      log.error('Companion presence observation failed', {
        companionId: this.companionId,
        siteId: place.siteId,
        placeId: place.placeId,
        error: toErrorMessage(error),
      });
    }
  }

  async recordDeliberateMove(place: SituatedPlaceRef): Promise<void> {
    // The write is the action: no catch here — an upsert failure propagates so
    // the world tool reports a failed move instead of half-applying it. Drop
    // the cached window first so a failed write can never serve stale history.
    this.ownSinceMs = null;
    this.ownUpdatedAtMs = null;
    const record = await this.store.upsertPresence({
      companionId: this.companionId,
      siteId: place.siteId,
      placeId: place.placeId,
      kind: place.kind,
    });
    // Our row now lives at the destination: the heartbeat keeps it fresh there
    // until the next situated turn or deliberate move supersedes it.
    this.currentPlace = place;
    this.ownSinceMs = Date.parse(record.since);
    this.ownUpdatedAtMs = Date.parse(record.updatedAt);
    try {
      // Arrival semantics: everyone already present at the destination is a
      // fresh co-location from our perspective (same rule as observeTurnPlace).
      await this.refreshCoPresence(place);
    } catch (error) {
      // The move itself succeeded (row written); the co-presence read is
      // auxiliary state — surface loudly, do not fail the move.
      log.error('Co-presence refresh after deliberate move failed', {
        companionId: this.companionId,
        siteId: place.siteId,
        placeId: place.placeId,
        error: toErrorMessage(error),
      });
    }
  }

  async refreshOwnPresence(): Promise<void> {
    const place = this.currentPlace;
    // No situated place yet (never bound / unsituated): nothing to keep alive.
    if (!place) return;
    try {
      // Cheap re-upsert of the SAME place: bumps updated_at (the freshness beat
      // siblings key staleness off) while the store preserves `since` (unless
      // the row had already gone stale — then the store re-arms it as a new
      // window). This is deliberately NOT an arrival — no refreshCoPresence,
      // so no co-location event is ever emitted for a heartbeat refresh.
      const record = await this.store.upsertPresence({
        companionId: this.companionId,
        siteId: place.siteId,
        placeId: place.placeId,
        kind: place.kind,
      });
      this.ownSinceMs = Date.parse(record.since);
      this.ownUpdatedAtMs = Date.parse(record.updatedAt);
    } catch (error) {
      // Fail closed for the window gate (see observeTurnPlace).
      this.ownSinceMs = null;
      this.ownUpdatedAtMs = null;
      // Mirror observeTurnPlace: presence is auxiliary world state — a
      // shared-schema failure is surfaced loudly here but never propagates out
      // to take down the heartbeat lane.
      log.error('Companion presence heartbeat refresh failed', {
        companionId: this.companionId,
        siteId: place.siteId,
        placeId: place.placeId,
        error: toErrorMessage(error),
      });
    }
  }

  getCoPresent(place: SituatedPlaceRef): ReadonlyArray<CoPresentCompanion> {
    if (this.currentPlaceKey !== placeKeyOf(place)) return [];
    return this.coPresentSnapshot;
  }

  /**
   * Our own current presence window: the place our row lives at and the epoch
   * ms of its `since` (join time). Null when we have no known window (never
   * situated, last write failed, or shut down) — private-room windowed
   * delivery treats null as a CLOSED window and serves nothing (fail closed).
   *
   * Freshness is part of the gate: our own row is subject to the SAME read-side
   * staleness TTL siblings apply to us. If the last successful write is older
   * than the TTL (a stalled heartbeat / hung agent), every reader already
   * treats our row as gone — so we must too, and the window reads as absent
   * (null). Without this, a stopped heartbeat would leave a private-room window
   * open indefinitely on a timestamp nobody else still trusts (bead jp36.9.1).
   */
  getOwnPresenceWindow(): OwnPresenceWindow | null {
    if (
      !this.currentPlace
      || this.ownSinceMs === null
      || !Number.isFinite(this.ownSinceMs)
      || this.ownUpdatedAtMs === null
      || !Number.isFinite(this.ownUpdatedAtMs)
    ) {
      return null;
    }
    // Stale own row = gone (mirrors the sibling read rule in refreshCoPresence:
    // fresh iff updatedAt >= now - staleTtlMs). Fail closed on staleness.
    const staleCutoffMs = this.now().getTime() - this.staleTtlMs;
    if (this.ownUpdatedAtMs < staleCutoffMs) {
      return null;
    }
    return { place: this.currentPlace, sinceMs: this.ownSinceMs };
  }

  /** Delete our own row on graceful shutdown (crash cleanup is the read TTL). */
  async shutdown(): Promise<void> {
    this.ownSinceMs = null;
    this.ownUpdatedAtMs = null;
    try {
      await this.store.deletePresence(this.companionId);
    } catch (error) {
      log.error('Failed to delete own companion presence row on shutdown', {
        companionId: this.companionId,
        error: toErrorMessage(error),
      });
    }
    await this.store.close();
  }

  private async refreshCoPresence(place: SituatedPlaceRef): Promise<void> {
    const rows = await this.store.listByPlace(place.siteId, place.placeId);
    const staleCutoffMs = this.now().getTime() - this.staleTtlMs;
    const fresh = rows.filter((row) =>
      row.companionId !== this.companionId
      && Date.parse(row.updatedAt) >= staleCutoffMs,
    );

    const placeKey = placeKeyOf(place);
    // Moving to a different place resets the dedupe set: everyone already
    // present at the NEW place is a fresh co-location from our perspective.
    const previouslyKnown = this.currentPlaceKey === placeKey
      ? this.knownCoPresentIds
      : new Set<string>();
    for (const row of fresh) {
      if (!previouslyKnown.has(row.companionId)) {
        this.emitCoLocated(row);
      }
    }

    this.currentPlaceKey = placeKey;
    this.knownCoPresentIds = new Set(fresh.map((row) => row.companionId));
    // The fleet manifest carries no display names (companions-config.ts), so
    // the render snapshot surfaces the companion id as the display name.
    this.coPresentSnapshot = fresh.map((row) => ({
      companionId: row.companionId,
      displayName: row.companionId,
    }));
  }

  private emitCoLocated(row: CompanionPresenceRecord): void {
    void this.eventBus.emit('presence.companion.co_located', {
      companionId: row.companionId,
      observerCompanionId: this.companionId,
      siteId: row.siteId,
      placeId: row.placeId,
      kind: row.kind,
      since: row.since,
      timestamp: this.now().getTime(),
    }).catch((error: unknown) => {
      log.error('Failed to emit companion co-location event', {
        companionId: row.companionId,
        observerCompanionId: this.companionId,
        error: toErrorMessage(error),
      });
    });
  }
}
