import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { InMemoryMemoryStore } from '../../test-support/in-memory-memory-store.js';
import {
  getRequestContext,
  runWithRequestContext,
} from '../../primitives/llm/request-context.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from './subject-authorized-store.js';
import type { MemoryMaintenanceReviewInput } from './memory-store-port.js';
import { buildProvenanceConfidenceReviewInput } from './maintenance-review.js';
import { MemoryWriter } from './writer.js';
import type { PurrMemory } from './types.js';

/**
 * The production tool writer runs over the subject-authorized store with the
 * live request context (src/app/agent/main.ts toolMemoryStore). These cover
 * the two background mutations that used to fail there with "Memory access
 * requires a trusted memory subject": the post-commit supersedes link and the
 * queued post-write maintenance review.
 */
const DM_CONTEXT: Partial<CorrelationMetadata> = {
  channelId: 'discord:dm:contact-a',
  requesterProvenance: 'human',
  viewerMemorySubjectContactId: 'contact-a',
};
const REFLECTION_CONTEXT: Partial<CorrelationMetadata> = {
  channelId: 'internal:reflection:sleeptime-review',
  requesterProvenance: 'self_directed',
  requestAudience: 'self',
};

function setup() {
  const raw = new InMemoryMemoryStore();
  const store = createSubjectAuthorizedMemoryStore(
    raw,
    () => memorySubjectAccessContextFromCorrelation(getRequestContext()),
  );
  const maintenanceErrors: unknown[] = [];
  const writer = new MemoryWriter(store, fromAny({
    dims: 2,
    embed: async () => new Float32Array([1, 0]),
  }), {
    onMaintenanceError: error => maintenanceErrors.push(error),
  });
  return { raw, store, writer, maintenanceErrors };
}

async function settleMaintenance(): Promise<void> {
  // The maintenance scheduler defers through setTimeout; the request context
  // travels with it exactly as in production.
  await new Promise(resolve => setTimeout(resolve, 10));
}

function memory(id: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id, text: `memory ${id}`, type: 'semantic', importance: 0.8, confidence: 0.9,
    emotionalValence: 0, salience: 0.7, sourceRef: 'test:subject', extractedAt: 1,
    lastAccessed: 1, accessCount: 0, tags: [], sensitivity: 'low', consentFlags: {},
    ...overrides,
  };
}

describe('subject-authorized background memory mutations', () => {
  it.each([
    ['a DM with a resolved contact', DM_CONTEXT],
    ['companion self-reflection', REFLECTION_CONTEXT],
  ])('records the supersedes link for a current-state replacement in %s', async (_label, context) => {
    const { raw, writer, maintenanceErrors } = setup();
    const { oldResult, newResult } = await runWithRequestContext(context, async () => {
      const oldResult = await writer.write({
        text: 'Current workspace is /home/user/old.',
        type: 'semantic',
        confidence: 0.65,
        tags: ['current_state', 'workspace'],
      });
      const newResult = await writer.write({
        text: 'Current workspace is /home/user/new.',
        type: 'semantic',
        confidence: 0.9,
        tags: ['current_state', 'workspace'],
      });
      return { oldResult, newResult };
    });
    await settleMaintenance();

    expect(newResult.action).toBe('superseded');
    expect(raw.getById(oldResult.memory.id)?.supersededBy).toBe(newResult.memory.id);
    expect(raw.getEvolutionLinksForSourceMemory(newResult.memory.id)).toEqual([
      expect.objectContaining({
        targetMemoryId: oldResult.memory.id,
        relation: 'supersedes',
        reason: 'memory_writer:current_state_replacement',
      }),
    ]);
    expect(newResult.evolutionLinks).toHaveLength(1);
    expect(maintenanceErrors).toEqual([]);
  });

  it.each([
    ['a DM with a resolved contact', DM_CONTEXT],
    ['companion self-reflection', REFLECTION_CONTEXT],
  ])('stores the queued post-write maintenance review in %s', async (_label, context) => {
    const { raw, writer, maintenanceErrors } = setup();
    const result = await runWithRequestContext(context, async () => await writer.write({
      text: 'Maybe the partner prefers green tea.',
      type: 'semantic',
      confidence: 0.4,
    }));
    await settleMaintenance();

    expect(maintenanceErrors).toEqual([]);
    expect(raw.listMemoryMaintenanceReviews()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'provenance_confidence',
        subjectMemoryId: result.memory.id,
      }),
    ]));
  });

  it('still rejects both mutations for a caller without a trusted subject', async () => {
    const { raw, store } = setup();
    await raw.insertMemory(memory('source', { provenance: { subjectContactId: 'contact-a' } }), new Float32Array([1, 0]));
    await raw.insertMemory(memory('target', { provenance: { subjectContactId: 'contact-a' } }), new Float32Array([1, 0]));
    const review = buildProvenanceConfidenceReviewInput(memory('source', { confidence: 0.3 }), 1)!;

    for (const context of [undefined, { channelId: 'discord:guild:1', requesterProvenance: 'human' as const }]) {
      const run = async <T>(fn: () => Promise<T>) => (
        context ? await runWithRequestContext(context, fn) : await fn()
      );
      await expect(run(async () => await store.recordEvolutionLink({
        sourceMemoryId: 'source', targetMemoryId: 'target', relation: 'supersedes',
        confidence: 0.9, reason: 'test', sourceRef: 'test', sourceType: 'conversation',
        provenanceRefs: [],
      }))).rejects.toThrow('Memory access requires a trusted memory subject');
      await expect(run(async () => await store.upsertMemoryMaintenanceReview!(review)))
        .rejects.toThrow('Memory access requires a trusted memory subject');
    }
    expect(raw.getEvolutionLinksForSourceMemory('source')).toEqual([]);
    expect(raw.listMemoryMaintenanceReviews()).toEqual([]);
  });

  it('rejects a trusted subject linking or reviewing memories it cannot see', async () => {
    const { raw, store } = setup();
    await raw.insertMemory(memory('mine', { provenance: { subjectContactId: 'contact-a' } }), new Float32Array([1, 0]));
    await raw.insertMemory(memory('theirs', { provenance: { subjectContactId: 'contact-b' } }), new Float32Array([1, 0]));
    // An archived row superseded by some OTHER memory is not provable either.
    await raw.insertMemory(memory('archived', {
      provenance: { subjectContactId: 'contact-a' },
      supersededBy: 'someone-else',
    }), new Float32Array([1, 0]));

    await runWithRequestContext(DM_CONTEXT, async () => {
      for (const targetMemoryId of ['theirs', 'archived']) {
        await expect(store.recordEvolutionLink({
          sourceMemoryId: 'mine', targetMemoryId, relation: 'supersedes', confidence: 0.9,
          reason: 'test', sourceRef: 'test', sourceType: 'conversation', provenanceRefs: [],
        })).rejects.toThrow('Memory access requires a trusted memory subject');
      }
      const base = buildProvenanceConfidenceReviewInput(memory('mine', { confidence: 0.3 }), 1)!;
      const foreignCandidate: MemoryMaintenanceReviewInput = {
        ...base,
        candidateMemoryIds: ['theirs'],
        state: { ...base.state, candidateMemoryIds: ['theirs'] },
      };
      await expect(store.upsertMemoryMaintenanceReview!(foreignCandidate))
        .rejects.toThrow('Memory access requires a trusted memory subject');
    });
    expect(raw.getEvolutionLinksForSourceMemory('mine')).toEqual([]);
    expect(raw.listMemoryMaintenanceReviews()).toEqual([]);
  });
});
