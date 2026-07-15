import type { Pool, PoolClient } from 'pg';

import type {
  TurnRecordEligibilityFenceKey,
  TurnRecordEligibilityFencePort,
} from '../sessions/turn-record-eligibility-fence-port.js';

function requireFenceText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`TurnRecord eligibility fence ${field} cannot be empty`);
  return normalized;
}

function advisoryKey(scope: string, key: TurnRecordEligibilityFenceKey): string {
  return JSON.stringify([
    'turn-record-source-eligibility-v1',
    scope,
    requireFenceText(key.logicalSessionId, 'logicalSessionId'),
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
  ): Promise<T> {
    const key = advisoryKey(this.scope, source);
    const client = await this.pool.connect();
    let acquired = false;
    let operationCompleted = false;
    let operationResult: T | undefined;
    let operationError: unknown;
    try {
      // SAFETY: this is the outer lock. Callers acquire it before queue-effect
      // receipts or session/TurnRecord filesystem locks; no writer may acquire
      // this advisory lock while already holding either inner lock.
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
      acquired = true;
      operationResult = await operation();
      operationCompleted = true;
    } catch (error) {
      operationError = error;
    }

    let releaseError: unknown;
    try {
      if (acquired) await unlock(client, key);
    } catch (error) {
      releaseError = error;
    } finally {
      client.release(releaseError ? new Error('TurnRecord eligibility fence release failed') : undefined);
    }

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
