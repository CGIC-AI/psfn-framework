import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import {
  assertCrossProcessLockHeartbeat,
  startCrossProcessLockHeartbeat,
  stopCrossProcessLockHeartbeat,
  type CrossProcessLockHeartbeat,
} from './cross-process-lock-heartbeat.js';

const log = createComponentLogger('CrossProcessWriteLock');
const LOCK_OWNER_TOKEN_FILENAME = '.owner-token';
// Sub-millisecond/low-millisecond stale thresholds are shorter than a worker
// thread and filesystem scheduler can reliably service. Tokenized live locks
// therefore get a small bounded scheduling allowance. Legacy abandoned locks
// retain the caller's exact threshold so existing recovery behavior is not
// broadened silently.
const MIN_TOKENIZED_STALE_MS = 250;

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
  /** Optional synchronous cancellation check, invoked while waiting and before ownership work. */
  assertCanContinue?: () => void;
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
  ownerToken?: string;
}

export type RenewCrossProcessWriteLock = () => void;

function sameInstance(left: LockInstanceIdentity, right: LockInstanceIdentity): boolean {
  if (left.ino !== right.ino) return false;
  // Token-bearing locks use an unguessable immutable identity. Their mtime is
  // deliberately mutable because the independent heartbeat renews it, even
  // while release is crossing the worker-message boundary. Legacy/tokenless
  // locks retain the stricter inode+mtime identity check. Never treat a
  // missing token as a wildcard: a legacy observation cannot identify a
  // newly tokenized lock even if the filesystem reuses its inode and mtime.
  if (left.ownerToken !== undefined || right.ownerToken !== undefined) {
    return left.ownerToken !== undefined
      && right.ownerToken !== undefined
      && left.ownerToken === right.ownerToken;
  }
  return left.mtimeMs === right.mtimeMs;
}

function readOwnerToken(lockPath: string): string | undefined {
  try {
    return readFileSync(join(lockPath, LOCK_OWNER_TOKEN_FILENAME), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    throw error;
  }
}

function lockIdentity(lockPath: string): LockInstanceIdentity {
  // Read the immutable token before mutable/reusable directory metadata. If a
  // replacement lands between these reads, the snapshot carries the old
  // token with the new stat and therefore cannot match/delete the replacement.
  // Stat-first could instead combine a stale mtime with the replacement's
  // fresh token and incorrectly authorize reclamation after inode reuse.
  const ownerToken = readOwnerToken(lockPath);
  const stats = statSync(lockPath);
  return {
    ino: stats.ino,
    mtimeMs: stats.mtimeMs,
    ownerToken,
  };
}

function staleThreshold(identity: LockInstanceIdentity, staleMs: number): number {
  return identity.ownerToken === undefined
    ? staleMs
    : Math.max(staleMs, MIN_TOKENIZED_STALE_MS);
}

function reclaimPrefix(lockPath: string): string {
  return `${basename(lockPath)}.reclaim-`;
}

function reclaimTombstonePaths(lockPath: string): string[] {
  const prefix = reclaimPrefix(lockPath);
  return readdirSync(dirname(lockPath))
    .filter(filename => filename.startsWith(prefix))
    .sort()
    .map(filename => join(dirname(lockPath), filename));
}

function recoverAbandonedReclamation(lockPath: string, staleMs: number): boolean {
  const tombstones = reclaimTombstonePaths(lockPath);
  if (tombstones.length === 0) return false;
  // rename(2) updates ctime, so ctime measures the reclamation attempt rather
  // than the age of the stale lock that was moved. Never interfere with a
  // reclaimer still inside its bounded identity-check/restore window.
  for (const tombstone of tombstones) {
    try {
      const identity = lockIdentity(tombstone);
      if (Date.now() - statSync(tombstone).ctimeMs <= staleThreshold(identity, staleMs)) {
        return false;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true;
      throw error;
    }
  }

  if (existsSync(lockPath)) {
    const current = lockIdentity(lockPath);
    if (Date.now() - current.mtimeMs <= staleThreshold(current, staleMs)) return false;
    if (!removeLockInstance(lockPath, current)) return false;
  }

  try {
    renameSync(tombstones[0]!, lockPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EEXIST' || code === 'ENOTEMPTY') return false;
    throw error;
  }
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
  const observedTombstone = lockIdentity(tombstone);
  if (!sameInstance(observedTombstone, expected)) {
    // We grabbed a DIFFERENT instance. Keep the reclaim tombstone visible so
    // every acquirer backs off, wait for any mkdir that slipped through the
    // rename gap to notice that tombstone and relinquish, then restore without
    // overwriting a newer lock directory.
    const restoreDeadline = Date.now() + 1_000;
    while (existsSync(lockPath)) {
      if (Date.now() >= restoreDeadline) {
        throw new Error(`Timed out safely restoring a concurrently replaced lock at ${lockPath}`);
      }
      sleepSync(1);
    }
    renameSync(tombstone, lockPath);
    return false;
  }
  rmSync(tombstone, { recursive: true, force: true });
  return true;
}

function clearStaleLock(lockPath: string, staleMs: number): boolean {
  let observed: LockInstanceIdentity;
  try {
    const identity = lockIdentity(lockPath);
    if (Date.now() - identity.mtimeMs <= staleThreshold(identity, staleMs)) {
      return false;
    }
    observed = identity;
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
  operation: (renewLease: RenewCrossProcessWriteLock) => T,
): T {
  const deadline = Date.now() + options.timeoutMs;

  let owned: LockInstanceIdentity;
  for (;;) {
    options.assertCanContinue?.();
    const reclamationInProgress = reclaimTombstonePaths(lockPath).length > 0;
    if (reclamationInProgress) {
      if (recoverAbandonedReclamation(lockPath, options.staleMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for cross-process lock reclamation at ${lockPath}`);
      }
      sleepSync(options.pollMs);
      continue;
    }
    try {
      mkdirSync(lockPath);
      const ownerToken = randomUUID();
      writeFileSync(join(lockPath, LOCK_OWNER_TOKEN_FILENAME), ownerToken, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      owned = lockIdentity(lockPath);
      if (reclaimTombstonePaths(lockPath).length > 0) {
        removeLockInstance(lockPath, owned);
        sleepSync(options.pollMs);
        continue;
      }
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

  let heartbeat: CrossProcessLockHeartbeat;
  try {
    options.assertCanContinue?.();
    heartbeat = startCrossProcessLockHeartbeat({
      lockPath,
      ino: owned.ino,
      ownerToken: owned.ownerToken!,
      staleMs: options.staleMs,
    });
    const registeredAt = new Date();
    utimesSync(lockPath, registeredAt, registeredAt);
    const registered = lockIdentity(lockPath);
    if (registered.ino !== owned.ino || registered.ownerToken !== owned.ownerToken) {
      throw new Error(`Cross-process write lock was replaced during heartbeat startup at ${lockPath}`);
    }
    owned = registered;
  } catch (error) {
    removeLockInstance(lockPath, owned);
    throw error;
  }

  const renewLease = (): void => {
    assertCrossProcessLockHeartbeat(heartbeat, lockPath);
    let current: LockInstanceIdentity;
    try {
      current = lockIdentity(lockPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`Cross-process write lock was lost before renewal at ${lockPath}`);
      }
      throw error;
    }
    if (current.ino !== owned.ino || current.ownerToken !== owned.ownerToken) {
      throw new Error(`Cross-process write lock was replaced before renewal at ${lockPath}`);
    }

    const renewedAt = new Date();
    utimesSync(lockPath, renewedAt, renewedAt);
    const renewed = lockIdentity(lockPath);
    if (renewed.ino !== owned.ino || renewed.ownerToken !== owned.ownerToken) {
      throw new Error(`Cross-process write lock was replaced during renewal at ${lockPath}`);
    }
    owned = renewed;
  };

  let operationCompleted = false;
  let operationResult: T | undefined;
  let operationError: unknown;
  try {
    operationResult = operation(renewLease);
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }

  let releaseError: unknown;
  try {
    const heartbeatHealthy = Atomics.load(heartbeat.health, 0) !== -1;
    stopCrossProcessLockHeartbeat(heartbeat);
    try {
      const current = lockIdentity(lockPath);
      if (current.ino === owned.ino && current.ownerToken === owned.ownerToken) {
        owned = current;
      }
    } catch {
      // The identity-checked release below reports a lost lock.
    }
    // Release only the instance WE created. If the operation outlived
    // `staleMs` and a sibling reclaimed the lock, the path now holds someone
    // else's fresh lock — deleting it by bare path would hand two processes
    // the same lock. Warn loudly instead: mutual exclusion was already
    // violated for the tail of this operation and that must be visible.
    const released = removeLockInstance(lockPath, owned);
    if (!released) {
      log.warn('Cross-process write lock was reclaimed while held; a sibling presumed it stale', {
        lockPath,
        staleMs: options.staleMs,
      });
    }
    if (!heartbeatHealthy || !released) {
      throw new Error(`Cross-process write lock ownership was lost during operation at ${lockPath}`);
    }
  } catch (error) {
    releaseError = error;
  }

  if (!operationCompleted) {
    if (releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        `Cross-process write operation and lock release both failed at ${lockPath}`,
      );
    }
    throw operationError;
  }
  if (releaseError) throw releaseError;
  return operationResult as T;
}
