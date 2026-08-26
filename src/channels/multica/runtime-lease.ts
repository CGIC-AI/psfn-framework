export interface MulticaRuntimeLeaseHandle {
  /** Aborts when the backing ownership session is lost unexpectedly. */
  readonly lost: AbortSignal;
  release(options?: { signal?: AbortSignal }): Promise<void>;
}

export interface MulticaRuntimeLease {
  /** Non-blocking ownership probe used during gateway readiness. */
  tryAcquire(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<MulticaRuntimeLeaseHandle | null>;
  /** Wait for ownership without blocking gateway readiness. */
  acquire(
    key: string,
    options: { signal: AbortSignal; pollIntervalMs: number },
  ): Promise<MulticaRuntimeLeaseHandle>;
}
