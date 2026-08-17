import type { SensitivityLevel } from '../../../system/trust/types.js';
import type { EmbeddingProviderCallOptions } from '../../../shared/contracts/embedding-provider.js';
import type {
  AutomataBusProvenance,
  AutomataBusVerificationStatus,
} from './contract.js';

/** Persisted visibility is separate from the pinned v1 event language. */
export type AutomataBusQueryAudience = 'eligible-automata' | 'operator';

export interface AutomataBusVisibility {
  companionId: string;
  audience: AutomataBusQueryAudience;
  maxSensitivity: SensitivityLevel;
}

export interface AutomataBusSearchFilters {
  automatonClasses?: readonly string[];
  taskIds?: readonly string[];
  runIds?: readonly string[];
  occurredAfter?: string;
  occurredBefore?: string;
  audiences?: readonly AutomataBusQueryAudience[];
  statuses?: readonly AutomataBusVerificationStatus[];
}

/**
 * Canonical current finding projection returned by the durable Postgres store.
 * Vector and cache adapters carry event ids only; this row is always hydrated
 * before disclosure so derived acceleration never becomes truth.
 */
export interface AutomataBusCanonicalFinding {
  eventId: string;
  companionId: string;
  sequence: number;
  occurredAt: string;
  automatonClass: string;
  taskId: string;
  runId: string;
  claim: string;
  provenance: AutomataBusProvenance;
  verificationStatus: AutomataBusVerificationStatus;
  audience: AutomataBusQueryAudience;
  sensitivity: SensitivityLevel;
}

export interface AutomataBusScoredReference {
  eventId: string;
  semanticScore?: number;
  lexicalScore?: number;
}

export interface AutomataBusCanonicalSearchInput {
  query: string;
  visibility: AutomataBusVisibility;
  filters: AutomataBusSearchFilters;
  limit: number;
}

export interface AutomataBusCanonicalHydrationInput {
  eventIds: readonly string[];
  visibility: AutomataBusVisibility;
  filters: AutomataBusSearchFilters;
}

/** Narrow adapter implemented by the companion-scoped canonical finding store. */
export interface AutomataBusCanonicalFindingPort {
  searchLexical(input: AutomataBusCanonicalSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]>;
  getCurrentByEventIds(
    input: AutomataBusCanonicalHydrationInput,
  ): Promise<readonly AutomataBusCanonicalFinding[]>;
}

export interface AutomataBusEmbeddingIdentity {
  provider: string;
  model: string;
  dimensions: number;
}

/** Supply the configured, usage-accounted gateway embedding provider here. */
export interface AutomataBusEmbeddingPort {
  readonly identity: AutomataBusEmbeddingIdentity;
  embed(text: string, options?: EmbeddingProviderCallOptions): Promise<Float32Array>;
}

export type AutomataBusIndexState = 'building' | 'degraded' | 'ready' | 'unavailable';
export type AutomataBusReindexState = 'current' | 'required' | 'running';

export interface AutomataBusIndexingLag {
  pendingCount: number;
  oldestPendingAt?: string;
  lastFailureAt?: string;
}

export interface AutomataBusVectorIndexState {
  indexState: AutomataBusIndexState;
  reindexState: AutomataBusReindexState;
  modelIdentity: AutomataBusEmbeddingIdentity | null;
  indexingLag: AutomataBusIndexingLag;
}

export interface AutomataBusVectorSearchInput {
  embedding: Float32Array;
  modelIdentity: AutomataBusEmbeddingIdentity;
  visibility: AutomataBusVisibility;
  filters: AutomataBusSearchFilters;
  limit: number;
}

export interface AutomataBusVectorUpsertInput extends AutomataBusCanonicalFinding {
  embedding: Float32Array;
  modelIdentity: AutomataBusEmbeddingIdentity;
}

/** pgvector is derived state. Both search methods return references, never claims. */
export interface AutomataBusVectorIndexPort {
  readState(): Promise<AutomataBusVectorIndexState>;
  searchApproximate(input: AutomataBusVectorSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]>;
  searchExact(input: AutomataBusVectorSearchInput): Promise<readonly {
    eventId: string;
    score: number;
  }[]>;
  upsert(input: AutomataBusVectorUpsertInput): Promise<void>;
}

/** Redis-backed adapters store only bounded scored references. */
export interface AutomataBusResultCachePort {
  get(key: string): Promise<readonly AutomataBusScoredReference[] | null>;
  set(
    key: string,
    references: readonly AutomataBusScoredReference[],
    ttlMs: number,
  ): Promise<void>;
}

export type AutomataBusIndexLagStage = 'embedding' | 'index-state' | 'model-identity' | 'vector';

export interface AutomataBusIndexLagInput {
  eventId: string;
  companionId: string;
  stage: AutomataBusIndexLagStage;
  modelIdentity: AutomataBusEmbeddingIdentity;
}

export interface AutomataBusIndexSuccessInput {
  eventId: string;
  companionId: string;
  modelIdentity: AutomataBusEmbeddingIdentity;
}

/** Health persistence is independent of the canonical finding write. */
export interface AutomataBusIndexHealthPort {
  markLagging(input: AutomataBusIndexLagInput): Promise<void>;
  markIndexed(input: AutomataBusIndexSuccessInput): Promise<void>;
}
