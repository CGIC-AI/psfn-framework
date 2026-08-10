import type { SessionStore } from '../../persistence/sessions/store.js';
import {
  buildCompactionSourceBlock,
  computeCompactionSourceSha256,
  parseCompactionSourceHashTag,
} from './compaction-audit.js';
import type { SessionEntry } from './types.js';

type LatestCompactionSourceStatus =
  | 'verified'
  | 'no_summary'
  | 'legacy_metadata'
  | 'invalid_metadata'
  | 'source_mismatch'
  | 'access_denied';

interface LatestCompactionSourceBase {
  status: LatestCompactionSourceStatus;
  channelId: string;
}

export interface VerifiedLatestCompactionSourceRange extends LatestCompactionSourceBase {
  status: 'verified';
  summaryEntryId: number;
  summaryCreatedAt: number;
  coveredUpTo: number;
  firstMessageId: number;
  lastMessageId: number;
  messageCount: number;
  sha256: string;
  entries: SessionEntry[];
}

interface UnavailableLatestCompactionSourceRange extends LatestCompactionSourceBase {
  status: Exclude<LatestCompactionSourceStatus, 'verified'>;
  reason: string;
  summaryEntryId?: number;
  summaryCreatedAt?: number;
}

export type LatestCompactionSourceRange =
  | VerifiedLatestCompactionSourceRange
  | UnavailableLatestCompactionSourceRange;

export interface LatestCompactionSourceResolver {
  getLatestCompactionSourceRange(
    channelId: string,
    authorization: { currentChannelId: string },
  ): LatestCompactionSourceRange;
}

function cloneSessionEntry(entry: SessionEntry): SessionEntry {
  return { ...entry };
}

export function resolveLatestCompactionSourceRange(
  store: Pick<SessionStore, 'getCompactionSummaries' | 'getEntriesInRange'>,
  channelId: string,
): LatestCompactionSourceRange {
  const latest = store
    .getCompactionSummaries(channelId)
    .reduce<ReturnType<SessionStore['getCompactionSummaries']>[number] | null>(
      (selected, candidate) => {
        if (!selected) return candidate;
        if (candidate.id !== selected.id) return candidate.id > selected.id ? candidate : selected;
        return candidate.createdAt > selected.createdAt ? candidate : selected;
      },
      null,
    );

  if (!latest) {
    return {
      status: 'no_summary',
      channelId,
      reason: 'No compaction summary exists for the current channel.',
    };
  }

  const summaryIdentity = {
    summaryEntryId: latest.id,
    summaryCreatedAt: latest.createdAt,
  };
  const metadata = parseCompactionSourceHashTag(latest.summary);
  if (!metadata) {
    return /<source_block_sha256\b/iu.test(latest.summary)
      ? {
          status: 'invalid_metadata',
          channelId,
          reason: 'The latest compaction summary has malformed source metadata.',
          ...summaryIdentity,
        }
      : {
          status: 'legacy_metadata',
          channelId,
          reason: 'The latest compaction summary predates exact source metadata.',
          ...summaryIdentity,
        };
  }

  if (latest.coveredUpTo !== metadata.lastMessageId) {
    return {
      status: 'invalid_metadata',
      channelId,
      reason: 'The latest compaction boundary disagrees with its source metadata.',
      ...summaryIdentity,
    };
  }

  const entries = store.getEntriesInRange(
    channelId,
    metadata.firstMessageId,
    metadata.lastMessageId,
  );
  const firstEntry = entries[0];
  const lastEntry = entries.at(-1);
  const sourceBlock = buildCompactionSourceBlock(entries);
  const actualHash = computeCompactionSourceSha256(sourceBlock);
  const sourceMatches = entries.length === metadata.messageCount
    && firstEntry?.id === metadata.firstMessageId
    && lastEntry?.id === metadata.lastMessageId
    && entries.every(entry => entry.channelId === channelId)
    && actualHash === metadata.sha256;
  if (!sourceMatches) {
    return {
      status: 'source_mismatch',
      channelId,
      reason: 'The latest compaction source is missing, tombstoned, or fails count/hash verification.',
      ...summaryIdentity,
    };
  }

  return {
    status: 'verified',
    channelId,
    ...summaryIdentity,
    coveredUpTo: latest.coveredUpTo,
    firstMessageId: metadata.firstMessageId,
    lastMessageId: metadata.lastMessageId,
    messageCount: metadata.messageCount,
    sha256: metadata.sha256,
    entries: entries.map(cloneSessionEntry),
  };
}
