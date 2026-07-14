import { parseCompanionChannelId } from '../../shared/contracts/companion-channels.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import type { ConcernStorePort } from '../intention/concern-store-port.js';
import type { IntentionOutboundMessageActionPayload } from '../intention/appraisal/types.js';
import {
  isPendingFollowUpExpired,
  type PendingFollowUp,
} from '../intention/pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../intention/pending-follow-up-store-port.js';
import {
  CanonicalCompanionPeerValidationError,
  type KnownCompanionPeer,
} from './agent-facing-autonomy.js';
import type {
  IcpInitiationSourceResult,
  IcpInitiationSourceRuntime,
} from './initiation-source-runtime.js';

export type IcpIntentionCandidateAdapterResult =
  | { kind: 'not_companion' }
  | { kind: 'blocked'; reason: 'stale_provenance' | 'ambiguous_contact' }
  | { kind: 'submitted'; result: IcpInitiationSourceResult };

export interface IcpIntentionCandidateAdapter {
  submit(input: {
    action: {
      id: string;
      dedupeKey: string;
      sourceMessageId: string;
    };
    payload: IntentionOutboundMessageActionPayload;
  }): Promise<IcpIntentionCandidateAdapterResult>;
}

function liveFollowUpContact(followUp: PendingFollowUp | null, nowMs: number): string | null {
  if (!followUp || followUp.activatedAt || isPendingFollowUpExpired(followUp, nowMs)) {
    return null;
  }
  return followUp.contactId?.trim() || null;
}

/**
 * Converts a provenance-checked durable intention into the same private ICP
 * candidate used by every other autonomy source. It rechecks the cited rows at
 * execution time so a stale-source race cannot fall through to human delivery.
 */
export function createIcpIntentionCandidateAdapter(input: {
  sourceRuntime: IcpInitiationSourceRuntime;
  peers: { resolveKnownPeer(contactId: string): Promise<KnownCompanionPeer> };
  pendingFollowUpStore: Pick<PendingFollowUpStorePort, 'peek'>;
  concernStore: Pick<ConcernStorePort, 'getById'>;
  now?: () => number;
}): IcpIntentionCandidateAdapter {
  const now = input.now ?? Date.now;
  return {
    async submit({ action, payload }) {
      const contactIds = new Set<string>();
      if (payload.pendingFollowUpId) {
        const contactId = liveFollowUpContact(
          await input.pendingFollowUpStore.peek(payload.pendingFollowUpId),
          now(),
        );
        if (!contactId) return { kind: 'blocked', reason: 'stale_provenance' };
        contactIds.add(contactId);
      }

      for (const concernId of payload.concernIds ?? []) {
        const concern = await input.concernStore.getById(concernId);
        if (
          !concern
          || concern.resolvedAt
          || ['resolved', 'dismissed', 'suppressed'].includes(concern.status)
          || Date.parse(concern.expiresAt) <= now()
        ) {
          return { kind: 'blocked', reason: 'stale_provenance' };
        }
        const contactId = concern.contactId?.trim();
        if (contactId) contactIds.add(contactId);
      }

      if (contactIds.size === 0) return { kind: 'not_companion' };
      if (contactIds.size !== 1) return { kind: 'blocked', reason: 'ambiguous_contact' };
      const [contactId] = contactIds;
      try {
        await input.peers.resolveKnownPeer(contactId!);
      } catch (error) {
        if (error instanceof CanonicalCompanionPeerValidationError) {
          return error.reason === 'not_machine_intelligence'
            ? { kind: 'not_companion' }
            : { kind: 'blocked', reason: 'ambiguous_contact' };
        }
        throw error;
      }

      const parsedChannel = parseCompanionChannelId(payload.channelId);
      const inheritedRoot = payload.originIcpRootInitiationId;
      if (inheritedRoot !== undefined && !isRfc4122Uuid(inheritedRoot)) {
        return { kind: 'blocked', reason: 'stale_provenance' };
      }
      const result = await input.sourceRuntime.submit({
        source: 'intention',
        peerContactId: contactId!,
        preferredChannel: parsedChannel?.kind === 'room' ? 'current_room' : 'dm',
        ...(parsedChannel?.kind === 'room' ? { currentRoomChannelId: payload.channelId } : {}),
        sourceRecordId: action.dedupeKey,
        reasonSummary: (payload.reason?.trim() || payload.content).slice(0, 1_000),
        cause: inheritedRoot
          ? { kind: 'icp_conversation', rootInitiationId: inheritedRoot }
          : { kind: 'independent' },
      });
      return { kind: 'submitted', result };
    },
  };
}
