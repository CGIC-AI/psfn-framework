import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import {
  removeLockInstance,
  withCrossProcessWriteLock,
  type LockInstanceIdentity,
} from './cross-process-write-lock.js';
import {
  startCrossProcessLockHeartbeat,
  stopCrossProcessLockHeartbeat,
} from './cross-process-lock-heartbeat.js';

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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for lock child: ${path}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
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

  it('recovers an abandoned stale-reclaim tombstone instead of wedging forever', () => {
    mkdirSync(lockPath);
    backdate(lockPath, 60);
    const tombstonePath = `${lockPath}.reclaim-dead-worker`;
    renameSync(lockPath, tombstonePath);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);

    const result = withCrossProcessWriteLock(
      lockPath,
      { pollMs: 2, staleMs: 10, timeoutMs: 100 },
      () => 'recovered tombstone',
    );

    expect(result).toBe('recovered tombstone');
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(tombstonePath)).toBe(false);
  });

  it('renews a long-running lock so a contender cannot reclaim it after staleMs', () => {
    const shortLease = { pollMs: 2, staleMs: 50, timeoutMs: 10 };
    withCrossProcessWriteLock(lockPath, shortLease, (renewLease) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
      renewLease();

      expect(() => withCrossProcessWriteLock(lockPath, shortLease, () => 'never'))
        .toThrow(/Timed out acquiring cross-process write lock/);
    });
    expect(existsSync(lockPath)).toBe(false);
  });

  it('automatically keeps a child-process lease exclusive while synchronous work exceeds staleMs', async () => {
    const markerPath = join(dir, 'lease-ready.marker');
    const childSource = `
      (async () => {
        const { writeFileSync } = await import('node:fs');
        const { withCrossProcessWriteLock } = await import(process.env.LOCK_MODULE_URL);
        for (let index = 0; index < 500; index += 1) {
          withCrossProcessWriteLock(process.env.LOCK_PATH + '.warmup', { pollMs: 2, staleMs: 40, timeoutMs: 100 }, () => undefined);
        }
        withCrossProcessWriteLock(process.env.LOCK_PATH, { pollMs: 1, staleMs: 1, timeoutMs: 100 }, () => {
          writeFileSync(process.env.MARKER_PATH, 'ready', 'utf8');
          for (let index = 0; index < 30; index += 1) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
          }
        });
      })();
    `;
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      '--eval',
      childSource,
    ], {
      env: {
        ...process.env,
        LOCK_MODULE_URL: new URL('./cross-process-write-lock.ts', import.meta.url).href,
        LOCK_PATH: lockPath,
        MARKER_PATH: markerPath,
      },
      stdio: 'ignore',
    });
    const childExit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    try {
      await waitForFile(markerPath);
      expect(() => withCrossProcessWriteLock(
        lockPath,
        { pollMs: 1, staleMs: 1, timeoutMs: 300 },
        () => 'never',
      )).toThrow(/Timed out acquiring cross-process write lock/);
    } finally {
      await childExit;
    }
    expect(existsSync(lockPath)).toBe(false);
  });

  it('registers the independent heartbeat before returning to synchronous operation code', () => {
    mkdirSync(lockPath);
    const ownerToken = 'heartbeat-registration-owner';
    writeFileSync(join(lockPath, '.owner-token'), ownerToken, 'utf8');
    const identity = identityOf(lockPath);

    const heartbeat = startCrossProcessLockHeartbeat({
      lockPath,
      ino: identity.ino,
      ownerToken,
      staleMs: 1,
    });
    expect(Atomics.load(heartbeat.health, 0)).toBe(1);
    stopCrossProcessLockHeartbeat(heartbeat);
  });

  it('release never deletes a sibling lock that reclaimed ours mid-operation', () => {
    expect(() => withCrossProcessWriteLock(lockPath, OPTIONS, () => {
      // Simulate a sibling that presumed our lock stale, reclaimed it, and
      // acquired its own instance at the same path (direct fs calls stand in
      // for the other process). Backdating guarantees the identity differs
      // even if the filesystem reuses the inode.
      rmSync(lockPath, { recursive: true, force: true });
      mkdirSync(lockPath);
      backdate(lockPath, 30);
    })).toThrow(/lock ownership was lost/);
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

  it('never lets a tokenless observation identify a tokenized replacement', () => {
    mkdirSync(lockPath);
    const tokenlessObservation = identityOf(lockPath);
    writeFileSync(join(lockPath, '.owner-token'), 'replacement-owner', 'utf8');

    expect(removeLockInstance(lockPath, tokenlessObservation)).toBe(false);
    expect(existsSync(lockPath)).toBe(true);
  });

  it('returns false when the lock is already gone', () => {
    expect(removeLockInstance(lockPath, { ino: 1, mtimeMs: 1 })).toBe(false);
  });
});
