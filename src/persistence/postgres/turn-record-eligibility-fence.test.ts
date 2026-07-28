import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresTurnRecordEligibilityFence } from './turn-record-eligibility-fence.js';

const FENCE_KEY = {
  logicalSessionId: 'session:recovery',
  turnId: 'turn_01JQRECOVERY00000000000000',
};

describe('PostgresTurnRecordEligibilityFence', () => {
  it('aborts an exhausted pool wait and releases a connection that arrives later', async () => {
    let provideClient!: (client: PoolClient) => void;
    const connection = new Promise<PoolClient>((resolve) => {
      provideClient = resolve;
    });
    const release = vi.fn();
    const query = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn(() => connection) } as unknown as Pool;
    const fence = new PostgresTurnRecordEligibilityFence(pool, 'companion:test');
    const controller = new AbortController();
    const operation = vi.fn(async () => 'should-not-run');

    const waiting = fence.withTurnRecordEligibilityFence(
      FENCE_KEY,
      operation,
      { signal: controller.signal },
    );
    expect(pool.connect).toHaveBeenCalledOnce();
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    provideClient(client);
    await new Promise<void>(resolve => setImmediate(resolve));

    expect(query).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('aborts an advisory-lock wait without running the protected operation', async () => {
    let markAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      markAttempted = resolve;
    });
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes('pg_try_advisory_lock')) {
        throw new Error(`Unexpected query: ${sql}`);
      }
      markAttempted();
      return { rows: [{ acquired: false }] };
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const fence = new PostgresTurnRecordEligibilityFence(pool, 'companion:test');
    const controller = new AbortController();
    const operation = vi.fn(async () => 'should-not-run');

    const waiting = fence.withTurnRecordEligibilityFence(
      FENCE_KEY,
      operation,
      { signal: controller.signal },
    );
    await attempted;
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(operation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('releases an acquired advisory lock after the protected operation', async () => {
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const fence = new PostgresTurnRecordEligibilityFence(pool, 'companion:test');

    await expect(fence.withTurnRecordEligibilityFence(
      FENCE_KEY,
      async () => 'completed',
    )).resolves.toBe('completed');

    expect(query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(undefined);
  });
});
