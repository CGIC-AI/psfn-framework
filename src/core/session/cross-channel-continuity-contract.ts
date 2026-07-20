import type { ChannelMeta } from '../../system/trust/policy.js';
import type {
  ActiveChannelQuery,
  ActiveContinuityChannel,
  ContinuityEntryProvenance,
} from './continuity.js';
import type { SessionEntry } from './types.js';

export interface CrossChannelContinuityAppendRequest {
  continuityUserId: string;
  entry: Omit<SessionEntry, 'id'>;
  /** Immutable id of `entry` in its source session's L0 journal. */
  sourceEntryId?: number;
  /** Explicit attestation for sources that intentionally have no L0 journal. */
  sourcePersistence?: 'non_persistent';
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

export type LinkedContinuityChannelEligibility = (channelId: string) => boolean;
