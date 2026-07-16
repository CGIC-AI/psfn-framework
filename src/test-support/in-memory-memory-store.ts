import {
  type ContactProfileArtifact,
  type MemoryAdminListOptions,
  type MemoryAdminListResult,
  type MemoryAdminPrivacySummary,
  type MemoryAbstractionLink,
  type MemoryAbstractionLinkInput,
  type MemoryBulkUpdatePatch,
  type MemoryDeleteVersion,
  type MemoryEvolutionLink,
  type MemoryEvolutionLinkInput,
  type MemoryEvolutionRelation,
  type MemoryMaintenanceDiagnostics,
  type MemoryMaintenanceDiagnosticsOptions,
  type MemoryMaintenanceReview,
  type MemoryMaintenanceReviewInput,
  type MemoryMaintenanceReviewListOptions,
  type MemoryLink,
  type MemoryPatchEvent,
  type MemorySalienceUpdate,
  type MemorySearchResult,
  type MemorySoftDeleteOptions,
  type MemoryStorePort,
  type MemoryStoreStats,
  type MemoryStoreUpdatePatch,
  type MemorySubjectAuthorizedDelete,
  type MemorySubjectAuthorizedMutation,
  type MemorySubjectAuthorizedQuery,
  type MemorySubjectAuthorizedRestore,
  type MemorySubjectAuthorizedWrite,
  type ScratchpadAddResult,
  type ScratchpadEntry,
  type ScratchpadEntryCreateOptions,
  type ScratchpadEntryReplaceOptions,
} from '../faculties/memory/memory-store-port.js';
import { isInternalMemoryArtifact } from '../faculties/memory/internal-artifacts.js';
import { normalizeMemoryMaintenanceReviewInput } from '../faculties/memory/maintenance-review.js';
import {
  applyRetentionClassTags,
  isDurableMemory,
  isPreferenceMemory,
  type MemoryScopeQuery,
  type PurrMemory,
} from '../faculties/memory/types.js';
import {
  classifyInMemorySubject,
  mutateInMemoryAuthorizedSubjects,
  persistInMemoryAuthorizedSubject,
  queryInMemoryAuthorizedSubjects,
  softDeleteInMemoryAuthorizedSubject,
  undoDeleteInMemoryAuthorizedSubject,
} from './in-memory-memory-subjects.js';

interface StoredMemory {
  memory: PurrMemory;
  embedding: Float32Array;
}

function cloneMemory(memory: PurrMemory): PurrMemory {
  return {
    ...memory,
    tags: [...memory.tags],
    ...(memory.scopeTags ? { scopeTags: [...memory.scopeTags] } : {}),
    ...(memory.provenanceRefs ? { provenanceRefs: [...memory.provenanceRefs] } : {}),
    ...(memory.consentFlags ? { consentFlags: { ...memory.consentFlags } } : {}),
    ...(memory.provenance ? { provenance: { ...memory.provenance } } : {}),
  };
}

function cloneEmbedding(embedding: Float32Array): Float32Array {
  return new Float32Array(embedding);
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length);
  if (length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function matchesScope(memory: PurrMemory, scopeQuery?: MemoryScopeQuery): boolean {
  if (!scopeQuery) return true;
  const refs = scopeQuery.refs ?? [];
  const tags = scopeQuery.tags ?? [];
  if (refs.length === 0 && tags.length === 0) return true;
  const scopeMatches = refs.length === 0 || refs.some(ref => (
    memory.scopeRef?.kind === ref.kind && memory.scopeRef.id === ref.id
  ));
  const tagMatches = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
  return scopeQuery.mode === 'only'
    ? scopeMatches && tagMatches
    : scopeMatches || tagMatches;
}

function lexicalSimilarity(text: string, query: string): number {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (terms.length === 0) return 0;
  const normalizedText = text.toLowerCase();
  const matched = terms.filter(term => normalizedText.includes(term)).length;
  return matched / terms.length;
}

/**
 * Focused, synchronous test double for consumers of MemoryStorePort.
 *
 * Production tests for the Postgres adapter live beside postgres-store.ts. This
 * fixture intentionally models the port's observable behavior so unrelated
 * feature suites do not need a database process just to arrange memory
 * state. Its synchronous methods remain await-compatible, matching the port's
 * historical backend contract and making transaction rollback deterministic.
 */
export class InMemoryMemoryStore {
  private readonly memories = new Map<string, StoredMemory>();
  private readonly deleteVersions = new Map<string, MemoryDeleteVersion>();
  private readonly evolutionLinks: MemoryEvolutionLink[] = [];
  private readonly abstractionLinks: MemoryAbstractionLink[] = [];
  private readonly linkedMemories: MemoryLink[] = [];
  private readonly patchEvents: MemoryPatchEvent[] = [];
  private readonly scratchpad = new Map<string, ScratchpadEntry>();
  private readonly contactProfiles = new Map<string, ContactProfileArtifact>();
  private readonly maintenanceReviews = new Map<string, MemoryMaintenanceReview>();

  asPort(): MemoryStorePort {
    return this as unknown as MemoryStorePort;
  }

  insertMemory(memory: PurrMemory, embedding: Float32Array = new Float32Array()): void {
    this.memories.set(memory.id, {
      memory: cloneMemory({
        ...memory,
        salienceDecayAnchorAt: memory.salienceDecayAnchorAt ?? memory.lastAccessed,
      }),
      embedding: cloneEmbedding(embedding),
    });
  }

  persistMemoryWrite(input: {
    memory: PurrMemory;
    embedding: Float32Array;
    supersededMemoryIds?: string[];
  }): void {
    this.runInTransaction(() => {
      for (const memoryId of input.supersededMemoryIds ?? []) {
        this.updateMemory(memoryId, { supersededBy: input.memory.id });
      }
      this.insertMemory(input.memory, input.embedding);
    });
  }

  runInTransaction<T>(handler: () => T): T {
    const memoriesSnapshot = new Map(
      [...this.memories].map(([id, stored]) => [
        id,
        { memory: cloneMemory(stored.memory), embedding: cloneEmbedding(stored.embedding) },
      ]),
    );
    const patchEventsSnapshot = this.patchEvents.map(event => ({
      ...event,
      patch: { ...event.patch },
      previousValues: { ...event.previousValues },
      nextValues: { ...event.nextValues },
    }));
    const rollback = (): void => {
      this.memories.clear();
      for (const [id, stored] of memoriesSnapshot) this.memories.set(id, stored);
      this.patchEvents.splice(0, this.patchEvents.length, ...patchEventsSnapshot);
    };
    try {
      const result = handler();
      if (
        result !== null
        && typeof result === 'object'
        && typeof (result as { then?: unknown }).then === 'function'
      ) {
        return Promise.resolve(result).catch((error: unknown) => {
          rollback();
          throw error;
        }) as T;
      }
      return result;
    } catch (error) {
      rollback();
      throw error;
    }
  }

  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): MemorySearchResult[] {
    return this.activeEntries()
      .filter(({ memory }) => matchesScope(memory, scopeQuery))
      .map(({ memory, embedding: storedEmbedding }) => ({
        ...cloneMemory(memory),
        similarity: cosineSimilarity(storedEmbedding, embedding),
      }))
      .filter(memory => memory.similarity >= threshold)
      .sort((left, right) => (
        right.similarity - left.similarity
        || right.salience - left.salience
        || right.extractedAt - left.extractedAt
      ))
      .slice(0, limit);
  }

  searchByText(query: string, limit: number, scopeQuery?: MemoryScopeQuery): MemorySearchResult[] {
    return this.activeEntries()
      .filter(({ memory }) => matchesScope(memory, scopeQuery))
      .map(({ memory }) => ({
        ...cloneMemory(memory),
        similarity: lexicalSimilarity(memory.text, query),
      }))
      .filter(memory => memory.similarity > 0)
      .sort((left, right) => (
        right.similarity - left.similarity
        || right.salience - left.salience
        || right.extractedAt - left.extractedAt
      ))
      .slice(0, limit);
  }

  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void {
    const stored = this.memories.get(id);
    if (!stored) return;
    const next = cloneMemory({ ...stored.memory, ...updates });
    if (updates.salience !== undefined || updates.lastAccessed !== undefined) {
      next.salienceDecayAnchorAt = updates.lastAccessed ?? Date.now();
    }
    this.memories.set(id, {
      memory: next,
      embedding: updates.embedding
        ? cloneEmbedding(updates.embedding)
        : stored.embedding,
    });
  }

  recordPatchEvent(event: MemoryPatchEvent): void {
    this.patchEvents.push({
      ...event,
      patch: { ...event.patch },
      previousValues: { ...event.previousValues },
      nextValues: { ...event.nextValues },
    });
  }

  getAllActiveMemories(limit = 10_000): PurrMemory[] {
    return this.activeEntries()
      .slice(0, limit)
      .map(({ memory }) => cloneMemory(memory));
  }

  listMemories(options: { limit?: number; offset?: number } = {}): PurrMemory[] {
    const offset = options.offset ?? 0;
    const sorted = [...this.memories.values()]
      .map(({ memory }) => memory)
      .sort((left, right) => {
        const leftArchived = left.supersededBy || left.deletedAt ? 1 : 0;
        const rightArchived = right.supersededBy || right.deletedAt ? 1 : 0;
        return leftArchived - rightArchived || right.extractedAt - left.extractedAt;
      });
    const page = options.limit === undefined
      ? sorted.slice(offset)
      : sorted.slice(offset, offset + options.limit);
    return page.map(memory => cloneMemory(memory));
  }

  listActiveMemories(options: { limit?: number; offset?: number } = {}): PurrMemory[] {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return this.getAllActiveMemories().slice(offset, offset + limit);
  }

  listAdminMemories(options: MemoryAdminListOptions = {}): MemoryAdminListResult {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    const filtered = this.getAllActiveMemories()
      .filter(memory => !isInternalMemoryArtifact(memory))
      .filter((memory) => {
        if (options.type && memory.type !== options.type) return false;
        if (options.sensitivity && memory.sensitivity !== options.sensitivity) return false;
        if (options.retentionClass === 'durable' && !isDurableMemory(memory)) return false;
        if (options.retentionClass === 'standard' && isDurableMemory(memory)) return false;
        if (options.preferenceOnly && !isPreferenceMemory(memory)) return false;
        if (options.startDate !== undefined && memory.extractedAt < options.startDate) return false;
        if (options.endDate !== undefined && memory.extractedAt > options.endDate) return false;
        return true;
      })
      .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id));
    return {
      memories: filtered.slice(offset, offset + limit),
      total: filtered.length,
      privacySummary: this.getAdminMemoryPrivacySummary(),
    };
  }

  getAdminMemoryPrivacySummary(): MemoryAdminPrivacySummary {
    const active = this.getAllActiveMemories()
      .filter(memory => !isInternalMemoryArtifact(memory));
    const sensitivityCounts: Record<string, number> = {};
    let highSensitivityCount = 0;
    let consentGatedCount = 0;
    let contactLinkedCount = 0;
    let scopedCount = 0;
    let preferenceCount = 0;
    let durablePreferenceCount = 0;
    for (const memory of active) {
      sensitivityCounts[memory.sensitivity] = (sensitivityCounts[memory.sensitivity] ?? 0) + 1;
      if (memory.sensitivity === 'intimate' || memory.sensitivity === 'confidential') {
        highSensitivityCount += 1;
      }
      if (memory.consentFlags?.allowRecall === false) consentGatedCount += 1;
      if (memory.contactId) contactLinkedCount += 1;
      if (memory.scopeRef || (memory.scopeTags?.length ?? 0) > 0) scopedCount += 1;
      if (isPreferenceMemory(memory)) {
        preferenceCount += 1;
        if (isDurableMemory(memory)) durablePreferenceCount += 1;
      }
    }
    return {
      activeMemoryCount: active.length,
      highSensitivityCount,
      consentGatedCount,
      contactLinkedCount,
      scopedCount,
      preferenceCount,
      durablePreferenceCount,
      sensitivityCounts,
    };
  }

  countActiveMemories(): number {
    return this.activeEntries().length;
  }

  getById(id: string): PurrMemory | undefined {
    const memory = this.memories.get(id)?.memory;
    return memory ? cloneMemory(memory) : undefined;
  }

  softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): MemoryDeleteVersion | null {
    const stored = this.memories.get(id);
    if (!stored || stored.memory.deletedAt) return null;
    const version: MemoryDeleteVersion = {
      deleteId: options.deleteId ?? `delete-${id}`,
      memoryId: id,
      snapshot: cloneMemory(stored.memory),
      deletedAt: options.deletedAt ?? Date.now(),
      deletedBy: options.deletedBy ?? 'test',
      ...(options.reason ? { deleteReason: options.reason } : {}),
    };
    this.deleteVersions.set(version.deleteId, version);
    this.updateMemory(id, {
      deletedAt: version.deletedAt,
      deletedBy: version.deletedBy,
      ...(version.deleteReason ? { deleteReason: version.deleteReason } : {}),
    });
    return version;
  }

  undoSoftDelete(deleteId: string): MemoryDeleteVersion | null {
    const version = this.deleteVersions.get(deleteId);
    if (!version) return null;
    const restored: MemoryDeleteVersion = {
      ...version,
      restoredAt: Date.now(),
      restoredBy: 'test',
    };
    this.memories.set(version.memoryId, {
      memory: cloneMemory(version.snapshot),
      embedding: this.memories.get(version.memoryId)?.embedding ?? new Float32Array(),
    });
    this.deleteVersions.set(deleteId, restored);
    return restored;
  }

  getDeleteVersion(deleteId: string): MemoryDeleteVersion | undefined {
    return this.deleteVersions.get(deleteId);
  }

  queryAuthorizedMemorySubjects(input: MemorySubjectAuthorizedQuery) {
    return queryInMemoryAuthorizedSubjects(this, input);
  }

  mutateAuthorizedMemorySubjects(input: MemorySubjectAuthorizedMutation) {
    return mutateInMemoryAuthorizedSubjects(this, input);
  }

  persistAuthorizedMemoryWrite(input: MemorySubjectAuthorizedWrite) {
    return persistInMemoryAuthorizedSubject(this, input);
  }

  softDeleteAuthorizedMemorySubject(input: MemorySubjectAuthorizedDelete) {
    return softDeleteInMemoryAuthorizedSubject(this, input);
  }

  undoAuthorizedMemorySubjectDelete(input: MemorySubjectAuthorizedRestore) {
    return undoDeleteInMemoryAuthorizedSubject(this, input);
  }

  getMemorySubjectClassification(memoryId: string) {
    return classifyInMemorySubject(this, memoryId);
  }

  getStats(): MemoryStoreStats {
    const memories = this.getAllActiveMemories();
    const byType: Record<string, number> = {};
    let salienceSum = 0;
    for (const memory of memories) {
      byType[memory.type] = (byType[memory.type] ?? 0) + 1;
      salienceSum += memory.salience;
    }
    return {
      total: memories.length,
      byType,
      avgSalience: memories.length > 0 ? salienceSum / memories.length : 0,
    };
  }

  recordEvolutionLink(input: MemoryEvolutionLinkInput): MemoryEvolutionLink {
    const link: MemoryEvolutionLink = {
      id: input.linkId ?? `evolution-${this.evolutionLinks.length + 1}`,
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      relation: input.relation,
      confidence: input.confidence ?? 1,
      sourceType: input.sourceType ?? 'unknown',
      provenanceRefs: input.provenanceRefs ?? [],
      createdAt: input.createdAt ?? Date.now(),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.provenance ? { provenance: input.provenance } : {}),
    };
    this.evolutionLinks.push(link);
    return link;
  }

  getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return this.evolutionLinks.filter(link => (
      link.sourceMemoryId === sourceMemoryId
      && (relation === undefined || link.relation === relation)
    ));
  }

  getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return this.evolutionLinks.filter(link => (
      link.targetMemoryId === targetMemoryId
      && (relation === undefined || link.relation === relation)
    ));
  }

  recordAbstractionLink(input: MemoryAbstractionLinkInput): MemoryAbstractionLink {
    const link: MemoryAbstractionLink = {
      id: input.linkId ?? `abstraction-${this.abstractionLinks.length + 1}`,
      sourceMemoryId: input.sourceMemoryId,
      abstractedMemoryId: input.abstractedMemoryId,
      externalRef: input.externalRef,
      createdAt: input.createdAt ?? Date.now(),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.abstractionLinks.push(link);
    return link;
  }

  getAbstractionLinksForSourceMemory(sourceMemoryId: string): MemoryAbstractionLink[] {
    return this.abstractionLinks.filter(link => link.sourceMemoryId === sourceMemoryId);
  }

  getAbstractionLinksForAbstractedMemory(abstractedMemoryId: string): MemoryAbstractionLink[] {
    return this.abstractionLinks.filter(link => link.abstractedMemoryId === abstractedMemoryId);
  }

  linkMemories(id1: string, id2: string, linkType = 'related'): MemoryLink | null {
    if (!id1.trim() || !id2.trim() || id1 === id2) return null;
    const link: MemoryLink = { id1, id2, linkType, createdAt: Date.now() };
    this.linkedMemories.push(link);
    return { ...link };
  }

  unlinkMemories(id1: string, id2: string): boolean {
    const index = this.linkedMemories.findIndex(link => (
      (link.id1 === id1 && link.id2 === id2)
      || (link.id1 === id2 && link.id2 === id1)
    ));
    if (index < 0) return false;
    this.linkedMemories.splice(index, 1);
    return true;
  }

  getLinkedMemories(id: string): MemoryLink[] {
    return this.linkedMemories
      .filter(link => link.id1 === id || link.id2 === id)
      .map(link => ({ ...link }));
  }

  bulkDelete(ids: string[]): number {
    let deleted = 0;
    for (const id of ids) {
      if (this.softDeleteMemory(id)) deleted += 1;
    }
    return deleted;
  }

  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): number {
    let updated = 0;
    for (const id of ids) {
      const stored = this.memories.get(id);
      if (!stored || stored.memory.deletedAt) continue;
      const memory = { ...stored.memory, ...fields };
      if (fields.retentionClass !== undefined) {
        memory.tags = applyRetentionClassTags(stored.memory, fields.retentionClass);
      }
      this.memories.set(id, {
        memory: cloneMemory(memory),
        embedding: stored.embedding,
      });
      updated += 1;
    }
    return updated;
  }

  bulkUpdateSalience(updates: MemorySalienceUpdate[]): number {
    let count = 0;
    for (const update of updates) {
      const stored = this.memories.get(update.id);
      if (!stored || stored.memory.deletedAt) continue;
      this.memories.set(update.id, {
        memory: cloneMemory({
          ...stored.memory,
          salience: update.salience,
          salienceDecayAnchorAt: update.salienceDecayAnchorAt,
        }),
        embedding: stored.embedding,
      });
      count += 1;
    }
    return count;
  }

  getMemoriesByChannel(channelId: string, limit: number): PurrMemory[] {
    return this.getAllActiveMemories()
      .filter(memory => (
        memory.provenance?.channelId === channelId
        || memory.sourceRef.startsWith(`${channelId}:`)
      ))
      .slice(0, limit);
  }

  getMemoriesByContact(contactId: string, limit: number): PurrMemory[] {
    return this.getAllActiveMemories()
      .filter(memory => memory.contactId === contactId)
      .slice(0, limit);
  }

  addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): ScratchpadAddResult {
    const id = options.id ?? `scratch-${this.scratchpad.size + 1}`;
    const now = options.now ?? Date.now();
    const entry: ScratchpadEntry = { id, content, createdAt: now, updatedAt: now };
    this.scratchpad.set(id, entry);
    return { entry: { ...entry }, evictedIds: [] };
  }

  replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): ScratchpadEntry | null {
    const current = this.scratchpad.get(id);
    if (!current) return null;
    const entry = { ...current, content, updatedAt: options.now ?? Date.now() };
    this.scratchpad.set(id, entry);
    return { ...entry };
  }

  appendScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): ScratchpadEntry | null {
    const current = this.scratchpad.get(id);
    if (!current) return null;
    return this.replaceScratchpadEntry(id, `${current.content}${content}`, options);
  }

  removeScratchpadEntry(id: string): boolean {
    return this.scratchpad.delete(id);
  }

  getScratchpadEntry(id: string): ScratchpadEntry | undefined {
    const entry = this.scratchpad.get(id);
    return entry ? { ...entry } : undefined;
  }

  listScratchpadEntries(limit = 64): ScratchpadEntry[] {
    return [...this.scratchpad.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map(entry => ({ ...entry }));
  }

  upsertContactProfile(profile: ContactProfileArtifact): void {
    this.contactProfiles.set(profile.contactId, { ...profile });
  }

  getContactProfile(contactId: string): ContactProfileArtifact | undefined {
    const profile = this.contactProfiles.get(contactId);
    return profile ? { ...profile } : undefined;
  }

  listContactProfiles(): ContactProfileArtifact[] {
    return [...this.contactProfiles.values()].map(profile => ({ ...profile }));
  }

  upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): MemoryMaintenanceReview {
    const review = normalizeMemoryMaintenanceReviewInput(input);
    this.maintenanceReviews.set(review.id, review);
    return review;
  }

  listMemoryMaintenanceReviews(
    options: MemoryMaintenanceReviewListOptions = {},
  ): MemoryMaintenanceReview[] {
    return [...this.maintenanceReviews.values()]
      .filter(review => options.status === undefined || review.status === options.status)
      .filter(review => options.kind === undefined || review.kind === options.kind)
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, options.limit ?? 100);
  }

  getMemoryMaintenanceReview(id: string): MemoryMaintenanceReview | undefined {
    return this.maintenanceReviews.get(id);
  }

  getMemoryMaintenanceDiagnostics(
    options: MemoryMaintenanceDiagnosticsOptions = {},
  ): MemoryMaintenanceDiagnostics {
    const now = options.now ?? Date.now();
    const reviews = [...this.maintenanceReviews.values()];
    const pendingAges = reviews
      .filter(review => review.status === 'pending')
      .map(review => Math.max(0, now - review.createdAt));
    const reviewCountsByKind: Record<string, number> = {};
    const reviewCountsByStatus: Record<string, number> = {};
    for (const review of reviews) {
      reviewCountsByKind[review.kind] = (reviewCountsByKind[review.kind] ?? 0) + 1;
      reviewCountsByStatus[review.status] = (reviewCountsByStatus[review.status] ?? 0) + 1;
    }
    const evolutionDecisionCountsByRelation: Record<MemoryEvolutionRelation, number> = {
      supersedes: 0,
      updates: 0,
      negates: 0,
      conflicts_with: 0,
    };
    let latestEvolutionDecisionAt: number | undefined;
    for (const link of this.evolutionLinks) {
      evolutionDecisionCountsByRelation[link.relation] += 1;
      latestEvolutionDecisionAt = Math.max(latestEvolutionDecisionAt ?? link.createdAt, link.createdAt);
    }
    const averagePendingReviewAgeMs = pendingAges.length > 0
      ? pendingAges.reduce((sum, age) => sum + age, 0) / pendingAges.length
      : 0;
    return {
      reviewCount: reviews.length,
      pendingReviewCount: pendingAges.length,
      reviewCountsByKind,
      reviewCountsByStatus,
      oldestPendingReviewAgeMs: pendingAges.length > 0 ? Math.max(...pendingAges) : 0,
      averagePendingReviewAgeMs,
      evolutionDecisionCount: this.evolutionLinks.length,
      evolutionDecisionCountsByRelation,
      supersessionDecisionCount: evolutionDecisionCountsByRelation.supersedes,
      conflictDecisionCount: evolutionDecisionCountsByRelation.conflicts_with,
      ...(latestEvolutionDecisionAt === undefined ? {} : { latestEvolutionDecisionAt }),
    };
  }

  private activeEntries(): StoredMemory[] {
    return [...this.memories.values()]
      .filter(({ memory }) => !memory.supersededBy && !memory.deletedAt)
      .sort((left, right) => (
        right.memory.extractedAt - left.memory.extractedAt
        || left.memory.id.localeCompare(right.memory.id)
      ));
  }
}
