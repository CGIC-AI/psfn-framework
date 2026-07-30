import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../shared/logger.js';
import type { WikiDocument } from './types.js';
import type { SharedWorldWikiProposalStorePort } from './shared-world-caretaker-store.js';
import {
  guardSharedWorldWikiProposal,
  type SharedWorldWikiProposal,
} from './shared-world-caretaker-types.js';
import {
  SharedWorldWikiCaretakerService,
  type SharedWorldWikiCaretakerOptions,
  type SharedWorldWikiProjectionPort,
} from './shared-world-caretaker.js';
import type { WikiProjectionSyncOutcome } from './pgvector-projection.js';
import { SharedWorldWikiStore } from './store.js';

const PROPOSAL_TITLE = 'Studio layout alpha';
const PROPOSAL_BODY = 'A painted object stands behind the north wall.';

function proposalFixture(): SharedWorldWikiProposal {
  const guarded = guardSharedWorldWikiProposal({
    siteId: 'studio',
    documentId: 'public-object',
    actorId: 'companion-a',
    sourceRef: 'world-observation:event-1',
    title: PROPOSAL_TITLE,
    body: PROPOSAL_BODY,
    tags: ['studio'],
    provenanceRefs: ['world-observation:sensor-1'],
    sensitivity: 'public',
  }, () => true);
  if (!guarded.accepted) throw new Error('test proposal must pass the deterministic guard');
  return {
    ...guarded.proposal,
    proposalId: 'proposal-diagnostics',
    reviewState: 'approved',
    reviewedBy: 'garden-operator',
    reviewedAtMs: 100,
    applyState: 'applying',
    applyLeaseToken: 'lease-diagnostics',
    applyLeaseUntilMs: 10_000,
    revision: 3,
    createdAtMs: 10,
    updatedAtMs: 100,
  };
}

function documentFixture(): WikiDocument {
  return {
    schemaVersion: 1,
    id: 'public-object',
    title: PROPOSAL_TITLE,
    body: PROPOSAL_BODY,
    bodyPath: 'documents/public-object.md',
    bodyFormat: 'markdown',
    tags: ['studio'],
    sourceClass: 'companion_authored_note',
    provenanceRefs: ['caretaker-proposal:proposal-diagnostics'],
    sensitivity: 'public',
    scope: 'shared_world:studio',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
    updatedBy: 'wiki-caretaker:garden-operator',
    version: 1,
    bodySha256: 'body-sha',
  };
}

function createProposalStore(markRetryableError?: Error): {
  store: SharedWorldWikiProposalStorePort;
  markRetryable: ReturnType<typeof vi.fn>;
} {
  let current = proposalFixture();
  const markRetryable = vi.fn(async () => {
    if (markRetryableError) throw markRetryableError;
    current = {
      ...current,
      applyState: 'retryable',
      applyLeaseToken: undefined,
      applyLeaseUntilMs: undefined,
    };
  });
  const store: SharedWorldWikiProposalStorePort = {
    submit: async () => ({ proposal: current, deduplicated: false }),
    list: async () => [current],
    get: async () => current,
    review: async () => current,
    claimApproved: async () => current,
    markApplied: async () => current,
    markRetryable,
    listCleanupCandidates: async () => [],
    markCleanupChecked: async () => undefined,
    close: async () => undefined,
  };
  return { store, markRetryable };
}

function successfulProjection(): SharedWorldWikiProjectionPort {
  return {
    syncDocument: async (_siteId, document) => ({
      status: 'ran',
      documentId: document.id,
      chunkCount: 1,
    }),
  };
}

function buildCaretaker(input: {
  proposalStore: SharedWorldWikiProposalStorePort;
  isKnownSite?: SharedWorldWikiCaretakerOptions['isKnownSite'];
  openSharedStore?: SharedWorldWikiCaretakerOptions['openSharedStore'];
  writeSharedDocument?: SharedWorldWikiCaretakerOptions['writeSharedDocument'];
  projection?: SharedWorldWikiProjectionPort;
}): SharedWorldWikiCaretakerService {
  const openSharedStore = input.openSharedStore ?? (() => ({
    get: () => null,
    upsert: () => documentFixture(),
  }));
  return new SharedWorldWikiCaretakerService({
    proposalStore: input.proposalStore,
    isKnownSite: input.isKnownSite ?? (() => true),
    openSharedStore,
    writeSharedDocument: input.writeSharedDocument ?? (async (siteId, documentInput) =>
      openSharedStore(siteId).upsert(documentInput)),
    projection: input.projection ?? successfulProjection(),
    now: () => 1_000,
  });
}

function expectSanitizedFailure(phase: string): void {
  const record = getRecentDiagnosticLogRecords({ limit: 10 })
    .find(candidate => candidate.component === 'SharedWorldWikiCaretaker');
  expect(record).toMatchObject({
    level: 'warn',
    context: {
      proposalId: 'proposal-diagnostics',
      state: 'retryable',
      siteId: 'studio',
      digest: proposalFixture().contentDigest,
      revision: 3,
      phase,
      code: 'Error',
    },
  });
  const serialized = JSON.stringify(record);
  expect(serialized).not.toContain(PROPOSAL_TITLE);
  expect(serialized).not.toContain(PROPOSAL_BODY);
}

describe('SharedWorldWikiCaretakerService failure diagnostics', () => {
  beforeEach(() => clearDiagnosticLogRingBufferForTests());
  afterEach(() => clearDiagnosticLogRingBufferForTests());

  it('routes the canonical document mutation through the required writer', async () => {
    const { store } = createProposalStore();
    const localUpsert = vi.fn(() => documentFixture());
    const writeSharedDocument = vi.fn(async () => documentFixture());
    const caretaker = buildCaretaker({
      proposalStore: store,
      openSharedStore: () => ({
        get: () => null,
        upsert: localUpsert,
      }),
      writeSharedDocument,
    });

    await expect(caretaker.applyApproved('proposal-diagnostics')).resolves.toMatchObject({
      status: 'applied',
    });
    expect(writeSharedDocument).toHaveBeenCalledOnce();
    expect(localUpsert).not.toHaveBeenCalled();
  });

  it('records a content-free deterministic guard failure and preserves retry state', async () => {
    const { store, markRetryable } = createProposalStore();
    const caretaker = buildCaretaker({ proposalStore: store, isKnownSite: () => false });

    await expect(caretaker.applyApproved('proposal-diagnostics')).resolves.toMatchObject({
      status: 'retryable_failure',
      proposal: { applyState: 'retryable' },
    });

    expect(markRetryable).toHaveBeenCalledOnce();
    expectSanitizedFailure('deterministic_guard');
  });

  it('records a content-free canonical write failure', async () => {
    const { store } = createProposalStore();
    const caretaker = buildCaretaker({
      proposalStore: store,
      openSharedStore: () => {
        throw new Error(`canonical write failed for ${PROPOSAL_TITLE}: ${PROPOSAL_BODY}`);
      },
    });

    await expect(caretaker.applyApproved('proposal-diagnostics')).resolves.toMatchObject({
      status: 'retryable_failure',
    });

    expectSanitizedFailure('canonical_write');
  });

  it('records a content-free projection failure', async () => {
    const { store } = createProposalStore();
    const projection: SharedWorldWikiProjectionPort = {
      syncDocument: async (_siteId, document) => ({
        status: 'failed',
        documentId: document.id,
        chunkCount: 0,
        error: `embedding rejected ${PROPOSAL_BODY}`,
      }),
    };
    const caretaker = buildCaretaker({ proposalStore: store, projection });

    await expect(caretaker.applyApproved('proposal-diagnostics')).resolves.toMatchObject({
      status: 'retryable_failure',
    });

    expectSanitizedFailure('projection');
  });

  it('preserves both failures when retry-state persistence also fails', async () => {
    const { store } = createProposalStore(new Error(`retry update failed for ${PROPOSAL_BODY}`));
    const caretaker = buildCaretaker({
      proposalStore: store,
      projection: {
        syncDocument: async () => {
          throw new Error(`projection crashed for ${PROPOSAL_TITLE}`);
        },
      },
    });

    const failure = caretaker.applyApproved('proposal-diagnostics');
    await expect(failure).rejects.toBeInstanceOf(AggregateError);
    await expect(failure).rejects.toThrow(
      'Shared-world wiki proposal apply failed during projection and retry state persistence also failed',
    );
    const record = getRecentDiagnosticLogRecords({ limit: 10 })
      .find(candidate => candidate.component === 'SharedWorldWikiCaretaker');
    expect(record).toMatchObject({
      level: 'error',
      context: {
        phase: 'retry_state_persistence',
        code: 'Error:Error',
      },
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain(PROPOSAL_TITLE);
    expect(serialized).not.toContain(PROPOSAL_BODY);
  });
});

function makeProposal(input: {
  proposalId: string;
  documentId: string;
  projectionBodySha256: string;
}): SharedWorldWikiProposal {
  return {
    proposalId: input.proposalId,
    siteId: 'studio',
    documentId: input.documentId,
    actorId: 'companion-a',
    sourceRef: 'world-observation:turn-1',
    title: input.documentId,
    body: 'Approved public content.\n',
    tags: [],
    provenanceRefs: ['world-observation:sensor-1'],
    sensitivity: 'public',
    contentDigest: `digest-${input.proposalId}`,
    reviewState: 'approved',
    reviewedBy: 'operator',
    reviewedAtMs: 100,
    applyState: 'applied',
    appliedAtMs: 101,
    appliedDocumentVersion: 1,
    appliedBodySha256: 'applied-sha',
    projectionBodySha256: input.projectionBodySha256,
    revision: 3,
    createdAtMs: 90,
    updatedAtMs: 101,
  };
}

describe('SharedWorldWikiCaretakerService cleanup', () => {
  it('projects only changed approved content in a deterministic bounded batch', async () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-caretaker-unit-'));
    try {
      const sharedStore = new SharedWorldWikiStore(systemDataDir, 'studio');
      const unchanged = sharedStore.upsert({
        id: 'unchanged',
        title: 'Unchanged',
        body: 'Approved unchanged body.',
        provenanceRefs: ['world-observation:unchanged'],
        sensitivity: 'public',
        updatedBy: 'operator',
      });
      const changed = sharedStore.upsert({
        id: 'changed',
        title: 'Changed',
        body: 'Approved changed body.',
        provenanceRefs: ['world-observation:changed'],
        sensitivity: 'public',
        updatedBy: 'operator',
      });
      const candidates = [
        makeProposal({
          proposalId: 'proposal-unchanged',
          documentId: unchanged.id,
          projectionBodySha256: unchanged.bodySha256,
        }),
        makeProposal({
          proposalId: 'proposal-changed',
          documentId: changed.id,
          projectionBodySha256: 'stale-projection-sha',
        }),
      ];
      const cleanupChecks: Array<{
        proposalId: string;
        projectionBodySha256?: string | undefined;
        nowMs: number;
      }> = [];
      const listCleanupCandidates = vi.fn(async (limit: number) => candidates.slice(0, limit));
      const proposalStore: SharedWorldWikiProposalStorePort = {
        submit: async () => { throw new Error('not used'); },
        list: async () => [],
        get: async () => null,
        review: async () => { throw new Error('not used'); },
        claimApproved: async () => null,
        markApplied: async () => { throw new Error('not used'); },
        markRetryable: async () => undefined,
        listCleanupCandidates,
        markCleanupChecked: async input => { cleanupChecks.push(input); },
        close: async () => undefined,
      };
      const syncDocument = vi.fn(async (
        _siteId: string,
        document: typeof changed,
      ): Promise<WikiProjectionSyncOutcome> => ({
        status: 'ran',
        documentId: document.id,
        chunkCount: 1,
      }));
      const caretaker = new SharedWorldWikiCaretakerService({
        proposalStore,
        isKnownSite: siteId => siteId === 'studio',
        openSharedStore: () => sharedStore,
        writeSharedDocument: async (_siteId, documentInput) =>
          sharedStore.upsert(documentInput),
        projection: { syncDocument },
        now: () => 500,
      });

      await expect(caretaker.cleanupChangedContent(2)).resolves.toEqual({
        checked: 2,
        reprojected: 1,
        failed: 0,
      });
      expect(syncDocument).toHaveBeenCalledOnce();
      expect(syncDocument).toHaveBeenCalledWith('studio', changed);
      expect(listCleanupCandidates).toHaveBeenCalledWith(2);
      expect(cleanupChecks).toEqual([
        { proposalId: 'proposal-unchanged', nowMs: 500 },
        {
          proposalId: 'proposal-changed',
          projectionBodySha256: changed.bodySha256,
          nowMs: 500,
        },
      ]);
    } finally {
      rmSync(systemDataDir, { recursive: true, force: true });
    }
  });
});
