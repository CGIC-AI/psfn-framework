import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(async (text: string) => ({
    rows: text.includes('to_regclass')
      ? [{ ledger_table: 'shared.shared_schema_migrations' }]
      : [{ versions: [1, 2, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15] }],
  })),
  poolEnd: vi.fn(async () => {}),
  createPostgresPool: vi.fn(() => ({
    query: mocks.poolQuery,
    end: mocks.poolEnd,
  })),
  queryRows: vi.fn(async () => [] as never[]),
}));

vi.mock('../postgres.js', () => ({
  createPostgresPool: mocks.createPostgresPool,
  queryRows: mocks.queryRows,
}));

import { PostgresSpeakingArbiterAdminStore } from './speaking-arbiter-admin-store.js';

const EPISODE_ID = '33333333-3333-4333-8333-333333333333';
const COMPANION = '11111111-1111-4111-8111-111111111111';

function rowsFor(text: string): unknown[] {
  if (text.includes('FROM speaking_room_episodes')) {
    return [{
      episode_id: EPISODE_ID,
      channel_id: 'discord:room-1',
      status: 'open',
      pressure: '2.5',
      consecutive_autonomous_turns: '1',
      last_speaker_companion_id: COMPANION,
      breaker_state: 'half_open',
      opened_at_ms: '1000',
      last_activity_at_ms: '2000',
      closed_at_ms: null,
      revision: '3',
    }];
  }
  if (text.includes('FROM speaking_episode_participation') && text.includes('GROUP BY')) {
    return [{
      companion_id: COMPANION,
      episode_count: '2',
      total_speak_count: '4',
      last_spoke_at_ms: '2000',
    }];
  }
  if (text.includes('FROM speaking_episode_participation')) {
    return [{
      episode_id: EPISODE_ID,
      companion_id: COMPANION,
      speak_count: '2',
      last_spoke_at_ms: '2000',
    }];
  }
  if (text.includes('FROM speaking_reservations')) {
    return [{
      reservation_id: '44444444-4444-4444-8444-444444444444',
      channel_id: 'discord:room-1',
      trigger_event_id: 'evt-1',
      companion_id: COMPANION,
      episode_id: EPISODE_ID,
      status: 'reserved',
      reason: null,
      reserved_at_ms: '1500',
      expires_at_ms: '9000',
      finalized_at_ms: null,
      revision: '1',
    }];
  }
  if (text.includes('FROM speaking_egress_leases')) {
    return [{
      lease_id: '55555555-5555-4555-8555-555555555555',
      reservation_id: '44444444-4444-4444-8444-444444444444',
      channel_id: 'discord:room-1',
      trigger_event_id: 'evt-1',
      companion_id: COMPANION,
      episode_id: EPISODE_ID,
      fencing_token: '7',
      charged_units: '1.5',
      status: 'held',
      reason: null,
      acquired_at_ms: '1600',
      expires_at_ms: '9500',
      finalized_at_ms: null,
      revision: '1',
    }];
  }
  return [];
}

describe('PostgresSpeakingArbiterAdminStore', () => {
  beforeEach(() => {
    mocks.createPostgresPool.mockClear();
    mocks.poolQuery.mockClear();
    mocks.poolEnd.mockClear();
    mocks.queryRows.mockReset();
    mocks.queryRows.mockImplementation(async (_pool: unknown, text: string) => rowsFor(text) as never[]);
  });

  it('fails reads when the shared migration ledger is not ready', async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ ledger_table: null }] });
    const store = await PostgresSpeakingArbiterAdminStore.connect('postgres://localhost/test');

    await expect(store.readProjection())
      .rejects.toThrow('shared_schema_migrations ledger');
  });

  it('projects the shared arbiter tables into a content-free, typed shape', async () => {
    const store = await PostgresSpeakingArbiterAdminStore.connect('postgres://localhost/test');
    const projection = await store.readProjection(10);

    expect(projection.episodes).toEqual([{
      episodeId: EPISODE_ID,
      channelId: 'discord:room-1',
      status: 'open',
      pressure: 2.5,
      consecutiveAutonomousTurns: 1,
      lastSpeakerCompanionId: COMPANION,
      breakerState: 'half_open',
      openedAtMs: 1000,
      lastActivityAtMs: 2000,
      closedAtMs: null,
      revision: 3,
      participants: [{ companionId: COMPANION, speakCount: 2, lastSpokeAtMs: 2000 }],
    }]);
    expect(projection.reservations[0]).toMatchObject({ status: 'reserved', reason: null });
    expect(projection.leases[0]).toMatchObject({ status: 'held', fencingToken: 7, chargedUnits: 1.5 });
    expect(projection.participation).toEqual([{
      companionId: COMPANION,
      episodeCount: 2,
      totalSpeakCount: 4,
      lastSpokeAtMs: 2000,
    }]);

    // Content-free: no free-text columns are ever selected.
    for (const call of mocks.queryRows.mock.calls) {
      const text = String(call[1]);
      expect(text).not.toMatch(/\b(text|content|body|message|transcript)\b/i);
    }
  });

  it('clamps the limit to the bounded admin ceiling', async () => {
    const store = await PostgresSpeakingArbiterAdminStore.connect('postgres://localhost/test');
    await store.readProjection(100_000);
    const episodeCall = mocks.queryRows.mock.calls.find(
      call => String(call[1]).includes('FROM speaking_room_episodes'),
    );
    expect(episodeCall?.[2]).toEqual([200]);
  });

  it('rejects an unexpected breaker state fail-closed', async () => {
    mocks.queryRows.mockImplementation(async (_pool: unknown, text: string) => {
      if (text.includes('FROM speaking_room_episodes')) {
        return [{
          episode_id: EPISODE_ID,
          channel_id: 'c',
          status: 'open',
          pressure: '0',
          consecutive_autonomous_turns: '0',
          last_speaker_companion_id: null,
          breaker_state: 'bogus',
          opened_at_ms: '1',
          last_activity_at_ms: '2',
          closed_at_ms: null,
          revision: '1',
        }] as never[];
      }
      return [] as never[];
    });
    const store = await PostgresSpeakingArbiterAdminStore.connect('postgres://localhost/test');
    await expect(store.readProjection()).rejects.toThrow(/breaker state/u);
  });
});
