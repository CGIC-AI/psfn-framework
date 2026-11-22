const AGGREGATE_ERROR_ITEM_CHARS = 240;
const AGGREGATE_ERROR_TOTAL_CHARS = 1024;
const AGGREGATE_ERROR_ITEM_SLOTS = 8;

interface AggregateErrorLike extends Error {
  errors: readonly unknown[];
}

interface SessionStageErrorMetadata {
  logicalSessionId?: unknown;
  stage?: unknown;
}

function isAggregateErrorLike(error: unknown): error is AggregateErrorLike {
  return error instanceof Error
    && 'errors' in error
    && Array.isArray((error as { errors?: unknown }).errors);
}

function truncateText(text: string, width: number): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= width) return collapsed;
  return `${collapsed.slice(0, width - 3).trimEnd()}...`;
}

function formatSessionStagePrefix(error: unknown, detail: string): string {
  if (!error || typeof error !== 'object') return detail;
  const meta = error as SessionStageErrorMetadata;
  const sessionId = typeof meta.logicalSessionId === 'string' ? meta.logicalSessionId.trim() : '';
  if (!sessionId || detail.startsWith(sessionId)) return detail;
  const stage = typeof meta.stage === 'string' ? meta.stage.trim() : '';
  return stage ? `${sessionId}/${stage}: ${detail}` : `${sessionId}: ${detail}`;
}

function formatErrorMessageInner(error: unknown, visited: Set<object>): string {
  if (isAggregateErrorLike(error)) {
    const outer = error.message.trim() || error.name || 'AggregateError';
    if (visited.has(error)) return outer;
    visited.add(error);
    const items: string[] = [];
    const total = error.errors.length;
    const shown = total < AGGREGATE_ERROR_ITEM_SLOTS ? total : AGGREGATE_ERROR_ITEM_SLOTS;
    for (let index = 0; index < shown; index += 1) {
      const inner = error.errors[index];
      const formatted = formatSessionStagePrefix(
        inner,
        formatErrorMessageInner(inner, visited),
      );
      items.push(truncateText(formatted, AGGREGATE_ERROR_ITEM_CHARS));
    }
    if (total > shown) {
      items.push(`+${total - shown} more`);
    }
    if (items.length === 0) return outer;
    return truncateText(`${outer} [${items.join('; ')}]`, AGGREGATE_ERROR_TOTAL_CHARS);
  }
  return error instanceof Error ? error.message : String(error);
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function toErrorMessage(error: unknown): string {
  return formatErrorMessageInner(error, new Set());
}

/**
 * Formats an error for logs, failure records, and telemetry. Preserves
 * `String(error)` for standard Error instances while expanding
 * `AggregateError.errors` inner causes (bounded length) so background drain
 * failures remain diagnosable.
 */
export function formatErrorSummary(error: unknown): string {
  if (isAggregateErrorLike(error)) {
    const name = error.name || 'AggregateError';
    return `${name}: ${toErrorMessage(error)}`;
  }
  return String(error);
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
