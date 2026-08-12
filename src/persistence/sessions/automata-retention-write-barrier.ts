import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { ExactSessionPurgeInput } from '../../faculties/automata/retention-contract.js';
import type { ExactSessionPurgeResolvedTarget } from '../../faculties/automata/production-exact-session-purge.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import { isSessionJournalFilename } from './store/channel-filenames.js';
import {
  fsyncDirectorySync,
  writeFileDurableAtomicSync,
} from '../../shared/utils/fs.js';

const BARRIER_DIR = '_automata_retention_write_barriers';

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Automata session write barrier ${field} cannot be empty`);
  return normalized;
}

function markerName(companionId: string, sessionIdentity: string): string {
  return createHash('sha256')
    .update(companionId)
    .update('\0')
    .update(sessionIdentity)
    .digest('hex');
}

/** Durable content-free seal checked by every canonical raw-session writer. */
export class FilesystemAutomataRetentionWriteBarrier {
  private readonly sessionsDir: string;
  private readonly companionId: string;
  private readonly markerDir: string;

  constructor(sessionsDir: string, companionId: string) {
    this.sessionsDir = resolve(sessionsDir);
    this.companionId = requiredText(companionId, 'companionId');
    this.markerDir = join(this.sessionsDir, BARRIER_DIR);
  }

  assertWritable(sessionIdentities: readonly string[]): void {
    for (const identity of sessionIdentities) {
      const normalized = requiredText(identity, 'session identity');
      if (existsSync(this.markerPath(normalized))) {
        throw new Error('Automata raw session is permanently sealed for retention cleanup');
      }
    }
  }

  seal(input: ExactSessionPurgeInput, target: ExactSessionPurgeResolvedTarget): void {
    if (input.companionId !== this.companionId) {
      throw new Error('Automata session write barrier companion scope mismatch');
    }
    const sessionId = requiredText(input.sessionId, 'sessionId');
    const channelId = requiredText(target.channelId, 'channelId');
    const activeJournalFilename = requiredText(
      target.activeJournalFilename,
      'activeJournalFilename',
    );
    if (
      activeJournalFilename !== basename(activeJournalFilename)
      || !isSessionJournalFilename(activeJournalFilename)
    ) {
      throw new Error('Automata session write barrier received an unsafe journal filename');
    }
    const activePath = join(this.sessionsDir, activeJournalFilename);
    withSessionJournalWriteLock(activePath, () => {
      for (const identity of new Set([sessionId, channelId])) {
        const path = this.markerPath(identity);
        if (existsSync(path)) {
          fsyncDirectorySync(this.markerDir);
          continue;
        }
        writeFileDurableAtomicSync(path, '', { exclusive: true });
      }
    });
  }

  private markerPath(sessionIdentity: string): string {
    return join(this.markerDir, markerName(this.companionId, sessionIdentity));
  }
}
