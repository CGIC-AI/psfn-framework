import type { ScratchpadProvider } from '../../core/agent/scratchpad-port.js';
import type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryRethinkInput,
  CoreMemorySnapshot,
} from '../core-memory/store.js';
import type {
  MemoryProvenance,
  MemoryScopeQuery,
  MemorySourceType,
  PurrMemory,
} from './types.js';

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

export interface MemoryStoreStats {
  total: number;
  byType: Record<string, number>;
  avgSalience: number;
}

export type MemoryStoreUpdatePatch = Partial<Pick<
  PurrMemory,
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
  | 'sourceType'
  | 'provenance'
  | 'contactId'
  | 'deletedAt'
  | 'deletedBy'
  | 'deleteReason'
  | 'embedding'
>>;

export interface MemoryListOptions {
  limit?: number;
  offset?: number;
}

export interface MemorySoftDeleteOptions {
  deletedBy?: string;
  reason?: string;
  deletedAt?: number;
  deleteId?: string;
}

export interface MemoryUndoSoftDeleteOptions {
  restoredBy?: string;
  restoredAt?: number;
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

type Awaitable<T> = T | Promise<T>;

interface MemoryStorePortBackend extends ScratchpadProvider {
  insertMemory(memory: PurrMemory, embedding: Float32Array): Awaitable<void>;
  persistMemoryWrite(input: MemoryWriteCommit): Awaitable<void>;
  runInTransaction<T>(handler: () => T): Awaitable<T>;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Awaitable<MemorySearchResult[]>;
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Awaitable<MemorySearchResult[]>;
  updateMemory(id: string, updates: MemoryStoreUpdatePatch): Awaitable<void>;
  recordPatchEvent(event: MemoryPatchEvent): Awaitable<void>;
  getAllActiveMemories(limit?: number): Awaitable<PurrMemory[]>;
  listActiveMemories(options?: MemoryListOptions): Awaitable<PurrMemory[]>;
  countActiveMemories(): Awaitable<number>;
  getById(id: string): Awaitable<PurrMemory | undefined>;
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
}

export interface MemoryStorePort extends ScratchpadProvider {
  insertMemory(memory: PurrMemory, embedding: Float32Array): Promise<void>;
  persistMemoryWrite(input: MemoryWriteCommit): Promise<void>;
  runInTransaction<T>(handler: () => T): Promise<T>;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<MemorySearchResult[]>;
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Promise<MemorySearchResult[]>;
  updateMemory(id: string, updates: MemoryStoreUpdatePatch): Promise<void>;
  recordPatchEvent(event: MemoryPatchEvent): Promise<void>;
  getAllActiveMemories(limit?: number): Promise<PurrMemory[]>;
  listActiveMemories(options?: MemoryListOptions): Promise<PurrMemory[]>;
  countActiveMemories(): Promise<number>;
  getById(id: string): Promise<PurrMemory | undefined>;
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
}

export interface CoreMemoryStorePort {
  getSnapshot(): CoreMemorySnapshot;
  getBlock(label: CoreMemoryLabel): CoreMemoryBlock;
  append(
    label: CoreMemoryLabel,
    appendText: string,
    options?: CoreMemoryAppendOptions,
  ): CoreMemoryBlock;
  replace(label: CoreMemoryLabel, content: string): CoreMemoryBlock;
  rethink(input: CoreMemoryRethinkInput): CoreMemorySnapshot;
  formatForContext(): string;
}

export function createMemoryStorePort(store: MemoryStorePortBackend): MemoryStorePort {
  return {
    insertMemory: async (memory, embedding) => {
      await store.insertMemory(memory, embedding);
    },
    persistMemoryWrite: async (input) => {
      await store.persistMemoryWrite(input);
    },
    runInTransaction: async (handler) => {
      return await store.runInTransaction(handler);
    },
    searchByEmbedding: async (embedding, threshold, limit, scopeQuery) => (
      await store.searchByEmbedding(embedding, threshold, limit, scopeQuery)
    ),
    searchByText: async (query, limit, scopeQuery) => await store.searchByText(query, limit, scopeQuery),
    updateMemory: async (id, updates) => {
      await store.updateMemory(id, updates);
    },
    recordPatchEvent: async (event) => {
      await store.recordPatchEvent(event);
    },
    getAllActiveMemories: async (limit) => await store.getAllActiveMemories(limit),
    listActiveMemories: async (options) => await store.listActiveMemories(options),
    countActiveMemories: async () => await store.countActiveMemories(),
    getById: async (id) => await store.getById(id),
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
  };
}

export function createCoreMemoryStorePort(store: CoreMemoryStorePort): CoreMemoryStorePort {
  return {
    getSnapshot: () => store.getSnapshot(),
    getBlock: (label) => store.getBlock(label),
    append: (label, appendText, options) => store.append(label, appendText, options),
    replace: (label, content) => store.replace(label, content),
    rethink: (input) => store.rethink(input),
    formatForContext: () => store.formatForContext(),
  };
}
