export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

/**
 * Stops awaiting an operation as soon as the caller aborts while still
 * observing a late rejection from an abort-ignoring implementation.
 */
export function awaitWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const observed = Promise.resolve(operation);
  if (signal.aborted) {
    void observed.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      complete();
    };
    const onAbort = (): void => {
      finish(() => reject(abortReason(signal)));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    observed.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) {
      onAbort();
    }
  });
}

/**
 * Makes an async iterable cancellation-aware even when its implementation
 * ignores the supplied AbortSignal. Late iterator results and rejections stay
 * observed, and iterator cleanup is requested without delaying cancellation.
 */
export async function* abortableAsyncIterable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T, void, void> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await awaitWithAbort(Promise.resolve(iterator.next()), signal);
      throwIfAborted(signal);
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed && iterator.return) {
      try {
        const cleanup = Promise.resolve(iterator.return());
        if (signal.aborted) {
          void cleanup.catch(() => undefined);
        } else {
          await cleanup;
        }
      } catch (error) {
        if (!signal.aborted) {
          throw error;
        }
      }
    }
  }
}
