export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// `name` may be an own property or inherited from a prototype (DOMException
// defines a getter-only `name` on its prototype). An assignment is safe only
// when the resolved property is a writable data property or an accessor with a
// setter, and the object is extensible when no descriptor exists anywhere.
function canAssignName(target: object): boolean {
  for (let current: object | null = target; current; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
    if (descriptor) return descriptor.writable === true || descriptor.set !== undefined;
  }
  return Object.isExtensible(target);
}

export function abortError(
  reason?: unknown,
  fallbackMessage = 'Request aborted',
  preserveEmptyString = false,
): Error {
  if (reason instanceof Error) {
    // Never mutate a foreign error: DOMException (the default AbortSignal
    // reason) exposes a getter-only `name`, and assigning it throws from
    // inside abort handlers where an escape is fatal to the process.
    if (reason.name) return reason;
    if (canAssignName(reason)) {
      reason.name = 'AbortError';
      return reason;
    }
    const wrapped = new Error(reason.message || fallbackMessage);
    wrapped.name = 'AbortError';
    wrapped.stack = reason.stack ?? wrapped.stack;
    return wrapped;
  }
  const message = typeof reason === 'string'
    && (preserveEmptyString || reason.trim().length > 0)
    ? reason
    : fallbackMessage;
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
