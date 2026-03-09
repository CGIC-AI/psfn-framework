import type { CompactionSummary, JournalEntry, SessionEntry } from '../types.js';
import type { JournalMarkerEntry, JournalTurnTombstoneEntry } from './types.js';
import { parseTurnId } from '../../turns/id.js';

export function journalToSessionEntry(entry: JournalEntry): SessionEntry | null {
  if (entry.type !== 'message') {
    return null;
  }

  return {
    id: entry.id,
    channelId: entry.channelId,
    role: entry.role!,
    content: entry.content!,
    authorId: entry.authorId,
    authorName: entry.authorName,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId,
    metadata: entry.metadata,
    originChannelId: entry.originChannelId,
    channelVisibility: entry.channelVisibility,
  };
}

export function journalToCompactionSummary(entry: JournalEntry): CompactionSummary | null {
  if (entry.type !== 'compaction') {
    return null;
  }

  return {
    id: entry.id,
    channelId: entry.channelId,
    summary: entry.summary!,
    coveredUpTo: entry.coveredUpTo!,
    createdAt: entry.timestamp,
  };
}

export function journalToMarkerEntry(entry: JournalEntry): JournalMarkerEntry | null {
  if (entry.type !== 'marker') return null;
  if (entry.marker !== 'extraction' && entry.marker !== 'graceful_shutdown') return null;

  return {
    id: entry.id,
    channelId: entry.channelId,
    marker: entry.marker,
    timestamp: entry.timestamp,
    coveredUpTo: entry.coveredUpTo,
  };
}

export function journalToTurnTombstoneEntry(entry: JournalEntry): JournalTurnTombstoneEntry | null {
  if (entry.type !== 'tombstone') return null;
  if (entry.tombstoneTargetType !== 'turn') return null;
  const parsedTurnId = parseTurnId(entry.tombstoneTargetId, 'tombstoneTargetId');
  if (!parsedTurnId) return null;
  if (entry.tombstoneAction !== 'redact' && entry.tombstoneAction !== 'restore') return null;

  return {
    id: entry.id,
    channelId: entry.channelId,
    targetType: 'turn',
    targetId: parsedTurnId,
    action: entry.tombstoneAction,
    timestamp: entry.timestamp,
    ...(typeof entry.tombstoneActor === 'string' && entry.tombstoneActor.trim().length > 0
      ? { actor: entry.tombstoneActor.trim() }
      : {}),
    ...(typeof entry.tombstoneReason === 'string' && entry.tombstoneReason.trim().length > 0
      ? { reason: entry.tombstoneReason.trim() }
      : {}),
  };
}

export function buildMessageJournalEntry(id: number, entry: Omit<SessionEntry, 'id'>): JournalEntry {
  return {
    type: 'message',
    id,
    channelId: entry.channelId,
    role: entry.role,
    content: entry.content,
    authorId: entry.authorId,
    authorName: entry.authorName,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId,
    metadata: entry.metadata,
    originChannelId: entry.originChannelId,
    channelVisibility: entry.channelVisibility,
  };
}

export function buildCompactionJournalEntry(
  id: number,
  channelId: string,
  summary: string,
  coveredUpTo: number,
  timestamp: number,
): JournalEntry {
  return {
    type: 'compaction',
    id,
    channelId,
    summary,
    coveredUpTo,
    timestamp,
  };
}

export function buildExtractionMarkerJournalEntry(
  id: number,
  channelId: string,
  coveredUpTo: number,
  timestamp: number,
): JournalEntry {
  return {
    type: 'marker',
    id,
    channelId,
    marker: 'extraction',
    coveredUpTo,
    timestamp,
  };
}

export function buildGracefulShutdownMarkerJournalEntry(
  id: number,
  channelId: string,
  timestamp: number,
): JournalEntry {
  return {
    type: 'marker',
    id,
    channelId,
    marker: 'graceful_shutdown',
    timestamp,
  };
}

export function buildTurnTombstoneJournalEntry(
  id: number,
  channelId: string,
  params: {
    turnId: string;
    action: 'redact' | 'restore';
    timestamp: number;
    actor?: string;
    reason?: string;
  },
): JournalEntry {
  return {
    type: 'tombstone',
    id,
    channelId,
    timestamp: params.timestamp,
    tombstoneTargetType: 'turn',
    tombstoneTargetId: params.turnId,
    tombstoneAction: params.action,
    ...(typeof params.actor === 'string' && params.actor.trim().length > 0
      ? { tombstoneActor: params.actor.trim() }
      : {}),
    ...(typeof params.reason === 'string' && params.reason.trim().length > 0
      ? { tombstoneReason: params.reason.trim() }
      : {}),
  };
}
