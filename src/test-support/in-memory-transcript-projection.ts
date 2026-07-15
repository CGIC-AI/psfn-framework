import { isCogSecTombstoneSessionEntry } from '../core/cogsec/tombstones.js';
import type { SessionEntry } from '../core/session/types.js';
import {
  type KeywordSearchableTranscriptProjection,
  type SessionSearchHit,
  type TranscriptProjectionDrift,
  type TranscriptSearchOptions,
} from '../persistence/sessions/transcript-projection-port.js';
import { classifyChannelDisclosure } from '../system/trust/policy.js';
import { decodeStoredChannelVisibility } from '../system/trust/types.js';

interface ProjectedEntry extends SessionEntry {
  channelId: string;
}

function searchTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (offset < haystack.length) {
    const foundAt = haystack.indexOf(needle, offset);
    if (foundAt < 0) break;
    count += 1;
    offset = foundAt + needle.length;
  }
  return count;
}

/**
 * Deterministic test implementation of the active transcript projection port.
 * JSONL remains authoritative; this helper only models the replace/upsert,
 * drift, keyword-ranking, channel-scope, and CogSec tombstone behavior that a
 * SessionStore consumer can observe from the production Postgres projection.
 */
export class InMemoryTranscriptProjection implements KeywordSearchableTranscriptProjection {
  private readonly entriesByChannel = new Map<string, Map<number, ProjectedEntry>>();
  private readonly driftByChannel = new Map<string, TranscriptProjectionDrift>();

  upsertSessionEntry(entry: SessionEntry, options: { channelId?: string } = {}): void {
    const channelId = options.channelId ?? entry.channelId;
    const entries = this.entriesByChannel.get(channelId) ?? new Map<number, ProjectedEntry>();
    if (isCogSecTombstoneSessionEntry(entry)) {
      entries.delete(entry.id);
    } else {
      entries.set(entry.id, { ...entry, channelId });
    }
    this.entriesByChannel.set(channelId, entries);
    this.driftByChannel.delete(channelId);
  }

  replaceChannelEntries(channelId: string, entries: readonly SessionEntry[]): void {
    const projected = new Map<number, ProjectedEntry>();
    for (const entry of entries) {
      if (!isCogSecTombstoneSessionEntry(entry)) {
        projected.set(entry.id, { ...entry, channelId });
      }
    }
    this.entriesByChannel.set(channelId, projected);
    this.driftByChannel.delete(channelId);
  }

  countProjectedMessages(channelId: string): number {
    return this.entriesByChannel.get(channelId)?.size ?? 0;
  }

  markProjectionDrift(channelId: string, reason?: string): void {
    this.driftByChannel.set(channelId, {
      channelId,
      ...(reason ? { reason } : {}),
      markedAt: Date.now(),
    });
  }

  clearProjectionDrift(channelId: string): void {
    this.driftByChannel.delete(channelId);
  }

  listProjectionDrift(): TranscriptProjectionDrift[] {
    return [...this.driftByChannel.values()].sort((left, right) => (
      right.markedAt - left.markedAt || left.channelId.localeCompare(right.channelId)
    ));
  }

  async searchByKeywords(
    query: string,
    limit = 10,
    options: TranscriptSearchOptions = {},
  ): Promise<SessionSearchHit[]> {
    const terms = searchTerms(query);
    if (terms.length === 0) return [];
    const boundedLimit = Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), 100)
      : 10;
    const channels = options.channelId
      ? [[options.channelId, this.entriesByChannel.get(options.channelId)]] as const
      : [...this.entriesByChannel.entries()];

    const hits: SessionSearchHit[] = [];
    for (const [channelId, entries] of channels) {
      for (const entry of entries?.values() ?? []) {
        const normalizedContent = entry.content.toLowerCase();
        if (!terms.every(term => normalizedContent.includes(term))) continue;
        const score = terms.reduce(
          (total, term) => total + countOccurrences(normalizedContent, term),
          0,
        );
        hits.push({
          channelId,
          messageId: entry.id,
          role: entry.role,
          ...(entry.authorId ? { authorId: entry.authorId } : {}),
          ...(entry.authorName ? { authorName: entry.authorName } : {}),
          content: entry.content,
          timestamp: entry.timestamp,
          channelVisibility: decodeStoredChannelVisibility(entry.channelVisibility)
            ?? classifyChannelDisclosure(channelId).channelPrivacy,
          score,
          snippet: entry.content,
        });
      }
    }

    return hits
      .sort((left, right) => (
        right.score - left.score
        || right.timestamp - left.timestamp
        || right.messageId - left.messageId
      ))
      .slice(0, boundedLimit);
  }
}

export function createInMemoryTranscriptProjection(): InMemoryTranscriptProjection {
  return new InMemoryTranscriptProjection();
}
