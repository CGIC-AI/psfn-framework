import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  removeLockInstance,
  withCrossProcessWriteLock,
  type LockInstanceIdentity,
} from './cross-process-write-lock.js';

const OPTIONS = { pollMs: 5, staleMs: 1_000, timeoutMs: 250 };

function identityOf(path: string): LockInstanceIdentity {
  const stats = statSync(path);
  return { ino: stats.ino, mtimeMs: stats.mtimeMs };
}

/** Backdate a directory's mtime so the lock reads as stale/distinct. */
function backdate(path: string, secondsAgo: number): void {
  const then = new Date(Date.now() - secondsAgo * 1_000);
  utimesSync(path, then, then);
}

describe('withCrossProcessWriteLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-write-lock-'));
    lockPath = join(dir, 'fixture.jsonl.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('acquires, runs the operation, returns its result, and releases', () => {
    const result = withCrossProcessWriteLock(lockPath, OPTIONS, () => {
      expect(existsSync(lockPath)).toBe(true);
      return 'operation-result';
    });
    expect(result).toBe('operation-result');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('fails loudly on timeout while a FRESH lock is held (never proceeds without the lock)', () => {
    mkdirSync(lockPath);
    expect(() => withCrossProcessWriteLock(lockPath, { ...OPTIONS, timeoutMs: 40 }, () => 'never'))
      .toThrow(/Timed out acquiring cross-process write lock/);
    // The holder's lock was not disturbed.
    expect(existsSync(lockPath)).toBe(true);
  });

  it('reclaims a STALE lock (crashed holder) and acquires', () => {
    mkdirSync(lockPath);
    backdate(lockPath, 60);
    const result = withCrossProcessWriteLock(lockPath, OPTIONS, () => 'reclaimed');
    expect(result).toBe('reclaimed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('release never deletes a sibling lock that reclaimed ours mid-operation', () => {
    withCrossProcessWriteLock(lockPath, OPTIONS, () => {
      // Simulate a sibling that presumed our lock stale, reclaimed it, and
      // acquired its own instance at the same path (direct fs calls stand in
      // for the other process). Backdating guarantees the identity differs
      // even if the filesystem reuses the inode.
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      backdate(lockPath, 30);
    });
    // Our release must NOT have removed the sibling's live lock.
    expect(existsSync(lockPath)).toBe(true);
  });
});

describe('removeLockInstance (atomic stale-lock reclamation)', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-write-lock-reclaim-'));
    lockPath = join(dir, 'fixture.jsonl.lock');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('two contenders observing the same stale lock: exactly one reclaims, the loser is a no-op', () => {
    mkdirSync(lockPath);
    backdate(lockPath, 60);
    const observed = identityOf(lockPath);

    // Both contenders decided the lock is stale from the SAME observation.
    expect(removeLockInstance(lockPath, observed)).toBe(true);
    // The loser's rename hits ENOENT: nothing to double-delete.
    expect(removeLockInstance(lockPath, observed)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("the loser can never delete the winner's fresh lock (identity mismatch restores it)", () => {
    mkdirSync(lockPath);
    backdate(lockPath, 60);
    const staleObservedByLoser = identityOf(lockPath);

    // Winner reclaims the stale lock and ACQUIRES a fresh one at the path.
    expect(removeLockInstance(lockPath, staleObservedByLoser)).toBe(true);
    mkdirSync(lockPath);
    const winnersLock = identityOf(lockPath);

    // Loser still acts on its old observation. With a bare rm-by-path this
    // would delete the winner's live lock; the identity check must instead
    // restore the lock untouched and report failure.
    expect(removeLockInstance(lockPath, staleObservedByLoser)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
    expect(identityOf(lockPath)).toEqual(winnersLock);
  });

  it('returns false when the lock is already gone', () => {
    expect(removeLockInstance(lockPath, { ino: 1, mtimeMs: 1 })).toBe(false);
  });
});
