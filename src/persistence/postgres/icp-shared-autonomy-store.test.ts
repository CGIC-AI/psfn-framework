import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IcpPermitRevocationConflictError } from '../../core/icp/autonomy-store-ports.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHANNEL = `companion-dm:${A}:${B}`;
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const PROVENANCE_HANDLE = 'icp-prov:11111111-1111-4111-8111-111111111111';

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => mocks.pool),
  executeQuery: vi.fn(async () => ({ rowCount: 1 })),
  queryOne: vi.fn(async () => undefined as unknown),
  queryRows: vi.fn(async () => [] as unknown[]),
  clientQuery: vi.fn(async () => ({ rows: [] as unknown[], rowCount: 0 })),
  withPostgresClient: vi.fn(async (_pool: unknown, handler: (client: unknown) => Promise<unknown>) =>
    await handler({ query: mocks.clientQuery })),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  executeQuery: mocks.executeQuery,
  queryOne: mocks.queryOne,
  queryRows: mocks.queryRows,
  withPostgresClient: mocks.withPostgresClient,
}));

const AVAILABILITY_ROW = {
  companion_id: A,
  state: 'open_to_chat',
  issued_at_ms: '1000',
  expires_at_ms: '61000',
  source: 'companion',
  revision: '1',
};
const EPISODE_ROW = {
  conversation_id: CONVERSATION_ID,
  channel_id: CHANNEL,
  participant_companion_ids: [A, B],
  root_initiation_id: '33333333-3333-4333-8333-333333333333',
  initiated_by_companion_id: A,
  initiation_source: 'free_time',
  provenance_ref: PROVENANCE_HANDLE,
  opened_at_ms: '10000',
  last_activity_at_ms: '10000',
  status: 'invited',
  close_reason_code: null,
  revision: '1',
};
const PERMIT_ROW = {
  permit_id: PERMIT_ID,
  candidate_id: '11111111-1111-4111-8111-111111111111',
  conversation_id: CONVERSATION_ID,
  sender_companion_id: A,
  recipient_companion_id: B,
  channel_id: CHANNEL,
  provenance_ref: PROVENANCE_HANDLE,
  issued_at_ms: '10000',
  expires_at_ms: '70000',
  status: 'issued',
  consumed_at_ms: null,
  revoked_at_ms: null,
  reason_code: null,
  revision: '1',
};
const FENCE_ROWS = [A, B].map(companionId => ({
  companion_id: companionId,
  generation: '0',
  invalidated_at_ms: null,
  last_reason_code: null,
}));
const FENCE = {
  companions: [
    { companionId: A, generation: 0 },
    { companionId: B, generation: 0 },
  ] as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeQuery.mockResolvedValue({ rowCount: 1 });
  mocks.queryRows.mockResolvedValue([]);
  mocks.clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

async function connect(): Promise<PostgresIcpSharedAutonomyStore> {
  return await PostgresIcpSharedAutonomyStore.connect('postgres://example', {
    knownCompanionIds: [A, B],
  });
}

describe('PostgresIcpSharedAutonomyStore', () => {
  it('pins the runtime pool to the pre-migrated shared schema without executing DDL', async () => {
    await connect();
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://example',
      expect.objectContaining({ schema: SHARED_SCHEMA_NAME }),
    );
  });

  it('requires a known fleet and rejects unknown episode participants before SQL', async () => {
    await expect(PostgresIcpSharedAutonomyStore.connect('postgres://example', {
      knownCompanionIds: [A],
    })).rejects.toThrow('at least two known companion IDs');

    const store = await connect();
    mocks.queryOne.mockClear();
    await expect(store.createEpisode({
      conversationId: CONVERSATION_ID,
      channelId: `companion-dm:${A}:${C}`,
      participantCompanionIds: [A, C],
      rootInitiationId: EPISODE_ROW.root_initiation_id,
      initiatedByCompanionId: A,
      initiationSource: 'free_time',
      provenanceRef: EPISODE_ROW.provenance_ref,
      openedAtMs: 10_000,
      lastActivityAtMs: 10_000,
      status: 'invited',
      revision: 1,
    })).rejects.toThrow(`unknown participant ${C}`);
    expect(mocks.queryOne).not.toHaveBeenCalled();
  });

  it('publishes availability only as a monotonic revision', async () => {
    mocks.queryOne.mockResolvedValue(AVAILABILITY_ROW);
    const store = await connect();
    const lease = await store.publishAvailability({
      companionId: A,
      state: 'open_to_chat',
      issuedAtMs: 1_000,
      expiresAtMs: 61_000,
      source: 'companion',
      revision: 1,
    });
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('ON CONFLICT (companion_id) DO UPDATE');
    expect(sql).toContain('WHERE $6::bigint = 1 OR EXISTS');
    expect(sql).toContain('icp_availability_leases.revision + 1 = EXCLUDED.revision');
    expect(sql).toContain("WHEN 'runtime' THEN 1");
    expect(sql).toContain("WHEN 'companion' THEN 2");
    expect(sql).toContain("WHEN 'operator' THEN 3");
    expect(sql).toMatch(/END\s+>=\s+CASE icp_availability_leases\.source/u);
    expect(sql).toMatch(/END\s+>\s+CASE icp_availability_leases\.source/u);
    expect(sql).toContain('icp_availability_leases.revision = EXCLUDED.revision');
    expect(sql).toContain('THEN icp_availability_leases.revision + 1');
    expect(lease.revision).toBe(1);
  });

  it('looks up the original permit by candidate for issue-response reconciliation', async () => {
    mocks.queryOne.mockResolvedValue(PERMIT_ROW);
    const store = await connect();

    await expect(store.getPermitByCandidate(PERMIT_ROW.candidate_id)).resolves.toMatchObject({
      permitId: PERMIT_ROW.permit_id,
      candidateId: PERMIT_ROW.candidate_id,
    });
    const [, sql, values] = mocks.queryOne.mock.calls.at(-1) as [unknown, string, unknown[]];
    expect(sql).toContain('WHERE candidate_id = $1');
    expect(values).toEqual([PERMIT_ROW.candidate_id]);
  });

  it('atomically prevents a companion clear from deleting an active operator lease', async () => {
    const store = await connect();
    mocks.executeQuery.mockClear();
    await expect(store.clearAvailability(A, 2, {
      source: 'companion',
      nowMs: 2_000,
    })).resolves.toBe(true);
    const [, sql, values] = mocks.executeQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain('CASE $3::text');
    expect(sql).toContain("WHEN 'runtime' THEN 1");
    expect(sql).toContain("WHEN 'companion' THEN 2");
    expect(sql).toContain("WHEN 'operator' THEN 3");
    expect(sql).toContain('END >= CASE source');
    expect(sql).toContain('expires_at_ms <= $4');
    expect(values).toEqual([A, 2, 'companion', 2_000]);
  });

  it('publishes restrictive availability and invalidates permits in one transaction', async () => {
    const store = await connect();
    const restrictiveLease = {
      ...AVAILABILITY_ROW,
      companion_id: B,
      state: 'do_not_disturb',
      issued_at_ms: '11000',
      expires_at_ms: '71000',
      revision: '2',
    };
    const revokedRow = {
      ...PERMIT_ROW,
      status: 'revoked',
      revoked_at_ms: '11000',
      reason_code: 'peer_do_not_disturb',
      revision: '2',
    };
    mocks.withPostgresClient.mockClear();
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({
        rows: [{
          companion_id: B,
          generation: '1',
          invalidated_at_ms: '11000',
          last_reason_code: 'peer_do_not_disturb',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [restrictiveLease], rowCount: 1 });

    await expect(store.publishAvailabilityAndInvalidate({
      companionId: B,
      state: 'do_not_disturb',
      issuedAtMs: 11_000,
      expiresAtMs: 71_000,
      source: 'companion',
      revision: 2,
    }, 'peer_do_not_disturb')).resolves.toMatchObject({
      lease: { companionId: B, state: 'do_not_disturb' },
      revokedPermits: [{ status: 'revoked', reasonCode: 'peer_do_not_disturb' }],
    });

    expect(mocks.withPostgresClient).toHaveBeenCalledTimes(1);
    expect((mocks.clientQuery.mock.calls[0] as [string])[0])
      .toContain('UPDATE icp_autonomy_invalidation_fences');
    expect((mocks.clientQuery.mock.calls[1] as [string])[0])
      .toContain('UPDATE icp_initiation_permits');
    expect((mocks.clientQuery.mock.calls[2] as [string])[0])
      .toContain('INSERT INTO icp_availability_leases');
  });

  it('clears availability and invalidates permits in one fence-first transaction', async () => {
    const store = await connect();
    const revokedRow = {
      ...PERMIT_ROW,
      status: 'revoked',
      revoked_at_ms: '11000',
      reason_code: 'availability_missing',
      revision: '2',
    };
    mocks.withPostgresClient.mockClear();
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [FENCE_ROWS[1]], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          companion_id: B,
          generation: '1',
          invalidated_at_ms: '11000',
          last_reason_code: 'availability_missing',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 });

    await expect(store.clearAvailabilityAndInvalidate(
      B,
      1,
      { source: 'companion', nowMs: 11_000 },
      'availability_missing',
    )).resolves.toMatchObject({
      cleared: true,
      revokedPermits: [{ status: 'revoked', reasonCode: 'availability_missing' }],
    });

    expect(mocks.withPostgresClient).toHaveBeenCalledTimes(1);
    expect((mocks.clientQuery.mock.calls[0] as [string])[0]).toContain('FOR UPDATE');
    expect((mocks.clientQuery.mock.calls[1] as [string])[0])
      .toContain('DELETE FROM icp_availability_leases');
    expect((mocks.clientQuery.mock.calls[2] as [string])[0])
      .toContain('UPDATE icp_autonomy_invalidation_fences');
    expect((mocks.clientQuery.mock.calls[3] as [string])[0])
      .toContain('UPDATE icp_initiation_permits');
  });

  it('creates a channel-bound episode with optimistic transitions', async () => {
    mocks.queryOne.mockResolvedValue(EPISODE_ROW);
    const store = await connect();
    await store.createEpisode({
      conversationId: CONVERSATION_ID,
      channelId: CHANNEL,
      participantCompanionIds: [A, B],
      rootInitiationId: EPISODE_ROW.root_initiation_id,
      initiatedByCompanionId: A,
      initiationSource: 'free_time',
      provenanceRef: EPISODE_ROW.provenance_ref,
      openedAtMs: 10_000,
      lastActivityAtMs: 10_000,
      status: 'invited',
      revision: 1,
    });
    expect((mocks.queryOne.mock.calls[0] as [unknown, string])[1])
      .toContain('INSERT INTO icp_conversation_episodes');

    mocks.queryOne.mockClear();
    mocks.queryOne.mockResolvedValue({
      ...EPISODE_ROW,
      status: 'active',
      last_activity_at_ms: '11000',
      revision: '2',
    });
    const active = await store.transitionEpisode({
      conversationId: CONVERSATION_ID,
      expectedStatus: 'invited',
      expectedRevision: 1,
      expectedLastActivityAtMs: 10_000,
      status: 'active',
      lastActivityAtMs: 11_000,
    });
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('status = $2 AND revision = $3');
    expect(sql).toContain('last_activity_at_ms = $4');
    expect(sql).toContain('$6 >= last_activity_at_ms');
    expect(active.revision).toBe(2);
  });

  it('issues only a content-free permit bound to an existing episode', async () => {
    const store = await connect();
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: FENCE_ROWS, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [PERMIT_ROW], rowCount: 1 });
    await store.issuePermit({
      permit: {
        permitId: PERMIT_ID,
        candidateId: PERMIT_ROW.candidate_id,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        provenanceRef: PERMIT_ROW.provenance_ref,
        issuedAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'issued',
        revision: 1,
      },
      expectedInvalidationFence: FENCE,
    });
    const [sql] = mocks.clientQuery.mock.calls[2] as [string];
    expect(sql).toContain('INSERT INTO icp_initiation_permits');
    expect(sql).toContain('FROM icp_conversation_episodes');
    expect(sql).toContain('participant_companion_ids @>');
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).not.toContain('reason_summary');
  });

  it('classifies an exact candidate insert conflict for broker reconciliation', async () => {
    const store = await connect();
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: FENCE_ROWS, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [PERMIT_ROW], rowCount: 1 });

    await expect(store.issuePermit({
      permit: {
        permitId: PERMIT_ID,
        candidateId: PERMIT_ROW.candidate_id,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        provenanceRef: PERMIT_ROW.provenance_ref,
        issuedAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'issued',
        revision: 1,
      },
      expectedInvalidationFence: FENCE,
    })).rejects.toThrow('outstanding invitation conflict');
    const [sameCandidateSql] = mocks.clientQuery.mock.calls[3] as [string];
    expect(sameCandidateSql).toContain('WHERE candidate_id = $1');
  });

  it('atomically consumes once and classifies a concurrent replay', async () => {
    const consumedRow = {
      ...PERMIT_ROW,
      status: 'consumed',
      consumed_at_ms: '11000',
      revision: '2',
    };
    const store = await connect();
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: FENCE_ROWS, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [consumedRow], rowCount: 1 });
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      consumedAtMs: 11_000,
      expectedInvalidationFence: FENCE,
    })).resolves.toMatchObject({ outcome: 'consumed' });
    expect((mocks.clientQuery.mock.calls[1] as [string])[0])
      .toContain("WHERE permit_id = $1 AND status = 'issued'");

    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({ rows: FENCE_ROWS, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [consumedRow], rowCount: 1 });
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      consumedAtMs: 11_001,
      expectedInvalidationFence: FENCE,
    })).resolves.toMatchObject({ outcome: 'replayed', reasonCode: 'permit_replayed' });
  });

  it('fails a mismatched permit binding closed', async () => {
    const store = await connect();
    const fenceAc = {
      companions: [
        { companionId: A, generation: 0 },
        { companionId: C, generation: 0 },
      ] as const,
    };
    mocks.clientQuery.mockReset();
    mocks.clientQuery
      .mockResolvedValueOnce({
        rows: [A, C].map(companionId => ({
          companion_id: companionId,
          generation: '0',
          invalidated_at_ms: null,
          last_reason_code: null,
        })),
        rowCount: 2,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [PERMIT_ROW], rowCount: 1 });
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: C,
      channelId: `companion-dm:${A}:${C}`,
      consumedAtMs: 11_000,
      expectedInvalidationFence: fenceAc,
    })).resolves.toMatchObject({ outcome: 'mismatch', reasonCode: 'permit_mismatch' });
  });

  it('rejects revocation timestamps before issuance at the atomic SQL boundary', async () => {
    mocks.queryOne.mockResolvedValue(undefined);
    const store = await connect();
    await expect(store.revokePermit(
      PERMIT_ID,
      1,
      9_999,
      'operator_cancelled',
    )).rejects.toBeInstanceOf(IcpPermitRevocationConflictError);
    expect(mocks.queryOne).toHaveBeenCalledOnce();
    mocks.queryOne.mockResolvedValue(undefined);
    await expect(store.revokePermit(
      PERMIT_ID,
      1,
      9_999,
      'operator_cancelled',
    )).rejects.toThrow('ICP permit revocation conflict');
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('issued_at_ms <= $3');
  });

  it('finds one current outstanding pair after lazily expiring old permits', async () => {
    mocks.queryOne.mockResolvedValue(PERMIT_ROW);
    const store = await connect();
    mocks.executeQuery.mockClear();
    await expect(store.findOutstandingPermitBetween(A, B, 11_000)).resolves.toMatchObject({
      permitId: PERMIT_ID,
    });
    const [, expirySql] = mocks.executeQuery.mock.calls[0] as [unknown, string];
    expect(expirySql).toContain("SET status = 'expired'");
    expect(expirySql).toContain('LEAST(sender_companion_id, recipient_companion_id)');
    const [, lookupSql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(lookupSql).toContain("WHERE status = 'issued'");
    expect(lookupSql).toContain('GREATEST(sender_companion_id, recipient_companion_id)');
  });

  it('atomically revokes every outstanding permit involving a disconnected companion', async () => {
    const store = await connect();
    mocks.clientQuery.mockReset();
    const revokedRow = {
      ...PERMIT_ROW,
      status: 'revoked',
      revoked_at_ms: '11000',
      reason_code: 'peer_offline',
      revision: '2',
    };
    mocks.clientQuery
      .mockResolvedValueOnce({
        rows: [{
          companion_id: B,
          generation: '1',
          invalidated_at_ms: '11000',
          last_reason_code: 'peer_offline',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [revokedRow], rowCount: 1 });
    await expect(store.revokeOutstandingPermitsForCompanion(B, 11_000, 'peer_offline'))
      .resolves.toEqual([expect.objectContaining({ status: 'revoked', reasonCode: 'peer_offline' })]);
    const [sql] = mocks.clientQuery.mock.calls[1] as [string];
    expect(sql).toContain("SET status = 'revoked'");
    expect(sql).toContain('(sender_companion_id = $1 OR recipient_companion_id = $1)');
  });
});
