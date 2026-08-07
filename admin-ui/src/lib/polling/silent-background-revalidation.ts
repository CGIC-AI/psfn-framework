import { isRecord } from '../../../../src/shared/utils/types.js';

export interface SilentBackgroundRevalidation {
  refresh(): Promise<void>;
  invalidate(): void;
  dispose(): void;
}

export interface SilentBackgroundRevalidationOptions<T> {
  load: (publish: (data: T) => void) => Promise<unknown>;
  read: () => T;
  write: (data: T) => void;
  reportError: (message: string) => void;
  fallbackError: string;
}

function recordId(value: unknown): string | number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.id === 'string' || typeof value.id === 'number') return value.id;
  return typeof value.companionId === 'string' || typeof value.companionId === 'number'
    ? value.companionId
    : undefined;
}

/**
 * Reconcile JSON-backed API data while retaining every unchanged object and
 * array identity. Svelte can then update the one changed keyed row without
 * revisiting stable rows, controls, or route-local interaction state.
 */
export function reconcilePollingSnapshot<T>(current: T, incoming: T): T {
  if (Object.is(current, incoming)) return current;

  if (Array.isArray(current) && Array.isArray(incoming)) {
    const currentById = new Map<string | number, unknown>();
    let keyed = current.length > 0 || incoming.length > 0;
    for (const value of current) {
      const id = recordId(value);
      if (id === undefined || currentById.has(id)) {
        keyed = false;
        break;
      }
      currentById.set(id, value);
    }
    if (keyed && incoming.some(value => recordId(value) === undefined)) keyed = false;
    if (keyed) {
      let changed = current.length !== incoming.length;
      const reconciled = incoming.map((value, index) => {
        const id = recordId(value)!;
        const previous = currentById.get(id);
        const next = previous === undefined
          ? value
          : reconcilePollingSnapshot(previous, value);
        if (!Object.is(next, current[index])) changed = true;
        return next;
      });
      return (changed ? reconciled : current) as T;
    }

    if (current.length !== incoming.length) {
      return incoming.map((value, index) => (
        index < current.length
          ? reconcilePollingSnapshot(current[index], value)
          : value
      )) as T;
    }
    let changed = false;
    const reconciled = incoming.map((value, index) => {
      const valueAtIndex = reconcilePollingSnapshot(current[index], value);
      if (!Object.is(valueAtIndex, current[index])) changed = true;
      return valueAtIndex;
    });
    return (changed ? reconciled : current) as T;
  }

  if (isRecord(current) && isRecord(incoming)) {
    const currentKeys = Object.keys(current);
    const incomingKeys = Object.keys(incoming);
    if (currentKeys.length !== incomingKeys.length
      || incomingKeys.some(key => !Object.prototype.hasOwnProperty.call(current, key))) {
      return incoming;
    }

    let changed = false;
    const reconciled: Record<string, unknown> = {};
    for (const key of incomingKeys) {
      const value = reconcilePollingSnapshot(current[key], incoming[key]);
      reconciled[key] = value;
      if (!Object.is(value, current[key])) changed = true;
    }
    return (changed ? reconciled : current) as T;
  }

  return incoming;
}

export function publishPollingSnapshotIfChanged<T>(
  current: T,
  incoming: T,
  write: (data: T) => void,
): T {
  const reconciled = reconcilePollingSnapshot(current, incoming);
  if (!Object.is(reconciled, current)) write(reconciled);
  return reconciled;
}

export function createSilentBackgroundRevalidation<T>(
  options: SilentBackgroundRevalidationOptions<T>,
): SilentBackgroundRevalidation {
  let generation = 0;
  let disposed = false;

  function invalidate(): void {
    generation += 1;
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    const requestGeneration = ++generation;
    try {
      await options.load((incoming) => {
        if (disposed || requestGeneration !== generation) return;
        publishPollingSnapshotIfChanged(options.read(), incoming, options.write);
      });
      if (!disposed && requestGeneration === generation) options.reportError('');
    } catch (error) {
      if (disposed || requestGeneration !== generation) return;
      options.reportError(error instanceof Error ? error.message : options.fallbackError);
    }
  }

  function dispose(): void {
    disposed = true;
    invalidate();
  }

  return { refresh, invalidate, dispose };
}
