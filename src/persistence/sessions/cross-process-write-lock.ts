import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('CrossProcessWriteLock');

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
 *
 * Reclamation is ATOMIC (hgw3 review round 2): a bare `rmSync(lockPath)` lets
 * two waiters both decide the lock is stale, one reclaim + re-acquire, and
 * the other's rmSync delete the NEW owner's fresh lock. Instead, a reclaimer
 * first `renameSync`s the lock dir to a unique tombstone name — exactly one
 * contender wins the rename (the loser gets ENOENT and re-polls) — then
 * verifies via inode + mtime that the tombstoned dir is the SAME stale
 * instance it observed. A mismatch (the path was recycled into a fresh lock
 * between stat and rename) is restored by renaming the tombstone back, so a
 * live owner's lock is never deleted. Release uses the same identity check:
 * an owner only removes the exact lock instance it created.
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

/** Identity of one concrete lock-directory instance at a path. */
export interface LockInstanceIdentity {
  ino: number;
  mtimeMs: number;
}

function sameInstance(left: LockInstanceIdentity, right: LockInstanceIdentity): boolean {
  return left.ino === right.ino && left.mtimeMs === right.mtimeMs;
}

/**
 * Atomically take the lock dir off its path and remove it, but ONLY if it is
 * still the exact instance identified by `expected`. Returns true when this
 * caller removed that instance; false when the path was already gone (another
 * contender won the rename race) or held a DIFFERENT instance (a fresh lock —
 * restored untouched). Exported for the reclamation-race tests.
 */
export function removeLockInstance(lockPath: string, expected: LockInstanceIdentity): boolean {
  // Unique sibling name: rename stays on the same filesystem and exactly one
  // renamer of a given source wins; the loser's rename throws ENOENT.
  const tombstone = `${lockPath}.reclaim-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, tombstone);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }
  const stats = statSync(tombstone);
  if (!sameInstance({ ino: stats.ino, mtimeMs: stats.mtimeMs }, expected)) {
    // We grabbed a DIFFERENT instance (the path was reclaimed and re-acquired
    // between our stat and our rename): put the live owner's lock back
    // exactly as it was and report that we removed nothing.
    renameSync(tombstone, lockPath);
    return false;
  }
  rmSync(tombstone, { recursive: true, force: true });
  return true;
}

function clearStaleLock(lockPath: string, staleMs: number): boolean {
  let observed: LockInstanceIdentity;
  try {
    const stats = statSync(lockPath);
    if (Date.now() - stats.mtimeMs <= staleMs) {
      return false;
    }
    observed = { ino: stats.ino, mtimeMs: stats.mtimeMs };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }

  return removeLockInstance(lockPath, observed);
}

export function withCrossProcessWriteLock<T>(
  lockPath: string,
  options: CrossProcessWriteLockOptions,
  operation: () => T,
): T {
  const deadline = Date.now() + options.timeoutMs;

  let owned: LockInstanceIdentity;
  for (;;) {
    try {
      mkdirSync(lockPath);
      const stats = statSync(lockPath);
      owned = { ino: stats.ino, mtimeMs: stats.mtimeMs };
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
    // Release only the instance WE created. If the operation outlived
    // `staleMs` and a sibling reclaimed the lock, the path now holds someone
    // else's fresh lock — deleting it by bare path would hand two processes
    // the same lock. Warn loudly instead: mutual exclusion was already
    // violated for the tail of this operation and that must be visible.
    if (!removeLockInstance(lockPath, owned)) {
      log.warn('Cross-process write lock was reclaimed while held; a sibling presumed it stale', {
        lockPath,
        staleMs: options.staleMs,
      });
    }
  }
}
