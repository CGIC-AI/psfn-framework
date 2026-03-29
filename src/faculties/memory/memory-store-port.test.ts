import { describe, expect, it } from 'vitest';
import type { EmbeddingProviderPort } from '../../core/agent/contracts.js';
import {
  type ContactProfileArtifact,
  type MemoryAbstractionLink,
  type MemoryAbstractionLinkInput,
  type MemoryBulkUpdatePatch,
  type MemoryDeleteVersion,
  type MemoryLink,
  type MemorySearchResult,
  type MemorySoftDeleteOptions,
  type MemoryStorePort,
  type MemoryStoreStats,
  type MemoryStoreUpdatePatch,
  type MemoryUndoSoftDeleteOptions,
  type ScratchpadAddResult,
  type ScratchpadEntry,
  type ScratchpadEntryCreateOptions,
  type ScratchpadEntryReplaceOptions,
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

class InMemoryMemoryStorePort implements MemoryStorePort {
  private readonly memories = new Map<string, PurrMemory>();
  private readonly deleteVersions = new Map<string, MemoryDeleteVersion>();
  private readonly abstractionLinks: MemoryAbstractionLink[] = [];
  private readonly linkedMemories: MemoryLink[] = [];
  private readonly profiles = new Map<string, ContactProfileArtifact>();
  private readonly scratchpad = new Map<string, ScratchpadEntry>();

  insertMemory(memory: PurrMemory): void {
    this.memories.set(memory.id, { ...memory });
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

  getAllActiveMemories(limit = 10_000): PurrMemory[] {
    return [...this.memories.values()]
      .filter(memory => !memory.supersededBy && !memory.deletedAt)
      .slice(0, limit)
      .map(memory => ({ ...memory }));
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
    expect(store.countActiveMemories()).toBe(1);
    expect(retrieved).toContain('V prefers oolong tea in the morning');
  });
});
