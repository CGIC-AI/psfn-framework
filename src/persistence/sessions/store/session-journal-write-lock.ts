import {
  withCrossProcessWriteLock,
  type RenewCrossProcessWriteLock,
} from '../cross-process-write-lock.js';

const JOURNAL_WRITE_LOCK_SUFFIX = '.write-lock';
const JOURNAL_WRITE_LOCK_POLL_MS = 10;
const JOURNAL_WRITE_LOCK_STALE_MS = 30_000;
const JOURNAL_WRITE_LOCK_TIMEOUT_MS = 5_000;

export function withSessionJournalWriteLock<T>(
  rootFilePath: string,
  operation: (renewLease: RenewCrossProcessWriteLock) => T,
): T {
  return withCrossProcessWriteLock(`${rootFilePath}${JOURNAL_WRITE_LOCK_SUFFIX}`, {
    pollMs: JOURNAL_WRITE_LOCK_POLL_MS,
    staleMs: JOURNAL_WRITE_LOCK_STALE_MS,
    timeoutMs: JOURNAL_WRITE_LOCK_TIMEOUT_MS,
  }, operation);
}

export type RenewSessionJournalWriteLock = RenewCrossProcessWriteLock;
