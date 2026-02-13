export interface SessionEntry {
  id: number;
  channelId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp: number;
  metadata?: string;
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
  type: 'message' | 'compaction';
  id: number;
  channelId: string;
  // message fields
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  authorId?: string;
  authorName?: string;
  timestamp: number;
  metadata?: string;
  // compaction fields
  summary?: string;
  coveredUpTo?: number;
}
