import { describe, expect, it } from 'vitest';

import type {
  SpeakingArbiterAdminProjection,
  SpeakingArbiterAdminStore,
} from '../../../persistence/postgres/speaking-arbiter-admin-store.js';
import { AdminRoomArbiterDataService } from './room-arbiter-service.js';

const NOW = 1_000_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function projection(
  overrides: Partial<SpeakingArbiterAdminProjection> = {},
): SpeakingArbiterAdminProjection {
  return {
    episodes: [
      {
        episodeId: 'ep-open',
        channelId: 'discord:room-1',
        status: 'open',
        pressure: 3.5,
        consecutiveAutonomousTurns: 2,
        lastSpeakerCompanionId: COMPANION_A,
        breakerState: 'open',
        openedAtMs: NOW - 10_000,
        lastActivityAtMs: NOW - 100,
        closedAtMs: null,
        revision: 4,
        participants: [
          { companionId: COMPANION_A, speakCount: 2, lastSpokeAtMs: NOW - 100 },
          { companionId: COMPANION_B, speakCount: 0, lastSpokeAtMs: null },
        ],
      },
      {
        episodeId: 'ep-closed',
        channelId: 'discord:room-2',
        status: 'closed',
        pressure: 0,
        consecutiveAutonomousTurns: 0,
        lastSpeakerCompanionId: null,
        breakerState: 'closed',
        openedAtMs: NOW - 50_000,
        lastActivityAtMs: NOW - 40_000,
        closedAtMs: NOW - 40_000,
        revision: 9,
        participants: [],
      },
    ],
    reservations: [
      {
        reservationId: 'res-active',
        channelId: 'discord:room-1',
        triggerEventId: 'evt-1',
        companionId: COMPANION_A,
        episodeId: 'ep-open',
        status: 'reserved',
        reason: null,
        reservedAtMs: NOW - 500,
        expiresAtMs: NOW + 5_000,
        finalizedAtMs: null,
        revision: 1,
      },
      {
        reservationId: 'res-released',
        channelId: 'discord:room-1',
        triggerEventId: 'evt-0',
        companionId: COMPANION_B,
        episodeId: 'ep-open',
        status: 'released',
        reason: 'silence',
        reservedAtMs: NOW - 9_000,
        expiresAtMs: NOW - 8_000,
        finalizedAtMs: NOW - 8_500,
        revision: 2,
      },
    ],
    leases: [
      {
        leaseId: 'lease-held',
        reservationId: 'res-active',
        channelId: 'discord:room-1',
        triggerEventId: 'evt-1',
        companionId: COMPANION_A,
        episodeId: 'ep-open',
        fencingToken: 7,
        chargedUnits: 1.25,
        status: 'held',
        reason: null,
        acquiredAtMs: NOW - 200,
        expiresAtMs: NOW + 3_000,
        finalizedAtMs: null,
        revision: 1,
      },
      {
        leaseId: 'lease-delivered',
        reservationId: 'res-old',
        channelId: 'discord:room-2',
        triggerEventId: 'evt-9',
        companionId: COMPANION_A,
        episodeId: 'ep-closed',
        fencingToken: 3,
        chargedUnits: 2,
        status: 'delivered',
        reason: 'delivered',
        acquiredAtMs: NOW - 41_000,
        expiresAtMs: NOW - 40_000,
        finalizedAtMs: NOW - 40_500,
        revision: 2,
      },
    ],
    participation: [
      { companionId: COMPANION_A, episodeCount: 2, totalSpeakCount: 5, lastSpokeAtMs: NOW - 100 },
      { companionId: COMPANION_B, episodeCount: 1, totalSpeakCount: 0, lastSpokeAtMs: null },
    ],
    ...overrides,
  };
}

function fakeStore(data: SpeakingArbiterAdminProjection): SpeakingArbiterAdminStore {
  return {
    readProjection: async () => data,
    close: async () => {},
  };
}

describe('AdminRoomArbiterDataService', () => {
  it('reports available:false and an empty payload when the store is absent', async () => {
    const service = new AdminRoomArbiterDataService({ arbiterStore: null, now: () => NOW });
    const data = await service.getData();
    expect(data.available).toBe(false);
    expect(data.episodes).toEqual([]);
    expect(data.reservations).toEqual([]);
    expect(data.leases).toEqual([]);
    expect(data.participation).toEqual([]);
    expect(data.summary).toEqual({
      openEpisodeCount: 0,
      suppressedEpisodeCount: 0,
      activeReservationCount: 0,
      heldLeaseCount: 0,
    });
    expect(data.reasonCounts).toEqual([]);
  });

  it('projects content-free room, reservation, lease, and participation state', async () => {
    const service = new AdminRoomArbiterDataService({
      arbiterStore: fakeStore(projection()),
      now: () => NOW,
    });
    const data = await service.getData();
    expect(data.available).toBe(true);
    expect(data.summary).toEqual({
      openEpisodeCount: 1,
      suppressedEpisodeCount: 1,
      activeReservationCount: 1,
      heldLeaseCount: 1,
    });
    // reason histogram: 'silence' (reservation) + 'delivered' (lease)
    expect(data.reasonCounts).toEqual([
      { reason: 'delivered', count: 1 },
      { reason: 'silence', count: 1 },
    ]);
  });

  it('exposes suppression state with the Law-36 reset path', async () => {
    const service = new AdminRoomArbiterDataService({
      arbiterStore: fakeStore(projection()),
      now: () => NOW,
    });
    const data = await service.getData();
    const open = data.episodes.find(episode => episode.episodeId === 'ep-open');
    const closed = data.episodes.find(episode => episode.episodeId === 'ep-closed');
    expect(open?.suppression).toEqual({
      breakerState: 'open',
      suppressed: true,
      resetPath: ['open', 'half_open', 'closed'],
    });
    expect(closed?.suppression.suppressed).toBe(false);
  });

  it('never surfaces room or message text (content-free contract)', async () => {
    const service = new AdminRoomArbiterDataService({
      arbiterStore: fakeStore(projection()),
      now: () => NOW,
    });
    const data = await service.getData();
    expect(data.redaction).toEqual({
      roomText: 'not_collected',
      messageContent: 'not_collected',
    });
    const serialized = JSON.stringify(data);
    // The projection carries no free-text keys — assert the shape stays id/enum/count only.
    for (const key of ['text', 'content', 'body', 'message', 'transcript']) {
      expect(serialized).not.toContain(`"${key}"`);
    }
  });
});
