export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export type CircuitBreakerTransitionReason =
  | 'failure_threshold'
  | 'cooldown_elapsed'
  | 'half_open_success'
  | 'half_open_failure';

export interface CircuitBreakerOptions {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  halfOpenMaxAttempts?: number;
  now?: () => number;
}

export interface CircuitBreakerSnapshot {
  key: string;
  method?: string;
  state: CircuitBreakerState;
  failureCount: number;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  openedAtMs?: number;
  openUntilMs?: number;
}

export interface CircuitBreakerTransition extends CircuitBreakerSnapshot {
  from: CircuitBreakerState;
  to: CircuitBreakerState;
  reason: CircuitBreakerTransitionReason;
  atMs: number;
  lastError?: string;
}

export interface CircuitBreakerExecuteOptions<T> {
  key: string;
  method?: string;
  operation: () => Promise<T>;
  isFailureResult?: (result: T) => Error | null | undefined;
  shouldRecordFailure?: (error: Error) => boolean;
  onTransition?: (transition: CircuitBreakerTransition) => void;
}

interface CircuitEntry {
  state: CircuitBreakerState;
  failures: number[];
  halfOpenAttempts: number;
  halfOpenSuccesses: number;
  openedAtMs?: number;
  openUntilMs?: number;
}

interface ResolvedCircuitBreakerOptions {
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  halfOpenMaxAttempts: number;
  now: () => number;
}

const CIRCUIT_OPEN_CODE = 'circuit_open';

export class CircuitOpenError extends Error {
  readonly code = CIRCUIT_OPEN_CODE;
  readonly circuitKey: string;
  readonly method?: string;
  readonly state: CircuitBreakerState;
  readonly failureCount: number;
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
  readonly openedAtMs?: number;
  readonly openUntilMs?: number;

  constructor(snapshot: CircuitBreakerSnapshot, nowMs: number) {
    const retrySuffix = snapshot.openUntilMs !== undefined
      ? `; retry after ${new Date(snapshot.openUntilMs).toISOString()}`
        + ` (${Math.max(0, snapshot.openUntilMs - nowMs)}ms remaining)`
      : '';
    const methodLabel = snapshot.method ? `${snapshot.method} ` : '';
    super(
      `Circuit open for ${methodLabel}${snapshot.key}: `
      + `${snapshot.failureCount}/${snapshot.failureThreshold} failures `
      + `in ${snapshot.windowMs}ms window${retrySuffix}`,
    );
    this.name = 'CircuitOpenError';
    this.circuitKey = snapshot.key;
    this.method = snapshot.method;
    this.state = snapshot.state;
    this.failureCount = snapshot.failureCount;
    this.failureThreshold = snapshot.failureThreshold;
    this.windowMs = snapshot.windowMs;
    this.cooldownMs = snapshot.cooldownMs;
    this.openedAtMs = snapshot.openedAtMs;
    this.openUntilMs = snapshot.openUntilMs;
  }
}

export function isCircuitOpenError(error: unknown): error is CircuitOpenError {
  return error instanceof CircuitOpenError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === CIRCUIT_OPEN_CODE
    );
}

function resolveOptions(options: CircuitBreakerOptions): ResolvedCircuitBreakerOptions {
  return {
    failureThreshold: normalizePositiveInt(options.failureThreshold, 1),
    windowMs: normalizePositiveInt(options.windowMs, 1),
    cooldownMs: normalizePositiveInt(options.cooldownMs, 1),
    halfOpenMaxAttempts: normalizePositiveInt(options.halfOpenMaxAttempts, 1),
    now: options.now ?? (() => Date.now()),
  };
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function createEntry(): CircuitEntry {
  return {
    state: 'closed',
    failures: [],
    halfOpenAttempts: 0,
    halfOpenSuccesses: 0,
  };
}

export class SlidingWindowCircuitBreaker {
  private readonly options: ResolvedCircuitBreakerOptions;
  private readonly entries = new Map<string, CircuitEntry>();

  constructor(options: CircuitBreakerOptions) {
    this.options = resolveOptions(options);
  }

  reset(key?: string): void {
    if (key) {
      this.entries.delete(key);
      return;
    }
    this.entries.clear();
  }

  snapshot(key: string, method?: string): CircuitBreakerSnapshot {
    const entry = this.entries.get(key) ?? createEntry();
    this.pruneFailures(entry, this.options.now());
    return this.toSnapshot(key, entry, method);
  }

  async execute<T>(options: CircuitBreakerExecuteOptions<T>): Promise<T> {
    const entry = this.entries.get(options.key) ?? createEntry();
    this.entries.set(options.key, entry);
    this.assertCanExecute(entry, options);

    const wasHalfOpen = entry.state === 'half_open';
    if (wasHalfOpen) {
      entry.halfOpenAttempts += 1;
    }

    try {
      const result = await options.operation();
      const resultFailure = options.isFailureResult?.(result);
      if (resultFailure) {
        this.recordFailure(entry, resultFailure, options);
        return result;
      }
      this.recordSuccess(entry, options);
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (options.shouldRecordFailure?.(err) ?? true) {
        this.recordFailure(entry, err, options);
      }
      throw err;
    } finally {
      if (wasHalfOpen) {
        entry.halfOpenAttempts = Math.max(0, entry.halfOpenAttempts - 1);
      }
    }
  }

  private assertCanExecute<T>(
    entry: CircuitEntry,
    options: CircuitBreakerExecuteOptions<T>,
  ): void {
    const nowMs = this.options.now();
    this.pruneFailures(entry, nowMs);

    if (entry.state === 'open' && (entry.openUntilMs ?? 0) <= nowMs) {
      this.transition(entry, options, 'half_open', 'cooldown_elapsed');
    }

    if (
      entry.state === 'half_open'
      && entry.halfOpenAttempts >= this.options.halfOpenMaxAttempts
    ) {
      throw new CircuitOpenError(this.toSnapshot(options.key, entry, options.method), nowMs);
    }

    if (entry.state === 'open') {
      throw new CircuitOpenError(this.toSnapshot(options.key, entry, options.method), nowMs);
    }
  }

  private recordSuccess<T>(
    entry: CircuitEntry,
    options: CircuitBreakerExecuteOptions<T>,
  ): void {
    if (entry.state !== 'half_open') {
      return;
    }

    // Close only once every allowed half-open probe has succeeded; otherwise a
    // first probe success would close the circuit while concurrent probe
    // failures are still in flight, weakening the half-open failure gate.
    entry.halfOpenSuccesses += 1;
    if (entry.halfOpenSuccesses < this.options.halfOpenMaxAttempts) {
      return;
    }

    entry.failures = [];
    entry.openedAtMs = undefined;
    entry.openUntilMs = undefined;
    this.transition(entry, options, 'closed', 'half_open_success');
  }

  private recordFailure<T>(
    entry: CircuitEntry,
    error: Error,
    options: CircuitBreakerExecuteOptions<T>,
  ): void {
    const nowMs = this.options.now();
    this.pruneFailures(entry, nowMs);
    entry.failures.push(nowMs);

    if (entry.state === 'half_open') {
      this.open(entry, options, 'half_open_failure', error);
      return;
    }

    if (
      entry.state === 'closed'
      && entry.failures.length >= this.options.failureThreshold
    ) {
      this.open(entry, options, 'failure_threshold', error);
    }
  }

  private open<T>(
    entry: CircuitEntry,
    options: CircuitBreakerExecuteOptions<T>,
    reason: CircuitBreakerTransitionReason,
    error: Error,
  ): void {
    const nowMs = this.options.now();
    entry.openedAtMs = nowMs;
    entry.openUntilMs = nowMs + this.options.cooldownMs;
    this.transition(entry, options, 'open', reason, error.message);
  }

  private transition<T>(
    entry: CircuitEntry,
    options: CircuitBreakerExecuteOptions<T>,
    to: CircuitBreakerState,
    reason: CircuitBreakerTransitionReason,
    lastError?: string,
  ): void {
    const from = entry.state;
    if (from === to && reason !== 'failure_threshold' && reason !== 'half_open_failure') {
      return;
    }

    entry.state = to;
    if (to !== 'half_open') {
      entry.halfOpenAttempts = 0;
    }
    entry.halfOpenSuccesses = 0;

    options.onTransition?.({
      ...this.toSnapshot(options.key, entry, options.method),
      from,
      to,
      reason,
      atMs: this.options.now(),
      ...(lastError ? { lastError } : {}),
    });
  }

  private pruneFailures(entry: CircuitEntry, nowMs: number): void {
    const windowStartMs = nowMs - this.options.windowMs;
    entry.failures = entry.failures.filter((timestamp) => timestamp >= windowStartMs);
  }

  private toSnapshot(
    key: string,
    entry: CircuitEntry,
    method?: string,
  ): CircuitBreakerSnapshot {
    return {
      key,
      ...(method ? { method } : {}),
      state: entry.state,
      failureCount: entry.failures.length,
      failureThreshold: this.options.failureThreshold,
      windowMs: this.options.windowMs,
      cooldownMs: this.options.cooldownMs,
      ...(entry.openedAtMs !== undefined ? { openedAtMs: entry.openedAtMs } : {}),
      ...(entry.openUntilMs !== undefined ? { openUntilMs: entry.openUntilMs } : {}),
    };
  }
}
