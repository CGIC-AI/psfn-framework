import type { ScratchpadProvider } from '../../core/agent/scratchpad-port.js';
import type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryFormatContext,
  CoreMemoryMutationOptions,
  CoreMemoryRethinkInput,
  CoreMemoryScopeOptions,
  CoreMemorySnapshot,
} from '../core-memory/store.js';
import type {
  MemoryProvenance,
  MemoryScopeQuery,
  MemorySourceType,
  PurrMemory,
} from './types.js';
import type {
  MemorySubjectClassification,
  MemorySubjectQueryAuthorization,
} from '../../shared/contracts/memory-subject.js';

export type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryRethinkInput,
  CoreMemorySnapshot,
} from '../core-memory/store.js';

export interface ContactProfileArtifact {
  contactId: string;
  summary: string;
  sourceMemoryIds: string[];
  confidenceScore: number;
  noveltyScore: number;
  updatedAt: number;
}

export interface MemoryDeleteVersion {
  deleteId: string;
  /** Present when this checkpoint was created by an Operator-approved deletion proposal. */
  proposalId?: string;
  memoryId: string;
  snapshot: PurrMemory;
  deletedAt: number;
  deletedBy: string;
  deleteReason?: string;
  restoredAt?: number;
  restoredBy?: string;
}

export interface MemoryLink {
  id1: string;
  id2: string;
  linkType: string;
  createdAt: number;
}

export const MEMORY_EVOLUTION_RELATIONS = [
  'supersedes',
  'updates',
  'negates',
  'conflicts_with',
] as const;

export type MemoryEvolutionRelation = typeof MEMORY_EVOLUTION_RELATIONS[number];

export interface MemoryEvolutionLink {
  id: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  relation: MemoryEvolutionRelation;
  confidence: number;
  reason?: string;
  sourceRef?: string;
  sourceType: MemorySourceType;
  provenanceRefs: string[];
  provenance?: MemoryProvenance;
  createdAt: number;
}

export interface MemoryEvolutionLinkInput {
  sourceMemoryId: string;
  targetMemoryId: string;
  relation: MemoryEvolutionRelation;
  confidence?: number;
  reason?: string;
  sourceRef?: string;
  sourceType?: MemorySourceType;
  provenanceRefs?: string[];
  provenance?: MemoryProvenance;
  createdAt?: number;
  linkId?: string;
}

export interface MemoryAbstractionLink {
  id: string;
  sourceMemoryId: string;
  abstractedMemoryId: string;
  externalRef: string;
  createdAt: number;
  createdBy?: string;
  reason?: string;
}

export interface MemoryPatchEvent {
  id: string;
  memoryId: string;
  sourceRef: string;
  sourceType: import('./types.js').MemorySourceType;
  provenance?: import('./types.js').MemoryProvenance;
  reason?: string;
  patch: Record<string, unknown>;
  previousValues: Record<string, unknown>;
  nextValues: Record<string, unknown>;
  createdAt: number;
}

export interface ScratchpadEntry {
  id: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScratchpadAddResult {
  entry: ScratchpadEntry;
  evictedIds: string[];
}

export type MemoryMaintenanceReviewKind =
  | 'near_duplicate'
  | 'provenance_confidence'
  | 'high_impact_low_confidence'
  | 'stale_memory'
  | 'conflicting_memory';

export type MemoryMaintenanceReviewStatus = 'pending' | 'quarantined' | 'resolved' | 'dismissed';

export type MemoryMaintenanceRecommendedAction =
  | 'review'
  | 'merge_candidate'
  | 'corroborate_or_dismiss'
  | 'verify_or_supersede'
  | 'resolve_conflict';

export interface MemoryMaintenanceReviewCandidate {
  memoryId: string;
  text: string;
  textPreview: string;
  sourceRef: string;
  provenanceRefs: string[];
  confidence: number;
  uniqueDetails: string[];
  similarity?: number;
}

export interface MemoryMaintenanceReviewState {
  schemaVersion: 1;
  kind: MemoryMaintenanceReviewKind;
  status: MemoryMaintenanceReviewStatus;
  subjectMemoryId: string;
  candidateMemoryIds: string[];
  reason: string;
  recommendedAction: MemoryMaintenanceRecommendedAction;
  sourceRefs: string[];
  provenanceRefs: string[];
  uniqueDetails: Record<string, string[]>;
  candidates: MemoryMaintenanceReviewCandidate[];
  createdBy: 'memory_maintenance';
  metadata?: Record<string, unknown>;
}

export interface MemoryMaintenanceReview {
  id: string;
  kind: MemoryMaintenanceReviewKind;
  status: MemoryMaintenanceReviewStatus;
  subjectMemoryId: string;
  candidateMemoryIds: string[];
  state: MemoryMaintenanceReviewState;
  createdAt: number;
  updatedAt: number;
  quarantineReason?: string;
}

export interface MemoryMaintenanceReviewInput {
  id?: string;
  kind: MemoryMaintenanceReviewKind;
  subjectMemoryId: string;
  candidateMemoryIds?: string[];
  state: MemoryMaintenanceReviewState;
  createdAt?: number;
  updatedAt?: number;
}

export interface MemoryMaintenanceReviewListOptions {
  status?: MemoryMaintenanceReviewStatus;
  kind?: MemoryMaintenanceReviewKind;
  limit?: number;
}

export interface MemoryMaintenanceDiagnostics {
  reviewCount: number;
  pendingReviewCount: number;
  reviewCountsByKind: Record<string, number>;
  reviewCountsByStatus: Record<string, number>;
  oldestPendingReviewAgeMs: number;
  averagePendingReviewAgeMs: number;
  evolutionDecisionCount: number;
  evolutionDecisionCountsByRelation: Record<MemoryEvolutionRelation, number>;
  supersessionDecisionCount: number;
  conflictDecisionCount: number;
  latestEvolutionDecisionAt?: number;
}

export interface MemoryMaintenanceDiagnosticsOptions {
  now?: number;
}

export type MemorySearchResult = PurrMemory & { similarity: number };

/**
 * Explicit authorization stance every caller of the raw `searchByEmbedding`
 * path must declare. There is no default: a call cannot silently pick a stance.
 *
 * - `'subject-enforced'`: the caller asserts subject authorization MUST be
 *   applied. Only a subject-authorized store (see
 *   `createSubjectAuthorizedMemoryStore`) can honor it; the raw
 *   `PostgresMemoryStore` rejects it by throwing, so a product-recall caller
 *   that is accidentally wired to the raw store fails closed instead of leaking
 *   unscoped memories.
 * - `'bypass-system-internal'`: an auditable opt-out for process-local
 *   system/maintenance callers (memory formation dedup, operator admin surfaces)
 *   that legitimately read the unscoped corpus. Every bypass site is greppable
 *   by the `'bypass-system-internal'` literal.
 */
export type EmbeddingSearchAuthorizationStance = 'subject-enforced' | 'bypass-system-internal';

export interface EmbeddingSearchAuthorization {
  authorization: EmbeddingSearchAuthorizationStance;
}

export type MemorySubjectQuerySelector =
  | { kind: 'list'; limit?: number; offset?: number; scopeQuery?: MemoryScopeQuery }
  | { kind: 'detail'; memoryId: string }
  | { kind: 'details_batch'; memoryIds: readonly string[] }
  | { kind: 'text_search'; query: string; limit?: number; offset?: number; scopeQuery?: MemoryScopeQuery }
  | { kind: 'embedding_search'; embedding: Float32Array; threshold: number; limit?: number; offset?: number; scopeQuery?: MemoryScopeQuery }
  | { kind: 'count'; scopeQuery?: MemoryScopeQuery };

export interface MemorySubjectAuthorizedQuery {
  authorization: MemorySubjectQueryAuthorization;
  selector: MemorySubjectQuerySelector;
}

export interface MemorySubjectAuthorizedQueryResult {
  memories: MemorySearchResult[];
  total: number;
}

/**
 * Subject-authorized admin aggregation/filter selectors (a27w.5). Unlike the
 * row-returning {@link MemorySubjectQuerySelector}, these push the operator
 * admin surface's counts, groupings, filters, and channel/contact slices into
 * SQL so the caller never hydrates the full authorized corpus into process.
 * Every selector applies `buildMemorySubjectAuthorizationPredicate` in the same
 * query, so a summary or slice can never observe a memory the caller is not
 * authorized for.
 */
export type MemorySubjectAdminSelector =
  | { kind: 'admin_page'; options?: MemoryAdminListOptions }
  | { kind: 'admin_stats' }
  | { kind: 'channel_prefix'; channelId: string; limit: number }
  | { kind: 'contact_filter'; contactId: string; limit: number }
  | { kind: 'privacy_summary' }
  | { kind: 'stats' };

export interface MemorySubjectAdminQuery {
  authorization: MemorySubjectQueryAuthorization;
  selector: MemorySubjectAdminSelector;
}

export type MemorySubjectAdminResult =
  | {
    kind: 'memories';
    memories: MemorySearchResult[];
    total: number;
    withheldBySubjectAuthorizationCount?: number;
  }
  | { kind: 'privacy_summary'; privacySummary: MemoryAdminPrivacySummary }
  | { kind: 'stats'; stats: MemoryStoreStats };

export interface MemorySubjectAuthorizedMutation {
  authorization: MemorySubjectQueryAuthorization;
  memoryIds: string[];
  updates: MemoryStoreUpdatePatch;
}

export interface MemorySubjectAuthorizedWrite extends MemoryWriteCommit {
  authorization: MemorySubjectQueryAuthorization;
}

export interface MemorySubjectAuthorizedDelete {
  authorization: MemorySubjectQueryAuthorization;
  memoryId: string;
  options?: MemorySoftDeleteOptions;
}

export interface MemorySubjectAuthorizedRestore {
  authorization: MemorySubjectQueryAuthorization;
  deleteId: string;
  options?: MemoryUndoSoftDeleteOptions;
}

export interface MemorySubjectBackfillOptions {
  batchSize?: number;
  resetCheckpoint?: boolean;
  now?: number;
}

export interface MemorySubjectBackfillResult {
  state: 'processed' | 'busy' | 'complete';
  processedCount: number;
  totalProcessedCount: number;
  classifierVersion: number;
  reasonCounts: Record<string, number>;
  durationMs: number;
}

export interface MemorySubjectClassificationCoverage {
  checkedAt: number;
  totalMemoryCount: number;
  currentClassificationCount: number;
  missingCurrentClassificationCount: number;
}

export interface MemoryStoreStats {
  total: number;
  byType: Record<string, number>;
  avgSalience: number;
}

export type MemoryStoreUpdatePatch = Partial<Pick<
  PurrMemory,
  | 'type'
  | 'text'
  | 'importance'
  | 'confidence'
  | 'emotionalValence'
  | 'formationVAD'
  | 'salience'
  | 'lastAccessed'
  | 'accessCount'
  | 'supersededBy'
  | 'sensitivity'
  | 'consentFlags'
  | 'tags'
  | 'scopeRef'
  | 'scopeTags'
  | 'provenanceRefs'
  | 'retentionClass'
  | 'sourceType'
  | 'provenance'
  | 'contactId'
  | 'deletedAt'
  | 'deletedBy'
  | 'deleteReason'
  | 'embedding'
>>;

export interface MemoryStoreUpdateOptions {
  requireActive?: boolean;
}

export class InactiveMemoryUpdateError extends Error {
  constructor(memoryId: string) {
    super(`Memory is no longer active: ${memoryId}`);
    this.name = 'InactiveMemoryUpdateError';
  }
}

export interface MemoryListOptions {
  limit?: number;
  offset?: number;
}

export interface MemoryAdminListOptions extends MemoryListOptions {
  type?: PurrMemory['type'];
  sensitivity?: PurrMemory['sensitivity'];
  retentionClass?: PurrMemory['retentionClass'];
  preferenceOnly?: boolean;
  startDate?: number;
  endDate?: number;
}

export interface MemoryAdminPrivacySummary {
  activeMemoryCount: number;
  highSensitivityCount: number;
  consentGatedCount: number;
  contactLinkedCount: number;
  scopedCount: number;
  preferenceCount: number;
  durablePreferenceCount: number;
  sensitivityCounts: Record<string, number>;
}

export interface MemoryAdminListResult {
  memories: PurrMemory[];
  total: number;
  privacySummary: MemoryAdminPrivacySummary;
  /** Present only when an authorized owner-facing projection requested it. */
  withheldBySubjectAuthorizationCount?: number;
}

export interface MemorySoftDeleteOptions {
  deletedBy?: string;
  reason?: string;
  deletedAt?: number;
  deleteId?: string;
  /** Internal audit linkage. Agent-facing callers must use the proposal workflow. */
  proposalId?: string;
}

export interface MemoryUndoSoftDeleteOptions {
  restoredBy?: string;
  restoredAt?: number;
  /** Required for proposal-linked restores so the audit actor uses canonical vocabulary. */
  actorRole?: 'Companion' | 'Operator';
}

export interface MemoryAbstractionLinkInput {
  sourceMemoryId: string;
  abstractedMemoryId: string;
  externalRef: string;
  createdAt?: number;
  createdBy?: string;
  reason?: string;
  linkId?: string;
}

export interface MemoryBulkUpdatePatch {
  type?: PurrMemory['type'];
  sensitivity?: PurrMemory['sensitivity'];
  retentionClass?: PurrMemory['retentionClass'];
}

export interface MemorySalienceUpdate {
  id: string;
  salience: number;
  salienceDecayAnchorAt: number;
}

export function normalizeMemorySalienceUpdates(
  updates: readonly MemorySalienceUpdate[],
): MemorySalienceUpdate[] {
  const byId = new Map<string, MemorySalienceUpdate>();
  for (const update of updates) {
    const id = update.id.trim();
    if (!id) continue;
    if (!Number.isFinite(update.salience) || !Number.isFinite(update.salienceDecayAnchorAt)) {
      throw new Error('bulkUpdateSalience requires finite salience and decay-anchor values');
    }
    byId.set(id, { ...update, id });
  }
  return Array.from(byId.values());
}

export interface ScratchpadEntryCreateOptions {
  id?: string;
  now?: number;
}

export interface ScratchpadEntryReplaceOptions {
  now?: number;
}

export interface MemoryWriteCommit {
  memory: PurrMemory;
  embedding: Float32Array;
  supersededMemoryIds?: string[];
}

/**
 * One active memory paired with its STORED embedding, for deterministic
 * evidence reads (cogsec second-arrow clustering, htm9.15). Embeddings are
 * already persisted at write time; this is a pure read, never a re-embed.
 */
export interface MemoryEmbeddingSample {
  id: string;
  text: string;
  type: PurrMemory['type'];
  extractedAt: number;
  contactId?: string;
  sourceType?: MemorySourceType;
  salience: number;
  embedding: Float32Array;
}

type Awaitable<T> = T | Promise<T>;

interface MemoryStorePortBackend extends ScratchpadProvider {
  /** Monotonic in-process signal for mutations that can change salience decay work. */
  getSalienceMaintenanceRevision?(): number;
  /** Monotonic in-process signal for mutations that can change retrieval output. */
  getRetrievalCorpusVersion?(): Awaitable<number>;
  /** Immutable startup diagnostic; contains counts only, never subject rows. */
  getStartupMemorySubjectClassificationCoverage?(): MemorySubjectClassificationCoverage;
  insertMemory(memory: PurrMemory, embedding: Float32Array): Awaitable<void>;
  persistMemoryWrite(input: MemoryWriteCommit): Awaitable<void>;
  runInTransaction<T>(handler: () => T): Awaitable<T>;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery: MemoryScopeQuery | undefined,
    authorization: EmbeddingSearchAuthorization,
  ): Awaitable<MemorySearchResult[]>;
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Awaitable<MemorySearchResult[]>;
  updateMemory(
    id: string,
    updates: MemoryStoreUpdatePatch,
    options?: MemoryStoreUpdateOptions,
  ): Awaitable<void>;
  recordPatchEvent(event: MemoryPatchEvent): Awaitable<void>;
  getAllActiveMemories(limit?: number): Awaitable<PurrMemory[]>;
  listMemories(options?: MemoryListOptions): Awaitable<PurrMemory[]>;
  listActiveMemories(options?: MemoryListOptions): Awaitable<PurrMemory[]>;
  listAdminMemories(options?: MemoryAdminListOptions): Awaitable<MemoryAdminListResult>;
  getAdminMemoryPrivacySummary(): Awaitable<MemoryAdminPrivacySummary>;
  countActiveMemories(): Awaitable<number>;
  getById(id: string): Awaitable<PurrMemory | undefined>;
  /**
   * Batch counterpart to {@link getById}. Resolves the accessible subset of the
   * requested ids in a single authorization round trip, deduplicated and
   * returned in first-seen input order. Inaccessible or nonexistent ids are
   * silently absent (never disclosed via order, count, or error). Semantics are
   * identical to calling `getById` for each id and dropping the misses; only the
   * query count differs.
   */
  getByIds(ids: readonly string[]): Awaitable<PurrMemory[]>;
  softDeleteMemory(
    id: string,
    options?: MemorySoftDeleteOptions,
  ): Awaitable<MemoryDeleteVersion | null>;
  undoSoftDelete(
    deleteId: string,
    options?: MemoryUndoSoftDeleteOptions,
  ): Awaitable<MemoryDeleteVersion | null>;
  getDeleteVersion(deleteId: string): Awaitable<MemoryDeleteVersion | undefined>;
  recordAbstractionLink(input: MemoryAbstractionLinkInput): Awaitable<MemoryAbstractionLink>;
  getAbstractionLinksForSourceMemory(sourceMemoryId: string): Awaitable<MemoryAbstractionLink[]>;
  getAbstractionLinksForAbstractedMemory(
    abstractedMemoryId: string,
  ): Awaitable<MemoryAbstractionLink[]>;
  recordEvolutionLink(input: MemoryEvolutionLinkInput): Awaitable<MemoryEvolutionLink>;
  getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Awaitable<MemoryEvolutionLink[]>;
  getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Awaitable<MemoryEvolutionLink[]>;
  getStats(): Awaitable<MemoryStoreStats>;
  getMemoriesByChannel(channelId: string, limit: number): Awaitable<PurrMemory[]>;
  getMemoriesByContact(contactId: string, limit: number): Awaitable<PurrMemory[]>;
  linkMemories(id1: string, id2: string, linkType?: string): Awaitable<MemoryLink | null>;
  unlinkMemories(id1: string, id2: string): Awaitable<boolean>;
  getLinkedMemories(id: string): Awaitable<MemoryLink[]>;
  bulkDelete(ids: string[]): Awaitable<number>;
  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Awaitable<number>;
  bulkUpdateSalience(updates: MemorySalienceUpdate[]): Awaitable<number>;
  upsertContactProfile(profile: ContactProfileArtifact): Awaitable<void>;
  getContactProfile(contactId: string): Awaitable<ContactProfileArtifact | undefined>;
  listContactProfiles(): Awaitable<ContactProfileArtifact[]>;
  addScratchpadEntry(
    content: string,
    options?: ScratchpadEntryCreateOptions,
  ): Awaitable<ScratchpadAddResult>;
  replaceScratchpadEntry(
    id: string,
    content: string,
    options?: ScratchpadEntryReplaceOptions,
  ): Awaitable<ScratchpadEntry | null>;
  appendScratchpadEntry(
    id: string,
    content: string,
    options?: ScratchpadEntryReplaceOptions,
  ): Awaitable<ScratchpadEntry | null>;
  removeScratchpadEntry(id: string): Awaitable<boolean>;
  getScratchpadEntry(id: string): Awaitable<ScratchpadEntry | undefined>;
  upsertMemoryMaintenanceReview?(input: MemoryMaintenanceReviewInput): Awaitable<MemoryMaintenanceReview>;
  listMemoryMaintenanceReviews?(
    options?: MemoryMaintenanceReviewListOptions,
  ): Awaitable<MemoryMaintenanceReview[]>;
  getMemoryMaintenanceReview?(id: string): Awaitable<MemoryMaintenanceReview | undefined>;
  getMemoryMaintenanceDiagnostics?(options?: MemoryMaintenanceDiagnosticsOptions): Awaitable<MemoryMaintenanceDiagnostics>;
  /**
   * Active memories written at/after `sinceMs`, paired with their stored
   * embeddings (rows without a persisted embedding are excluded), oldest
   * first. Optional in the same style as the maintenance-review surface;
   * consumers (the second-arrow drift lane) fail closed — loudly skip their
   * scan — when the backing store does not provide it.
   */
  listActiveMemoryEmbeddingsSince?(sinceMs: number, limit?: number): Awaitable<MemoryEmbeddingSample[]>;
  queryAuthorizedMemorySubjects(input: MemorySubjectAuthorizedQuery): Awaitable<MemorySubjectAuthorizedQueryResult>;
  aggregateAuthorizedMemorySubjects(input: MemorySubjectAdminQuery): Awaitable<MemorySubjectAdminResult>;
  mutateAuthorizedMemorySubjects(input: MemorySubjectAuthorizedMutation): Awaitable<number>;
  persistAuthorizedMemoryWrite(input: MemorySubjectAuthorizedWrite): Awaitable<void>;
  softDeleteAuthorizedMemorySubject(input: MemorySubjectAuthorizedDelete): Awaitable<MemoryDeleteVersion | null>;
  undoAuthorizedMemorySubjectDelete(input: MemorySubjectAuthorizedRestore): Awaitable<MemoryDeleteVersion | null>;
  getMemorySubjectClassification(memoryId: string): Awaitable<MemorySubjectClassification | undefined>;
  backfillMemorySubjectClassifications(options?: MemorySubjectBackfillOptions): Awaitable<MemorySubjectBackfillResult>;
}

export interface MemoryStorePort extends ScratchpadProvider {
  /** Postgres exposes this to let decay skip unchanged in-memory snapshots. */
  getSalienceMaintenanceRevision?(): number;
  /** Postgres exposes this to let active retrieval skip an unchanged corpus. */
  getRetrievalCorpusVersion?(): Awaitable<number>;
  /** Immutable startup diagnostic; contains counts only, never subject rows. */
  getStartupMemorySubjectClassificationCoverage?(): MemorySubjectClassificationCoverage;
  insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void>;
  persistMemoryWrite(input: MemoryWriteCommit): Promise<void>;
  runInTransaction<T>(handler: () => T): Promise<T>;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery: MemoryScopeQuery | undefined,
    authorization: EmbeddingSearchAuthorization,
  ): Promise<MemorySearchResult[]>;
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<MemorySearchResult[]>;
  updateMemory(
    id: string,
    updates: MemoryStoreUpdatePatch,
    options?: MemoryStoreUpdateOptions,
  ): Promise<void>;
  recordPatchEvent(event: MemoryPatchEvent): Promise<void>;
  getAllActiveMemories(limit?: number): Promise<PurrMemory[]>;
  listMemories(options?: MemoryListOptions): Promise<PurrMemory[]>;
  listActiveMemories(options?: MemoryListOptions): Promise<PurrMemory[]>;
  listAdminMemories(options?: MemoryAdminListOptions): Promise<MemoryAdminListResult>;
  getAdminMemoryPrivacySummary(): Promise<MemoryAdminPrivacySummary>;
  countActiveMemories(): Promise<number>;
  getById(id: string): Promise<PurrMemory | undefined>;
  /**
   * Batch counterpart to {@link getById}. Resolves the accessible subset of the
   * requested ids in a single authorization round trip, deduplicated and
   * returned in first-seen input order. Inaccessible or nonexistent ids are
   * silently absent. Semantics are identical to calling `getById` per id and
   * dropping the misses; only the query count differs.
   */
  getByIds(ids: readonly string[]): Promise<PurrMemory[]>;
  softDeleteMemory(id: string, options?: MemorySoftDeleteOptions): Promise<MemoryDeleteVersion | null>;
  undoSoftDelete(
    deleteId: string,
    options?: MemoryUndoSoftDeleteOptions,
  ): Promise<MemoryDeleteVersion | null>;
  getDeleteVersion(deleteId: string): Promise<MemoryDeleteVersion | undefined>;
  recordAbstractionLink(input: MemoryAbstractionLinkInput): Promise<MemoryAbstractionLink>;
  getAbstractionLinksForSourceMemory(sourceMemoryId: string): Promise<MemoryAbstractionLink[]>;
  getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): Promise<MemoryAbstractionLink[]>;
  recordEvolutionLink(input: MemoryEvolutionLinkInput): Promise<MemoryEvolutionLink>;
  getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]>;
  getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): Promise<MemoryEvolutionLink[]>;
  getStats(): Promise<MemoryStoreStats>;
  getMemoriesByChannel(channelId: string, limit: number): Promise<PurrMemory[]>;
  getMemoriesByContact(contactId: string, limit: number): Promise<PurrMemory[]>;
  linkMemories(id1: string, id2: string, linkType?: string): Promise<MemoryLink | null>;
  unlinkMemories(id1: string, id2: string): Promise<boolean>;
  getLinkedMemories(id: string): Promise<MemoryLink[]>;
  bulkDelete(ids: string[]): Promise<number>;
  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): Promise<number>;
  bulkUpdateSalience(updates: MemorySalienceUpdate[]): Promise<number>;
  upsertContactProfile(profile: ContactProfileArtifact): Promise<void>;
  getContactProfile(contactId: string): Promise<ContactProfileArtifact | undefined>;
  listContactProfiles(): Promise<ContactProfileArtifact[]>;
  addScratchpadEntry(content: string, options?: ScratchpadEntryCreateOptions): Promise<ScratchpadAddResult>;
  replaceScratchpadEntry(
    id: string,
    content: string,
    options?: ScratchpadEntryReplaceOptions,
  ): Promise<ScratchpadEntry | null>;
  appendScratchpadEntry(
    id: string,
    content: string,
    options?: ScratchpadEntryReplaceOptions,
  ): Promise<ScratchpadEntry | null>;
  removeScratchpadEntry(id: string): Promise<boolean>;
  getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined>;
  listScratchpadEntries(limit?: number): ScratchpadEntry[];
  upsertMemoryMaintenanceReview?(input: MemoryMaintenanceReviewInput): Promise<MemoryMaintenanceReview>;
  listMemoryMaintenanceReviews?(options?: MemoryMaintenanceReviewListOptions): Promise<MemoryMaintenanceReview[]>;
  getMemoryMaintenanceReview?(id: string): Promise<MemoryMaintenanceReview | undefined>;
  getMemoryMaintenanceDiagnostics?(options?: MemoryMaintenanceDiagnosticsOptions): Promise<MemoryMaintenanceDiagnostics>;
  /** See MemoryStorePortBackend.listActiveMemoryEmbeddingsSince (htm9.15 evidence read). */
  listActiveMemoryEmbeddingsSince?(sinceMs: number, limit?: number): Promise<MemoryEmbeddingSample[]>;
  queryAuthorizedMemorySubjects(input: MemorySubjectAuthorizedQuery): Promise<MemorySubjectAuthorizedQueryResult>;
  aggregateAuthorizedMemorySubjects(input: MemorySubjectAdminQuery): Promise<MemorySubjectAdminResult>;
  mutateAuthorizedMemorySubjects(input: MemorySubjectAuthorizedMutation): Promise<number>;
  persistAuthorizedMemoryWrite(input: MemorySubjectAuthorizedWrite): Promise<void>;
  softDeleteAuthorizedMemorySubject(input: MemorySubjectAuthorizedDelete): Promise<MemoryDeleteVersion | null>;
  undoAuthorizedMemorySubjectDelete(input: MemorySubjectAuthorizedRestore): Promise<MemoryDeleteVersion | null>;
  getMemorySubjectClassification(memoryId: string): Promise<MemorySubjectClassification | undefined>;
  backfillMemorySubjectClassifications(options?: MemorySubjectBackfillOptions): Promise<MemorySubjectBackfillResult>;
}

export interface CoreMemoryStorePort {
  getSnapshot(options?: CoreMemoryScopeOptions): CoreMemorySnapshot;
  getBlock(label: CoreMemoryLabel, options?: CoreMemoryScopeOptions): CoreMemoryBlock;
  append(
    label: CoreMemoryLabel,
    appendText: string,
    options?: CoreMemoryAppendOptions,
  ): CoreMemoryBlock;
  replace(label: CoreMemoryLabel, content: string, options?: CoreMemoryMutationOptions): CoreMemoryBlock;
  rethink(input: CoreMemoryRethinkInput, options?: CoreMemoryMutationOptions): CoreMemorySnapshot;
  formatForContext(context?: CoreMemoryFormatContext): string;
}

export function createMemoryStorePort(store: MemoryStorePortBackend): MemoryStorePort {
  return {
    ...(store.getSalienceMaintenanceRevision
      ? { getSalienceMaintenanceRevision: () => store.getSalienceMaintenanceRevision!() }
      : {}),
    ...(store.getRetrievalCorpusVersion
      ? { getRetrievalCorpusVersion: async () => await store.getRetrievalCorpusVersion!() }
      : {}),
    ...(store.getStartupMemorySubjectClassificationCoverage
      ? {
        getStartupMemorySubjectClassificationCoverage: () => (
          store.getStartupMemorySubjectClassificationCoverage!()
        ),
      }
      : {}),
    insertMemory: async (memory, embedding) => {
      await store.insertMemory(memory, embedding);
    },
    persistMemoryWrite: async (input) => {
      await store.persistMemoryWrite(input);
    },
    runInTransaction: async (handler) => {
      return await store.runInTransaction(handler);
    },
    searchByEmbedding: async (embedding, threshold, limit, scopeQuery, authorization) => (
      await store.searchByEmbedding(embedding, threshold, limit, scopeQuery, authorization)
    ),
    searchByText: async (query, limit, scopeQuery) => await store.searchByText(query, limit, scopeQuery),
    updateMemory: async (id, updates, options) => {
      await store.updateMemory(id, updates, options);
    },
    recordPatchEvent: async (event) => {
      await store.recordPatchEvent(event);
    },
    getAllActiveMemories: async (limit) => await store.getAllActiveMemories(limit),
    listMemories: async (options) => await store.listMemories(options),
    listActiveMemories: async (options) => await store.listActiveMemories(options),
    listAdminMemories: async (options) => await store.listAdminMemories(options),
    getAdminMemoryPrivacySummary: async () => await store.getAdminMemoryPrivacySummary(),
    countActiveMemories: async () => await store.countActiveMemories(),
    getById: async (id) => await store.getById(id),
    getByIds: async (ids) => await store.getByIds(ids),
    softDeleteMemory: async (id, options) => await store.softDeleteMemory(id, options),
    undoSoftDelete: async (deleteId, options) => await store.undoSoftDelete(deleteId, options),
    getDeleteVersion: async (deleteId) => await store.getDeleteVersion(deleteId),
    recordAbstractionLink: async (input) => await store.recordAbstractionLink(input),
    getAbstractionLinksForSourceMemory: async (sourceMemoryId) => (
      await store.getAbstractionLinksForSourceMemory(sourceMemoryId)
    ),
    getAbstractionLinksForAbstractedMemory: async (abstractedMemoryId) => (
      await store.getAbstractionLinksForAbstractedMemory(abstractedMemoryId)
    ),
    recordEvolutionLink: async (input) => await store.recordEvolutionLink(input),
    getEvolutionLinksForSourceMemory: async (sourceMemoryId, relation) => (
      await store.getEvolutionLinksForSourceMemory(sourceMemoryId, relation)
    ),
    getEvolutionLinksForTargetMemory: async (targetMemoryId, relation) => (
      await store.getEvolutionLinksForTargetMemory(targetMemoryId, relation)
    ),
    getStats: async () => await store.getStats(),
    getMemoriesByChannel: async (channelId, limit) => await store.getMemoriesByChannel(channelId, limit),
    getMemoriesByContact: async (contactId, limit) => await store.getMemoriesByContact(contactId, limit),
    linkMemories: async (id1, id2, linkType) => await store.linkMemories(id1, id2, linkType),
    unlinkMemories: async (id1, id2) => await store.unlinkMemories(id1, id2),
    getLinkedMemories: async (id) => await store.getLinkedMemories(id),
    bulkDelete: async (ids) => await store.bulkDelete(ids),
    bulkUpdate: async (ids, fields) => await store.bulkUpdate(ids, fields),
    bulkUpdateSalience: async (updates) => await store.bulkUpdateSalience(updates),
    upsertContactProfile: async (profile) => {
      await store.upsertContactProfile(profile);
    },
    getContactProfile: async (contactId) => await store.getContactProfile(contactId),
    listContactProfiles: async () => await store.listContactProfiles(),
    addScratchpadEntry: async (content, options) => await store.addScratchpadEntry(content, options),
    replaceScratchpadEntry: async (id, content, options) => (
      await store.replaceScratchpadEntry(id, content, options)
    ),
    appendScratchpadEntry: async (id, content, options) => (
      await store.appendScratchpadEntry(id, content, options)
    ),
    removeScratchpadEntry: async (id) => await store.removeScratchpadEntry(id),
    getScratchpadEntry: async (id) => await store.getScratchpadEntry(id),
    listScratchpadEntries: (limit) => store.listScratchpadEntries(limit),
    ...(store.upsertMemoryMaintenanceReview
      ? {
        upsertMemoryMaintenanceReview: async (input) => await store.upsertMemoryMaintenanceReview!(input),
      }
      : {}),
    ...(store.listMemoryMaintenanceReviews
      ? {
        listMemoryMaintenanceReviews: async (options) => await store.listMemoryMaintenanceReviews!(options),
      }
      : {}),
    ...(store.getMemoryMaintenanceReview
      ? {
        getMemoryMaintenanceReview: async (id) => await store.getMemoryMaintenanceReview!(id),
      }
      : {}),
    ...(store.getMemoryMaintenanceDiagnostics
      ? {
        getMemoryMaintenanceDiagnostics: async (options) => (
          await store.getMemoryMaintenanceDiagnostics!(options)
        ),
      }
      : {}),
    ...(store.listActiveMemoryEmbeddingsSince
      ? {
        listActiveMemoryEmbeddingsSince: async (sinceMs, limit) => (
          await store.listActiveMemoryEmbeddingsSince!(sinceMs, limit)
        ),
      }
      : {}),
    queryAuthorizedMemorySubjects: async input => await store.queryAuthorizedMemorySubjects(input),
    aggregateAuthorizedMemorySubjects: async input => await store.aggregateAuthorizedMemorySubjects(input),
    mutateAuthorizedMemorySubjects: async input => await store.mutateAuthorizedMemorySubjects(input),
    persistAuthorizedMemoryWrite: async input => await store.persistAuthorizedMemoryWrite(input),
    softDeleteAuthorizedMemorySubject: async input => await store.softDeleteAuthorizedMemorySubject(input),
    undoAuthorizedMemorySubjectDelete: async input => await store.undoAuthorizedMemorySubjectDelete(input),
    getMemorySubjectClassification: async memoryId => await store.getMemorySubjectClassification(memoryId),
    backfillMemorySubjectClassifications: async options => (
      await store.backfillMemorySubjectClassifications(options)
    ),
  };
}

export function createCoreMemoryStorePort(store: CoreMemoryStorePort): CoreMemoryStorePort {
  return {
    getSnapshot: (options) => store.getSnapshot(options),
    getBlock: (label, options) => store.getBlock(label, options),
    append: (label, appendText, options) => store.append(label, appendText, options),
    replace: (label, content, options) => store.replace(label, content, options),
    rethink: (input, options) => store.rethink(input, options),
    formatForContext: (context) => store.formatForContext(context),
  };
}
