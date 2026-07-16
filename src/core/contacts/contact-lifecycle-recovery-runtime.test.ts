import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContactLifecycleRecoveryRuntime } from './contact-lifecycle-recovery-runtime.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ContactLifecycleRecoveryRuntime', () => {
  it('checks ledger integrity and finishes bounded recovery before exposure', async () => {
    const order: string[] = [];
    const runtime = new ContactLifecycleRecoveryRuntime({
      store: {
        assertContactLifecycleLedgerHealthy: async () => { order.push('health'); },
        recoverContactLifecycleMutations: async () => {
          order.push('recover');
          return [];
        },
      },
    });

    await runtime.recoverBeforeExposure();
    order.push('exposed');

    expect(order).toEqual(['health', 'recover', 'exposed']);
  });

  it('fails startup closed without attempting recovery when the ledger is corrupt', async () => {
    const recover = vi.fn(async () => []);
    const runtime = new ContactLifecycleRecoveryRuntime({
      store: {
        assertContactLifecycleLedgerHealthy: async () => {
          throw new Error('corrupt durable contact lifecycle ledger');
        },
        recoverContactLifecycleMutations: recover,
      },
    });

    await expect(runtime.recoverBeforeExposure()).rejects.toThrow(/corrupt durable/u);
    expect(recover).not.toHaveBeenCalled();
  });

  it('runs non-overlapping leased batches and waits for an in-flight batch at shutdown', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const recover = vi.fn(() => new Promise<[]>(resolve => { finish = () => resolve([]); }));
    const runtime = new ContactLifecycleRecoveryRuntime({
      store: {
        assertContactLifecycleLedgerHealthy: async () => undefined,
        recoverContactLifecycleMutations: recover,
      },
      pollIntervalMs: 100,
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(recover).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(recover).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(recover).toHaveBeenCalledTimes(1);
  });
});
