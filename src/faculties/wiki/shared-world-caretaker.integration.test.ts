import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { createPostgresPool } from '../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { SharedWorldWikiStore } from './store.js';
import { createSharedWikiPgvectorProjectionStore } from './shared-pgvector-projection.js';
import { SharedWorldWikiProposalStore } from './shared-world-caretaker-store.js';
import type { SharedWorldWikiProposalInput } from './shared-world-caretaker-types.js';
import {
  SharedWorldWikiCaretakerService,
  SharedWorldWikiProposalService,
  type SharedWorldWikiProjectionPort,
} from './shared-world-caretaker.js';

interface SharedWorldWikiCaretakerTestLimits {
  timeoutMs: number;
  embeddingDims: number;
}

const TEST_LIMITS = {
  timeoutMs: 120_000,
  embeddingDims: 16,
} satisfies Readonly<SharedWorldWikiCaretakerTestLimits>;

const embedding: EmbeddingProviderPort = {
  dims: TEST_LIMITS.embeddingDims,
  embed: async text => embed(text),
  embedBatch: async texts => texts.map(embed),
};

function embed(text: string): Float32Array {
  const vector = new Float32Array(TEST_LIMITS.embeddingDims);
  for (const character of text) vector[character.charCodeAt(0) % vector.length] += 1;
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (vector[index] ?? 0) / norm;
  }
  return vector;
}

async function closeTestResources(resources: ReadonlyArray<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(resources.map(close => close()));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Shared-world caretaker test resource cleanup failed');
  }
}

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, TEST_LIMITS.timeoutMs);

afterAll(async () => {
  await harness?.stop();
}, TEST_LIMITS.timeoutMs);

describe('shared-world wiki caretaker real Postgres toaster', () => {
  it('keeps proposals invisible until approval, dedups, resumes projection, and repairs changed approved content', async () => {
    if (!harness) throw new Error('Postgres harness is unavailable');
    const database = await harness.createDatabase();
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-caretaker-'));
    const proposalStore = new SharedWorldWikiProposalStore(database.databaseUrl);
    let companionAReader: Awaited<ReturnType<typeof createSharedWikiPgvectorProjectionStore>> | null = null;
    let companionBReader: Awaited<ReturnType<typeof createSharedWikiPgvectorProjectionStore>> | null = null;
    let writer: Awaited<ReturnType<typeof createSharedWikiPgvectorProjectionStore>> | null = null;
    let pool: ReturnType<typeof createPostgresPool> | null = null;
    try {
      await proposalStore.initialize();
      companionAReader = await createSharedWikiPgvectorProjectionStore(database.databaseUrl, embedding);
      companionBReader = await createSharedWikiPgvectorProjectionStore(database.databaseUrl, embedding);
      writer = await createSharedWikiPgvectorProjectionStore(database.databaseUrl, embedding);
      pool = createPostgresPool(database.databaseUrl, { applicationName: 'caretaker-test-inspection' });
      const isKnownSite = (siteId: string): boolean => siteId === 'studio';
      const submitterA = new SharedWorldWikiProposalService({ proposalStore, isKnownSite, now: () => 1_000 });
      const submitterB = new SharedWorldWikiProposalService({ proposalStore, isKnownSite, now: () => 1_001 });
      const input: SharedWorldWikiProposalInput = {
        siteId: 'studio',
        documentId: 'kitchen-toaster',
        actorId: 'companion-a',
        sourceRef: 'world-observation:turn-10',
        title: 'Kitchen toaster',
        body: 'A new toaster is installed beside the kitchen satellite.',
        tags: ['kitchen', 'appliance'],
        provenanceRefs: ['world-observation:sensor-4'],
        sensitivity: 'public',
      };

      const [fromA, fromB] = await Promise.all([
        submitterA.submit(input),
        submitterB.submit({
          ...input,
          actorId: 'companion-b',
          sourceRef: 'world-observation:turn-11',
          provenanceRefs: ['world-observation:sensor-9'],
        }),
      ]);
      expect(fromA.proposal.proposalId).toBe(fromB.proposal.proposalId);
      expect([fromA.deduplicated, fromB.deduplicated].sort()).toEqual([false, true]);
      expect(fromA.proposal.reviewState).toBe('pending');

      const query = embed(input.body);
      await expect(companionAReader.search(query, 0.1, 10, ['shared_world:studio'])).resolves.toEqual([]);
      await expect(companionBReader.search(query, 0.1, 10, ['shared_world:studio'])).resolves.toEqual([]);

      await expect(submitterA.submit({
        ...input,
        documentId: 'private-toaster',
        body: 'My partner keeps a private toaster in the bedroom.',
      })).rejects.toThrow('personal_fact_content');
      await expect(submitterA.submit({
        ...input,
        documentId: 'memory-toaster',
        provenanceRefs: ['memory:private-memory-id'],
      })).rejects.toThrow('personal_memory_provenance');
      await expect(submitterA.submit({
        ...input,
        documentId: 'unknown-site',
        siteId: 'unknown',
      })).rejects.toThrow('invalid_site');
      expect(await proposalStore.list()).toHaveLength(1);

      const rejected = await submitterA.submit({
        ...input,
        documentId: 'rejected-clock',
        title: 'Studio clock',
        body: 'A public clock is mounted in the studio.',
      });
      const rejectedState = await proposalStore.review({
        proposalId: rejected.proposal.proposalId,
        decision: 'reject',
        operatorActorId: 'garden-operator',
        rejectionCode: 'operator_rejected',
        nowMs: 1_100,
      });
      expect(rejectedState.reviewState).toBe('rejected');
      const rejectedAgain = await submitterB.submit({
        ...input,
        actorId: 'companion-b',
        sourceRef: 'world-observation:turn-12',
        provenanceRefs: ['world-observation:sensor-12'],
        documentId: 'rejected-clock',
        title: 'Studio clock',
        body: 'A public clock is mounted in the studio.',
      });
      expect(rejectedAgain).toMatchObject({
        deduplicated: true,
        proposal: { proposalId: rejected.proposal.proposalId, reviewState: 'rejected' },
      });

      let failFirstProjection = true;
      const resumableProjection: SharedWorldWikiProjectionPort = {
        syncDocument: async (siteId, document) => {
          if (failFirstProjection) {
            failFirstProjection = false;
            return { status: 'failed', documentId: document.id, chunkCount: 0, error: 'injected' };
          }
          return writer.syncDocument(siteId, document);
        },
      };
      let nowMs = 2_000;
      const caretaker = new SharedWorldWikiCaretakerService({
        proposalStore,
        isKnownSite,
        openSharedStore: siteId => new SharedWorldWikiStore(systemDataDir, siteId),
        projection: resumableProjection,
        now: () => nowMs++,
      });
      const firstApply = await caretaker.approve(fromA.proposal.proposalId, 'garden-operator');
      expect(firstApply.status).toBe('retryable_failure');
      const canonicalAfterFailure = new SharedWorldWikiStore(systemDataDir, 'studio').get('kitchen-toaster');
      expect(canonicalAfterFailure).toMatchObject({ version: 1, sensitivity: 'public', scope: 'shared_world:studio' });
      await expect(companionBReader.search(query, 0.1, 10, ['shared_world:studio'])).resolves.toEqual([]);

      const resumed = await caretaker.applyApproved(fromA.proposal.proposalId);
      expect(resumed).toMatchObject({ status: 'applied', documentVersion: 1 });
      const canonical = new SharedWorldWikiStore(systemDataDir, 'studio').get('kitchen-toaster');
      if (!canonical) throw new Error('caretaker canonical document was not written');
      expect(canonical).toMatchObject({
        version: 1,
        updatedBy: 'wiki-caretaker:garden-operator',
        sensitivity: 'public',
        scope: 'shared_world:studio',
      });
      expect(canonical.provenanceRefs).toEqual(expect.arrayContaining([
        'world-observation:sensor-4',
        'world-observation:turn-10',
        'actor-companion:companion-a',
        `caretaker-proposal:${fromA.proposal.proposalId}`,
        `caretaker-digest:${fromA.proposal.contentDigest}`,
      ]));
      const visibleToA = await companionAReader.search(query, 0.1, 10, ['shared_world:studio']);
      const visibleToB = await companionBReader.search(query, 0.1, 10, ['shared_world:studio']);
      expect(visibleToA.map(match => match.documentId)).toContain('kitchen-toaster');
      expect(visibleToB.map(match => match.documentId)).toContain('kitchen-toaster');
      expect(await caretaker.applyApproved(fromA.proposal.proposalId)).toMatchObject({
        status: 'already_applied',
        documentVersion: 1,
      });
      expect((await submitterB.submit({ ...input, actorId: 'companion-b' })).proposal.applyState).toBe('applied');

      const sharedStore = new SharedWorldWikiStore(systemDataDir, 'studio');
      const changed = sharedStore.upsert({
        id: canonical.id,
        title: canonical.title,
        body: 'The approved toaster moved to the north kitchen counter.',
        tags: canonical.tags,
        sourceClass: canonical.sourceClass,
        provenanceRefs: canonical.provenanceRefs,
        sensitivity: 'public',
        updatedBy: 'garden-operator',
      });
      expect(changed.version).toBe(2);
      expect(await caretaker.cleanupChangedContent(1)).toEqual({ checked: 1, reprojected: 1, failed: 0 });
      expect(await caretaker.cleanupChangedContent(1)).toEqual({ checked: 1, reprojected: 0, failed: 0 });

      const privateRows = await pool.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM shared.shared_wiki_proposals
        WHERE sensitivity <> 'public'
           OR provenance_refs_json::text ~* '(memory|episode|contact):'
           OR body ~* 'my partner'
      `);
      expect(privateRows.rows[0]?.count).toBe('0');
    } finally {
      const resourceClosers: Array<() => Promise<void>> = [];
      if (pool) {
        const openedPool = pool;
        resourceClosers.push(() => openedPool.end());
      }
      if (writer) {
        const openedWriter = writer;
        resourceClosers.push(() => openedWriter.close());
      }
      if (companionBReader) {
        const openedCompanionBReader = companionBReader;
        resourceClosers.push(() => openedCompanionBReader.close());
      }
      if (companionAReader) {
        const openedCompanionAReader = companionAReader;
        resourceClosers.push(() => openedCompanionAReader.close());
      }
      resourceClosers.push(() => proposalStore.close());
      try {
        await closeTestResources(resourceClosers);
      } finally {
        rmSync(systemDataDir, { recursive: true, force: true });
      }
    }
  }, TEST_LIMITS.timeoutMs);
});
