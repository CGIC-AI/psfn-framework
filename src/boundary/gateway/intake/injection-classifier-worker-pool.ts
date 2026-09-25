// Bounded worker-thread pool for L1.5 injection-classifier inference
// (psfn-framework-3mbpi).
//
// Tokenization and ONNX inference of a large untrusted page blocked the
// gateway event loop for ~1 s per 512-token window. This pool runs them on
// worker threads: each worker loads the model once, calls are queued with a
// hard bound (backpressure: a full queue rejects immediately), and every call
// has a deadline. A timed-out or crashed worker is terminated and replaced; its
// call rejects, and the gateway's screening adapter turns any classifier
// failure into a fail-closed escalation — content is never passed because the
// classifier could not score it.

import { Worker } from 'node:worker_threads';
import { createComponentLogger } from '../../../shared/logger.js';
import type { InjectionClassifierBackend } from './injection-classifier.js';
import { INJECTION_CLASSIFIER_WORKER_SOURCE } from './injection-classifier-worker-source.js';

const log = createComponentLogger('InjectionClassifierWorkerPool');

export interface InjectionClassifierWorkerPoolOptions {
  modelDir: string;
  /** Workers, each holding one copy of the model. */
  poolSize: number;
  /** Calls allowed to wait for a worker; one more is rejected (backpressure). */
  queueMax: number;
  /** Deadline for one call (model load, one tokenize chunk or one window). */
  callTimeoutMs: number;
  /** Test seam; production evaluates INJECTION_CLASSIFIER_WORKER_SOURCE. */
  workerSource?: string;
}

type WorkerCall =
  | { type: 'encode'; text: string }
  | { type: 'encodeSpecial'; text: string }
  | { type: 'probability'; inputIds: number[] };

interface Job {
  call: WorkerCall;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  ready: boolean;
  busy: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
  callId: number;
}

export class InjectionClassifierWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InjectionClassifierWorkerError';
  }
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isWorkerReply(value: unknown): value is WorkerReply {
  return typeof value === 'object' && value !== null
    && typeof (value as { id?: unknown }).id === 'number'
    && typeof (value as { ok?: unknown }).ok === 'boolean';
}

/**
 * Starts the pool, waits until every worker has loaded the model, and returns
 * it as an InjectionClassifierBackend. A worker that fails to load fails
 * startup (fail closed, like the in-process backend).
 */
export async function createInjectionClassifierWorkerPool(
  options: InjectionClassifierWorkerPoolOptions,
): Promise<InjectionClassifierBackend> {
  const source = options.workerSource ?? INJECTION_CLASSIFIER_WORKER_SOURCE;
  const workers: PoolWorker[] = [];
  const queue: Job[] = [];
  let disposed = false;
  let nextCallId = 0;
  let specialTokens: { clsTokenId: number; sepTokenId: number } | null = null;

  const failJob = (entry: PoolWorker, error: Error): void => {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    const job = entry.busy;
    entry.busy = null;
    job?.reject(error);
  };

  const replace = (entry: PoolWorker, reason: string): void => {
    const index = workers.indexOf(entry);
    if (index >= 0) workers.splice(index, 1);
    failJob(entry, new InjectionClassifierWorkerError(reason));
    void entry.worker.terminate().catch(() => undefined);
    // A worker that never finished loading is not replaced here: its failed
    // load rejects whoever spawned it (startup, or a previous replacement).
    if (disposed || index < 0) return;
    log.warn('Replacing injection classifier worker', { reason });
    void spawn().then(dispatch, (error: unknown) => {
      log.error('Injection classifier worker replacement failed to load', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Without a live worker nothing queued can run: reject it (fail closed).
      if (workers.length === 0) {
        for (const job of queue.splice(0)) {
          job.reject(new InjectionClassifierWorkerError('No injection classifier worker is available'));
        }
      }
    });
  };

  const send = (entry: PoolWorker, message: Record<string, unknown>): Promise<unknown> => (
    new Promise((resolve, reject) => {
      const id = ++nextCallId;
      entry.callId = id;
      entry.busy = { call: message as unknown as WorkerCall, resolve, reject };
      entry.timer = setTimeout(() => {
        replace(entry, `Injection classifier worker call ${String(message.type)} exceeded ${String(options.callTimeoutMs)}ms`);
      }, options.callTimeoutMs);
      entry.worker.postMessage({ ...message, id });
    })
  );

  const spawn = async (): Promise<PoolWorker> => {
    const worker = new Worker(source, { eval: true });
    const entry: PoolWorker = { worker, ready: false, busy: null, timer: null, callId: 0 };
    worker.on('message', (reply: unknown) => {
      if (!isWorkerReply(reply) || reply.id !== entry.callId || !entry.busy) return;
      const job = entry.busy;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.busy = null;
      if (reply.ok) job.resolve(reply.result);
      else job.reject(new InjectionClassifierWorkerError(reply.error ?? 'Injection classifier worker call failed'));
      dispatch();
    });
    worker.on('error', (error) => {
      replace(entry, `Injection classifier worker crashed: ${error.message}`);
    });
    worker.on('exit', (code) => {
      if (disposed) return;
      replace(entry, `Injection classifier worker exited with code ${String(code)}`);
    });
    const loaded = await send(entry, { type: 'init', modelDir: options.modelDir }) as {
      clsTokenId: number;
      sepTokenId: number;
    };
    if (!specialTokens) specialTokens = loaded;
    entry.ready = true;
    workers.push(entry);
    return entry;
  };

  function dispatch(): void {
    for (const entry of workers) {
      if (queue.length === 0) return;
      if (!entry.ready || entry.busy) continue;
      const job = queue.shift()!;
      send(entry, job.call as unknown as Record<string, unknown>).then(job.resolve, job.reject);
    }
  }

  const call = (workerCall: WorkerCall): Promise<unknown> => {
    if (disposed) return Promise.reject(new InjectionClassifierWorkerError('Injection classifier pool is disposed'));
    const idle = workers.find(entry => entry.ready && !entry.busy);
    if (idle) return send(idle, workerCall as unknown as Record<string, unknown>).finally(dispatch);
    if (queue.length >= options.queueMax) {
      return Promise.reject(new InjectionClassifierWorkerError(
        `Injection classifier queue is full (${String(options.queueMax)} waiting)`,
      ));
    }
    return new Promise((resolve, reject) => {
      queue.push({ call: workerCall, resolve, reject });
    });
  };

  try {
    await Promise.all(Array.from({ length: options.poolSize }, () => spawn()));
  } catch (error) {
    disposed = true;
    await Promise.allSettled(workers.map(entry => entry.worker.terminate()));
    throw error;
  }
  const tokens = specialTokens as { clsTokenId: number; sepTokenId: number } | null;
  if (!tokens) throw new InjectionClassifierWorkerError('Injection classifier pool started no worker');

  return {
    clsTokenId: tokens.clsTokenId,
    sepTokenId: tokens.sepTokenId,
    encode: async text => await call({ type: 'encode', text }) as number[],
    encodeWithSpecialTokens: async text => await call({ type: 'encodeSpecial', text }) as number[],
    injectionProbability: async inputIds => await call({ type: 'probability', inputIds }) as number,
    async dispose() {
      disposed = true;
      for (const job of queue.splice(0)) {
        job.reject(new InjectionClassifierWorkerError('Injection classifier pool is disposed'));
      }
      await Promise.allSettled(workers.map(entry => entry.worker.terminate()));
      workers.length = 0;
    },
  };
}
