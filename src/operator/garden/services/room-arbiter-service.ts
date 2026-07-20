import type {
  SpeakingArbiterAdminProjection,
  SpeakingArbiterAdminStore,
} from '../../../persistence/postgres/speaking-arbiter-admin-store.js';
import { isEgressLeaseLive, isReservationActive }
  from '../../../core/agent/arbiter/speaking-arbiter-store-port.js';
import type {
  AdminRoomArbiterData,
  AdminRoomArbiterReasonCount,
  AdminRoomArbiterService,
  AdminRoomEpisodeView,
} from './types/room-arbiter.js';

const ADMIN_ARBITER_LIMIT = 100;

const RESET_PATH = ['open', 'half_open', 'closed'] as const;

export interface AdminRoomArbiterServiceDependencies {
  /** Read-only projection over the shared arbiter schema; null when unavailable. */
  arbiterStore?: SpeakingArbiterAdminStore | null;
  now?: () => number;
}

const EMPTY_PROJECTION: SpeakingArbiterAdminProjection = {
  episodes: [],
  reservations: [],
  leases: [],
  participation: [],
};

function projectEpisode(
  episode: SpeakingArbiterAdminProjection['episodes'][number],
): AdminRoomEpisodeView {
  return {
    ...episode,
    suppression: {
      breakerState: episode.breakerState,
      suppressed: episode.breakerState !== 'closed',
      resetPath: RESET_PATH,
    },
  };
}

export class AdminRoomArbiterDataService implements AdminRoomArbiterService {
  private readonly now: () => number;

  constructor(private readonly deps: AdminRoomArbiterServiceDependencies) {
    this.now = deps.now ?? Date.now;
  }

  async getData(): Promise<AdminRoomArbiterData> {
    const available = Boolean(this.deps.arbiterStore);
    const projection = this.deps.arbiterStore
      ? await this.deps.arbiterStore.readProjection(ADMIN_ARBITER_LIMIT)
      : EMPTY_PROJECTION;
    const nowMs = this.now();

    const episodes = projection.episodes.map(projectEpisode);
    const suppressedEpisodeCount = episodes
      .filter(episode => episode.suppression.suppressed).length;
    const openEpisodeCount = episodes.filter(episode => episode.status === 'open').length;
    const activeReservationCount = projection.reservations
      .filter(reservation => isReservationActive(reservation, nowMs)).length;
    const heldLeaseCount = projection.leases
      .filter(lease => isEgressLeaseLive(lease, nowMs)).length;

    const reasonCounts = new Map<string, number>();
    for (const reservation of projection.reservations) {
      if (reservation.reason) {
        reasonCounts.set(reservation.reason, (reasonCounts.get(reservation.reason) ?? 0) + 1);
      }
    }
    for (const lease of projection.leases) {
      if (lease.reason) {
        reasonCounts.set(lease.reason, (reasonCounts.get(lease.reason) ?? 0) + 1);
      }
    }

    return {
      available,
      episodes,
      reservations: projection.reservations,
      leases: projection.leases,
      participation: projection.participation,
      summary: {
        openEpisodeCount,
        suppressedEpisodeCount,
        activeReservationCount,
        heldLeaseCount,
      },
      reasonCounts: [...reasonCounts.entries()]
        .map(([reason, count]): AdminRoomArbiterReasonCount => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      redaction: {
        roomText: 'not_collected',
        messageContent: 'not_collected',
      },
    };
  }

  async close(): Promise<void> {
    await this.deps.arbiterStore?.close();
  }
}
