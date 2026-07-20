import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../faculties/memory/types.js';
import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  type MemorySubjectQueryAuthorization,
} from '../shared/contracts/memory-subject.js';

const CONTRACT_EMBEDDING = new Float32Array([0.9, 0.1, 0.1, 0.1]);

type SubjectMutationStore = Pick<
  MemoryStorePort,
  | 'getById'
  | 'getMemorySubjectClassification'
  | 'insertMemory'
  | 'mutateAuthorizedMemorySubjects'
>;

export type WithSubjectMutationStore = <T>(
  run: (store: SubjectMutationStore) => Promise<T>,
) => Promise<T>;

function memory(id: string, subjectContactId: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text: `Memory ${id}`,
    type: 'semantic',
    importance: 0.6,
    confidence: 0.9,
    emotionalValence: 0.1,
    salience: 0.3,
    sourceRef: 'test:subject-mutation-contract',
    extractedAt: 1_700_000_000_000,
    lastAccessed: 1_700_000_000_000,
    accessCount: 0,
    tags: [],
    sensitivity: 'low',
    consentFlags: {},
    provenance: { subjectContactId },
    ...overrides,
  };
}

function authorization(
  action: MemorySubjectQueryAuthorization['action'] = 'bulk_mutation',
  overrides: Partial<MemorySubjectQueryAuthorization> = {},
): MemorySubjectQueryAuthorization {
  return {
    action,
    viewerContactIds: ['contact-a'],
    allowedSubjectClasses: ['single_contact'],
    allowedViewerRelations: ['self'],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [],
    ...overrides,
  };
}

export function describeMemorySubjectMutationContract(
  implementation: string,
  withStore: WithSubjectMutationStore,
  timeoutMs?: number,
): void {
  describe(`${implementation} subject-authorized mutation contract`, () => {
    it.each([
      {
        name: 'an unauthorized target',
        memoryIds: ['a-authorized', 'z-other-subject'],
      },
      {
        name: 'a missing target',
        memoryIds: ['a-authorized', 'z-missing'],
      },
    ])('rejects a batch containing $name without mutating an authorized sibling', async ({ memoryIds }) => {
      await withStore(async (store) => {
        await store.insertMemory(memory('a-authorized', 'contact-a', { sensitivity: 'public' }), CONTRACT_EMBEDDING);
        await store.insertMemory(memory('z-other-subject', 'contact-b', { sensitivity: 'personal' }), CONTRACT_EMBEDDING);

        await expect(store.mutateAuthorizedMemorySubjects({
          authorization: authorization(),
          memoryIds,
          updates: { sensitivity: 'confidential' },
        })).rejects.toThrow(new Error('Memory subject authorization denied'));
        expect((await store.getById('a-authorized'))?.sensitivity).toBe('public');
        expect((await store.getById('z-other-subject'))?.sensitivity).toBe('personal');
      });
    }, timeoutMs);

    it('rejects a stale classification binding without mutating any target', async () => {
      await withStore(async (store) => {
        await store.insertMemory(memory('a-authorized', 'contact-a', { sensitivity: 'public' }), CONTRACT_EMBEDDING);
        await store.insertMemory(memory('z-stale-binding', 'contact-a', { sensitivity: 'personal' }), CONTRACT_EMBEDDING);
        const currentA = await store.getMemorySubjectClassification('a-authorized');
        const currentStale = await store.getMemorySubjectClassification('z-stale-binding');
        if (!currentA || !currentStale) throw new Error('Test setup failed to classify memories');

        await expect(store.mutateAuthorizedMemorySubjects({
          authorization: authorization('bulk_mutation', {
            grantBindings: [
              {
                memoryId: currentA.memoryId,
                memoryRevision: currentA.memoryRevision,
                classifierVersion: currentA.classifierVersion,
                evidenceDigest: currentA.evidenceDigest,
              },
              {
                memoryId: currentStale.memoryId,
                memoryRevision: currentStale.memoryRevision + 1,
                classifierVersion: currentStale.classifierVersion,
                evidenceDigest: currentStale.evidenceDigest,
              },
            ],
          }),
          memoryIds: ['a-authorized', 'z-stale-binding'],
          updates: { sensitivity: 'confidential' },
        })).rejects.toThrow(new Error('Memory subject authorization denied'));
        expect((await store.getById('a-authorized'))?.sensitivity).toBe('public');
        expect((await store.getById('z-stale-binding'))?.sensitivity).toBe('personal');
      });
    }, timeoutMs);

    it('rejects stale classifier versions with the production failure shape', async () => {
      await withStore(async (store) => {
        await store.insertMemory(memory('authorized', 'contact-a', { sensitivity: 'public' }), CONTRACT_EMBEDDING);
        const staleVersion = MEMORY_SUBJECT_CLASSIFIER_VERSION + 1;

        await expect(store.mutateAuthorizedMemorySubjects({
          authorization: authorization('bulk_mutation', { classifierVersion: staleVersion }),
          memoryIds: ['authorized'],
          updates: { sensitivity: 'confidential' },
        })).rejects.toThrow(new Error(
          `Memory subject authorization classifier version ${staleVersion} is stale or unsupported`,
        ));
        expect((await store.getById('authorized'))?.sensitivity).toBe('public');
      });
    }, timeoutMs);

    it('normalizes a fully authorized batch and preserves retention tag behavior', async () => {
      await withStore(async (store) => {
        await store.insertMemory(memory('memory-a', 'contact-a', {
          text: 'Favorite tea',
          tags: ['preference:drink'],
        }), CONTRACT_EMBEDDING);
        await store.insertMemory(memory('memory-b', 'contact-a', {
          text: 'Favorite color',
          tags: ['preference:color'],
        }), CONTRACT_EMBEDDING);

        await expect(store.mutateAuthorizedMemorySubjects({
          authorization: authorization(),
          memoryIds: [' memory-b ', 'memory-a', 'memory-b', 'memory-a', ''],
          updates: {
            retentionClass: 'durable',
            sensitivity: 'confidential',
          },
        })).resolves.toBe(2);
        expect(await store.getById('memory-a')).toMatchObject({
          retentionClass: 'durable',
          sensitivity: 'confidential',
          tags: ['preference:drink', 'durable', 'durable_preference'],
        });
        expect(await store.getById('memory-b')).toMatchObject({
          retentionClass: 'durable',
          sensitivity: 'confidential',
          tags: ['preference:color', 'durable', 'durable_preference'],
        });
      });
    }, timeoutMs);

    it('rejects a wrong action with the production failure shape and mutates nothing', async () => {
      await withStore(async (store) => {
        await store.insertMemory(memory('authorized', 'contact-a', { sensitivity: 'public' }), CONTRACT_EMBEDDING);

        await expect(store.mutateAuthorizedMemorySubjects({
          authorization: authorization('detail'),
          memoryIds: ['authorized'],
          updates: { sensitivity: 'confidential' },
        })).rejects.toThrow(new Error('Memory subject authorization action does not permit mutation'));
        expect((await store.getById('authorized'))?.sensitivity).toBe('public');
      });
    }, timeoutMs);
  });
}
