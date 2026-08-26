import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresMulticaRuntimeLease } from './multica-runtime-lease.js';

function fakeClient(query: (sql: string) => Promise<unknown>): {
  client: PoolClient;
  release: ReturnType<typeof vi.fn>;
  events: EventEmitter;
} {
  const events = new EventEmitter();
  const release = vi.fn();
  const client = Object.assign(events, { query: vi.fn(query), release }) as unknown as PoolClient;
  return { client, release, events };
}

describe('PostgresMulticaRuntimeLease', () => {
  it('cancels startup while the ownership connection is still pending', async () => {
    let provideClient!: (client: PoolClient) => void;
    const connection = new Promise<PoolClient>(resolve => { provideClient = resolve; });
    const { client, release } = fakeClient(async () => ({ rows: [{ acquired: true }] }));
    const lease = new PostgresMulticaRuntimeLease({
      connect: vi.fn(() => connection),
    } as unknown as Pool);
    const controller = new AbortController();

    const acquiring = lease.tryAcquire('multica:workspace:companion', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    provideClient(client);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(client.query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it('destroys a connection whose advisory-lock query stalls during shutdown', async () => {
    let queryStarted!: () => void;
    const started = new Promise<void>(resolve => { queryStarted = resolve; });
    const { client, release } = fakeClient(async () => {
      queryStarted();
      return await new Promise<never>(() => undefined);
    });
    const lease = new PostgresMulticaRuntimeLease({
      connect: vi.fn(async () => client),
    } as unknown as Pool);
    const controller = new AbortController();
    const acquiring = lease.tryAcquire('multica:workspace:companion', {
      signal: controller.signal,
    });
    await started;

    controller.abort();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }));
  });

  it('holds and explicitly releases one session advisory lock', async () => {
    const { client, release } = fakeClient(async (sql) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const lease = new PostgresMulticaRuntimeLease({
      connect: vi.fn(async () => client),
    } as unknown as Pool);

    const handle = await lease.tryAcquire('multica:workspace:companion');
    expect(handle).not.toBeNull();
    await handle?.release();

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('fences the adapter when the lock-holding database session dies', async () => {
    const { client, release, events } = fakeClient(async () => ({ rows: [{ acquired: true }] }));
    const lease = new PostgresMulticaRuntimeLease({
      connect: vi.fn(async () => client),
    } as unknown as Pool);
    const handle = await lease.tryAcquire('multica:workspace:companion');
    const connectionError = new Error('database connection lost');

    events.emit('error', connectionError);

    expect(handle?.lost.aborted).toBe(true);
    expect(handle?.lost.reason).toBe(connectionError);
    expect(release).toHaveBeenCalledWith(connectionError);
    await expect(handle?.release()).resolves.toBeUndefined();
  });

  it('bounds a stalled advisory unlock and destroys its session', async () => {
    let queryCount = 0;
    const { client, release } = fakeClient(async () => {
      queryCount += 1;
      if (queryCount === 1) return { rows: [{ acquired: true }] };
      return await new Promise<never>(() => undefined);
    });
    const lease = new PostgresMulticaRuntimeLease({
      connect: vi.fn(async () => client),
    } as unknown as Pool, 5);
    const handle = await lease.tryAcquire('multica:workspace:companion');

    await expect(handle?.release()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ name: 'TimeoutError' }));
  });
});
