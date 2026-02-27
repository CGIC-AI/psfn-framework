import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../utils/errors.js';
import { readJournalFirstEntry } from '../journal-utils.js';
import {
  IMPORT_MANIFEST_FILENAME,
  READABLE_SESSION_FILENAME,
  formatDateUTC,
  sanitizeChannelId,
  toSlug,
  type SessionFileSeed,
} from '../store-primitives.js';

const log = createComponentLogger('SessionStore');

export function isSessionJournalFilename(filename: string): boolean {
  return filename.endsWith('.jsonl')
    && !filename.startsWith('user_')
    && filename !== IMPORT_MANIFEST_FILENAME;
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
