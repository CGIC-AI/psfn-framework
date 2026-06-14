import {
  createStaticHealthSnapshot,
  notifyObserverEvalLifecycle,
  ObserverEvalSidecarQueue,
} from './queue.js';
import type {
  ObserverEvalInputPayload,
  ObserverEvalLifecycleState,
  ObserverEvalSidecarHealthSnapshot,
  ObserverEvalSidecarLogger,
  ObserverEvalSidecarRuntime,
  ObserverEvalSidecarShutdownOptions,
} from './types.js';

export { createObserverEvalInput } from './queue.js';
export type { ObserverEvalSidecarShutdownOptions } from './types.js';

export interface ObserverEvalDispatchInput {
  sidecarRuntime?: ObserverEvalSidecarRuntime | null;
  input: ObserverEvalInputPayload;
  logger?: ObserverEvalSidecarLogger;
}

const queueByRuntime = new WeakMap<ObserverEvalSidecarRuntime, ObserverEvalSidecarQueue>();

export function dispatchObserverEvalTurn(
  dispatchInput: ObserverEvalDispatchInput,
): Promise<ObserverEvalLifecycleState> {
  const { sidecarRuntime } = dispatchInput;
  const sidecarId = sidecarRuntime?.config?.sidecarId;

  if (!sidecarRuntime || sidecarRuntime.config?.enabled !== true) {
    return Promise.resolve(notifyObserverEvalLifecycle(sidecarRuntime, {
      status: 'disabled',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
      reason: sidecarRuntime ? 'config_disabled' : 'runtime_not_configured',
    }, dispatchInput.logger));
  }

  if (!sidecarRuntime.observer) {
    return Promise.resolve(notifyObserverEvalLifecycle(sidecarRuntime, {
      status: 'unavailable',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
      reason: 'observer_not_configured',
    }, dispatchInput.logger));
  }

  const queue = getOrCreateQueue(sidecarRuntime, dispatchInput.logger);
  queue.updateLogger(dispatchInput.logger);
  return Promise.resolve(queue.enqueue(dispatchInput.input));
}

export function getObserverEvalSidecarHealthSnapshot(
  sidecarRuntime?: ObserverEvalSidecarRuntime | null,
): ObserverEvalSidecarHealthSnapshot {
  if (!sidecarRuntime) {
    return createStaticHealthSnapshot(null);
  }

  const queue = queueByRuntime.get(sidecarRuntime);
  return queue?.getHealthSnapshot() ?? createStaticHealthSnapshot(sidecarRuntime);
}

export async function drainObserverEvalSidecarQueue(
  sidecarRuntime?: ObserverEvalSidecarRuntime | null,
): Promise<ObserverEvalSidecarHealthSnapshot> {
  if (!sidecarRuntime) {
    return createStaticHealthSnapshot(null);
  }

  const queue = queueByRuntime.get(sidecarRuntime);
  if (!queue) {
    return createStaticHealthSnapshot(sidecarRuntime);
  }

  await queue.drainNow();
  return queue.getHealthSnapshot();
}

export async function shutdownObserverEvalSidecar(
  sidecarRuntime?: ObserverEvalSidecarRuntime | null,
  options: ObserverEvalSidecarShutdownOptions = {},
): Promise<ObserverEvalSidecarHealthSnapshot> {
  if (!sidecarRuntime) {
    return createStaticHealthSnapshot(null);
  }

  const queue = queueByRuntime.get(sidecarRuntime);
  if (!queue) {
    return createStaticHealthSnapshot(sidecarRuntime);
  }

  return queue.shutdown(options);
}

function getOrCreateQueue(
  runtime: ObserverEvalSidecarRuntime,
  logger: ObserverEvalSidecarLogger | undefined,
): ObserverEvalSidecarQueue {
  const existing = queueByRuntime.get(runtime);
  if (existing) {
    return existing;
  }

  const queue = new ObserverEvalSidecarQueue(runtime, logger);
  queueByRuntime.set(runtime, queue);
  return queue;
}
