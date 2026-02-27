import type { JournalEntry, JournalMarkerType } from '../types.js';

export interface QuarantinedJournalEntry {
  lineNumber: number;
  error: string;
  raw: string;
}

export interface ReadJournalResult {
  entries: JournalEntry[];
  maxId: number;
  quarantined: QuarantinedJournalEntry[];
}

export interface ReadJournalFileOptions {
  persistQuarantine?: boolean;
}

export interface ScanJournalMetadataOptions {
  persistQuarantine?: boolean;
}

export interface JournalFileMetadata {
  entryCount: number;
  maxId: number;
  messageCount: number;
  lastTimestamp: number;
  lastHmac: string | null;
  lastEntry: JournalEntry | null;
  lastExtractionCoveredUpTo: number;
  quarantined: QuarantinedJournalEntry[];
}

export interface ReadJournalTailOptions {
  messageLimit: number;
  includeBoundaryEntry?: boolean;
}

export interface ReadJournalTailResult {
  entries: JournalEntry[];
  quarantined: QuarantinedJournalEntry[];
  truncated: boolean;
}

export interface SessionHmacKeyring {
  activeVersion: string;
  keys: Record<string, string>;
}

export interface SessionHmacKeyringInput {
  serializedKeys?: string;
  singleKey?: string;
  activeVersion?: string;
  defaultVersion?: string;
}

export interface JournalIntegrityVerificationResult {
  verified: boolean;
  observedHmac: string | null;
  reason?: string;
}

export interface JournalMarkerEntry {
  id: number;
  channelId: string;
  marker: JournalMarkerType;
  timestamp: number;
  coveredUpTo?: number;
}

export interface LegacyChatSourceRecord {
  sourceIndex: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  authorId?: string;
  authorName?: string;
  metadata?: string;
  originChannelId?: string;
  channelVisibility?: string;
}

export type LegacyChatSourceFormat = 'jsonl' | 'json-array' | 'json-messages';

export interface ParsedLegacyChatSource {
  format: LegacyChatSourceFormat;
  sourceHash: string;
  records: LegacyChatSourceRecord[];
}
