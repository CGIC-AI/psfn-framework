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

function isLiveFollowUp(followUp: PendingFollowUp | null, nowMs: number): followUp is PendingFollowUp {
  if (!followUp || followUp.activatedAt || isPendingFollowUpExpired(followUp, nowMs)) {
    return false;
  }
  return true;
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
      const lineageRoots = new Set<string>();
      const addLineageRoot = (root: string | undefined): boolean => {
        if (root === undefined) return true;
        if (!isRfc4122Uuid(root)) return false;
        lineageRoots.add(root);
        return lineageRoots.size <= 1;
      };
      if (payload.pendingFollowUpId) {
        const followUp = await input.pendingFollowUpStore.peek(payload.pendingFollowUpId);
        if (!isLiveFollowUp(followUp, now())) {
          return { kind: 'blocked', reason: 'stale_provenance' };
        }
        const contactId = followUp.contactId?.trim() || null;
        if (!contactId) return { kind: 'blocked', reason: 'stale_provenance' };
        if (!addLineageRoot(followUp.originIcpRootInitiationId)) {
          return { kind: 'blocked', reason: 'stale_provenance' };
        }
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
        if (!addLineageRoot(concern.originIcpRootInitiationId)) {
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
      if (!addLineageRoot(payload.originIcpRootInitiationId)) {
        return { kind: 'blocked', reason: 'stale_provenance' };
      }
      const inheritedRoot = [...lineageRoots][0];
      const result = await input.sourceRuntime.submit({
        source: 'intention',
        peerContactId: contactId!,
        preferredChannel: parsedChannel?.kind === 'room' ? 'current_room' : 'dm',
        ...(parsedChannel?.kind === 'room' ? { currentRoomChannelId: payload.channelId } : {}),
        sourceRecordId: action.dedupeKey,
        ...(payload.pendingFollowUpId ? { pendingFollowUpId: payload.pendingFollowUpId } : {}),
        reasonSummary: (payload.reason?.trim() || payload.content).slice(0, 1_000),
        cause: inheritedRoot
          ? { kind: 'icp_conversation', rootInitiationId: inheritedRoot }
          : { kind: 'independent' },
      });
      return { kind: 'submitted', result };
    },
  };
}
