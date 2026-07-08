// ── Presence-driven emanation follow (Sprint 10, Workstream G1 — bead vinz.20) ──
//
// "Conversation follows you": when the hub resolves a PHYSICAL presence claim
// (bead .13, fail-closed identity resolution) for an owner-enrolled
// PRIMARY/TRUSTED human contact at a satellite-bound place DIFFERENT from the
// companion's current emanation, the emanation auto-follows to that satellite —
// no tool call (satellites are static; per SPRINT_10_LOCATIONS.md the AUTO
// path is emanation handoff driven by the sensor bridge, not by `world move`).
//
// This module is a decorator over the .13→.14 resolved-presence seam: it runs
// the follow decision, then ALWAYS delegates to the inner sink so the
// `[Presence]` context note (bead .14) still delivers regardless of whether a
// move happened. It never throws outward — a failed follow is logged at error
// level and surfaced on the perception telemetry lane, never silently dropped
// and never allowed to suppress note delivery.
//
// Fail-closed no-op cases (each logged at debug, never a move):
//   - anonymous / unenrolled / low-confidence presences (.13 already resolved
//     these explicitly — the companion NEVER follows an unrecognized person);
//   - contacts below primary/trusted, and machine-intelligence contacts (only
//     the human partner pulls the emanation around the house);
//   - events older than the freshness bound (a replayed/backlogged claim must
//     not teleport her to where someone WAS);
//   - places the registry cannot resolve, or that are not physical (the
//     bridge already fails closed on unbound satellites/unknown places —
//     re-checked here defensively);
//   - the place she is already emanating at.
//
// Debounce (documented bound): at most one auto-move per
// DEFAULT_PRESENCE_FOLLOW_DEBOUNCE_MS (30s), so a flapping sensor pair
// (doorway straddling, person pacing between rooms) cannot thrash handoffs.
// A suppressed-by-debounce move IS logged at info level for operator
// visibility (auditability: you can always see why she did or did not move).
//
// Shared-presence write flows through the SAME CompanionPresenceTurnPort path
// a deliberate move uses (`recordDeliberateMove`, contract s10wm): row upsert
// + full arrival semantics (co-presence refresh, co-location events). Ordering
// mirrors the world tool: the shared write happens FIRST and a failure aborts
// the move BEFORE any local state changes, so local and shared views never
// diverge. Flag-off (single-companion, port null) the follow is local-only by
// design — conversation-follows-you predates multi-companion.

import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isHighTierTrustLevel } from '../../../system/trust/types.js';
import type { CompanionPresenceTurnPort } from '../companion-presence-runtime.js';
import type { ResolvedPresence, ResolvedPresenceSink } from './identity-claim-resolver.js';

const log = createComponentLogger('PresenceFollow');

/**
 * Freshness bound: a resolved presence event whose `occurredAt` is older than
 * this is treated as stale and never triggers a follow. Sixty seconds covers
 * hub→gateway→bus latency generously while rejecting replayed or backlogged
 * claims (she must never follow to where someone WAS a while ago).
 */
export const DEFAULT_PRESENCE_FOLLOW_FRESHNESS_MS = 60_000;

/**
 * Debounce bound: minimum interval between APPLIED auto-follow moves. Thirty
 * seconds means a sensor pair flapping across a doorway produces at most one
 * handoff per window instead of thrashing the emanation back and forth.
 */
export const DEFAULT_PRESENCE_FOLLOW_DEBOUNCE_MS = 30_000;

/**
 * Local (agent-side) emanation handoff seam. `SubstrateAgent` implements this:
 * the current-place read is the situated-emanation tracker's physical
 * emanation, and applying the handoff drives the SAME tracker transition a
 * place-bearing satellite turn performs plus the durable situated-location
 * confirmation (so the vinz.29 mindspace twin follows too).
 */
export interface EmanationFollowTarget {
  /** The current physical emanation's placeId; undefined when never situated. */
  resolveCurrentEmanationPlaceId(): string | undefined;
  /** Apply the local handoff: tracker transition + durable location confirm. */
  applyEmanationFollowHandoff(input: {
    placeId: string;
    siteId: string;
    /** Registry display name of the destination place. */
    placeDisplayName: string;
  }): void;
}

export interface PresenceFollowSinkOptions {
  /** Downstream note delivery (bead .14). ALWAYS invoked, move or not. */
  inner: ResolvedPresenceSink;
  /** Local handoff seam (SubstrateAgent). */
  target: EmanationFollowTarget;
  /**
   * Cross-companion presence port, read lazily because the agent entrypoint
   * wires it AFTER core-runtime composition. Null = flag-off (single
   * companion): the follow is local-only, no shared write.
   */
  getCompanionPresence: () => CompanionPresenceTurnPort | null;
  /** Places soft-registry; without it no destination resolves (no moves). */
  placesRegistry?: PlacesRegistryConfig;
  eventBus: EventBus;
  freshnessMs?: number;
  debounceMs?: number;
  now?: () => number;
  logger?: Pick<typeof log, 'debug' | 'info' | 'warn' | 'error'>;
}

/**
 * Build the resolved-presence sink decorator that implements physical
 * conversation-follows-you (vinz.20). See module header for the decision
 * table; the returned sink never throws and never suppresses note delivery.
 */
export function createPresenceFollowSink(options: PresenceFollowSinkOptions): ResolvedPresenceSink {
  const logger = options.logger ?? log;
  const freshnessMs = options.freshnessMs ?? DEFAULT_PRESENCE_FOLLOW_FRESHNESS_MS;
  const debounceMs = options.debounceMs ?? DEFAULT_PRESENCE_FOLLOW_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  let lastMoveAtMs: number | null = null;

  async function maybeFollow(presence: ResolvedPresence): Promise<void> {
    // Trust gate first: only a KNOWN, owner-enrolled contact can pull the
    // emanation, and only at primary/trusted tier. Anonymous presences
    // (unenrolled / low-confidence / dangling binding) are explicit no-ops.
    if (presence.kind !== 'known') {
      logger.debug('Presence follow skipped: anonymous presence', {
        reason: presence.reason,
        placeId: presence.event.placeId,
      });
      return;
    }
    if (!isHighTierTrustLevel(presence.trustLevel)) {
      logger.debug('Presence follow skipped: contact below primary/trusted', {
        contactId: presence.contactId,
        trustLevel: presence.trustLevel,
        placeId: presence.event.placeId,
      });
      return;
    }
    if (presence.isMachineIntelligence) {
      logger.debug('Presence follow skipped: machine-intelligence contact', {
        contactId: presence.contactId,
        placeId: presence.event.placeId,
      });
      return;
    }

    // Freshness gate: an unparsable or old occurredAt fails closed as stale.
    const occurredAtMs = Date.parse(presence.event.occurredAt);
    if (!Number.isFinite(occurredAtMs) || now() - occurredAtMs > freshnessMs) {
      logger.debug('Presence follow skipped: stale presence event', {
        contactId: presence.contactId,
        occurredAt: presence.event.occurredAt,
        freshnessMs,
      });
      return;
    }

    // Destination gate: the bridge already rejected unbound satellites and
    // unknown places; re-resolve defensively and require a PHYSICAL place —
    // a satellite bound to a virtual place must never receive an emanation.
    const place = options.placesRegistry?.places.find(
      (entry) => entry.placeId === presence.event.placeId,
    );
    if (!place || place.kind !== 'physical') {
      logger.warn('Presence follow skipped: destination is not a resolvable physical place', {
        placeId: presence.event.placeId,
        satelliteId: presence.event.satelliteId,
        resolved: place ? place.kind : 'unknown_place',
      });
      return;
    }

    const fromPlaceId = options.target.resolveCurrentEmanationPlaceId();
    if (fromPlaceId === place.placeId) {
      // Already emanating there — a repeat detection is not a move.
      return;
    }

    // Debounce: one applied move per window. Suppression is logged at info so
    // an operator can see a flapping sensor being held back.
    const nowMs = now();
    if (lastMoveAtMs !== null && nowMs - lastMoveAtMs < debounceMs) {
      logger.info('Presence follow debounced (auto-move suppressed)', {
        contactId: presence.contactId,
        fromPlaceId,
        toPlaceId: place.placeId,
        debounceMs,
        sinceLastMoveMs: nowMs - lastMoveAtMs,
      });
      return;
    }

    // Shared presence write FIRST (same port path a deliberate move uses,
    // contract s10wm: row upsert + arrival semantics). A write failure throws
    // out of here and aborts the move before any local state changes.
    const companionPresence = options.getCompanionPresence();
    if (companionPresence) {
      await companionPresence.recordDeliberateMove({
        siteId: place.siteId,
        placeId: place.placeId,
        kind: place.kind,
      });
    }

    // Local handoff: tracker transition (same as a satellite turn establishing
    // a place) + durable situated-location confirmation.
    options.target.applyEmanationFollowHandoff({
      placeId: place.placeId,
      siteId: place.siteId,
      placeDisplayName: place.displayName,
    });
    lastMoveAtMs = nowMs;

    // Auditability: every applied auto-move logs WHY and emits the typed
    // follow event. No silent movement, ever.
    logger.info('Emanation auto-followed trusted presence', {
      contactId: presence.contactId,
      displayName: presence.displayName,
      satelliteId: presence.event.satelliteId,
      fromPlaceId,
      toPlaceId: place.placeId,
      siteId: place.siteId,
      sharedWrite: companionPresence ? 'shared' : 'local_only',
    });
    void options.eventBus.emit('presence.emanation.follow', {
      trigger: 'physical_presence',
      contactId: presence.contactId,
      satelliteId: presence.event.satelliteId,
      ...(fromPlaceId ? { fromPlaceId } : {}),
      toPlaceId: place.placeId,
      siteId: place.siteId,
      kind: place.kind,
      timestamp: nowMs,
    }).catch((error: unknown) => {
      logger.error('Failed to emit presence follow event', {
        contactId: presence.contactId,
        toPlaceId: place.placeId,
        error: toErrorMessage(error),
      });
    });
  }

  return {
    async handleResolvedPresence(presence: ResolvedPresence): Promise<void> {
      try {
        await maybeFollow(presence);
      } catch (error) {
        // Loud, never turn-fatal for the perception lane: an aborted follow
        // (e.g. shared-presence write failure) must not suppress the
        // context-visible presence note below.
        logger.error('Presence follow failed (emanation NOT moved)', {
          placeId: presence.event.placeId,
          satelliteId: presence.event.satelliteId,
          error: toErrorMessage(error),
        });
      }
      await options.inner.handleResolvedPresence(presence);
    },
  };
}
