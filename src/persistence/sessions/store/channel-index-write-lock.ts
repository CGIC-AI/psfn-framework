import { withCrossProcessWriteLock } from '../cross-process-write-lock.js';

const CHANNEL_INDEX_LOCK_POLL_MS = 10;
const CHANNEL_INDEX_LOCK_STALE_MS = 30_000;
const CHANNEL_INDEX_LOCK_TIMEOUT_MS = 5_000;

export function withChannelIndexWriteLock<T>(
  channelIndexPath: string,
  operation: () => T,
): T {
  return withCrossProcessWriteLock(`${channelIndexPath}.write-lock`, {
    pollMs: CHANNEL_INDEX_LOCK_POLL_MS,
    staleMs: CHANNEL_INDEX_LOCK_STALE_MS,
    timeoutMs: CHANNEL_INDEX_LOCK_TIMEOUT_MS,
  }, operation);
}
