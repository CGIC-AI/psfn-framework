import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHANNEL = `companion-dm:${A}:${B}`;
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';

const mocks = vi.hoisted(() => ({
  pool: { end: vi.fn(async () => undefined) },
  createPostgresPool: vi.fn(() => mocks.pool),
  ensureSharedSchema: vi.fn(async () => undefined),
  executeQuery: vi.fn(async () => ({ rowCount: 1 })),
  queryOne: vi.fn(async () => undefined as unknown),
  queryRows: vi.fn(async () => [] as unknown[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  executeQuery: mocks.executeQuery,
  queryOne: mocks.queryOne,
  queryRows: mocks.queryRows,
}));
vi.mock('./shared-schema.js', () => ({ ensureSharedSchema: mocks.ensureSharedSchema }));

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
  provenance_ref: 'free-time:block:17',
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
  provenance_ref: 'free-time:block:17',
  issued_at_ms: '10000',
  expires_at_ms: '70000',
  status: 'issued',
  consumed_at_ms: null,
  revoked_at_ms: null,
  reason_code: null,
  revision: '1',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeQuery.mockResolvedValue({ rowCount: 1 });
  mocks.queryRows.mockResolvedValue([]);
});

async function connect(): Promise<PostgresIcpSharedAutonomyStore> {
  return await PostgresIcpSharedAutonomyStore.connect('postgres://example', {
    knownCompanionIds: [A, B],
  });
}

describe('PostgresIcpSharedAutonomyStore', () => {
  it('pins and provisions the shared schema', async () => {
    await connect();
    expect(mocks.createPostgresPool).toHaveBeenCalledWith(
      'postgres://example',
      expect.objectContaining({ schema: SHARED_SCHEMA_NAME }),
    );
    expect(mocks.ensureSharedSchema).toHaveBeenCalledWith(mocks.pool);
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
    expect(lease.revision).toBe(1);
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
    mocks.queryOne.mockResolvedValue(PERMIT_ROW);
    const store = await connect();
    await store.issuePermit({
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
    });
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('INSERT INTO icp_initiation_permits');
    expect(sql).toContain('FROM icp_conversation_episodes');
    expect(sql).toContain('participant_companion_ids @>');
    expect(sql).not.toContain('reason_summary');
  });

  it('atomically consumes once and classifies a concurrent replay', async () => {
    const consumedRow = {
      ...PERMIT_ROW,
      status: 'consumed',
      consumed_at_ms: '11000',
      revision: '2',
    };
    mocks.queryOne.mockResolvedValueOnce(consumedRow);
    const store = await connect();
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      consumedAtMs: 11_000,
    })).resolves.toMatchObject({ outcome: 'consumed' });
    expect((mocks.queryOne.mock.calls[0] as [unknown, string])[1])
      .toContain("WHERE permit_id = $1 AND status = 'issued'");

    mocks.queryOne.mockReset();
    mocks.queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce(consumedRow);
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: B,
      channelId: CHANNEL,
      consumedAtMs: 11_001,
    })).resolves.toMatchObject({ outcome: 'replayed', reasonCode: 'permit_replayed' });
  });

  it('fails a mismatched permit binding closed', async () => {
    mocks.queryOne.mockResolvedValueOnce(undefined).mockResolvedValueOnce(PERMIT_ROW);
    const store = await connect();
    await expect(store.consumePermit({
      permitId: PERMIT_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: A,
      recipientCompanionId: C,
      channelId: `companion-dm:${A}:${C}`,
      consumedAtMs: 11_000,
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
    )).rejects.toThrow('revocation conflict');
    const [, sql] = mocks.queryOne.mock.calls[0] as [unknown, string];
    expect(sql).toContain('issued_at_ms <= $3');
  });

  it('finds one current outstanding pair after lazily expiring old permits', async () => {
    mocks.queryOne.mockResolvedValue(PERMIT_ROW);
    const store = await connect();
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
    mocks.queryRows.mockResolvedValue([{
      ...PERMIT_ROW,
      status: 'revoked',
      revoked_at_ms: '11000',
      reason_code: 'peer_offline',
      revision: '2',
    }]);
    const store = await connect();
    await expect(store.revokeOutstandingPermitsForCompanion(B, 11_000, 'peer_offline'))
      .resolves.toEqual([expect.objectContaining({ status: 'revoked', reasonCode: 'peer_offline' })]);
    const [, sql] = mocks.queryRows.mock.calls[0] as [unknown, string];
    expect(sql).toContain("SET status = 'revoked'");
    expect(sql).toContain('(sender_companion_id = $1 OR recipient_companion_id = $1)');
  });
});
