export type SessionEntryRole = 'user' | 'assistant' | 'system' | 'tool';

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

export type JournalMarkerType = 'extraction' | 'graceful_shutdown';

/** A single line in a channel's JSONL session file. */
export interface JournalEntry {
  type: 'message' | 'compaction' | 'marker';
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
  // integrity fields
  _hmac?: string;
  _hmacKeyVersion?: string;
}
