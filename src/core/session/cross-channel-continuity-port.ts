import {
  classifyChannel,
  type ChannelMeta,
} from '../../system/trust/policy.js';
import type { ActiveChannelQuery, ActiveContinuityChannel, ContinuityEntryProvenance, UserContinuityStore } from './continuity.js';
import { parseContinuityEntryProvenance } from './continuity.js';
import { getMergedContinuity } from './manager/context-support.js';
import { parseChannelVisibility } from './manager-primitives.js';
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

interface ChannelSessionThreadScope {
  familyKey: string;
  threadKey: string | null;
}

function resolveChannelSessionThreadScope(channelId: string): ChannelSessionThreadScope | null {
  if (channelId.startsWith('api:')) {
    const [, principalId, ...sessionParts] = channelId.split(':');
    if (!principalId) return null;
    return {
      familyKey: `api:${principalId}`,
      threadKey: sessionParts.length > 0 ? sessionParts.join(':') : null,
    };
  }

  if (channelId.startsWith('telegram:')) {
    const withoutPrefix = channelId.slice('telegram:'.length);
    if (!withoutPrefix) return null;
    const threadDelimiter = '#thread:';
    const threadIndex = withoutPrefix.indexOf(threadDelimiter);
    if (threadIndex === -1) {
      return {
        familyKey: `telegram:${withoutPrefix}`,
        threadKey: null,
      };
    }
    const chatId = withoutPrefix.slice(0, threadIndex);
    if (!chatId) return null;
    const threadKey = withoutPrefix.slice(threadIndex + threadDelimiter.length) || null;
    return {
      familyKey: `telegram:${chatId}`,
      threadKey,
    };
  }

  if (channelId.startsWith('discord:')) {
    const withoutPrefix = channelId.slice('discord:'.length);
    if (!withoutPrefix) return null;
    const [baseChannelId, ...threadParts] = withoutPrefix.split(':');
    if (!baseChannelId) return null;
    return {
      familyKey: `discord:${baseChannelId}`,
      threadKey: threadParts.length > 0 ? threadParts.join(':') : null,
    };
  }

  return null;
}

export function channelsShareActiveSessionThread(
  leftChannelId: string,
  rightChannelId: string,
): boolean {
  if (leftChannelId === rightChannelId) {
    return true;
  }

  const left = resolveChannelSessionThreadScope(leftChannelId);
  const right = resolveChannelSessionThreadScope(rightChannelId);
  if (!left || !right) {
    return false;
  }

  return left.familyKey === right.familyKey
    && left.threadKey === right.threadKey;
}

function channelsConflictWithinSessionFamily(
  leftChannelId: string,
  rightChannelId: string,
): boolean {
  const left = resolveChannelSessionThreadScope(leftChannelId);
  const right = resolveChannelSessionThreadScope(rightChannelId);
  if (!left || !right) {
    return false;
  }

  return left.familyKey === right.familyKey
    && left.threadKey !== right.threadKey;
}

export function resolveValidatedCrossChannelContinuityProvenance(
  entry: Pick<SessionEntry, 'channelId' | 'role' | 'timestamp' | 'metadata' | 'originChannelId' | 'channelVisibility'>,
  currentChannelId: string,
): ContinuityEntryProvenance | null {
  const continuity = parseCrossChannelContinuityProvenance(entry.metadata);
  if (!continuity) {
    return null;
  }

  const sourceChannelId = entry.originChannelId ?? entry.channelId;
  if (continuity.sourceChannelId !== sourceChannelId) {
    return null;
  }

  if (continuity.sourceRole !== entry.role) {
    return null;
  }

  if (continuity.recordedAt !== entry.timestamp) {
    return null;
  }

  const sourceVisibility = parseChannelVisibility(entry.channelVisibility)
    ?? classifyChannel(sourceChannelId);
  if (continuity.sourceVisibility !== sourceVisibility) {
    return null;
  }

  if (channelsConflictWithinSessionFamily(sourceChannelId, currentChannelId)) {
    return null;
  }

  return continuity;
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
      }).filter(entry => resolveValidatedCrossChannelContinuityProvenance(entry, params.channelId) !== null);
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
