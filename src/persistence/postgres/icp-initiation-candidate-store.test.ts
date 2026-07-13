import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './migrations.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANDIDATE_ROW = {
  candidate_id: '11111111-1111-4111-8111-111111111111',
  root_initiation_id: '33333333-3333-4333-8333-333333333333',
  local_companion_id: A,
  peer_contact_id: 'contact-artemis',
  peer_companion_id: B,
  preferred_channel: 'dm',
  source: 'weighted_thought',
  provenance_ref: 'icp-prov:11111111-1111-4111-8111-111111111111',
  reason_summary: 'Follow up on the research question.',
  created_at_ms: '10000',
  expires_at_ms: '70000',
  status: 'pending',
  reason_code: null,
  revision: '1',
};

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => mocks.pool),
  ensurePostgresSchema: vi.fn(async () => undefined),
  ensurePostgresSchemaExists: vi.fn(async () => undefined),
  queryOne: vi.fn(async () => undefined as unknown),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  ensurePostgresSchema: mocks.ensurePostgresSchema,
  ensurePostgresSchemaExists: mocks.ensurePostgresSchemaExists,
  queryOne: mocks.queryOne,
  queryRows: mocks.queryRows,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRows.mockResolvedValue([]);
});

describe('PostgresIcpInitiationCandidateStore', () => {
  it('requires and provisions a companion-local schema', async () => {
    await PostgresIcpInitiationCandidateStore.connect('postgres://example', {
      schema: 'companion_artemis',
    });
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://example',
      expect.objectContaining({ schema: 'companion_artemis' }),
    );
    expect(mocks.ensurePostgresSchema).toHaveBeenCalledWith(
      mocks.pool,
      POSTGRES_INTENTION_MIGRATIONS,
    );
    expect(mocks.ensurePostgresSchemaExists).toHaveBeenCalledWith(
      mocks.pool,
      'companion_artemis',
    );
    await expect(PostgresIcpInitiationCandidateStore.connect('postgres://example', {
      schema: '',
    })).rejects.toThrow('requires a companion-local Postgres schema');
  });

  it('persists private motivation only in the companion-local table', async () => {
    mocks.queryOne.mockResolvedValue(CANDIDATE_ROW);
    const store = await PostgresIcpInitiationCandidateStore.connect('postgres://example', {
      schema: 'companion_artemis',
    });
    const saved = await store.createCandidate({
      candidateId: CANDIDATE_ROW.candidate_id,
      rootInitiationId: CANDIDATE_ROW.root_initiation_id,
      localCompanionId: A,
      peerContactId: CANDIDATE_ROW.peer_contact_id,
      peerCompanionId: B,
      preferredChannel: 'dm',
      source: 'weighted_thought',
      provenanceRef: CANDIDATE_ROW.provenance_ref,
      reasonSummary: CANDIDATE_ROW.reason_summary,
      createdAtMs: 10_000,
      expiresAtMs: 70_000,
      status: 'pending',
      revision: 1,
    });
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('INSERT INTO icp_initiation_candidates');
    expect(sql).toContain('reason_summary');
    expect(saved.reasonSummary).toContain('research');
  });

  it('uses expected status and revision for transitions', async () => {
    mocks.queryOne.mockResolvedValue({ ...CANDIDATE_ROW, status: 'deferred', revision: '2' });
    const store = await PostgresIcpInitiationCandidateStore.connect('postgres://example', {
      schema: 'companion_artemis',
    });
    const deferred = await store.transitionCandidate({
      candidateId: CANDIDATE_ROW.candidate_id,
      expectedStatus: 'pending',
      expectedRevision: 1,
      status: 'deferred',
      reasonCode: 'candidate_deferred',
    });
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('status = $2 AND revision = $3');
    expect(deferred.revision).toBe(2);

    mocks.queryOne.mockClear();
    await expect(store.transitionCandidate({
      candidateId: CANDIDATE_ROW.candidate_id,
      expectedStatus: 'consumed',
      expectedRevision: 2,
      status: 'pending',
    })).rejects.toThrow('Invalid ICP candidate status transition');
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });
});
