import type {
  AdminEgressLeaseProjection,
  AdminParticipationProjection,
  AdminReservationProjection,
  AdminRoomEpisodeProjection,
} from '../../../../persistence/postgres/speaking-arbiter-admin-store.js';

/**
 * Fleet Command room-state and arbitration telemetry (jp36.8.1; design bible
 * §8.5, §12.2, §20.1; charter §8.11 Law 36). Every field is CONTENT-FREE — ids,
 * enums, counters, timestamps only, never room/message text (bible §19 do-not-log
 * list). The projections are re-exported directly because they already carry the
 * content-free shape.
 */
export type AdminRoomEpisodeView = AdminRoomEpisodeProjection & {
  /**
   * Suppression state and its Law-36 recovery path, made inspectable. `open`
   * suppresses autonomous egress; the breaker recovers `open → half_open` (a
   * single probe turn) `→ closed`. `suppressed` is true whenever the breaker is
   * not `closed`.
   */
  suppression: {
    breakerState: AdminRoomEpisodeProjection['breakerState'];
    suppressed: boolean;
    resetPath: readonly ['open', 'half_open', 'closed'];
  };
};

export type AdminReservationView = AdminReservationProjection;
export type AdminEgressLeaseView = AdminEgressLeaseProjection;
export type AdminParticipationView = AdminParticipationProjection;

export interface AdminRoomArbiterReasonCount {
  reason: string;
  count: number;
}

export interface AdminRoomArbiterData {
  /** False when the arbiter store is absent (single-companion / no Postgres). */
  available: boolean;
  episodes: AdminRoomEpisodeView[];
  reservations: AdminReservationView[];
  leases: AdminEgressLeaseView[];
  participation: AdminParticipationView[];
  /** Content-free rollups for the Fleet Command summary. */
  summary: {
    openEpisodeCount: number;
    suppressedEpisodeCount: number;
    activeReservationCount: number;
    heldLeaseCount: number;
  };
  /** Content-free reason-code histogram across reservations and leases. */
  reasonCounts: AdminRoomArbiterReasonCount[];
  redaction: {
    roomText: 'not_collected';
    messageContent: 'not_collected';
  };
}

export interface AdminRoomArbiterService {
  getData(): Promise<AdminRoomArbiterData>;
  close?(): Promise<void>;
}
