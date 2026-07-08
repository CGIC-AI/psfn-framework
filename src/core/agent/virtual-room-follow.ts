// ── Virtual-activity presence follow (Sprint 10 — bead vinz.21) ──
//
// The virtual counterpart of physical conversation-follows-you (vinz.20):
// when the partner is ACTIVE in a place-bound VIRTUAL room — a turn arriving
// on a `companion-room:<placeId>` channel (the W6 companion-room mapping,
// which is also how the MUD's virtual venues are addressed) — and the
// companion is not already present there, her virtual presence is pulled to
// that place through the SAME path a deliberate `world move` uses (vinz.26,
// contract s10wm): shared presence write with full arrival semantics via
// `recordDeliberateMove`, local virtual-move overlay, and the W5 room-entry
// system note into the room's session.
//
// Precedence (vinz.29 resolution chain, unmodified): physical always outranks
// — a physical-origin (satellite/voice) turn never triggers a virtual follow,
// and the follow only sets the same virtual-move overlay a deliberate move
// sets, which the next place-bearing physical turn supersedes. A later
// deliberate move likewise outranks by being the later event.
//
// Fail-closed no-op cases (never a move):
//   - physical-origin turns (satellite/wyoming/embodiment routing);
//   - channels that are not well-formed companion-room channels;
//   - rooms whose place the registry cannot resolve, or that are not virtual;
//   - system-role turns, machine-intelligence authors (a peer companion
//     speaking in a room must not drag us there), and authors below
//     primary/trusted;
//   - rooms the companion is already present at (per this turn's own
//     dual-presence fallback resolution — the same seam the situated block
//     renders from).
//
// Debounce (documented bound): at most one applied auto-move per
// DEFAULT_VIRTUAL_FOLLOW_DEBOUNCE_MS (30s), so rapid-fire partner messages in
// a room produce one arrival, not one per message.
//
// The controller NEVER throws — it runs on the pre-turn path and a failed
// follow must not take down the turn; failures are logged at error level.

import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { isHighTierTrustLevel, type TrustLevel } from '../../system/trust/types.js';
import {
  appendRoomEntryNote,
  type RoomEntryNoteSink,
  type RoomEntryOccupant,
} from '../session/room-entry-note.js';
import type { CompanionPresenceTurnPort } from './companion-presence-runtime.js';
import { classifyTurnPresenceMode } from './substrate-agent/runtime-context-sections/turn-presence-mode.js';

const log = createComponentLogger('VirtualRoomFollow');

/**
 * Debounce bound: minimum interval between APPLIED virtual auto-follow moves.
 * Mirrors the physical follow bound (vinz.20): rapid partner activity in a
 * room yields one arrival per window, never a move per message.
 */
export const DEFAULT_VIRTUAL_FOLLOW_DEBOUNCE_MS = 30_000;

/**
 * Narrow structural view of the turn's resolved author context — exactly the
 * trust-gating fields. `ResolvedAuthorContext` satisfies this.
 */
export interface VirtualFollowAuthorContext {
  trustLevel: TrustLevel;
  speakerRole: 'user' | 'system';
  speakingWithIsMachineIntelligence?: boolean;
  canonicalContactKey?: string;
}

export interface VirtualRoomFollowerOptions {
  /** Places soft-registry; without it no room resolves (no moves). */
  placesRegistry?: PlacesRegistryConfig;
  /**
   * Cross-companion presence port, read lazily (wired after composition).
   * Null = flag-off: the follow is local-only, exactly like a flag-off
   * deliberate move.
   */
  getCompanionPresence: () => CompanionPresenceTurnPort | null;
  /** Local situated overlay — the SAME seam the world tool's move uses. */
  applyVirtualMove: (placeId: string) => void;
  /**
   * This turn's dual-presence situated fallback (vinz.29 chain) — "where is
   * the companion for this turn". Used for the already-present check so the
   * follow and the rendered situated block always agree.
   */
  resolveSituatedFallbackPlaceId: (message: SubstrateMessage) => string | undefined;
  /** W5 room-entry note lane (SessionManager satisfies this). */
  roomEntryNoteSink?: RoomEntryNoteSink;
  eventBus: EventBus;
  debounceMs?: number;
  now?: () => number;
  logger?: Pick<typeof log, 'debug' | 'info' | 'warn' | 'error'>;
}

export interface VirtualRoomFollower {
  /**
   * Evaluate one inbound turn for a virtual follow. Runs after author/trust
   * resolution on the pre-turn path. Never throws.
   */
  maybeFollow(message: SubstrateMessage, author: VirtualFollowAuthorContext): Promise<void>;
}

export function createVirtualRoomFollower(options: VirtualRoomFollowerOptions): VirtualRoomFollower {
  const logger = options.logger ?? log;
  const debounceMs = options.debounceMs ?? DEFAULT_VIRTUAL_FOLLOW_DEBOUNCE_MS;
  const now = options.now ?? Date.now;
  let lastMoveAtMs: number | null = null;

  async function follow(message: SubstrateMessage, author: VirtualFollowAuthorContext): Promise<void> {
    // Physical always outranks (vinz.29): a device-origin turn carries its own
    // place and must never be re-routed by virtual-room inference.
    if (classifyTurnPresenceMode(message) === 'physical') return;

    const parsed = parseCompanionChannelId(message.channelId);
    if (!parsed || parsed.kind !== 'room') return;

    const place = options.placesRegistry?.places.find(
      (entry) => entry.placeId === parsed.placeId,
    );
    if (!place || place.kind !== 'virtual') {
      logger.debug('Virtual follow skipped: room place not a resolvable virtual place', {
        channelId: message.channelId,
        placeId: parsed.placeId,
        resolved: place ? place.kind : 'unknown_place',
      });
      return;
    }

    // Trust gate: only the human partner's own activity pulls presence —
    // primary/trusted, user-role, not a machine intelligence.
    if (author.speakerRole !== 'user') return;
    if (author.speakingWithIsMachineIntelligence === true) {
      logger.debug('Virtual follow skipped: machine-intelligence author', {
        channelId: message.channelId,
        placeId: place.placeId,
      });
      return;
    }
    if (!isHighTierTrustLevel(author.trustLevel)) {
      logger.debug('Virtual follow skipped: author below primary/trusted', {
        channelId: message.channelId,
        placeId: place.placeId,
        trustLevel: author.trustLevel,
      });
      return;
    }

    // Already present: this turn's own dual-presence resolution (deliberate
    // move → mindspace twin → physical emanation) already foregrounds the room.
    const fromPlaceId = options.resolveSituatedFallbackPlaceId(message);
    if (fromPlaceId === place.placeId) return;

    const nowMs = now();
    if (lastMoveAtMs !== null && nowMs - lastMoveAtMs < debounceMs) {
      logger.info('Virtual follow debounced (auto-move suppressed)', {
        channelId: message.channelId,
        fromPlaceId,
        toPlaceId: place.placeId,
        debounceMs,
        sinceLastMoveMs: nowMs - lastMoveAtMs,
      });
      return;
    }

    // Same port path a deliberate move uses (contract s10wm): shared write +
    // arrival semantics FIRST; a failure throws and aborts before any local
    // state changes. Flag-off (port null) the move is local-only by design.
    const companionPresence = options.getCompanionPresence();
    const placeRef = { siteId: place.siteId, placeId: place.placeId, kind: place.kind };
    if (companionPresence) {
      await companionPresence.recordDeliberateMove(placeRef);
    }
    options.applyVirtualMove(place.placeId);
    lastMoveAtMs = nowMs;

    // W5 entry event: arrival semantics include the room-entry system note,
    // delivered into the room channel itself (the session this turn runs in).
    if (options.roomEntryNoteSink) {
      const coPresent = companionPresence?.getCoPresent(placeRef) ?? [];
      const present: RoomEntryOccupant[] = coPresent.map((companion) => ({
        displayName: companion.displayName.trim() || companion.companionId,
        kind: 'companion',
      }));
      appendRoomEntryNote(options.roomEntryNoteSink, {
        roomChannelId: message.channelId,
        place,
        affordances: place.affordances,
        present,
      });
    }

    // Auditability: every applied auto-move logs WHY and emits the typed
    // follow event. No silent movement, ever.
    const contactId = author.canonicalContactKey ?? message.authorId;
    logger.info('Virtual presence auto-followed partner room activity', {
      contactId,
      channelId: message.channelId,
      fromPlaceId,
      toPlaceId: place.placeId,
      siteId: place.siteId,
      sharedWrite: companionPresence ? 'shared' : 'local_only',
    });
    void options.eventBus.emit('presence.emanation.follow', {
      trigger: 'virtual_activity',
      contactId,
      channelId: message.channelId,
      ...(fromPlaceId ? { fromPlaceId } : {}),
      toPlaceId: place.placeId,
      siteId: place.siteId,
      kind: place.kind,
      timestamp: nowMs,
    }).catch((error: unknown) => {
      logger.error('Failed to emit virtual follow event', {
        contactId,
        toPlaceId: place.placeId,
        error: toErrorMessage(error),
      });
    });
  }

  return {
    async maybeFollow(message, author): Promise<void> {
      try {
        await follow(message, author);
      } catch (error) {
        // Loud, never turn-fatal: an aborted follow (e.g. shared-presence
        // write failure) leaves the turn untouched at the old place.
        logger.error('Virtual room follow failed (presence NOT moved)', {
          channelId: message.channelId,
          error: toErrorMessage(error),
        });
      }
    },
  };
}
