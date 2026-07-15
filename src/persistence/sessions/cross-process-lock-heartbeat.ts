import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const WORKER_SOURCE = String.raw`
  const { parentPort } = require('node:worker_threads');
  const { readFileSync, statSync, utimesSync } = require('node:fs');
  const { join } = require('node:path');
  const leases = new Map();

  function signal(control, status) {
    Atomics.store(control, 0, status);
    Atomics.notify(control, 0);
  }

  function renew(lease) {
    try {
      const before = statSync(lease.lockPath);
      if (before.ino !== lease.ino) throw new Error('lock inode changed');
      if (readFileSync(join(lease.lockPath, '.owner-token'), 'utf8') !== lease.ownerToken) {
        throw new Error('lock owner token changed');
      }
      const now = new Date();
      utimesSync(lease.lockPath, now, now);
      const after = statSync(lease.lockPath);
      if (after.ino !== lease.ino) throw new Error('lock inode changed during heartbeat');
      if (readFileSync(join(lease.lockPath, '.owner-token'), 'utf8') !== lease.ownerToken) {
        throw new Error('lock owner token changed during heartbeat');
      }
    } catch {
      clearInterval(lease.timer);
      leases.delete(lease.token);
      signal(lease.health, -1);
    }
  }

  parentPort.on('message', (message) => {
    if (message.kind === 'start') {
      const health = new Int32Array(message.healthBuffer);
      const intervalMs = Math.max(1, Math.floor(message.staleMs / 3));
      const lease = {
        token: message.token,
        lockPath: message.lockPath,
        ino: message.ino,
        ownerToken: message.ownerToken,
        health,
        timer: undefined,
      };
      leases.set(lease.token, lease);
      lease.timer = setInterval(() => renew(lease), intervalMs);
      // The caller waits for registration, then immediately renews and
      // revalidates the concrete lock on its own thread before entering the
      // operation. Keeping that first filesystem round trip on the caller
      // avoids serializing every short lease behind worker-thread I/O.
      signal(health, 1);
      return;
    }

    if (message.kind === 'stop') {
      const lease = leases.get(message.token);
      if (lease) {
        clearInterval(lease.timer);
        leases.delete(message.token);
      }
    }
  });
`;

let heartbeatWorker: Worker | null = null;

function getHeartbeatWorker(): Worker {
  if (!heartbeatWorker) {
    heartbeatWorker = new Worker(WORKER_SOURCE, { eval: true });
    heartbeatWorker.unref();
  }
  return heartbeatWorker;
}

export interface CrossProcessLockHeartbeat {
  token: string;
  health: Int32Array;
}

export function startCrossProcessLockHeartbeat(params: {
  lockPath: string;
  ino: number;
  ownerToken: string;
  staleMs: number;
}): CrossProcessLockHeartbeat {
  const token = randomUUID();
  const health = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  getHeartbeatWorker().postMessage({
    kind: 'start',
    token,
    lockPath: params.lockPath,
    ino: params.ino,
    ownerToken: params.ownerToken,
    staleMs: params.staleMs,
    healthBuffer: health.buffer,
  });
  // The operation may immediately block the main thread for longer than
  // staleMs. Do not enter it until the independent worker has registered the
  // lease; otherwise a contender can reclaim the lock during worker startup.
  // Only startup is synchronized. Stop remains ordered and asynchronous so
  // short critical sections do not pay a second worker round trip.
  const startupTimeoutMs = Math.max(1_000, Math.min(params.staleMs, 5_000));
  const startupResult = Atomics.wait(health, 0, 0, startupTimeoutMs);
  if (startupResult === 'timed-out' || Atomics.load(health, 0) !== 1) {
    throw new Error(`Cross-process write lock heartbeat failed to start for ${params.lockPath}`);
  }
  return { token, health };
}

export function assertCrossProcessLockHeartbeat(
  heartbeat: CrossProcessLockHeartbeat,
  lockPath: string,
): void {
  if (Atomics.load(heartbeat.health, 0) === -1) {
    throw new Error(`Cross-process write lock heartbeat failed for ${lockPath}`);
  }
}

export function stopCrossProcessLockHeartbeat(heartbeat: CrossProcessLockHeartbeat): void {
  getHeartbeatWorker().postMessage({
    kind: 'stop',
    token: heartbeat.token,
  });
}
