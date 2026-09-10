import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';

import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type {
  TurnRecordEligibilityFenceKey,
  TurnRecordEligibilityFencePort,
} from '../sessions/turn-record-eligibility-fence-port.js';

const log = createComponentLogger('PostgresTurnRecordEligibilityFence');

/**
 * Upper bound on waiting for one fence key. A fence is held for the length of
 * one durable post-turn effect (a bounded LLM call plus its writes), so a
 * waiter that has not acquired inside this window is contending with a stuck
 * holder, not a busy one. The waiter is released with a typed error the
 * background lane maps to a bounded retry; it never parks forever.
 */
export const DEFAULT_TURN_RECORD_ELIGIBILITY_FENCE_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Physical capacity of the fence's dedicated pool lane. Every fenced
 * background operation holds one client for its whole duration, so this must
 * exceed the supervisor's `maxConcurrentSessions` (default 4) by enough
 * headroom for foreground TurnRecord appends and handoff recovery to acquire
 * their own short-lived fences without queueing behind background holders.
 */
export const TURN_RECORD_ELIGIBILITY_FENCE_POOL_CAPACITY = 8;

/** Pool lane name; see {@link PostgresConnectionOptions.lane}. */
export const TURN_RECORD_ELIGIBILITY_FENCE_POOL_LANE = 'turn-record-eligibility-fence';

const PG_POOL_CONNECT_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

/**
 * Thrown when a fence cannot be entered inside its bound: either no pool
 * client became available (`connect`) or the advisory key stayed held by
 * another session (`acquire`). Matched by `name` across the core boundary.
 */
export class TurnRecordEligibilityFenceTimeoutError extends Error {
  constructor(
    readonly phase: 'connect' | 'acquire',
    readonly timeoutMs: number,
  ) {
    super(`TurnRecord eligibility fence ${phase} timed out after ${timeoutMs}ms`);
    this.name = 'TurnRecordEligibilityFenceTimeoutError';
  }
}

function isTurnRecordEligibilityFenceTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TurnRecordEligibilityFenceTimeoutError';
}

export interface PostgresTurnRecordEligibilityFenceOptions {
  acquireTimeoutMs?: number;
  now?: () => number;
}

function requireFenceText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`TurnRecord eligibility fence ${field} cannot be empty`);
  return normalized;
}

function advisoryKey(scope: string, key: TurnRecordEligibilityFenceKey): string {
  requireFenceText(key.logicalSessionId, 'logicalSessionId');
  return JSON.stringify([
    'turn-record-source-eligibility-v2',
    scope,
    requireFenceText(key.turnId, 'turnId'),
  ]);
}

async function unlock(client: PoolClient, key: string): Promise<void> {
  const result = await client.query<{ unlocked: boolean }>(
    'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
    [key],
  );
  if (result.rows[0]?.unlocked !== true) {
    throw new Error('TurnRecord eligibility fence ownership was lost before release');
  }
}

async function lockInterruptibly(
  client: PoolClient,
  key: string,
  signal: AbortSignal | undefined,
  deadline: { atMs: number; timeoutMs: number; now: () => number },
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    if (result.rows[0]?.acquired === true) return;
    // A blocking pg_advisory_lock query cannot observe process shutdown or a
    // deadline. Polling keeps the server-side wait cancellable without
    // abandoning a query that could acquire the lock and run its protected
    // effect later; the deadline keeps a waiter behind a stuck holder from
    // parking forever (bead psfn-framework-52epa).
    if (deadline.now() >= deadline.atMs) {
      throw new TurnRecordEligibilityFenceTimeoutError('acquire', deadline.timeoutMs);
    }
    await delay(50, undefined, signal ? { signal } : undefined);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException('TurnRecord eligibility fence acquisition was aborted', 'AbortError');
}

function isPoolConnectTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === PG_POOL_CONNECT_TIMEOUT_MESSAGE;
}

async function connectInterruptibly(
  pool: Pool,
  signal: AbortSignal | undefined,
  connectTimeoutMs: number,
): Promise<PoolClient> {
  signal?.throwIfAborted();
  // pg-pool applies `connectionTimeoutMillis` to queued waiters as well as to
  // new sockets; surface that bound as the fence's own typed error so callers
  // see one failure shape for "could not enter the fence in time".
  const connection = pool.connect().catch((error: unknown) => {
    if (isPoolConnectTimeout(error)) {
      throw new TurnRecordEligibilityFenceTimeoutError('connect', connectTimeoutMs);
    }
    throw error;
  });
  if (!signal) return await connection;

  return await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();

    void connection.then(
      (client) => {
        if (settled) {
          try {
            client.release();
          } catch (error) {
            log.error('Failed to release a late eligibility-fence connection', {
              error: toErrorMessage(error),
            });
          }
          return;
        }
        settled = true;
        removeAbortListener();
        resolve(client);
      },
      (error: unknown) => {
        if (settled) {
          log.warn('Eligibility-fence connection failed after cancellation', {
            error: toErrorMessage(error),
          });
          return;
        }
        settled = true;
        removeAbortListener();
        reject(error);
      },
    );
  });
}

/**
 * A session-level advisory lock is deliberate here: the lock must stay held
 * while a background handler performs asynchronous durable effects. A
 * process crash closes the checked-out connection and releases the lock.
 */
export class PostgresTurnRecordEligibilityFence implements TurnRecordEligibilityFencePort {
  private readonly acquireTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly scope: string,
    options: PostgresTurnRecordEligibilityFenceOptions = {},
  ) {
    requireFenceText(scope, 'scope');
    const acquireTimeoutMs = options.acquireTimeoutMs
      ?? DEFAULT_TURN_RECORD_ELIGIBILITY_FENCE_ACQUIRE_TIMEOUT_MS;
    if (!Number.isSafeInteger(acquireTimeoutMs) || acquireTimeoutMs < 1) {
      throw new Error('TurnRecord eligibility fence acquireTimeoutMs must be a positive integer');
    }
    this.acquireTimeoutMs = acquireTimeoutMs;
    this.now = options.now ?? Date.now;
  }

  async withTurnRecordEligibilityFence<T>(
    source: TurnRecordEligibilityFenceKey,
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    return this.withTurnRecordEligibilityFences([source], operation, options);
  }

  async withTurnRecordEligibilityFences<T>(
    sources: readonly TurnRecordEligibilityFenceKey[],
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal },
  ): Promise<T> {
    if (sources.length === 0) {
      throw new Error('TurnRecord eligibility fence set cannot be empty');
    }
    const keys = [...new Set(sources.map(source => advisoryKey(this.scope, source)))].sort();
    const connectTimeoutMs = this.pool.options.connectionTimeoutMillis ?? this.acquireTimeoutMs;
    let client: PoolClient;
    try {
      client = await connectInterruptibly(this.pool, options?.signal, connectTimeoutMs);
    } catch (error) {
      if (isTurnRecordEligibilityFenceTimeoutError(error)) {
        log.warn('TurnRecord eligibility fence could not obtain a pool client in time', {
          scope: this.scope,
          keyCount: keys.length,
          timeoutMs: connectTimeoutMs,
        });
      }
      throw error;
    }
    // One deadline for the whole key set: the keys are acquired in order on
    // one session, and a multi-key waiter must not stack per-key bounds.
    const deadline = {
      atMs: this.now() + this.acquireTimeoutMs,
      timeoutMs: this.acquireTimeoutMs,
      now: this.now,
    };
    const acquired: string[] = [];
    let operationCompleted = false;
    let operationResult: T | undefined;
    let operationError: unknown;
    try {
      // SAFETY: these are the outer locks. Every multi-record consumer acquires
      // the canonical text keys lexicographically on one checked-out session;
      // single-record writers are a subset of that same order. The key is
      // TurnID-global within the companion scope, so a duplicate attributed to
      // a different logical owner cannot race a consumer of the first copy.
      // Callers acquire it before queue-effect receipts or session/TurnRecord
      // filesystem locks; no writer may acquire it while holding an inner lock.
      for (const key of keys) {
        await lockInterruptibly(client, key, options?.signal, deadline);
        acquired.push(key);
      }
      options?.signal?.throwIfAborted();
      operationResult = await operation();
      operationCompleted = true;
    } catch (error) {
      operationError = error;
      if (isTurnRecordEligibilityFenceTimeoutError(error)) {
        log.warn('TurnRecord eligibility fence acquisition timed out; releasing the waiter', {
          scope: this.scope,
          keyCount: keys.length,
          acquiredCount: acquired.length,
          timeoutMs: this.acquireTimeoutMs,
        });
      }
    }

    const releaseErrors: unknown[] = [];
    for (const key of acquired.reverse()) {
      try {
        await unlock(client, key);
      } catch (error) {
        releaseErrors.push(error);
      }
    }
    const releaseError = releaseErrors.length === 0
      ? undefined
      : releaseErrors.length === 1
        ? releaseErrors[0]
        : new AggregateError(releaseErrors, 'Multiple TurnRecord eligibility fence releases failed');
    client.release(releaseError ? new Error('TurnRecord eligibility fence release failed') : undefined);

    if (!operationCompleted) {
      if (releaseError) {
        throw new AggregateError(
          [operationError, releaseError],
          'TurnRecord eligibility operation and fence release both failed',
        );
      }
      throw operationError;
    }
    if (releaseError) throw releaseError;
    return operationResult as T;
  }
}
