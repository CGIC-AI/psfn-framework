import { describe, expect, it } from 'vitest';
import type { PurrMemory } from '../faculties/memory/types.js';
import { InMemoryMemoryStore } from './in-memory-memory-store.js';
import { describeMemorySubjectMutationContract } from './memory-subject-mutation-contract.js';

function memory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0.1,
    salience: 0.3,
    sourceRef: 'test:in-memory-subjects',
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'low',
    consentFlags: {},
    provenance: { subjectContactId: 'contact-a' },
    ...overrides,
  };
}

describeMemorySubjectMutationContract(
  'in-memory',
  async run => await run(new InMemoryMemoryStore().asPort()),
);

describe('in-memory subject-authorized mutation concurrency', () => {
  it('does not roll back a concurrent successful mutation when another batch is denied', async () => {
    const store = new InMemoryMemoryStore();
    store.insertMemory(memory('a-authorized', { sensitivity: 'public' }));
    const authorization = {
      action: 'bulk_mutation' as const,
      viewerContactIds: ['contact-a'],
      allowedSubjectClasses: ['single_contact'] as const,
      allowedViewerRelations: ['self'] as const,
      classifierVersion: 1,
      grantBindings: [],
    };

    const denied = store.mutateAuthorizedMemorySubjects({
      authorization,
      memoryIds: ['a-authorized', 'z-missing'],
      updates: { sensitivity: 'confidential' },
    });
    const successful = store.mutateAuthorizedMemorySubjects({
      authorization,
      memoryIds: ['a-authorized'],
      updates: { sensitivity: 'intimate' },
    });

    await expect(denied).rejects.toThrow('Memory subject authorization denied');
    await expect(successful).resolves.toBe(1);
    expect(store.getById('a-authorized')?.sensitivity).toBe('intimate');
  });
});
