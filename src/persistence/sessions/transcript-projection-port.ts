import type { SessionEntry } from '../../core/session/types.js';

export interface SessionSearchHit {
  channelId: string;
  messageId: number;
  role: SessionEntry['role'];
  authorId?: string;
  authorName?: string;
  content: string;
  timestamp: number;
  channelVisibility: import('../../system/trust/context-envelope.js').ChannelPrivacy;
  score: number;
  snippet: string;
}

export interface TranscriptProjectionDrift {
  channelId: string;
  reason?: string;
  markedAt: number;
}

export interface TranscriptProjectionPort {
  upsertSessionEntry(entry: SessionEntry, options?: { channelId?: string }): void;
  replaceChannelEntries(channelId: string, entries: readonly SessionEntry[]): void;
  countProjectedMessages(channelId: string): number;
  markProjectionDrift(channelId: string, reason?: string): void;
  clearProjectionDrift(channelId: string): void;
  listProjectionDrift(): TranscriptProjectionDrift[];
  flushPendingWrites?(): Promise<void>;
}

export interface KeywordSearchableTranscriptProjection extends TranscriptProjectionPort {
  searchByKeywords(query: string, limit?: number): Promise<SessionSearchHit[]>;
}

export function supportsKeywordSearch(
  projection: TranscriptProjectionPort | null | undefined,
): projection is KeywordSearchableTranscriptProjection {
  return Boolean(projection && typeof (projection as KeywordSearchableTranscriptProjection).searchByKeywords === 'function');
}
