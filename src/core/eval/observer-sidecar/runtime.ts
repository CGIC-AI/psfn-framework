import type {
  ObserverEvalInput,
  ObserverEvalInputPayload,
  ObserverEvalLifecycleState,
  ObserverEvalLifecycleStatePayload,
  ObserverEvalReadonly,
  ObserverEvalSidecarLogger,
  ObserverEvalSidecarRuntime,
} from './types.js';
import {
  createObserverEvalLogSafeInput,
  sanitizeObserverEvalError,
} from './privacy.js';

export interface ObserverEvalDispatchInput {
  sidecarRuntime?: ObserverEvalSidecarRuntime | null;
  input: ObserverEvalInputPayload;
  logger?: ObserverEvalSidecarLogger;
}

export function createObserverEvalInput(input: ObserverEvalInputPayload): ObserverEvalInput {
  return deepFreeze(structuredClone(input));
}

export async function dispatchObserverEvalTurn(
  dispatchInput: ObserverEvalDispatchInput,
): Promise<ObserverEvalLifecycleState> {
  const { sidecarRuntime } = dispatchInput;
  const sidecarId = sidecarRuntime?.config?.sidecarId;

  if (!sidecarRuntime || !sidecarRuntime.config?.enabled) {
    return notifyLifecycle(sidecarRuntime, {
      status: 'disabled',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
      reason: sidecarRuntime ? 'config_disabled' : 'runtime_not_configured',
    }, dispatchInput.logger);
  }

  if (!sidecarRuntime.observer) {
    return notifyLifecycle(sidecarRuntime, {
      status: 'unavailable',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
      reason: 'observer_not_configured',
    }, dispatchInput.logger);
  }

  const observerInput = createObserverEvalInput(dispatchInput.input);
  try {
    await sidecarRuntime.observer.observeTurn(observerInput);
    return notifyLifecycle(sidecarRuntime, {
      status: 'enabled',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
    }, dispatchInput.logger);
  } catch (error) {
    const sanitizedError = sanitizeObserverEvalError(error);
    const logSafeInput = createObserverEvalLogSafeInput(dispatchInput.input);
    dispatchInput.logger?.debug('Observer eval sidecar degraded', {
      sidecarId: sidecarId ?? null,
      turn: logSafeInput.turn,
      privacy: logSafeInput.privacy,
      error: sanitizedError,
    });
    return notifyLifecycle(sidecarRuntime, {
      status: 'degraded',
      observedAt: Date.now(),
      ...(sidecarId ? { sidecarId } : {}),
      reason: 'observer_failed',
      error: sanitizedError,
    }, dispatchInput.logger);
  }
}

async function notifyLifecycle(
  sidecarRuntime: ObserverEvalSidecarRuntime | null | undefined,
  state: ObserverEvalLifecycleStatePayload,
  logger: ObserverEvalSidecarLogger | undefined,
): Promise<ObserverEvalLifecycleState> {
  const readonlyState = deepFreeze(structuredClone(state));
  try {
    await sidecarRuntime?.onLifecycleState?.(readonlyState);
  } catch (error) {
    const sanitizedError = sanitizeObserverEvalError(error);
    logger?.debug('Observer eval sidecar lifecycle hook failed', {
      status: state.status,
      sidecarId: state.sidecarId ?? null,
      error: sanitizedError,
    });
  }
  return readonlyState;
}

function deepFreeze<T>(value: T): ObserverEvalReadonly<T> {
  if (value === null || typeof value !== 'object') {
    return value as ObserverEvalReadonly<T>;
  }

  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }

  return Object.freeze(value) as ObserverEvalReadonly<T>;
}
