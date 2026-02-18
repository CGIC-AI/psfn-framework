import { describe, expect, it } from 'vitest';
import { PipelineTask } from './task.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

describe('PipelineTask', () => {
  it('completes when executor resolves', async () => {
    const task = new PipelineTask(async () => {});

    task.start();
    await task.wait();

    expect(task.snapshot.state).toBe('completed');
  });

  it('stops an active task and records stop reason', async () => {
    const task = new PipelineTask(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    task.start();
    await task.stop('shutdown');

    expect(task.snapshot.state).toBe('stopped');
    expect(task.snapshot.reason).toBe('shutdown');
  });

  it('cancellation overrides a pending stop request', async () => {
    const release = createDeferred<void>();

    const task = new PipelineTask(async ({ signal }) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }

        signal.addEventListener('abort', () => resolve(), { once: true });
      });

      await release.promise;
    });

    task.start();

    const stopPromise = task.stop('graceful-stop');
    const cancelPromise = task.cancel('barge-in');

    release.resolve();
    await Promise.all([stopPromise, cancelPromise]);

    expect(task.snapshot.state).toBe('cancelled');
    expect(task.snapshot.reason).toBe('barge-in');
  });

  it('moves to failed when executor throws without cancellation', async () => {
    const task = new PipelineTask(async () => {
      throw new Error('boom');
    });

    task.start();
    await task.wait();

    expect(task.snapshot.state).toBe('failed');
    expect(task.snapshot.error?.message).toBe('boom');
  });
});
