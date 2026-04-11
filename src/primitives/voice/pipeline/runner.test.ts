import { describe, expect, it } from 'vitest';
import { VoicePipeline } from './pipeline.js';
import { VoicePipelineRunner } from './runner.js';

describe('VoicePipelineRunner', () => {
  it('runs a pipeline to completion', async () => {
    const outputs: number[] = [];

    const definition = VoicePipeline
      .fromSource<number>(async function* () {
        yield 1;
        yield 2;
      })
      .pipe((input: number) => input * 2)
      .toDefinition(async (output: number) => {
        outputs.push(output);
      });

    const runner = new VoicePipelineRunner(definition);
    runner.start();
    await runner.waitForCompletion();

    expect(outputs).toEqual([2, 4]);
    expect(runner.snapshot.state).toBe('completed');
  });

  it('stops a running pipeline and keeps processed output', async () => {
    const outputs: number[] = [];
    const firstOutput = createDeferred<void>();

    const definition = VoicePipeline
      .fromSource<number>(async function* ({ signal }) {
        yield 1;
        await waitForAbort(signal);
        yield 2;
      })
      .toDefinition(async (output: number) => {
        outputs.push(output);
        if (output === 1) {
          firstOutput.resolve();
        }
      });

    const runner = new VoicePipelineRunner(definition);
    runner.start();
    await firstOutput.promise;

    await runner.stop('shutdown');

    expect(outputs).toEqual([1]);
    expect(runner.snapshot.state).toBe('stopped');
    expect(runner.snapshot.reason).toBe('shutdown');
  });

  it('supports stop/cancel races and resolves to cancelled', async () => {
    const outputs: number[] = [];
    const firstOutput = createDeferred<void>();

    const definition = VoicePipeline
      .fromSource<number>(async function* ({ signal }) {
        yield 1;
        await waitForAbort(signal);
      })
      .toDefinition(async (output: number) => {
        outputs.push(output);
        if (output === 1) {
          firstOutput.resolve();
        }
      });

    const runner = new VoicePipelineRunner(definition);
    runner.start();
    await firstOutput.promise;

    const stopPromise = runner.stop('graceful-stop');
    const cancelPromise = runner.cancel('barge-in');

    await Promise.all([stopPromise, cancelPromise]);

    expect(outputs).toEqual([1]);
    expect(runner.snapshot.state).toBe('cancelled');
    expect(runner.snapshot.reason).toBe('barge-in');
  });

  it('can be restarted after completion', async () => {
    const outputs: number[] = [];

    const definition = VoicePipeline
      .fromSource<number>(async function* () {
        yield 7;
      })
      .toDefinition(async (output: number) => {
        outputs.push(output);
      });

    const runner = new VoicePipelineRunner(definition);

    runner.start();
    await runner.waitForCompletion();
    runner.start();
    await runner.waitForCompletion();

    expect(outputs).toEqual([7, 7]);
    expect(runner.snapshot.runId).toBe(2);
  });
});

async function waitForAbort(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

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
