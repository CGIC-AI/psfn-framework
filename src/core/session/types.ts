export type SessionEntryRole = 'user' | 'assistant' | 'system' | 'tool';
export type JournalMarkerType = 'extraction' | 'graceful_shutdown';
export type JournalTombstoneTargetType = 'turn';
export type JournalTombstoneAction = 'redact' | 'restore';

export interface SessionEntry {
  id: number;
  channelId: string;
  role: SessionEntryRole;
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp: number;
  discordMessageId?: string;
  metadata?: string;
  originChannelId?: string;
  channelVisibility?: string;
}

export interface CompactionSummary {
  id: number;
  channelId: string;
  summary: string;
  coveredUpTo: number;
  createdAt: number;
}

/** A single line in a channel's JSONL session file. */
export interface JournalEntry {
  type: 'message' | 'compaction' | 'marker' | 'tombstone';
  id: number;
  channelId: string;
  // message fields
  role?: SessionEntryRole;
  content?: string;
  authorId?: string;
  authorName?: string;
  timestamp: number;
  discordMessageId?: string;
  metadata?: string;
  originChannelId?: string;
  channelVisibility?: string;
  // compaction fields
  summary?: string;
  // compaction + extraction marker fields
  coveredUpTo?: number;
  // marker fields
  marker?: JournalMarkerType;
  // tombstone fields
  tombstoneTargetType?: JournalTombstoneTargetType;
  tombstoneTargetId?: string;
  tombstoneAction?: JournalTombstoneAction;
  tombstoneActor?: string;
  tombstoneReason?: string;
  // integrity fields
  _hmac?: string;
  _hmacKeyVersion?: string;
}
