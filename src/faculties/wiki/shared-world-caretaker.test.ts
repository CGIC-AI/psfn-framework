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
  projection?: SharedWorldWikiProjectionPort;
}): SharedWorldWikiCaretakerService {
  return new SharedWorldWikiCaretakerService({
    proposalStore: input.proposalStore,
    isKnownSite: input.isKnownSite ?? (() => true),
    openSharedStore: input.openSharedStore ?? (() => ({
      get: () => null,
      upsert: () => documentFixture(),
    })),
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
