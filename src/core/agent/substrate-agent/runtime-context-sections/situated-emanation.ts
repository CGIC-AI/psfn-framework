// ── Active-emanation → situated-place tracker (S10, Workstream B2) ──
//
// The situated block (B1) foregrounds "where am I right now". On a satellite
// turn the answer is the turn's own bound place. But most turns arrive over a
// placeless channel (Discord/Telegram): those must still foreground the
// companion's CURRENT active emanation — the room it last emanated into — not
// nothing. This tracker is that handoff-aware memory of the current emanation.
//
// It wraps the canonical `ActiveEmanationAuthority` so switching emanation is
// modeled the same way the rest of the runtime models it (source-keyed,
// handoff-aware), and layers the place binding on top: an emanation turn that
// carries a `placeId` ESTABLISHES the current situated place; a later placeless
// turn CONSUMES it.
//
// Fail closed: only a turn that carries a resolvable place (routing.satellite
// .placeId) updates the current emanation. A conflicting/unresolvable presence
// never establishes a location. Nothing is fabricated — when nothing has ever
// established a place, the situated block renders its honest B1 fallback.
//
// Durability is OUT OF SCOPE here (bead .7): this tracker is per-process
// in-memory only. A fresh process starts with no current emanation and the
// first placeless turn falls back honestly until a placed turn arrives.

import { ActiveEmanationAuthority } from '../../active-emanation-state.js';
import {
  resolvePresenceSubjectId,
  type CompanionPresenceMetadata,
} from '../../presence-metadata.js';
import type { SubstrateMessage } from '../../../../shared/contracts/runtime.js';

/** The companion's current active emanation, resolved to a situated place. */
export interface SituatedEmanation {
  /** Presence that established this emanation, when the turn carried one. */
  presence?: CompanionPresenceMetadata;
  /** `PlaceConfig.placeId` this emanation is bound to (static satellite binding). */
  placeId: string;
}

/** Reads the turn's own bound place off satellite routing, trimmed/guarded. */
function readTurnPlaceId(message: SubstrateMessage): string | undefined {
  const placeId = message.routing?.satellite?.placeId;
  if (typeof placeId !== 'string') return undefined;
  const trimmed = placeId.trim();
  return trimmed ? trimmed : undefined;
}

export class SituatedEmanationTracker {
  private readonly authority = new ActiveEmanationAuthority();
  private current: SituatedEmanation | undefined;
  /**
   * Deliberate virtual navigation overlay (S10 vinz.26, contract s10wm). Set by
   * the world tool's `move` action; NEVER touched by physical emanation turns
   * except to be superseded: a later place-bearing (satellite) turn clears it
   * (latest event wins — locations decision 13's blend default). The physical
   * emanation in {@link current} is deliberately NOT modified by a virtual
   * move: virtually walking into a MUD room does not move the satellite
   * emanation, it only changes which place is foregrounded on placeless turns.
   */
  private virtualMove: { placeId: string } | undefined;

  /**
   * Fold a turn into the tracker. Presence-bearing turns update the canonical
   * emanation authority (handoff-aware continuity); a turn that also carries a
   * resolvable `placeId` becomes the current situated emanation. Placeless turns
   * (Discord/Telegram) leave the current emanation untouched so it can be
   * consumed by {@link resolvePlaceId}/{@link resolvePresence}.
   */
  observe(message: SubstrateMessage): void {
    const presence = message.routing?.presence;
    if (presence) {
      const sourceKey = resolvePresenceSubjectId(presence);
      const resolution = this.authority.resolve(presence, {
        ...(sourceKey ? { sourceKey } : {}),
        // Situated foregrounding is explicitly handoff-aware: emanating into a
        // new place supersedes the previous one rather than erroring.
        allowPrimaryEmbodimentHandoff: true,
      });
      // A conflicting/unresolvable presence never establishes a location.
      if (resolution.error) return;
    }

    const placeId = readTurnPlaceId(message);
    // Only a place-bearing turn (a bound satellite emanation) moves the marker.
    if (!placeId) return;
    this.current = {
      ...(presence ? { presence } : {}),
      placeId,
    };
    // Latest event wins: a fresh physical emanation supersedes a prior
    // deliberate virtual move (decision 13 — the latent position defaults back
    // to where you physically are until the next deliberate cue).
    this.virtualMove = undefined;
  }

  /**
   * Presence-driven emanation handoff (conversation-follows-you, vinz.20).
   * A resolved, trust-gated presence claim at another satellite-bound place
   * moves the active emanation there WITHOUT a turn: this is the same
   * state transition a place-bearing satellite turn performs in
   * {@link observe} — establish the new current place and clear any
   * deliberate virtual-move overlay (a fresh physical emanation is the
   * latest event and supersedes it, decision 13) — minus the turn's own
   * presence metadata, which only a real device turn can honestly carry.
   * The caller (the presence-follow controller) has already validated the
   * place against the registry and applied trust/freshness/debounce gates.
   */
  handoffToPlace(placeId: string): void {
    this.current = { placeId };
    this.virtualMove = undefined;
  }

  /**
   * Deliberate virtual navigation (world tool `move`, vinz.26). Foregrounds
   * `placeId` for subsequent placeless turns WITHOUT touching the physical
   * emanation: a satellite turn still renders its own bound place, and the next
   * place-bearing turn supersedes (clears) this overlay. The caller has already
   * validated `placeId` against the places registry (virtual kind only).
   */
  moveToVirtualPlace(placeId: string): void {
    this.virtualMove = { placeId };
  }

  /** The deliberate virtual-move place, if one is active (inspection/tests). */
  resolveVirtualMovePlaceId(): string | undefined {
    return this.virtualMove?.placeId;
  }

  /**
   * The place to foreground on a placeless turn: a deliberate virtual move
   * outranks the physical emanation (it is by definition the later event —
   * any newer physical emanation would have cleared it in {@link observe}).
   */
  resolvePlaceId(): string | undefined {
    return this.virtualMove?.placeId ?? this.current?.placeId;
  }

  /** The presence that established the current active emanation, if any. */
  resolvePresence(): CompanionPresenceMetadata | undefined {
    return this.current?.presence;
  }

  /** Snapshot of the current active emanation (copy), for inspection/tests. */
  snapshot(): SituatedEmanation | undefined {
    return this.current ? { ...this.current } : undefined;
  }
}
