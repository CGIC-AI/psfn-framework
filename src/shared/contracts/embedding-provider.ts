/**
 * zn2iy: optional cancellation for a single embedding call. Foreground callers
 * (retrieval, Analysis Workbench) forward their request/turn lifetime signal so a
 * caller abort — or, in the split runtime, a client disconnect — tears down the
 * upstream provider work instead of leaving a zombie that finishes and records
 * cost after the caller is gone. Durable background jobs (extraction, sleeptime)
 * deliberately omit the signal and own a bounded independent lifetime.
 *
 * The field is optional so every existing caller compiles unchanged and simply
 * expresses deliberate non-cancellation by not passing a signal.
 */
export interface EmbeddingProviderCancellation {
  signal?: AbortSignal;
}

export interface EmbeddingProviderPort {
  embed(text: string, options?: EmbeddingProviderCancellation): Promise<Float32Array>;
  embedBatch(texts: string[], options?: EmbeddingProviderCancellation): Promise<Float32Array[]>;
  readonly dims: number;
}
