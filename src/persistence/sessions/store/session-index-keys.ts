import type { ChannelIndexEntry } from '../store-primitives.js';
import {
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalString,
} from '../store-primitives.js';

function sessionSuffix(filename: string): string {
  return filename.endsWith('.jsonl')
    ? filename.slice(0, -'.jsonl'.length)
    : filename;
}

export function sessionIdForChannelFile(
  channelId: string,
  filename: string,
  hasMultipleSessions: boolean,
): string {
  return hasMultipleSessions
    ? `${channelId}#${sessionSuffix(filename)}`
    : channelId;
}

export function indexedChannelId(sessionId: string, entry: ChannelIndexEntry): string {
  return normalizeOptionalString(entry.channelId) ?? sessionId;
}

export function findSessionIdByFilename(
  filename: string,
  channelIndex: ReadonlyMap<string, ChannelIndexEntry>,
): string | null {
  for (const [sessionId, entry] of channelIndex.entries()) {
    if (entry.filename === filename) {
      return sessionId;
    }
  }
  return null;
}

export function deriveSessionIndexId(
  channelId: string,
  filename: string,
  channelIndex: ReadonlyMap<string, ChannelIndexEntry>,
): string {
  const existingByFile = findSessionIdByFilename(filename, channelIndex);
  const matchingSessions = [...channelIndex.entries()].filter(([sessionId, entry]) => (
    indexedChannelId(sessionId, entry) === channelId
  ));
  const hasMultipleSessions = (
    matchingSessions.some(([, entry]) => entry.filename !== filename)
    || matchingSessions.length > 1
  );

  if (existingByFile && !(existingByFile === channelId && hasMultipleSessions)) {
    return existingByFile;
  }

  if (!hasMultipleSessions && !existingByFile) {
    return channelId;
  }

  const base = sessionIdForChannelFile(channelId, filename, true);
  if (!channelIndex.has(base)) {
    return base;
  }

  let suffix = 2;
  while (channelIndex.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function resolvePrimarySessionId(
  lookupKey: string,
  channelIndex: ReadonlyMap<string, ChannelIndexEntry>,
): string | null {
  const exactEntry = channelIndex.get(lookupKey);
  if (exactEntry && indexedChannelId(lookupKey, exactEntry) !== lookupKey) {
    return lookupKey;
  }

  let bestSessionId: string | null = null;
  let bestTimestamp = -1;
  for (const [sessionId, entry] of channelIndex.entries()) {
    if (indexedChannelId(sessionId, entry) !== lookupKey) continue;
    const timestamp = normalizeOptionalNonNegativeNumber(entry.lastTimestamp) ?? -1;
    if (
      bestSessionId === null
      || timestamp > bestTimestamp
      || (timestamp === bestTimestamp && sessionId.localeCompare(bestSessionId) < 0)
    ) {
      bestSessionId = sessionId;
      bestTimestamp = timestamp;
    }
  }
  return bestSessionId;
}
