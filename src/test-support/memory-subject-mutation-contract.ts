import { describe, expect, it } from 'vitest';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import { createSubjectAuthorizedMemoryStore } from '../faculties/memory/subject-authorized-store.js';
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
  | 'persistAuthorizedMemoryWrite'
  | 'queryAuthorizedMemorySubjects'
  | 'updateMemory'
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
    sensitivity: 'public',
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
    it('writes companion-internal memories as companion_private, invisible to contact viewers', async () => {
      await withStore(async (store) => {
        const port = store as unknown as MemoryStorePort;
        const internal = createSubjectAuthorizedMemoryStore(port, { companionInternal: true });
        const contactViewer = createSubjectAuthorizedMemoryStore(port, { viewerContactId: 'contact-a' });
        const untrusted = createSubjectAuthorizedMemoryStore(port, {});
        const note = memory('internal-note', 'contact-a', {
          text: 'Free-time workspace note: the sketch folder is tidy now.',
          // A caller-supplied contact subject must not survive the internal stamp.
          provenance: { subjectContactId: 'contact-a', channelId: 'internal:free-time:workspace' },
        });

        await internal.persistMemoryWrite({ memory: note, embedding: CONTRACT_EMBEDDING });

        const stored = await store.getById('internal-note');
        expect(stored?.provenance?.subjectContactId).toBeUndefined();
        expect(stored?.provenance?.subjectScope).toBe('companion_internal');
        const classification = await store.getMemorySubjectClassification('internal-note');
        expect(classification).toMatchObject({
          subjectClass: 'companion_private',
          status: 'current',
          subjectContactIds: [],
          reasonClass: 'companion_internal_source',
        });
        const internalDetail = await internal.queryAuthorizedMemorySubjects({
          authorization: authorization('detail'),
          selector: { kind: 'detail', memoryId: 'internal-note' },
        });
        expect(internalDetail.total).toBe(1);
        const viewerDetail = await contactViewer.queryAuthorizedMemorySubjects({
          authorization: authorization('detail'),
          selector: { kind: 'detail', memoryId: 'internal-note' },
        });
        expect(viewerDetail.total).toBe(0);

        // A contact viewer cannot claim the companion-internal scope either.
        await contactViewer.persistMemoryWrite({
          memory: memory('viewer-note', 'contact-a', {
            provenance: { subjectScope: 'companion_internal' },
          }),
          embedding: CONTRACT_EMBEDDING,
        });
        const viewerNote = await store.getById('viewer-note');
        expect(viewerNote?.provenance?.subjectScope).toBeUndefined();
        expect(viewerNote?.provenance?.subjectContactId).toBe('contact-a');
        expect((await store.getMemorySubjectClassification('viewer-note'))?.subjectClass)
          .toBe('single_contact');

        // No trusted subject: still rejected, nothing written.
        await expect(untrusted.persistMemoryWrite({
          memory: memory('untrusted-note', 'contact-a'),
          embedding: CONTRACT_EMBEDDING,
        })).rejects.toThrow('Memory access requires a trusted memory subject');
        expect(await store.getById('untrusted-note')).toBeUndefined();
      });
    }, timeoutMs);

    it('rejects a write whose new row the writer cannot read back, and keeps legitimate writes', async () => {
      await withStore(async (store) => {
        const port = store as unknown as MemoryStorePort;
        const currentState = { tags: ['current_state', 'workspace'] };
        await store.insertMemory(memory('a-old', 'contact-a', {
          ...currentState,
          text: 'Current workspace is /home/a/old.',
        }), CONTRACT_EMBEDDING);

        // contact-a's authorization cannot read a contact-b row: the whole
        // write fails closed, including the supersede of contact-a's own row.
        await expect(store.persistAuthorizedMemoryWrite({
          authorization: authorization(),
          memory: memory('foreign-new', 'contact-b', { ...currentState, text: 'Current workspace is /home/b/new.' }),
          embedding: CONTRACT_EMBEDDING,
          supersededMemoryIds: ['a-old'],
        })).rejects.toThrow('Memory subject authorization denied');
        expect(await store.getById('foreign-new')).toBeUndefined();
        expect((await store.getById('a-old'))?.supersededBy).toBeUndefined();
        // A companion-internal writer cannot persist a contact row either.
        await expect(store.persistAuthorizedMemoryWrite({
          authorization: authorization('bulk_mutation', {
            viewerContactIds: ['companion:internal'],
            allowedSubjectClasses: ['companion_private'],
            allowedViewerRelations: ['none'],
          }),
          memory: memory('internal-contact-row', 'contact-a'),
          embedding: CONTRACT_EMBEDDING,
        })).rejects.toThrow('Memory subject authorization denied');
        expect(await store.getById('internal-contact-row')).toBeUndefined();

        // Legitimate contact and companion-internal writes still land and
        // stay readable by their writer.
        const contactWriter = createSubjectAuthorizedMemoryStore(port, { viewerContactId: 'contact-a' });
        const internalWriter = createSubjectAuthorizedMemoryStore(port, { companionInternal: true });
        await contactWriter.persistMemoryWrite({
          memory: memory('a-new', 'contact-a', { ...currentState, text: 'Current workspace is /home/a/new.' }),
          embedding: CONTRACT_EMBEDDING,
          supersededMemoryIds: ['a-old'],
        });
        await internalWriter.persistMemoryWrite({
          memory: memory('internal-new', 'contact-a', { text: 'Free-time note: the sketch folder is tidy.' }),
          embedding: CONTRACT_EMBEDDING,
        });
        expect((await store.getById('a-old'))?.supersededBy).toBe('a-new');
        for (const [writer, memoryId] of [[contactWriter, 'a-new'], [internalWriter, 'internal-new']] as const) {
          const detail = await writer.queryAuthorizedMemorySubjects({
            authorization: authorization('detail'),
            selector: { kind: 'detail', memoryId },
          });
          expect(detail.total).toBe(1);
        }
      });
    }, timeoutMs);

    it('proves a superseded row only through its exact superseding memory', async () => {
      await withStore(async (store) => {
        const currentState = { tags: ['current_state', 'workspace'] };
        await store.insertMemory(memory('ws-old', 'contact-a', {
          ...currentState,
          text: 'Current workspace is /home/a/old.',
          confidence: 0.65,
        }), CONTRACT_EMBEDDING);
        await store.insertMemory(memory('ws-foreign-old', 'contact-b', {
          ...currentState,
          text: 'Current workspace is /home/b/old.',
          confidence: 0.65,
        }), CONTRACT_EMBEDDING);
        // The MemoryWriter current_state_replacement commit: the new memory
        // lands and archives the one it replaces in one authorized write.
        await store.persistAuthorizedMemoryWrite({
          authorization: authorization(),
          memory: memory('ws-new', 'contact-a', { ...currentState, text: 'Current workspace is /home/a/new.' }),
          embedding: CONTRACT_EMBEDDING,
          supersededMemoryIds: ['ws-old'],
        });
        await store.persistAuthorizedMemoryWrite({
          authorization: authorization('bulk_mutation', { viewerContactIds: ['contact-b'] }),
          memory: memory('ws-foreign-new', 'contact-b', { ...currentState, text: 'Current workspace is /home/b/new.' }),
          embedding: CONTRACT_EMBEDDING,
          supersededMemoryIds: ['ws-foreign-old'],
        });
        expect((await store.getById('ws-old'))?.supersededBy).toBe('ws-new');
        const detail = authorization('detail');
        const ids = async (selector: Parameters<SubjectMutationStore['queryAuthorizedMemorySubjects']>[0]['selector']) => {
          const result = await store.queryAuthorizedMemorySubjects({ authorization: detail, selector });
          return { total: result.total, ids: result.memories.map(row => row.id) };
        };

        // The ordinary detail selector never sees an archived row.
        await expect(ids({ kind: 'detail', memoryId: 'ws-old' })).resolves.toEqual({ total: 0, ids: [] });
        // (a) the trusted subject proves it through the correct superseding memory
        await expect(ids({ kind: 'superseded_detail', memoryId: 'ws-old', supersededBy: 'ws-new' }))
          .resolves.toEqual({ total: 1, ids: ['ws-old'] });
        // (b) any other supersededBy returns nothing
        await expect(ids({ kind: 'superseded_detail', memoryId: 'ws-old', supersededBy: 'ws-foreign-new' }))
          .resolves.toEqual({ total: 0, ids: [] });
        // (d) a foreign contact's archived row returns nothing, even with its true superseder
        await expect(ids({ kind: 'superseded_detail', memoryId: 'ws-foreign-old', supersededBy: 'ws-foreign-new' }))
          .resolves.toEqual({ total: 0, ids: [] });
        // An active row is not a superseded row.
        await expect(ids({ kind: 'superseded_detail', memoryId: 'ws-new', supersededBy: 'ws-new' }))
          .resolves.toEqual({ total: 0, ids: [] });
        // Only the detail action may use the selector.
        await expect(store.queryAuthorizedMemorySubjects({
          authorization: authorization('list'),
          selector: { kind: 'superseded_detail', memoryId: 'ws-old', supersededBy: 'ws-new' },
        })).rejects.toThrow('does not permit superseded_detail');
        // (c) a deleted archived row returns nothing
        await store.updateMemory('ws-old', {
          deletedAt: 1_700_000_100_000,
          deletedBy: 'test:contract',
          deleteReason: 'contract deletion',
        });
        await expect(ids({ kind: 'superseded_detail', memoryId: 'ws-old', supersededBy: 'ws-new' }))
          .resolves.toEqual({ total: 0, ids: [] });
      });
    }, timeoutMs);

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
        })).rejects.toThrow('Memory subject authorization denied');
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
        })).rejects.toThrow('Memory subject authorization denied');
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
