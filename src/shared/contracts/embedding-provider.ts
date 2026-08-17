import type { ObservabilityCallType } from './observability-call-types.js';
import type { RuntimeLaneClass } from './runtime-lanes.js';

/** Content-free, caller-authored identity for one embedding workload. */
export interface EmbeddingUsageProvenance {
  callType: ObservabilityCallType;
  purpose: string;
  originType: ObservabilityCallType;
  originStage: string;
  service: string;
  process: string;
  /** The originating runtime's already-resolved lane; capture never reclassifies it. */
  runtimeLaneClass: RuntimeLaneClass;
  workloadType: string;
  workloadId: string;
}

/**
 * Options for one embedding call. Foreground callers forward their lifetime
 * signal; durable background callers omit it. Sessionless services also stamp
 * explicit usage provenance so the canonical usage ledger records their real
 * service, purpose, and already-resolved runtime lane instead of `unknown`.
 */
export interface EmbeddingProviderCallOptions {
  signal?: AbortSignal;
  usageProvenance?: EmbeddingUsageProvenance;
}

export interface EmbeddingProviderPort {
  embed(text: string, options?: EmbeddingProviderCallOptions): Promise<Float32Array>;
  embedBatch(texts: string[], options?: EmbeddingProviderCallOptions): Promise<Float32Array[]>;
  readonly dims: number;
}
