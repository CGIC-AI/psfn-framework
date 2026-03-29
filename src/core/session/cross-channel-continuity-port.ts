import type { ChannelMeta } from '../../system/trust/policy.js';
import type { ActiveChannelQuery, ActiveContinuityChannel, ContinuityEntryProvenance, UserContinuityStore } from './continuity.js';
import { parseContinuityEntryProvenance } from './continuity.js';
import { getMergedContinuity } from './manager/context-support.js';
import type { SessionEntry } from './types.js';

export interface CrossChannelContinuityAppendRequest {
  continuityUserId: string;
  entry: Omit<SessionEntry, 'id'>;
}

export interface CrossChannelContinuityQuery {
  canonicalUserId: string;
  limit: number;
  fallbackUserIds: string[];
  channelId: string;
  channelMeta?: ChannelMeta;
}

export type CrossChannelContinuityStatus = 'wired' | 'disabled' | 'missing_wiring';

export interface CrossChannelContinuityHealth {
  status: CrossChannelContinuityStatus;
  detail: string;
}

export interface CrossChannelContinuityPort {
  append(request: CrossChannelContinuityAppendRequest): number | null;
  getMerged(params: CrossChannelContinuityQuery): SessionEntry[];
  getActiveChannels(
    continuityUserId: string,
    query?: ActiveChannelQuery,
  ): ActiveContinuityChannel[];
  parseProvenance(metadata?: string): ContinuityEntryProvenance | null;
  getHealth(): CrossChannelContinuityHealth;
}

export function parseCrossChannelContinuityProvenance(
  metadata?: string,
): ContinuityEntryProvenance | null {
  return parseContinuityEntryProvenance(metadata);
}

export function createMissingCrossChannelContinuityPort(): CrossChannelContinuityPort {
  return {
    append() {
      return null;
    },
    getMerged() {
      return [];
    },
    getActiveChannels() {
      return [];
    },
    parseProvenance(metadata) {
      return parseCrossChannelContinuityProvenance(metadata);
    },
    getHealth() {
      return {
        status: 'missing_wiring',
        detail: 'Cross-channel continuity store is not wired',
      };
    },
  };
}

export function createDisabledCrossChannelContinuityPort(): CrossChannelContinuityPort {
  return {
    append() {
      return null;
    },
    getMerged() {
      return [];
    },
    getActiveChannels() {
      return [];
    },
    parseProvenance(metadata) {
      return parseCrossChannelContinuityProvenance(metadata);
    },
    getHealth() {
      return {
        status: 'disabled',
        detail: 'Cross-channel continuity is intentionally disabled',
      };
    },
  };
}

export function createUserContinuityPort(
  continuityStore: UserContinuityStore | null,
): CrossChannelContinuityPort {
  if (!continuityStore) {
    return createMissingCrossChannelContinuityPort();
  }

  return {
    append(request) {
      return continuityStore.append(request.continuityUserId, request.entry);
    },
    getMerged(params) {
      return getMergedContinuity({
        continuityStore,
        canonicalUserId: params.canonicalUserId,
        limit: params.limit,
        fallbackUserIds: params.fallbackUserIds,
        channelId: params.channelId,
        channelMeta: params.channelMeta,
      });
    },
    getActiveChannels(continuityUserId, query) {
      return continuityStore.getActiveChannels(continuityUserId, query);
    },
    parseProvenance(metadata) {
      return parseCrossChannelContinuityProvenance(metadata);
    },
    getHealth() {
      return {
        status: 'wired',
        detail: 'Cross-channel continuity store is wired',
      };
    },
  };
}
