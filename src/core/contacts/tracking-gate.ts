// ── Contact-tracking policy gate (E3.4) ──
// Resolves the per-channel contactTracking mode from channel-owned envelope
// labels (channels.json `contextEnvelope.channels`, docs/context-envelope.md)
// and gates automatic contact creation for channels in 'approval' mode.
//
//   auto       — default; contacts are tracked automatically as speakers appear
//   approval   — NEW speakers do not auto-upsert a contact; they are enqueued
//                for operator approval and stay UNTRACKED (transcript/provenance
//                attribution only) until approved
//   role_gated — reserved; validates as config, fails closed at use
//                (assertContactTrackingModeImplemented)
//
// Mode resolution is a direct exact-channel-id label read with an 'auto'
// default — deliberately NOT a classification pipeline (that hierarchy is
// owned by the E3.2 classification work).

import {
  assertContactTrackingModeImplemented,
  DEFAULT_CONTACT_TRACKING_MODE,
  type ChannelEnvelopeLabel,
  type ContactTrackingMode,
} from '../../system/trust/context-envelope.js';
import type {
  PendingContactApprovalEntry,
  PendingContactApprovalStore,
  PendingContactSighting,
} from './pending-contact-approvals.js';

export type ContactTrackingChannelLabels = Record<
  string,
  Pick<ChannelEnvelopeLabel, 'contactTracking'>
>;

/**
 * Per-channel contactTracking mode: exact channel-id label, default 'auto'.
 * This validates reserved vocabulary as config; callers that are about to
 * OPERATE in the resolved mode must use ContactTrackingGate.resolveMode (or
 * call assertContactTrackingModeImplemented themselves) so 'role_gated' fails
 * closed at use.
 */
export function resolveContactTrackingMode(
  channelLabels: ContactTrackingChannelLabels | undefined,
  channelId: string,
): ContactTrackingMode {
  return channelLabels?.[channelId]?.contactTracking ?? DEFAULT_CONTACT_TRACKING_MODE;
}

export type UntrackedSpeakerDisposition = 'enqueued' | 'pending' | 'denied';

export interface ContactTrackingGate {
  /**
   * Resolve the tracking mode for a channel that is about to be operated in.
   * Throws for reserved modes ('role_gated') — fail closed, visible.
   */
  resolveMode(channelId: string): ContactTrackingMode;
  /** True only for 'auto' channels; throws for reserved modes. */
  isAutoContactCreationAllowed(channelId: string): boolean;
  /**
   * Report a sighting of a speaker with no contact record in an
   * approval-mode channel. Durably enqueues a pending-contact request on
   * first sighting and notifies the operator through the gateway
   * notification path; subsequent sightings update the existing entry
   * without re-notifying. Denied speakers are never re-enqueued.
   */
  reportUntrackedSpeaker(sighting: PendingContactSighting): Promise<UntrackedSpeakerDisposition>;
}

export interface ContactTrackingGateOptions {
  channelLabels: ContactTrackingChannelLabels;
  pendingApprovals: PendingContactApprovalStore;
  /**
   * Operator notification for a newly enqueued pending contact. Must route
   * through the gateway notification path (system-derived sender). Delivery
   * failures are logged and do not fail the turn — the durable queue entry is
   * the source of truth; the notification is the alerting layer.
   */
  notifyOperatorPendingContact: (entry: PendingContactApprovalEntry) => Promise<void>;
  logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
}

export function createContactTrackingGate(options: ContactTrackingGateOptions): ContactTrackingGate {
  const resolveMode = (channelId: string): ContactTrackingMode => {
    const mode = resolveContactTrackingMode(options.channelLabels, channelId);
    assertContactTrackingModeImplemented(mode);
    return mode;
  };

  return {
    resolveMode,

    isAutoContactCreationAllowed(channelId: string): boolean {
      return resolveMode(channelId) === 'auto';
    },

    async reportUntrackedSpeaker(sighting: PendingContactSighting): Promise<UntrackedSpeakerDisposition> {
      const { entry, created } = await options.pendingApprovals.recordSighting(sighting);
      if (entry.status === 'denied') return 'denied';
      if (!created) return 'pending';

      try {
        await options.notifyOperatorPendingContact(entry);
      } catch (error) {
        options.logger.warn('Failed to deliver pending contact approval notification', {
          pendingContactId: entry.id,
          channel: entry.channel,
          channelId: entry.channelId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 'enqueued';
    },
  };
}
