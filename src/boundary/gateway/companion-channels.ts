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
// DM peers are validated against the fleet manifest (companions.json): the
// cluster's sibling set is the addressable universe, cross-cluster transport
// is explicitly deferred.

import {
  parseCompanionChannelId,
} from '../../shared/contracts/companion-channels.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import { DEFAULT_COMPANION_PRESENCE_STALE_TTL_MS } from '../../core/agent/companion-presence-runtime.js';

/** Narrow read-only view over the shared-schema presence store. */
export interface CompanionPresenceReadRow {
  companionId: string;
  /** ISO-8601 freshness beat; rows older than the staleness TTL are gone. */
  updatedAt: string;
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
  | { ok: true; kind: 'room' | 'dm'; channelId: string; recipients: string[] }
  | { ok: false; violation: CompanionDeliveryViolation };

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

    const rows = await this.presence.listByPlace(place.siteId, place.placeId);
    const staleCutoffMs = this.now() - this.staleTtlMs;
    const recipients: string[] = [];
    for (const row of rows) {
      if (row.companionId === senderCompanionId) continue; // never echo the sender
      if (Date.parse(row.updatedAt) < staleCutoffMs) continue; // crashed/idle-out rows
      if (recipients.includes(row.companionId)) continue;
      recipients.push(row.companionId);
    }
    return { ok: true, kind: 'room', channelId, recipients };
  }
}

function violation(
  event: string,
  message: string,
  details: Record<string, unknown>,
): CompanionDeliveryResolution {
  return { ok: false, violation: { event, message, details } };
}
