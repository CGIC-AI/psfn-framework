import { setTimeout as delay } from 'node:timers/promises';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import type {
  MulticaRuntimeLease,
  MulticaRuntimeLeaseHandle,
} from '../../channels/multica/runtime-lease.js';

const MULTICA_RUNTIME_LEASE_OPERATION_TIMEOUT_MS = 5_000;

function requireLeaseKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) throw new Error('Multica runtime lease key cannot be empty');
  return normalized;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Multica runtime lease acquisition was aborted', 'AbortError');
}

async function connectInterruptibly(pool: Pool, signal?: AbortSignal): Promise<PoolClient> {
  signal?.throwIfAborted();
  const connection = pool.connect();
  if (!signal) return await connection;
  return await new Promise<PoolClient>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void connection.then(
      client => {
        signal.removeEventListener('abort', onAbort);
        if (settled) {
          client.release();
          return;
        }
        settled = true;
        resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

async function queryInterruptibly<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
  signal?: AbortSignal,
): Promise<QueryResult<T>> {
  signal?.throwIfAborted();
  const query = client.query<T>(text, values);
  if (!signal) return await query;
  return await new Promise<QueryResult<T>>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void query.then(
      result => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
}

class PostgresMulticaRuntimeLeaseHandle implements MulticaRuntimeLeaseHandle {
  private readonly lostController = new AbortController();
  private released = false;
  private readonly onClientError = (error: Error): void => {
    if (this.released) return;
    this.released = true;
    this.lostController.abort(error);
    this.client.release(error);
  };

  readonly lost = this.lostController.signal;

  constructor(
    private readonly client: PoolClient,
    private readonly key: string,
    private readonly operationTimeoutMs: number,
  ) {
    client.once('error', this.onClientError);
  }

  async release(options?: { signal?: AbortSignal }): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.client.removeListener('error', this.onClientError);
    let releaseError: unknown;
    try {
      const timeout = AbortSignal.timeout(this.operationTimeoutMs);
      const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const result = await queryInterruptibly<{ unlocked: boolean }>(
        this.client,
        'SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked',
        [this.key],
        signal,
      );
      if (result.rows[0]?.unlocked !== true) {
        throw new Error('Multica runtime lease ownership was lost before release');
      }
    } catch (error) {
      releaseError = error;
    }
    this.client.release(releaseError instanceof Error ? releaseError : undefined);
    if (releaseError) throw releaseError;
  }
}

/**
 * Cross-pod ownership for one stable Multica daemon identity. The checked-out
 * PostgreSQL session holds the advisory lock for the entire active runtime;
 * process or connection death releases it automatically for a standby pod.
 */
export class PostgresMulticaRuntimeLease implements MulticaRuntimeLease {
  constructor(
    private readonly pool: Pool,
    private readonly operationTimeoutMs = MULTICA_RUNTIME_LEASE_OPERATION_TIMEOUT_MS,
  ) {}

  private operationSignal(parent?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.operationTimeoutMs);
    return parent ? AbortSignal.any([parent, timeout]) : timeout;
  }

  async tryAcquire(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<MulticaRuntimeLeaseHandle | null> {
    const normalizedKey = requireLeaseKey(key);
    const signal = this.operationSignal(options?.signal);
    const client = await connectInterruptibly(this.pool, signal);
    let clientOwned = true;
    try {
      signal.throwIfAborted();
      const result = await queryInterruptibly<{ acquired: boolean }>(
        client,
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [normalizedKey],
        signal,
      );
      if (result.rows[0]?.acquired !== true) {
        client.release();
        clientOwned = false;
        return null;
      }
      const handle = new PostgresMulticaRuntimeLeaseHandle(
        client,
        normalizedKey,
        this.operationTimeoutMs,
      );
      clientOwned = false;
      if (signal.aborted) {
        await handle.release();
        throw abortReason(signal);
      }
      return handle;
    } catch (error) {
      if (clientOwned) client.release(error instanceof Error ? error : undefined);
      throw error;
    }
  }

  async acquire(
    key: string,
    options: { signal: AbortSignal; pollIntervalMs: number },
  ): Promise<MulticaRuntimeLeaseHandle> {
    const normalizedKey = requireLeaseKey(key);
    const pollIntervalMs = Math.max(1, options.pollIntervalMs);
    for (;;) {
      options.signal.throwIfAborted();
      const signal = this.operationSignal(options.signal);
      const client = await connectInterruptibly(this.pool, signal);
      let clientOwned = true;
      try {
        const result = await queryInterruptibly<{ acquired: boolean }>(
          client,
          'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
          [normalizedKey],
          signal,
        );
        if (result.rows[0]?.acquired === true) {
          const handle = new PostgresMulticaRuntimeLeaseHandle(
            client,
            normalizedKey,
            this.operationTimeoutMs,
          );
          clientOwned = false;
          if (signal.aborted) {
            await handle.release();
            throw abortReason(signal);
          }
          return handle;
        }
        client.release();
        clientOwned = false;
      } catch (error) {
        if (clientOwned) client.release(error instanceof Error ? error : undefined);
        throw error;
      }
      await delay(pollIntervalMs, undefined, { signal: options.signal });
    }
  }
}
