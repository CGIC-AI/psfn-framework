// ── Gateway inter-companion channel lane (sprint 10, W6) ──
//
// The GATEWAY owns cross-companion routing: an agent addresses a room
// (`companion-room:<placeId>`) or a peer DM (`companion-dm:<a>:<b>`), and this
// lane resolves who receives the message. Resolution is fail-closed — an
// unparseable channel, unknown place, non-participant sender, or unknown DM
// peer is a violation the server alarms on, never a silent drop or broadcast.
//
// Delivery itself stays in GatewayServer (it owns the companion connection
// registry); this module is the pure-ish resolution seam so recipient logic is
// testable without a socket harness.
//
// Room membership = shared-schema presence. Companions whose
// `companion_presence` row sits at the addressed place (and is fresher than
// the staleness TTL — the same read-side TTL the agent presence runtime uses)
// are the room's members; the sender is always excluded so a companion never
// receives its own message back. The sender is NOT required to be present at
// the place: the reply path must keep working even when the replier's own
// presence row has gone stale between turns, and delivery-side trust gates
// govern what a recipient does with the message.
//
// PRIVATE rooms (psfn-framework-s10rm, presence-windowed delivery): when the
// addressed place is marked `privacy: 'private'`, a recipient additionally
// must have JOINED before the message was minted — its presence row's `since`
// (the join time; the one clock, no separate bookkeeping) must not be after
// the message timestamp. This closes the join race at the fan-out boundary;
// the agent-side session window gate (companion-room-window.ts) closes the
// serving side. PUBLIC places (the default) skip the `since` check entirely —
// byte-identical to pre-privacy behavior. Discord/Telegram group channels
// never route through this lane at all; a future private HUMAN room enforces
// its window at its own channel adapter, not here.
//
// DM peers are validated against the fleet manifest (companions.json): the
// cluster's sibling set is the addressable universe, cross-cluster transport
// is explicitly deferred.

import {
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import {
  resolvePlacePrivacy,
  type PlacePrivacy,
  type PlacesRegistryConfig,
} from '../../shared/contracts/places-registry.js';
import { DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS } from '../../core/agent/companion-presence-runtime.js';

/** Narrow read-only view over the shared-schema presence store. */
export interface CompanionPresenceReadRow {
  companionId: string;
  /** ISO-8601 freshness beat; rows older than the staleness TTL are gone. */
  updatedAt: string;
  /**
   * ISO-8601 join time (start of the current presence window). Required for
   * PRIVATE-room delivery — a row without it is excluded fail-closed there.
   * The real store always returns it; it is optional only so narrow public
   * test doubles remain valid.
   */
  since?: string;
}

export interface CompanionPresenceReadPort {
  listByPlace(siteId: string, placeId: string): Promise<CompanionPresenceReadRow[]>;
}

export interface GatewayCompanionChannelLaneOptions {
  placesRegistry: Pick<PlacesRegistryConfig, 'places'>;
  presence: CompanionPresenceReadPort;
  /** Fleet manifest companion ids (companions.json); DM peers must be members. */
  fleetCompanionIds: ReadonlySet<string>;
  /** Read-side staleness TTL override (tests). */
  staleTtlMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export interface CompanionDeliveryViolation {
  event: string;
  message: string;
  details: Record<string, unknown>;
}

export type CompanionDeliveryResolution =
  | {
    ok: true;
    kind: 'room' | 'dm';
    channelId: string;
    recipients: string[];
    /** Room only: the addressed place's privacy classification. */
    roomPrivacy?: PlacePrivacy;
    /**
     * Private room only: present companions excluded because their window
     * opened after the message was minted (join race) or their row carried
     * no `since` (fail closed).
     */
    windowExcluded?: string[];
  }
  | { ok: false; violation: CompanionDeliveryViolation };

export interface CompanionDeliveryResolveOptions {
  /**
   * Epoch ms the message envelope is minted with. Private-room recipients
   * whose `since` is after this instant are excluded. Defaults to now().
   */
  messageTimestampMs?: number;
}

export class GatewayCompanionChannelLane {
  private readonly placesRegistry: Pick<PlacesRegistryConfig, 'places'>;
  private readonly presence: CompanionPresenceReadPort;
  private readonly fleetCompanionIds: ReadonlySet<string>;
  private readonly staleTtlMs: number;
  private readonly now: () => number;

  constructor(options: GatewayCompanionChannelLaneOptions) {
    this.placesRegistry = options.placesRegistry;
    this.presence = options.presence;
    this.fleetCompanionIds = options.fleetCompanionIds;
    this.staleTtlMs = options.staleTtlMs ?? DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  async resolveDelivery(
    senderCompanionId: string,
    channelId: string,
    options?: CompanionDeliveryResolveOptions,
  ): Promise<CompanionDeliveryResolution> {
    const parsed = parseCompanionChannelId(channelId);
    if (!parsed) {
      return violation('companion_channel_unparseable', 'Companion channelId is not a well-formed room or DM address', {
        senderCompanionId,
        channelId,
      });
    }

    if (parsed.kind === 'dm') {
      const [a, b] = parsed.participants;
      if (senderCompanionId !== a && senderCompanionId !== b) {
        return violation(
          'companion_dm_sender_not_participant',
          'Companion DM send rejected: sender is not a participant of the addressed pair',
          { senderCompanionId, channelId },
        );
      }
      const peer = senderCompanionId === a ? b : a;
      if (!this.fleetCompanionIds.has(peer)) {
        return violation(
          'companion_dm_unknown_peer',
          `Companion DM peer "${peer}" is not a member of the cluster fleet`,
          { senderCompanionId, channelId, peerCompanionId: peer },
        );
      }
      return { ok: true, kind: 'dm', channelId, recipients: [peer] };
    }

    const place = this.placesRegistry.places.find((entry) => entry.placeId === parsed.placeId);
    if (!place) {
      return violation(
        'companion_unknown_place',
        `Companion room addresses unknown placeId "${parsed.placeId}"`,
        { senderCompanionId, channelId, placeId: parsed.placeId },
      );
    }

    const roomPrivacy = resolvePlacePrivacy(place);
    // Private rooms deliver presence-WINDOWED (psfn-framework-s10rm): the
    // recipient must have joined (their `since`) no later than the message
    // mint. Public rooms never consult `since` — byte-identical behavior.
    const windowCutoffMs = roomPrivacy === 'private'
      ? options?.messageTimestampMs ?? this.now()
      : null;

    const rows = await this.presence.listByPlace(place.siteId, place.placeId);
    const staleCutoffMs = this.now() - this.staleTtlMs;
    const recipients: string[] = [];
    const windowExcluded: string[] = [];
    for (const row of rows) {
      if (row.companionId === senderCompanionId) continue; // never echo the sender
      if (Date.parse(row.updatedAt) < staleCutoffMs) continue; // crashed/idle-out rows
      if (recipients.includes(row.companionId) || windowExcluded.includes(row.companionId)) continue;
      if (windowCutoffMs !== null) {
        const sinceMs = typeof row.since === 'string' ? Date.parse(row.since) : Number.NaN;
        // Fail closed: no parseable join time, or joined after the message
        // was minted — a private room never delivers pre-join content.
        if (!Number.isFinite(sinceMs) || sinceMs > windowCutoffMs) {
          windowExcluded.push(row.companionId);
          continue;
        }
      }
      recipients.push(row.companionId);
    }
    return {
      ok: true,
      kind: 'room',
      channelId,
      recipients,
      roomPrivacy,
      ...(roomPrivacy === 'private' ? { windowExcluded } : {}),
    };
  }
}

function violation(
  event: string,
  message: string,
  details: Record<string, unknown>,
): CompanionDeliveryResolution {
  return { ok: false, violation: { event, message, details } };
}
