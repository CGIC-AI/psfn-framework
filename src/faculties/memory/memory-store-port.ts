import type { ScratchpadProvider } from '../../core/agent/contracts.js';
import type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryRethinkInput,
  CoreMemorySnapshot,
} from '../core-memory/store.js';
import type {
  MemoryScopeQuery,
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

export interface MemoryAbstractionLink {
  id: string;
  sourceMemoryId: string;
  abstractedMemoryId: string;
  externalRef: string;
  createdAt: number;
  createdBy?: string;
  reason?: string;
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

export type MemorySearchResult = PurrMemory & { similarity: number };

export interface MemoryStoreStats {
  total: number;
  byType: Record<string, number>;
  avgSalience: number;
}

export type MemoryStoreUpdatePatch = Partial<Pick<
  PurrMemory,
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
  | 'contactId'
  | 'deletedAt'
  | 'deletedBy'
  | 'deleteReason'
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

export interface MemoryStorePort extends ScratchpadProvider {
  insertMemory(memory: PurrMemory, embedding: Float32Array): void;
  runInTransaction<T>(handler: () => T): T;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): MemorySearchResult[];
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): MemorySearchResult[];
  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void;
  getAllActiveMemories(limit?: number): PurrMemory[];
  listActiveMemories(options?: MemoryListOptions): PurrMemory[];
  countActiveMemories(): number;
  getById(id: string): PurrMemory | undefined;
  softDeleteMemory(id: string, options?: MemorySoftDeleteOptions): MemoryDeleteVersion | null;
  undoSoftDelete(
    deleteId: string,
    options?: MemoryUndoSoftDeleteOptions,
  ): MemoryDeleteVersion | null;
  getDeleteVersion(deleteId: string): MemoryDeleteVersion | undefined;
  recordAbstractionLink(input: MemoryAbstractionLinkInput): MemoryAbstractionLink;
  getAbstractionLinksForSourceMemory(sourceMemoryId: string): MemoryAbstractionLink[];
  getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): MemoryAbstractionLink[];
  getStats(): MemoryStoreStats;
  getMemoriesByChannel(channelId: string, limit: number): PurrMemory[];
  getMemoriesByContact(contactId: string, limit: number): PurrMemory[];
  linkMemories(id1: string, id2: string, linkType?: string): MemoryLink | null;
  unlinkMemories(id1: string, id2: string): boolean;
  getLinkedMemories(id: string): MemoryLink[];
  bulkDelete(ids: string[]): number;
  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): number;
  upsertContactProfile(profile: ContactProfileArtifact): void;
  getContactProfile(contactId: string): ContactProfileArtifact | undefined;
  listContactProfiles(): ContactProfileArtifact[];
  addScratchpadEntry(content: string, options?: ScratchpadEntryCreateOptions): ScratchpadAddResult;
  replaceScratchpadEntry(
    id: string,
    content: string,
    options?: ScratchpadEntryReplaceOptions,
  ): ScratchpadEntry | null;
  removeScratchpadEntry(id: string): boolean;
  getScratchpadEntry(id: string): ScratchpadEntry | undefined;
  listScratchpadEntries(limit?: number): ScratchpadEntry[];
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

export function createMemoryStorePort(store: MemoryStorePort): MemoryStorePort {
  return {
    insertMemory: (memory, embedding) => store.insertMemory(memory, embedding),
    runInTransaction: <T>(handler: () => T) => store.runInTransaction(handler),
    searchByEmbedding: (embedding, threshold, limit, scopeQuery) => (
      store.searchByEmbedding(embedding, threshold, limit, scopeQuery)
    ),
    searchByText: (query, limit, scopeQuery) => store.searchByText(query, limit, scopeQuery),
    updateMemory: (id, updates) => store.updateMemory(id, updates),
    getAllActiveMemories: (limit) => store.getAllActiveMemories(limit),
    listActiveMemories: (options) => store.listActiveMemories(options),
    countActiveMemories: () => store.countActiveMemories(),
    getById: (id) => store.getById(id),
    softDeleteMemory: (id, options) => store.softDeleteMemory(id, options),
    undoSoftDelete: (deleteId, options) => store.undoSoftDelete(deleteId, options),
    getDeleteVersion: (deleteId) => store.getDeleteVersion(deleteId),
    recordAbstractionLink: (input) => store.recordAbstractionLink(input),
    getAbstractionLinksForSourceMemory: (sourceMemoryId) => (
      store.getAbstractionLinksForSourceMemory(sourceMemoryId)
    ),
    getAbstractionLinksForAbstractedMemory: (abstractedMemoryId) => (
      store.getAbstractionLinksForAbstractedMemory(abstractedMemoryId)
    ),
    getStats: () => store.getStats(),
    getMemoriesByChannel: (channelId, limit) => store.getMemoriesByChannel(channelId, limit),
    getMemoriesByContact: (contactId, limit) => store.getMemoriesByContact(contactId, limit),
    linkMemories: (id1, id2, linkType) => store.linkMemories(id1, id2, linkType),
    unlinkMemories: (id1, id2) => store.unlinkMemories(id1, id2),
    getLinkedMemories: (id) => store.getLinkedMemories(id),
    bulkDelete: (ids) => store.bulkDelete(ids),
    bulkUpdate: (ids, fields) => store.bulkUpdate(ids, fields),
    upsertContactProfile: (profile) => store.upsertContactProfile(profile),
    getContactProfile: (contactId) => store.getContactProfile(contactId),
    listContactProfiles: () => store.listContactProfiles(),
    addScratchpadEntry: (content, options) => store.addScratchpadEntry(content, options),
    replaceScratchpadEntry: (id, content, options) => (
      store.replaceScratchpadEntry(id, content, options)
    ),
    removeScratchpadEntry: (id) => store.removeScratchpadEntry(id),
    getScratchpadEntry: (id) => store.getScratchpadEntry(id),
    listScratchpadEntries: (limit) => store.listScratchpadEntries(limit),
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
