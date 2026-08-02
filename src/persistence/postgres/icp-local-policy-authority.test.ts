import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PostgresIcpLocalPolicyAuthority } from './icp-local-policy-authority.js';
import { deriveIcpLocalPolicyAcquirePayloadDigest } from '../../core/icp/local-policy-contract.js';

const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const ROOT_ID = '44444444-4444-4444-8444-444444444444';
const PERMIT_ID = '55555555-5555-4555-8555-555555555555';
const NONCE = '66666666-6666-4666-8666-666666666666';
const HOLD_ID = '77777777-7777-4777-8777-777777777777';

const candidate = {
  candidateId: CANDIDATE_ID,
  rootInitiationId: ROOT_ID,
  localCompanionId: SENDER_ID,
  peerCompanionId: RECIPIENT_ID,
  preferredChannel: 'dm',
  source: 'intention',
  provenanceRef: `icp-prov:${ROOT_ID}`,
  createdAtMs: 1_000,
  expiresAtMs: 20_000,
  status: 'pending',
  revision: 1,
} as const;

function candidateRow(status = 'pending') {
  return {
    candidate_id: CANDIDATE_ID,
    root_initiation_id: ROOT_ID,
    local_companion_id: SENDER_ID,
    peer_contact_id: 'private-contact-id',
    peer_companion_id: RECIPIENT_ID,
    preferred_channel: 'dm',
    source: 'intention',
    provenance_ref: `icp-prov:${ROOT_ID}`,
    created_at_ms: 1_000,
    expires_at_ms: 20_000,
    status,
    reason_code: null,
    initiation_permit_id: status === 'pending' ? null : PERMIT_ID,
    revision: 1,
  };
}

function policyQuery(status = 'pending') {
  return vi.fn(async (sql: string) => {
    if (sql.includes('pg_catalog.pg_attribute')) {
      return { rows: [{ relation_exists: true, missing_columns: [], missing_privileges: [] }] };
    }
    if (sql.includes('FROM icp_initiation_candidates')) return { rows: [candidateRow(status)] };
    if (sql.includes('FROM contacts AS c')) {
      return { rows: [{ id: 'private-contact-id', trust_level: 'regular', relationship_type: 'friend', is_machine_intelligence: true }] };
    }
    if (sql.includes('FROM contact_channel_ids AS identity')) {
      return { rows: [{ channel_user_id: RECIPIENT_ID }] };
    }
    return { rows: [] };
  });
}

function fakePool(query = policyQuery(), beforeConnect?: () => Promise<void>) {
  const clients: Array<PoolClient & { release: ReturnType<typeof vi.fn> }> = [];
  const connect = vi.fn(async () => {
    await beforeConnect?.();
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient & { release: ReturnType<typeof vi.fn> };
    clients.push(client);
    return client;
  });
  return {
    pool: { query, connect, end: vi.fn() } as unknown as Pool,
    query,
    connect,
    clients,
  };
}

async function readyAuthority(
  poolFixture = fakePool(),
  overrides: Partial<ConstructorParameters<typeof PostgresIcpLocalPolicyAuthority>[1]> = {},
) {
  const capacity = { resolve: vi.fn(async () => ({
    socialPressureAllows: true,
    chargeAllows: true,
    fatigueAllows: true,
    costAllows: true,
  })) };
  const authority = new PostgresIcpLocalPolicyAuthority('postgres://test', {
    companionId: SENDER_ID,
    postgresSchema: 'tenant_a',
    companionDataDir: '/tmp/psfn-local-policy-authority-test',
    quietHours: { enabled: false, startLocalTime: '22:00', endLocalTime: '07:00', timeZone: 'UTC' },
    policyHolds: { ttlMs: 10_000, maxOutstanding: 2 },
    capacityAuthority: capacity,
    pool: poolFixture.pool,
    randomUuid: () => HOLD_ID,
    now: () => 2_000,
    ...overrides,
  });
  await authority.assertReady();
  return { authority, capacity, poolFixture };
}

describe('PostgresIcpLocalPolicyAuthority', () => {
  it('keeps sender-private rows local while evaluating content-free pressure', async () => {
    const { authority, capacity } = await readyAuthority();
    const result = await authority.inspect({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: 2_000,
      relationshipPressure: 2.5,
    });

    expect(result).toEqual({
      role: 'sender',
      ready: true,
      canonicalPeerContact: true,
      trustAllows: true,
      blocksPeer: false,
      quietHours: false,
      provenanceFresh: true,
      socialPressureAllows: true,
      chargeAllows: true,
      fatigueAllows: true,
      costAllows: true,
    });
    expect(capacity.resolve).toHaveBeenCalledWith(expect.objectContaining({
      relationshipPressure: 2.5,
      senderRelationship: { trustLevel: 'regular', relationshipType: 'friend' },
    }));
    expect(JSON.stringify(result)).not.toMatch(/private-contact|tenant_a|companionDataDir/u);
  });

  it('retains exact local locks until bound release and rejects replay', async () => {
    const fixture = fakePool();
    const { authority } = await readyAuthority(fixture);
    const request = {
      role: 'sender',
      phase: 'issue',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nonce: NONCE,
      nowMs: 2_000,
      expiresAtMs: 3_000,
      relationshipPressure: 2.5,
    } as const;
    const boundRequest = {
      ...request,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(request),
    };

    await expect(authority.acquire(boundRequest)).resolves.toEqual({
      acquired: true,
      holdId: HOLD_ID,
      expiresAtMs: 3_000,
    });
    expect(fixture.query).toHaveBeenCalledWith('BEGIN');
    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes('FOR SHARE'))).toBe(true);
    expect(fixture.query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE OF c'))).toBe(true);
    const identityLockSql = fixture.query.mock.calls
      .map(([sql]) => String(sql))
      .find(sql => sql.includes('SELECT identity.channel_user_id'));
    expect(identityLockSql?.match(/FOR SHARE OF identity/gu)).toHaveLength(1);
    expect(fixture.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(fixture.clients[0]?.release).not.toHaveBeenCalled();

    await expect(authority.release({
      holdId: HOLD_ID,
      payloadDigest: boundRequest.payloadDigest,
      nonce: NONCE,
    })).resolves.toEqual({ released: true });
    expect(fixture.query).toHaveBeenCalledWith('ROLLBACK');
    expect(fixture.clients[0]?.release).toHaveBeenCalledOnce();
    await expect(authority.release({ holdId: HOLD_ID, payloadDigest: boundRequest.payloadDigest, nonce: NONCE }))
      .rejects.toThrow(/unknown or already released/i);
    await expect(authority.acquire(boundRequest)).resolves.toEqual({
      acquired: false,
      reasonCode: 'permit_mismatch',
    });
    await expect(authority.acquire({
      ...boundRequest,
      nonce: '99999999-9999-4999-8999-999999999999',
    })).resolves.toEqual({ acquired: false, reasonCode: 'permit_mismatch' });
  });

  it('accepts only the exact consumed-recovery binding', async () => {
    const fixture = fakePool(policyQuery('consumed'));
    const { authority, capacity } = await readyAuthority(fixture, {
      now: () => 30_000,
      quietHours: {
        enabled: true,
        startLocalTime: '22:00',
        endLocalTime: '07:00',
        timeZone: 'UTC',
      },
    });
    capacity.resolve.mockResolvedValue({
      socialPressureAllows: false,
      chargeAllows: false,
      fatigueAllows: false,
      costAllows: false,
    });
    const permit = {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: '88888888-8888-4888-8888-888888888888',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      provenanceRef: `icp-prov:${ROOT_ID}`,
      issuedAtMs: 2_000,
      expiresAtMs: 10_000,
      status: 'consumed',
      consumedAtMs: 2_500,
      revision: 2,
    } as const;
    const consumeRequest = {
      role: 'sender',
      phase: 'consume',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      permit,
      rootInitiationId: ROOT_ID,
      channelId: permit.channelId,
      nonce: NONCE,
      nowMs: 3_000,
      expiresAtMs: 40_000,
      relationshipPressure: 0,
    } as const;
    await expect(authority.acquire({
      ...consumeRequest,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(consumeRequest),
    })).resolves.toMatchObject({ acquired: true });
    expect(capacity.resolve).not.toHaveBeenCalled();
  });

  it('rejects an issued handoff whose candidate expired on the local decision clock', async () => {
    const fixture = fakePool(policyQuery('permitted'));
    const { authority } = await readyAuthority(fixture, { now: () => 20_000 });
    const permit = {
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: '88888888-8888-4888-8888-888888888888',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      provenanceRef: `icp-prov:${ROOT_ID}`,
      issuedAtMs: 2_000,
      expiresAtMs: 25_000,
      status: 'issued',
      revision: 2,
    } as const;
    const consumeRequest = {
      role: 'sender',
      phase: 'consume',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      permit,
      rootInitiationId: ROOT_ID,
      channelId: permit.channelId,
      nonce: NONCE,
      nowMs: 3_000,
      expiresAtMs: 25_000,
      relationshipPressure: 0,
    } as const;

    await expect(authority.acquire({
      ...consumeRequest,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(consumeRequest),
    })).resolves.toEqual({ acquired: false, reasonCode: 'stale_provenance' });
  });

  it('rejects an expired pending candidate using the local decision clock', async () => {
    const fixture = fakePool();
    const { authority, capacity } = await readyAuthority(fixture, { now: () => 20_000 });
    const request = {
      role: 'sender',
      phase: 'issue',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nonce: NONCE,
      nowMs: 2_000,
      expiresAtMs: 25_000,
      relationshipPressure: 0,
    } as const;

    await expect(authority.acquire({
      ...request,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(request),
    })).resolves.toEqual({ acquired: false, reasonCode: 'stale_provenance' });
    expect(capacity.resolve).not.toHaveBeenCalled();
    expect(fixture.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('uses the local clock for inspection time gates and capacity policy', async () => {
    const localNowMs = 23 * 60 * 60 * 1_000;
    const callerNowMs = 12 * 60 * 60 * 1_000;
    const { authority, capacity } = await readyAuthority(fakePool(), {
      now: () => localNowMs,
      quietHours: {
        enabled: true,
        startLocalTime: '22:00',
        endLocalTime: '07:00',
        timeZone: 'UTC',
      },
    });

    await expect(authority.inspect({
      role: 'sender',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nowMs: callerNowMs,
      relationshipPressure: 0,
    })).resolves.toMatchObject({
      quietHours: true,
      provenanceFresh: false,
    });
    expect(capacity.resolve).toHaveBeenCalledWith(expect.objectContaining({ nowMs: localNowMs }));
  });

  it('rolls back every retained client on hard expiry despite wall-clock regression and cleanup', async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakePool();
      let nowMs = 2_000;
      const { authority } = await readyAuthority(fixture, { now: () => nowMs });
      const request = {
        role: 'sender',
        phase: 'issue',
        senderCompanionId: SENDER_ID,
        recipientCompanionId: RECIPIENT_ID,
        candidate,
        channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
        nonce: NONCE,
        nowMs,
        expiresAtMs: 3_000,
        relationshipPressure: 0,
      } as const;
      const boundRequest = {
        ...request,
        payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(request),
      };
      await authority.acquire(boundRequest);
      nowMs = 1_500;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fixture.query).toHaveBeenCalledWith('ROLLBACK');
      expect(fixture.clients[0]?.release).toHaveBeenCalledOnce();

      const secondRequest = {
        ...request,
        nonce: '99999999-9999-4999-8999-999999999999',
        nowMs: 4_000,
        expiresAtMs: 5_000,
      } as const;
      await authority.acquire({
        ...secondRequest,
        payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(secondRequest),
      });
      await authority.releaseAll();
      expect(fixture.query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(2);

      const thirdRequest = {
        ...request,
        nonce: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        nowMs: 6_000,
        expiresAtMs: 7_000,
      } as const;
      await authority.acquire({
        ...thirdRequest,
        payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(thirdRequest),
      });
      await authority.close();
      expect(fixture.query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps expiry against local time and reserves nonce/capacity before pool wait', async () => {
    let unblockConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { unblockConnect = resolve; });
    const fixture = fakePool(policyQuery(), async () => await connectGate);
    const { authority } = await readyAuthority(fixture, {
      now: () => 2_000,
      policyHolds: { ttlMs: 10_000, maxOutstanding: 1 },
    });
    const request = {
      role: 'sender',
      phase: 'issue',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nonce: NONCE,
      nowMs: 1_000_000,
      expiresAtMs: 1_020_000,
      relationshipPressure: 0,
    } as const;
    const boundRequest = {
      ...request,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(request),
    };
    const first = authority.acquire(boundRequest);
    await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    await expect(authority.acquire(boundRequest)).resolves.toEqual({
      acquired: false,
      reasonCode: 'permit_mismatch',
    });
    const otherNonce = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherRequest = { ...request, nonce: otherNonce };
    await expect(authority.acquire({
      ...otherRequest,
      payloadDigest: deriveIcpLocalPolicyAcquirePayloadDigest(otherRequest),
    })).resolves.toEqual({ acquired: false, reasonCode: 'peer_busy' });
    expect(fixture.connect).toHaveBeenCalledOnce();

    unblockConnect();
    await expect(first).resolves.toMatchObject({ acquired: true, expiresAtMs: 12_000 });
  });

  it('rolls back an in-flight acquisition that resumes after shutdown', async () => {
    let unblockConnect!: () => void;
    const connectGate = new Promise<void>((resolve) => { unblockConnect = resolve; });
    const fixture = fakePool(policyQuery(), async () => await connectGate);
    const { authority } = await readyAuthority(fixture);
    const request = {
      role: 'sender',
      phase: 'issue',
      senderCompanionId: SENDER_ID,
      recipientCompanionId: RECIPIENT_ID,
      candidate,
      channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
      nonce: NONCE,
      nowMs: 2_000,
      expiresAtMs: 3_000,
      relationshipPressure: 0,
    } as const;
    const payloadDigest = deriveIcpLocalPolicyAcquirePayloadDigest(request);
    const acquisition = authority.acquire({ ...request, payloadDigest });
    await vi.waitFor(() => expect(fixture.connect).toHaveBeenCalledOnce());

    await authority.close();
    unblockConnect();

    await expect(acquisition).rejects.toThrow(/closed/u);
    expect(fixture.query).toHaveBeenCalledWith('ROLLBACK');
    expect(fixture.clients[0]?.release).toHaveBeenCalledOnce();
    await expect(authority.release({ holdId: HOLD_ID, payloadDigest, nonce: NONCE }))
      .rejects.toThrow(/unknown or already released/u);
  });
});
