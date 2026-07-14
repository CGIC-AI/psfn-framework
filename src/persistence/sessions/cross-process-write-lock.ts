import { mkdirSync, rmSync, statSync } from 'node:fs';

/**
 * Cross-process advisory write lock built on `mkdirSync` (atomic on POSIX:
 * exactly one caller creates the directory, everyone else gets EEXIST).
 * Extracted from the session-journal write path (psfn-framework-hgw3.1) so the
 * turn-record rotation path can serialize against sibling processes with the
 * SAME mechanism: agent, gateway, and garden all mount the sessions dir.
 *
 * Stale-lock recovery: a lock older than `staleMs` is presumed abandoned by a
 * crashed process and removed. Acquisition that cannot succeed within
 * `timeoutMs` fails loudly — never silently proceeding without the lock.
 */

export interface CrossProcessWriteLockOptions {
  /** Poll interval while waiting for a held lock. */
  pollMs: number;
  /** Age after which a held lock is presumed abandoned and cleared. */
  staleMs: number;
  /** Total time to wait for acquisition before failing loudly. */
  timeoutMs: number;
}

const SLEEP_STATE = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(SLEEP_STATE, 0, 0, ms);
}

function clearStaleLock(lockPath: string, staleMs: number): boolean {
  try {
    const stats = statSync(lockPath);
    if (Date.now() - stats.mtimeMs <= staleMs) {
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }

  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

export function withCrossProcessWriteLock<T>(
  lockPath: string,
  options: CrossProcessWriteLockOptions,
  operation: () => T,
): T {
  const deadline = Date.now() + options.timeoutMs;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      if (clearStaleLock(lockPath, options.staleMs)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring cross-process write lock at ${lockPath}`);
      }
      sleepSync(options.pollMs);
    }
  }

  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}
