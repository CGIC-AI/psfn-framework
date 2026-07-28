import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';

import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type {
  TurnRecordEligibilityFenceKey,
  TurnRecordEligibilityFencePort,
} from '../sessions/turn-record-eligibility-fence-port.js';

const log = createComponentLogger('PostgresTurnRecordEligibilityFence');

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
): Promise<void> {
  for (;;) {
    signal?.throwIfAborted();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    if (result.rows[0]?.acquired === true) return;
    // A blocking pg_advisory_lock query cannot observe process shutdown.
    // Polling keeps the server-side wait cancellable without abandoning a
    // query that could acquire the lock and run its protected effect later.
    await delay(50, undefined, signal ? { signal } : undefined);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason
    ?? new DOMException('TurnRecord eligibility fence acquisition was aborted', 'AbortError');
}

async function connectInterruptibly(
  pool: Pool,
  signal: AbortSignal | undefined,
): Promise<PoolClient> {
  signal?.throwIfAborted();
  const connection = pool.connect();
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
  constructor(
    private readonly pool: Pool,
    private readonly scope: string,
  ) {
    requireFenceText(scope, 'scope');
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
    const client = await connectInterruptibly(this.pool, options?.signal);
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
        await lockInterruptibly(client, key, options?.signal);
        acquired.push(key);
      }
      options?.signal?.throwIfAborted();
      operationResult = await operation();
      operationCompleted = true;
    } catch (error) {
      operationError = error;
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
