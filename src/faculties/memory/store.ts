import type Database from 'better-sqlite3';
import { DEFAULT_EMBEDDING_CONFIG } from './embedding.js';
import type { MemoryJournal } from './journal.js';
import type {
  ContactProfileArtifact,
  MemoryAbstractionLink,
  MemoryAbstractionLinkInput,
  MemoryBulkUpdatePatch,
  MemoryDeleteVersion,
  MemoryEvolutionLink,
  MemoryEvolutionLinkInput,
  MemoryEvolutionRelation,
  MemoryListOptions,
  MemoryLink,
  MemoryPatchEvent,
  MemorySalienceUpdate,
  MemorySoftDeleteOptions,
  MemoryStoreUpdatePatch,
  MemoryUndoSoftDeleteOptions,
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
  MemoryMaintenanceReview,
  MemoryMaintenanceDiagnostics,
  MemoryMaintenanceDiagnosticsOptions,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewListOptions,
  MemoryWriteCommit,
} from './memory-store-port.js';
import type { MemoryScopeQuery, PurrMemory } from './types.js';
import { upsertContactProfile, getContactProfile, listContactProfiles } from './store/contact-profiles.js';
import { loadSqliteVecExtension } from './store/embeddings.js';
import { linkMemories, unlinkMemories, getLinkedMemories } from './store/links.js';
import {
  insertMemory,
  updateMemory,
  runInTransaction,
  recordPatchEvent,
  getPatchEvents,
  softDeleteMemory,
  undoSoftDelete,
  getDeleteVersion,
  recordAbstractionLink,
  getAbstractionLinksForSourceMemory,
  getAbstractionLinksForAbstractedMemory,
  recordEvolutionLink,
  getEvolutionLinksForSourceMemory,
  getEvolutionLinksForTargetMemory,
  bulkDelete,
  bulkUpdate,
  bulkUpdateSalience,
} from './store/read-write-operations.js';
import {
  getAllActiveMemories,
  listActiveMemories,
  countActiveMemories,
  getById,
  getStats,
  getMemoriesByChannel,
  getMemoriesByContact,
} from './store/salience-queries.js';
import { createMemoryStoreSchema, migrateMemoryStoreSchema } from './store/schema.js';
import {
  resolveScratchpadMirrorPath,
  addScratchpadEntry,
  replaceScratchpadEntry,
  appendScratchpadEntry,
  removeScratchpadEntry,
  getScratchpadEntry,
  listScratchpadEntries,
  syncScratchpadMirror,
} from './store/scratchpad.js';
import { searchByText } from './store/lexical-search.js';
import {
  upsertMemoryMaintenanceReview,
  listMemoryMaintenanceReviews,
  getMemoryMaintenanceReview,
  getMemoryMaintenanceDiagnostics,
} from './store/maintenance-reviews.js';
import type { MemoryStoreOptions } from './store/types.js';
import { searchByEmbedding } from './store/vector-search.js';

export class MemoryStore {
  private db: Database.Database;
  private embeddingDims: number;
  private scratchpadMirrorPath: string | null;
  private journal: MemoryJournal | null;

  constructor(
    db: Database.Database,
    embeddingDims: number = DEFAULT_EMBEDDING_CONFIG.dims,
    options: MemoryStoreOptions = {},
  ) {
    this.db = db;
    this.embeddingDims = embeddingDims;
    this.scratchpadMirrorPath = resolveScratchpadMirrorPath(options);
    this.journal = options.journal ?? null;
    loadSqliteVecExtension(this.db);
    createMemoryStoreSchema(this.db, this.embeddingDims);
    migrateMemoryStoreSchema(this.db);
    syncScratchpadMirror(this.db, this.scratchpadMirrorPath);
  }

  insertMemory(memory: PurrMemory, embedding: Float32Array): void {
    insertMemory(this.db, this.embeddingDims, this.journal, memory, embedding);
  }

  persistMemoryWrite(input: MemoryWriteCommit): void {
    const supersededMemoryIds = [...new Set(input.supersededMemoryIds ?? [])];
    this.runInTransaction(() => {
      for (const memoryId of supersededMemoryIds) {
        this.updateMemory(memoryId, { supersededBy: input.memory.id });
      }
      this.insertMemory(input.memory, input.embedding);
    });
  }

  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Array<PurrMemory & { similarity: number }> {
    return searchByEmbedding(this.db, this.embeddingDims, embedding, threshold, limit, scopeQuery);
  }

  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Array<PurrMemory & { similarity: number }> {
    return searchByText(this.db, query, limit, scopeQuery);
  }

  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void {
    updateMemory(this.db, this.embeddingDims, id, updates);
  }

  runInTransaction<T>(handler: () => T): T {
    return runInTransaction(this.db, handler);
  }

  recordPatchEvent(event: MemoryPatchEvent): void {
    recordPatchEvent(this.db, event);
  }

  getPatchEvents(memoryId: string): MemoryPatchEvent[] {
    return getPatchEvents(this.db, memoryId);
  }

  getAllActiveMemories(limit: number = 10_000): PurrMemory[] {
    return getAllActiveMemories(this.db, limit);
  }

  listActiveMemories(options: MemoryListOptions = {}): PurrMemory[] {
    return listActiveMemories(this.db, options);
  }

  countActiveMemories(): number {
    return countActiveMemories(this.db);
  }

  getById(id: string): PurrMemory | undefined {
    return getById(this.db, id);
  }

  softDeleteMemory(
    id: string,
    options: MemorySoftDeleteOptions = {},
  ): MemoryDeleteVersion | null {
    return softDeleteMemory(this.db, this.journal, id, options);
  }

  undoSoftDelete(
    deleteId: string,
    options: MemoryUndoSoftDeleteOptions = {},
  ): MemoryDeleteVersion | null {
    return undoSoftDelete(this.db, this.journal, deleteId, options);
  }

  getDeleteVersion(deleteId: string): MemoryDeleteVersion | undefined {
    return getDeleteVersion(this.db, deleteId);
  }

  recordAbstractionLink(input: MemoryAbstractionLinkInput): MemoryAbstractionLink {
    return recordAbstractionLink(this.db, input);
  }

  getAbstractionLinksForSourceMemory(sourceMemoryId: string): MemoryAbstractionLink[] {
    return getAbstractionLinksForSourceMemory(this.db, sourceMemoryId);
  }

  getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): MemoryAbstractionLink[] {
    return getAbstractionLinksForAbstractedMemory(this.db, abstractedMemoryId);
  }

  recordEvolutionLink(input: MemoryEvolutionLinkInput): MemoryEvolutionLink {
    return recordEvolutionLink(this.db, input);
  }

  getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return getEvolutionLinksForSourceMemory(this.db, sourceMemoryId, relation);
  }

  getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return getEvolutionLinksForTargetMemory(this.db, targetMemoryId, relation);
  }

  getStats(): { total: number; byType: Record<string, number>; avgSalience: number } {
    return getStats(this.db);
  }

  upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): MemoryMaintenanceReview {
    return upsertMemoryMaintenanceReview(this.db, input);
  }

  listMemoryMaintenanceReviews(
    options: MemoryMaintenanceReviewListOptions = {},
  ): MemoryMaintenanceReview[] {
    return listMemoryMaintenanceReviews(this.db, options);
  }

  getMemoryMaintenanceReview(id: string): MemoryMaintenanceReview | undefined {
    return getMemoryMaintenanceReview(this.db, id);
  }

  getMemoryMaintenanceDiagnostics(
    options: MemoryMaintenanceDiagnosticsOptions = {},
  ): MemoryMaintenanceDiagnostics {
    return getMemoryMaintenanceDiagnostics(this.db, options);
  }

  getMemoriesByChannel(channelId: string, limit: number): PurrMemory[] {
    return getMemoriesByChannel(this.db, channelId, limit);
  }

  getMemoriesByContact(contactId: string, limit: number): PurrMemory[] {
    return getMemoriesByContact(this.db, contactId, limit);
  }

  linkMemories(id1: string, id2: string, linkType: string = 'related'): MemoryLink | null {
    return linkMemories(this.db, id1, id2, linkType);
  }

  unlinkMemories(id1: string, id2: string): boolean {
    return unlinkMemories(this.db, id1, id2);
  }

  getLinkedMemories(id: string): MemoryLink[] {
    return getLinkedMemories(this.db, id);
  }

  bulkDelete(ids: string[]): number {
    return bulkDelete(this.db, ids);
  }

  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): number {
    return bulkUpdate(this.db, ids, fields);
  }

  bulkUpdateSalience(updates: MemorySalienceUpdate[]): number {
    return bulkUpdateSalience(this.db, updates);
  }

  upsertContactProfile(profile: ContactProfileArtifact): void {
    upsertContactProfile(this.db, profile);
  }

  getContactProfile(contactId: string): ContactProfileArtifact | undefined {
    return getContactProfile(this.db, contactId);
  }

  listContactProfiles(): ContactProfileArtifact[] {
    return listContactProfiles(this.db);
  }

  addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): ScratchpadAddResult {
    return addScratchpadEntry(this.db, this.scratchpadMirrorPath, content, options);
  }

  replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): ScratchpadEntry | null {
    return replaceScratchpadEntry(this.db, this.scratchpadMirrorPath, id, content, options);
  }

  appendScratchpadEntry(
    id: string,
    content: string,
    options: {
      now?: number;
    } = {},
  ): ScratchpadEntry | null {
    return appendScratchpadEntry(this.db, this.scratchpadMirrorPath, id, content, options);
  }

  removeScratchpadEntry(id: string): boolean {
    return removeScratchpadEntry(this.db, this.scratchpadMirrorPath, id);
  }

  getScratchpadEntry(id: string): ScratchpadEntry | undefined {
    return getScratchpadEntry(this.db, id);
  }

  listScratchpadEntries(limit?: number): ScratchpadEntry[] {
    return listScratchpadEntries(this.db, limit);
  }
}
