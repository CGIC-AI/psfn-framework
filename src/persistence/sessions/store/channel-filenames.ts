import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { readJournalFirstEntry } from '../../journals/journal-utils.js';
import {
  IMPORT_MANIFEST_FILENAME,
  formatDateUTC,
  READABLE_SESSION_FILENAME,
  ROLLED_SESSION_FILENAME,
  sanitizeChannelId,
  toSlug,
  type SessionFileSeed,
} from '../store-file-contracts.js';

const log = createComponentLogger('SessionStore');

export function isSessionJournalFilename(filename: string): boolean {
  return filename.endsWith('.jsonl')
    && !filename.startsWith('user_')
    && filename !== IMPORT_MANIFEST_FILENAME;
}

export function isReadableSessionJournalFilename(filename: string): boolean {
  return READABLE_SESSION_FILENAME.test(filename) || ROLLED_SESSION_FILENAME.test(filename);
}

export interface SessionSegmentFilename {
  rootFilename: string;
  segmentNumber: number;
}

export function parseSessionSegmentFilename(filename: string): SessionSegmentFilename {
  const rolled = ROLLED_SESSION_FILENAME.exec(filename);
  if (!rolled) {
    return { rootFilename: filename, segmentNumber: 1 };
  }
  return {
    rootFilename: `${rolled[1]}.jsonl`,
    segmentNumber: Number.parseInt(rolled[2], 10),
  };
}

export function makeRolledFilePath(firstFilePath: string, segmentNumber: number): string {
  if (!Number.isSafeInteger(segmentNumber) || segmentNumber < 2 || segmentNumber > 9_999) {
    throw new Error(`Invalid L0 session segment number: ${segmentNumber}`);
  }
  const base = firstFilePath.endsWith('.jsonl')
    ? firstFilePath.slice(0, -'.jsonl'.length)
    : firstFilePath;
  return `${base}.segment-${segmentNumber.toString().padStart(4, '0')}.jsonl`;
}

export function encodedFilePath(sessionsDir: string, channelId: string): string {
  return join(sessionsDir, sanitizeChannelId(channelId) + '.jsonl');
}

export function legacyFilePath(sessionsDir: string, channelId: string): string {
  const legacy = channelId.replace(/\//g, '_').replace(/:/g, '-');
  return join(sessionsDir, legacy + '.jsonl');
}

export function makeReadableFilePath(
  sessionsDir: string,
  channelId: string,
  seed: SessionFileSeed,
): string {
  const datePart = formatDateUTC(seed.timestamp);
  const channelPart = toSlug(channelId, 40);
  const userSource = seed.authorId ?? seed.authorName ?? 'unknown';
  const userPart = toSlug(userSource, 24);

  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
    const filename = `${datePart}_${channelPart}_${userPart}_${suffix}.jsonl`;
    const fp = join(sessionsDir, filename);
    if (!existsSync(fp)) return fp;
  }

  // Last-resort deterministic fallback (extremely unlikely to be needed).
  return encodedFilePath(sessionsDir, channelId);
}

export function readChannelIdFromFile(filePath: string): string | null {
  try {
    const entry = readJournalFirstEntry(filePath);
    if (!entry || !entry.channelId || typeof entry.channelId !== 'string') {
      return null;
    }
    return entry.channelId;
  } catch (err) {
    log.debug('Failed to read first journal entry', {
      path: filePath,
      error: toErrorMessage(err),
    });
    return null;
  }
}

export {
  READABLE_SESSION_FILENAME,
};
