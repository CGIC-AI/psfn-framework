import { describe, expect, it } from 'vitest';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import {
  type ContactProfileArtifact,
  type MemoryAbstractionLink,
  type MemoryAbstractionLinkInput,
  type MemoryBulkUpdatePatch,
  type MemoryDeleteVersion,
  type MemoryEvolutionLink,
  type MemoryEvolutionLinkInput,
  type MemoryEvolutionRelation,
  type MemoryLink,
  type MemoryPatchEvent,
  type MemorySearchResult,
  type MemorySalienceUpdate,
  type MemorySoftDeleteOptions,
  type MemoryStorePort,
  type MemoryStoreStats,
  type MemoryStoreUpdatePatch,
  type MemoryUndoSoftDeleteOptions,
  type ScratchpadAddResult,
  type ScratchpadEntry,
  type ScratchpadEntryCreateOptions,
  type ScratchpadEntryReplaceOptions,
  createMemoryStorePort,
} from './memory-store-port.js';
import { MemoryRetriever } from './retrieval.js';
import { MemoryWriter } from './writer.js';
import type { PurrMemory } from './types.js';

function makeEmbeddingProvider(): EmbeddingProviderPort {
  return {
    embed: async () => new Float32Array([0.1, 0.2, 0.3, 0.4]),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4])),
    dims: 4,
  };
}

function makePortMemory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.5,
    confidence: 0.8,
    emotionalValence: 0,
    salience: 0.5,
    sourceRef: 'test:memory-store-port',
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

class InMemoryMemoryStorePort implements MemoryStorePort {
  private readonly memories = new Map<string, PurrMemory>();
  private readonly deleteVersions = new Map<string, MemoryDeleteVersion>();
  private readonly abstractionLinks: MemoryAbstractionLink[] = [];
  private readonly evolutionLinks: MemoryEvolutionLink[] = [];
  private readonly linkedMemories: MemoryLink[] = [];
  private readonly profiles = new Map<string, ContactProfileArtifact>();
  private readonly scratchpad = new Map<string, ScratchpadEntry>();
  private readonly patchEvents: MemoryPatchEvent[] = [];

  insertMemory(memory: PurrMemory): void {
    this.memories.set(memory.id, { ...memory });
  }

  async persistMemoryWrite(input: {
    memory: PurrMemory;
    embedding: Float32Array;
    supersededMemoryIds?: string[];
  }): Promise<void> {
    for (const id of input.supersededMemoryIds ?? []) {
      this.updateMemory(id, { supersededBy: input.memory.id });
    }
    this.insertMemory(input.memory, input.embedding);
  }

  runInTransaction<T>(handler: () => T): T {
    return handler();
  }

  searchByEmbedding(): MemorySearchResult[] {
    return this.getAllActiveMemories().map(memory => ({ ...memory, similarity: 0.95 }));
  }

  searchByText(query: string): MemorySearchResult[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return this.getAllActiveMemories()
      .filter(memory => memory.text.toLowerCase().includes(normalized))
      .map(memory => ({ ...memory, similarity: 0.9 }));
  }

  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void {
    const current = this.memories.get(id);
    if (!current) return;
    this.memories.set(id, {
      ...current,
      ...updates,
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
    return [...this.memories.values()]
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .slice(0, limit)
      .map(memory => ({ ...memory }));
  }

  listMemories(options: { limit?: number; offset?: number } = {}): PurrMemory[] {
    const offset = options.offset ?? 0;
    const memories = [...this.memories.values()]
      .sort((left, right) => {
        const leftArchived = left.supersededBy || left.deletedAt ? 1 : 0;
        const rightArchived = right.supersededBy || right.deletedAt ? 1 : 0;
        return leftArchived - rightArchived || right.extractedAt - left.extractedAt;
      });
    const limited = options.limit === undefined
      ? memories.slice(offset)
      : memories.slice(offset, offset + options.limit);
    return limited.map(memory => ({ ...memory }));
  }

  listActiveMemories(options: { limit?: number; offset?: number } = {}): PurrMemory[] {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    return this.getAllActiveMemories().slice(offset, offset + limit);
  }

  countActiveMemories(): number {
    return this.getAllActiveMemories().length;
  }

  getById(id: string): PurrMemory | undefined {
    const memory = this.memories.get(id);
    return memory ? { ...memory } : undefined;
  }

  softDeleteMemory(id: string, options: MemorySoftDeleteOptions = {}): MemoryDeleteVersion | null {
    const memory = this.memories.get(id);
    if (!memory || memory.deletedAt) return null;
    const deleteVersion: MemoryDeleteVersion = {
      deleteId: options.deleteId ?? `delete-${id}`,
      memoryId: id,
      snapshot: { ...memory },
      deletedAt: options.deletedAt ?? Date.now(),
      deletedBy: options.deletedBy ?? 'test',
      ...(options.reason ? { deleteReason: options.reason } : {}),
    };
    this.deleteVersions.set(deleteVersion.deleteId, deleteVersion);
    this.updateMemory(id, {
      deletedAt: deleteVersion.deletedAt,
      deletedBy: deleteVersion.deletedBy,
      ...(deleteVersion.deleteReason ? { deleteReason: deleteVersion.deleteReason } : {}),
    });
    return deleteVersion;
  }

  undoSoftDelete(
    deleteId: string,
    options: MemoryUndoSoftDeleteOptions = {},
  ): MemoryDeleteVersion | null {
    const version = this.deleteVersions.get(deleteId);
    if (!version) return null;
    this.updateMemory(version.memoryId, {
      deletedAt: undefined,
      deletedBy: undefined,
      deleteReason: undefined,
    });
    const restored: MemoryDeleteVersion = {
      ...version,
      restoredAt: options.restoredAt ?? Date.now(),
      restoredBy: options.restoredBy ?? 'test',
    };
    this.deleteVersions.set(deleteId, restored);
    return restored;
  }

  getDeleteVersion(deleteId: string): MemoryDeleteVersion | undefined {
    return this.deleteVersions.get(deleteId);
  }

  recordAbstractionLink(input: MemoryAbstractionLinkInput): MemoryAbstractionLink {
    const link: MemoryAbstractionLink = {
      id: input.linkId ?? `link-${this.abstractionLinks.length + 1}`,
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

  recordEvolutionLink(input: MemoryEvolutionLinkInput): MemoryEvolutionLink {
    const link: MemoryEvolutionLink = {
      id: input.linkId ?? `evolution-${this.evolutionLinks.length + 1}`,
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      relation: input.relation,
      confidence: input.confidence ?? 1,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      sourceType: input.sourceType ?? 'unknown',
      provenanceRefs: input.provenanceRefs ?? [],
      ...(input.provenance ? { provenance: input.provenance } : {}),
      createdAt: input.createdAt ?? Date.now(),
    };
    this.evolutionLinks.push(link);
    return link;
  }

  getEvolutionLinksForSourceMemory(
    sourceMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return this.evolutionLinks
      .filter(link => link.sourceMemoryId === sourceMemoryId)
      .filter(link => relation === undefined || link.relation === relation);
  }

  getEvolutionLinksForTargetMemory(
    targetMemoryId: string,
    relation?: MemoryEvolutionRelation,
  ): MemoryEvolutionLink[] {
    return this.evolutionLinks
      .filter(link => link.targetMemoryId === targetMemoryId)
      .filter(link => relation === undefined || link.relation === relation);
  }

  getStats(): MemoryStoreStats {
    const byType: Record<string, number> = {};
    const memories = this.getAllActiveMemories();
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

  getMemoriesByChannel(channelId: string, limit: number): PurrMemory[] {
    return this.getAllActiveMemories()
      .filter(memory => memory.sourceRef.startsWith(`${channelId}:`))
      .slice(0, limit);
  }

  getMemoriesByContact(contactId: string, limit: number): PurrMemory[] {
    return this.getAllActiveMemories()
      .filter(memory => memory.contactId === contactId)
      .slice(0, limit);
  }

  linkMemories(id1: string, id2: string, linkType = 'related'): MemoryLink | null {
    if (!id1.trim() || !id2.trim() || id1 === id2) return null;
    const link: MemoryLink = {
      id1,
      id2,
      linkType,
      createdAt: Date.now(),
    };
    this.linkedMemories.push(link);
    return link;
  }

  unlinkMemories(id1: string, id2: string): boolean {
    const index = this.linkedMemories.findIndex(
      link => (link.id1 === id1 && link.id2 === id2) || (link.id1 === id2 && link.id2 === id1),
    );
    if (index < 0) return false;
    this.linkedMemories.splice(index, 1);
    return true;
  }

  getLinkedMemories(id: string): MemoryLink[] {
    return this.linkedMemories.filter(link => link.id1 === id || link.id2 === id);
  }

  bulkDelete(ids: string[]): number {
    let count = 0;
    for (const id of ids) {
      if (this.softDeleteMemory(id)) count += 1;
    }
    return count;
  }

  bulkUpdate(ids: string[], fields: MemoryBulkUpdatePatch): number {
    let count = 0;
    for (const id of ids) {
      const memory = this.memories.get(id);
      if (!memory || memory.deletedAt) continue;
      this.memories.set(id, {
        ...memory,
        ...fields,
      });
      count += 1;
    }
    return count;
  }

  bulkUpdateSalience(updates: MemorySalienceUpdate[]): number {
    let count = 0;
    for (const update of updates) {
      const memory = this.memories.get(update.id);
      if (!memory || memory.deletedAt) continue;
      this.memories.set(update.id, {
        ...memory,
        salience: update.salience,
      });
      count += 1;
    }
    return count;
  }

  upsertContactProfile(profile: ContactProfileArtifact): void {
    this.profiles.set(profile.contactId, { ...profile });
  }

  getContactProfile(contactId: string): ContactProfileArtifact | undefined {
    const profile = this.profiles.get(contactId);
    return profile ? { ...profile } : undefined;
  }

  listContactProfiles(): ContactProfileArtifact[] {
    return [...this.profiles.values()].map(profile => ({ ...profile }));
  }

  addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): ScratchpadAddResult {
    const id = options.id ?? `scratch-${this.scratchpad.size + 1}`;
    const now = options.now ?? Date.now();
    const entry: ScratchpadEntry = { id, content, createdAt: now, updatedAt: now };
    this.scratchpad.set(id, entry);
    return {
      entry: { ...entry },
      evictedIds: [],
    };
  }

  replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): ScratchpadEntry | null {
    const current = this.scratchpad.get(id);
    if (!current) return null;
    const updated: ScratchpadEntry = {
      ...current,
      content,
      updatedAt: options.now ?? Date.now(),
    };
    this.scratchpad.set(id, updated);
    return { ...updated };
  }

  removeScratchpadEntry(id: string): boolean {
    return this.scratchpad.delete(id);
  }

  getScratchpadEntry(id: string): ScratchpadEntry | undefined {
    const entry = this.scratchpad.get(id);
    return entry ? { ...entry } : undefined;
  }

  listScratchpadEntries(limit = 64): ScratchpadEntry[] {
    return [...this.scratchpad.values()].slice(0, limit).map(entry => ({ ...entry }));
  }

  getPatchEvents(): MemoryPatchEvent[] {
    return this.patchEvents.map((event) => ({
      ...event,
      patch: { ...event.patch },
      previousValues: { ...event.previousValues },
      nextValues: { ...event.nextValues },
    }));
  }
}

describe('MemoryStorePort', () => {
  it('supports writer and retriever flow against a non-SQLite implementation', async () => {
    const store = new InMemoryMemoryStorePort();
    const embeddings = makeEmbeddingProvider();
    const writer = new MemoryWriter(store, embeddings);
    const retriever = new MemoryRetriever(store, embeddings, {
      telemetryEnabled: false,
      contextWindow: 32_000,
    });

    const write = await writer.write({
      text: 'V prefers oolong tea in the morning',
      type: 'semantic',
      sourceRef: 'api:test:conversation',
    });
    const retrieved = await retriever.retrieve('oolong tea', 'api:test', 'primary');

    expect(write.action).toBe('created');
    expect(await store.countActiveMemories()).toBe(1);
    expect(retrieved).toContain('V prefers oolong tea in the morning');
  });

  it('lists archived memories separately from active memory reads', () => {
    const store = new InMemoryMemoryStorePort();
    store.insertMemory(makePortMemory('active-memory', { extractedAt: 2 }));
    store.insertMemory(makePortMemory('archived-memory', {
      extractedAt: 1,
      deletedAt: 3,
      deletedBy: 'test',
    }));

    expect(store.getAllActiveMemories().map(memory => memory.id)).toEqual(['active-memory']);
    expect(store.listMemories().map(memory => memory.id)).toEqual(['active-memory', 'archived-memory']);
  });

  it('delegates transaction, patch event, and evolution link APIs through createMemoryStorePort', async () => {
    const backend = new InMemoryMemoryStorePort();
    const port = createMemoryStorePort(backend);
    const patchEvent: MemoryPatchEvent = {
      id: 'patch-1',
      memoryId: 'memory-1',
      sourceRef: 'source:tool:memory_patch|invocation:call-1',
      sourceType: 'tool_write',
      provenance: {
        toolName: 'memory_patch',
        toolCallId: 'call-1',
      },
      reason: 'test patch',
      patch: { text: 'after' },
      previousValues: { text: 'before' },
      nextValues: { text: 'after' },
      createdAt: 123,
    };

    const value = await port.runInTransaction(() => 7);
    await port.recordPatchEvent(patchEvent);
    const evolutionLink = await port.recordEvolutionLink({
      linkId: 'evolution-1',
      sourceMemoryId: 'memory-2',
      targetMemoryId: 'memory-1',
      relation: 'updates',
      confidence: 0.8,
      provenanceRefs: ['l0:turn-1'],
      provenance: { turnId: 'turn-1' },
      createdAt: 456,
    });

    expect(value).toBe(7);
    expect(backend.getPatchEvents()).toEqual([patchEvent]);
    expect(evolutionLink.relation).toBe('updates');
    await expect(port.getEvolutionLinksForSourceMemory('memory-2')).resolves.toEqual([evolutionLink]);
    await expect(port.getEvolutionLinksForTargetMemory('memory-1', 'updates')).resolves.toEqual([evolutionLink]);
    await expect(port.listMemories()).resolves.toEqual([]);
  });
});
