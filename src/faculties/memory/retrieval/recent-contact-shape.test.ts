import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';

import type { MemoryStorePort, RecentContactShapeArtifact } from '../memory-store-port.js';
import { classifyMemorySubject } from '../subject-classification.js';
import type { PurrMemory } from '../types.js';
import { resolveRecentContactShapeAccess } from './access-context.js';

const NOW = Date.parse('2026-08-10T12:00:00.000Z');

function source(id: string, contactId = 'contact-1'): PurrMemory {
  return fromPartial<PurrMemory>({
    id,
    text: 'live authorized source',
    type: 'semantic',
    confidence: 0.9,
    sensitivity: 'personal',
    sourceRef: `memory:${id}`,
    sourceType: 'conversation',
    tags: [],
    contactId,
    provenance: { channelId: 'dm:contact-1', subjectContactId: contactId },
    consentFlags: { allowRecall: true },
  });
}

function shape(overrides: Partial<RecentContactShapeArtifact> = {}): RecentContactShapeArtifact {
  return {
    schemaVersion: 1,
    contactId: 'contact-1',
    summary: 'A recent, bounded impression.',
    sourceMemoryIds: ['memory-1'],
    confidenceScore: 0.9,
    noveltyScore: 0.4,
    updatedAt: NOW - 1_000,
    freshUntil: NOW + 1_000,
    ...overrides,
  };
}

function store(memories: readonly PurrMemory[]): MemoryStorePort {
  return fromPartial<MemoryStorePort>({
    getById: async (id: string) => memories.find(memory => memory.id === id),
    getMemorySubjectClassification: async (id: string) => {
      const memory = memories.find(candidate => candidate.id === id);
      return memory
        ? classifyMemorySubject(memory, {
            memoryRevision: 1,
            now: NOW,
            validSubjectContactIds: new Set(['contact-1', 'contact-2']),
          })
        : undefined;
    },
  });
}

const options = {
  trustLevel: 'primary' as const,
  channelPrivacy: 'private' as const,
  broadcast: false,
  channelMeta: { isDirectMessage: true },
  canonicalContactId: 'contact-1',
};

describe('Recent Contact Shape access', () => {
  it('admits only a fresh shape whose complete live source set is authorized', async () => {
    const result = await resolveRecentContactShapeAccess({
      memoryStore: store([source('memory-1')]),
      sessionQuarantineFilter: null,
      recentContactShape: shape(),
      options,
      now: NOW,
    });

    expect(result.recentContactShape?.summary).toBe('A recent, bounded impression.');
    expect(result.withheldSourceMemoryIds).toEqual([]);
  });

  it.each([
    ['expired', shape({ freshUntil: NOW })],
    ['missing source', shape({ sourceMemoryIds: ['missing'] })],
    ['empty source set', shape({ sourceMemoryIds: [] })],
  ])('withholds an %s shape instead of treating prose as profile authority', async (_name, value) => {
    const result = await resolveRecentContactShapeAccess({
      memoryStore: store([]),
      sessionQuarantineFilter: null,
      recentContactShape: value,
      options,
      now: NOW,
    });

    expect(result.recentContactShape).toBeUndefined();
  });

  it('withholds a shape when any live source belongs to another canonical contact', async () => {
    const result = await resolveRecentContactShapeAccess({
      memoryStore: store([source('memory-1', 'contact-2')]),
      sessionQuarantineFilter: null,
      recentContactShape: shape(),
      options,
      now: NOW,
    });

    expect(result.recentContactShape).toBeUndefined();
    expect(result.authorizedSourceMemories).toEqual([]);
    expect(result.withheldSourceMemoryIds).toEqual(['memory-1']);
  });
});
