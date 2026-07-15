import type { SessionEntry } from '../../../core/session/types.js';
import type { ChannelCache } from '../store-primitives.js';

const DEFAULT_MESSAGE_PREVIEW_CHARS = 120;

function toMessagePreview(content: string, maxChars = DEFAULT_MESSAGE_PREVIEW_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function applyLastMessageMetadata(
  cache: ChannelCache,
  entry: Pick<SessionEntry, 'timestamp' | 'role' | 'authorName' | 'content'>,
): void {
  cache.lastMessageTimestamp = entry.timestamp;
  cache.lastMessageRole = entry.role;
  cache.lastMessageAuthorName = entry.authorName;
  cache.lastMessagePreview = toMessagePreview(entry.content);
}

export function syncLastMessageMetadataFromEntries(cache: ChannelCache): void {
  const lastEntry = cache.entries.at(-1);
  if (lastEntry) {
    applyLastMessageMetadata(cache, lastEntry);
    return;
  }
  cache.lastMessageTimestamp = 0;
  cache.lastMessageRole = null;
  cache.lastMessageAuthorName = undefined;
  cache.lastMessagePreview = '';
}
