import type { Pool, QueryResultRow } from 'pg';

import {
  SPEAKING_ARBITER_REASONS,
  SPEAKING_EGRESS_LEASE_STATUSES,
  SPEAKING_RESERVATION_STATUSES,
  type RoomEpisodeBreakerState,
  type RoomEpisodeParticipant,
  type SpeakingArbiterReason,
  type SpeakingEgressLeaseStatus,
  type SpeakingReservationStatus,
} from '../../core/agent/arbiter/speaking-arbiter-store-port.js';
import { createPostgresPool, queryRows } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

/**
 * Read-only, admin-owned projection over the gateway-owned speaking-arbiter
 * shared-schema tables (design bible §8.5, §12.2; charter §8.11). This never
 * mutates and never takes the per-channel advisory lock the runtime store uses —
 * it opens its own bounded read connection so Fleet Command telemetry cannot
 * contend with live arbitration. Mirrors {@link PostgresIcpAdminProjectionStore}:
 * arbitration is a fleet/gateway concern (a companion never arbitrates a peer's
 * turn), so the projection is fleet-wide, not tenant-filtered.
 *
 * Every projected field is CONTENT-FREE: ids, enums, counters, and timestamps
 * only — never room/message text (bible §19 do-not-log list).
 */
const MAX_ADMIN_ROWS = 200;
const DEFAULT_ADMIN_ROWS = 50;

interface EpisodeRow extends QueryResultRow {
  episode_id: string;
  channel_id: string;
  status: string;
  pressure: string | number;
  consecutive_autonomous_turns: string | number;
  last_speaker_companion_id: string | null;
  breaker_state: string;
  opened_at_ms: string | number;
  last_activity_at_ms: string | number;
  closed_at_ms: string | number | null;
  revision: string | number;
}

interface ParticipantRow extends QueryResultRow {
  episode_id: string;
  companion_id: string;
  speak_count: string | number;
  last_spoke_at_ms: string | number | null;
}

interface ReservationRow extends QueryResultRow {
  reservation_id: string;
  channel_id: string;
  trigger_event_id: string;
  companion_id: string;
  episode_id: string;
  status: string;
  reason: string | null;
  reserved_at_ms: string | number;
  expires_at_ms: string | number;
  finalized_at_ms: string | number | null;
  revision: string | number;
}

interface LeaseRow extends QueryResultRow {
  lease_id: string;
  reservation_id: string;
  channel_id: string;
  trigger_event_id: string;
  companion_id: string;
  episode_id: string;
  fencing_token: string | number;
  charged_units: string | number;
  status: string;
  reason: string | null;
  acquired_at_ms: string | number;
  expires_at_ms: string | number;
  finalized_at_ms: string | number | null;
  revision: string | number;
}

/**
 * Per-companion participation aggregate across every open episode. Content-free
 * fairness telemetry (§8.5 priority #4, §20.1): who has spoken how many times and
 * how recently, with no room text.
 */
interface ParticipationAggregateRow extends QueryResultRow {
  companion_id: string;
  episode_count: string | number;
  total_speak_count: string | number;
  last_spoke_at_ms: string | number | null;
}

export interface AdminRoomEpisodeProjection {
  episodeId: string;
  channelId: string;
  status: 'open' | 'closed';
  pressure: number;
  consecutiveAutonomousTurns: number;
  lastSpeakerCompanionId: string | null;
  breakerState: RoomEpisodeBreakerState;
  openedAtMs: number;
  lastActivityAtMs: number;
  closedAtMs: number | null;
  revision: number;
  participants: RoomEpisodeParticipant[];
}

export interface AdminReservationProjection {
  reservationId: string;
  channelId: string;
  triggerEventId: string;
  companionId: string;
  episodeId: string;
  status: SpeakingReservationStatus;
  reason: SpeakingArbiterReason | null;
  reservedAtMs: number;
  expiresAtMs: number;
  finalizedAtMs: number | null;
  revision: number;
}

export interface AdminEgressLeaseProjection {
  leaseId: string;
  reservationId: string;
  channelId: string;
  triggerEventId: string;
  companionId: string;
  episodeId: string;
  fencingToken: number;
  chargedUnits: number;
  status: SpeakingEgressLeaseStatus;
  reason: SpeakingArbiterReason | null;
  acquiredAtMs: number;
  expiresAtMs: number;
  finalizedAtMs: number | null;
  revision: number;
}

export interface AdminParticipationProjection {
  companionId: string;
  episodeCount: number;
  totalSpeakCount: number;
  lastSpokeAtMs: number | null;
}

export interface SpeakingArbiterAdminProjection {
  episodes: AdminRoomEpisodeProjection[];
  reservations: AdminReservationProjection[];
  leases: AdminEgressLeaseProjection[];
  participation: AdminParticipationProjection[];
}

export interface SpeakingArbiterAdminStore {
  readProjection(limit?: number): Promise<SpeakingArbiterAdminProjection>;
  close(): Promise<void>;
}

function integer(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function nullableInteger(value: string | number | null, field: string): number | null {
  return value === null ? null : integer(value, field);
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

function assertEpisodeStatus(value: string): 'open' | 'closed' {
  if (value === 'open' || value === 'closed') return value;
  throw new Error(`unexpected speaking room episode status "${value}"`);
}

function assertBreakerState(value: string): RoomEpisodeBreakerState {
  if (value === 'closed' || value === 'open' || value === 'half_open') return value;
  throw new Error(`unexpected speaking room episode breaker state "${value}"`);
}

function assertReservationStatus(value: string): SpeakingReservationStatus {
  const match = SPEAKING_RESERVATION_STATUSES.find(status => status === value);
  if (match) return match;
  throw new Error(`unexpected speaking reservation status "${value}"`);
}

function assertLeaseStatus(value: string): SpeakingEgressLeaseStatus {
  const match = SPEAKING_EGRESS_LEASE_STATUSES.find(status => status === value);
  if (match) return match;
  throw new Error(`unexpected speaking egress lease status "${value}"`);
}

function assertReason(value: string | null): SpeakingArbiterReason | null {
  if (value === null) return null;
  const match = SPEAKING_ARBITER_REASONS.find(reason => reason === value);
  if (match) return match;
  throw new Error(`unexpected speaking arbiter reason "${value}"`);
}

function mapParticipant(row: ParticipantRow): RoomEpisodeParticipant {
  return {
    companionId: row.companion_id,
    speakCount: integer(row.speak_count, 'participant.speakCount'),
    lastSpokeAtMs: nullableInteger(row.last_spoke_at_ms, 'participant.lastSpokeAtMs'),
  };
}

function mapEpisode(
  row: EpisodeRow,
  participantRows: readonly ParticipantRow[],
): AdminRoomEpisodeProjection {
  return {
    episodeId: row.episode_id,
    channelId: row.channel_id,
    status: assertEpisodeStatus(row.status),
    pressure: finiteNumber(row.pressure, 'episode.pressure'),
    consecutiveAutonomousTurns: integer(
      row.consecutive_autonomous_turns,
      'episode.consecutiveAutonomousTurns',
    ),
    lastSpeakerCompanionId: row.last_speaker_companion_id,
    breakerState: assertBreakerState(row.breaker_state),
    openedAtMs: integer(row.opened_at_ms, 'episode.openedAtMs'),
    lastActivityAtMs: integer(row.last_activity_at_ms, 'episode.lastActivityAtMs'),
    closedAtMs: nullableInteger(row.closed_at_ms, 'episode.closedAtMs'),
    revision: integer(row.revision, 'episode.revision'),
    participants: participantRows
      .filter(participant => participant.episode_id === row.episode_id)
      .map(mapParticipant),
  };
}

function mapReservation(row: ReservationRow): AdminReservationProjection {
  return {
    reservationId: row.reservation_id,
    channelId: row.channel_id,
    triggerEventId: row.trigger_event_id,
    companionId: row.companion_id,
    episodeId: row.episode_id,
    status: assertReservationStatus(row.status),
    reason: assertReason(row.reason),
    reservedAtMs: integer(row.reserved_at_ms, 'reservation.reservedAtMs'),
    expiresAtMs: integer(row.expires_at_ms, 'reservation.expiresAtMs'),
    finalizedAtMs: nullableInteger(row.finalized_at_ms, 'reservation.finalizedAtMs'),
    revision: integer(row.revision, 'reservation.revision'),
  };
}

function mapLease(row: LeaseRow): AdminEgressLeaseProjection {
  return {
    leaseId: row.lease_id,
    reservationId: row.reservation_id,
    channelId: row.channel_id,
    triggerEventId: row.trigger_event_id,
    companionId: row.companion_id,
    episodeId: row.episode_id,
    fencingToken: integer(row.fencing_token, 'lease.fencingToken'),
    chargedUnits: finiteNumber(row.charged_units, 'lease.chargedUnits'),
    status: assertLeaseStatus(row.status),
    reason: assertReason(row.reason),
    acquiredAtMs: integer(row.acquired_at_ms, 'lease.acquiredAtMs'),
    expiresAtMs: integer(row.expires_at_ms, 'lease.expiresAtMs'),
    finalizedAtMs: nullableInteger(row.finalized_at_ms, 'lease.finalizedAtMs'),
    revision: integer(row.revision, 'lease.revision'),
  };
}

function mapParticipation(row: ParticipationAggregateRow): AdminParticipationProjection {
  return {
    companionId: row.companion_id,
    episodeCount: integer(row.episode_count, 'participation.episodeCount'),
    totalSpeakCount: integer(row.total_speak_count, 'participation.totalSpeakCount'),
    lastSpokeAtMs: nullableInteger(row.last_spoke_at_ms, 'participation.lastSpokeAtMs'),
  };
}

export class PostgresSpeakingArbiterAdminStore implements SpeakingArbiterAdminStore {
  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresSpeakingArbiterAdminStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-speaking-arbiter-admin-projection',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
      max: 2,
    });
    return new PostgresSpeakingArbiterAdminStore(pool);
  }

  async readProjection(limit = DEFAULT_ADMIN_ROWS): Promise<SpeakingArbiterAdminProjection> {
    const boundedLimit = Math.min(MAX_ADMIN_ROWS, Math.max(1, Math.floor(limit)));
    const episodeRows = await queryRows<EpisodeRow>(this.pool, `
      SELECT episode_id, channel_id, status, pressure, consecutive_autonomous_turns,
        last_speaker_companion_id, breaker_state, opened_at_ms, last_activity_at_ms,
        closed_at_ms, revision
      FROM speaking_room_episodes
      ORDER BY (status = 'open') DESC, last_activity_at_ms DESC, episode_id
      LIMIT $1
    `, [boundedLimit]);
    const episodeIds = episodeRows.map(row => row.episode_id);
    const [participantRows, reservationRows, leaseRows, participationRows] = await Promise.all([
      episodeIds.length > 0
        ? queryRows<ParticipantRow>(this.pool, `
          SELECT episode_id, companion_id, speak_count, last_spoke_at_ms
          FROM speaking_episode_participation
          WHERE episode_id = ANY($1::uuid[])
          ORDER BY last_spoke_at_ms ASC NULLS FIRST, companion_id
        `, [episodeIds])
        : Promise.resolve([] as ParticipantRow[]),
      queryRows<ReservationRow>(this.pool, `
        SELECT reservation_id, channel_id, trigger_event_id, companion_id, episode_id,
          status, reason, reserved_at_ms, expires_at_ms, finalized_at_ms, revision
        FROM speaking_reservations
        ORDER BY reserved_at_ms DESC, reservation_id
        LIMIT $1
      `, [boundedLimit]),
      queryRows<LeaseRow>(this.pool, `
        SELECT lease_id, reservation_id, channel_id, trigger_event_id, companion_id,
          episode_id, fencing_token, charged_units, status, reason, acquired_at_ms,
          expires_at_ms, finalized_at_ms, revision
        FROM speaking_egress_leases
        ORDER BY acquired_at_ms DESC, lease_id
        LIMIT $1
      `, [boundedLimit]),
      queryRows<ParticipationAggregateRow>(this.pool, `
        SELECT companion_id,
          COUNT(*) AS episode_count,
          COALESCE(SUM(speak_count), 0) AS total_speak_count,
          MAX(last_spoke_at_ms) AS last_spoke_at_ms
        FROM speaking_episode_participation
        GROUP BY companion_id
        ORDER BY MAX(last_spoke_at_ms) DESC NULLS LAST, companion_id
        LIMIT $1
      `, [boundedLimit]),
    ]);
    return {
      episodes: episodeRows.map(row => mapEpisode(row, participantRows)),
      reservations: reservationRows.map(mapReservation),
      leases: leaseRows.map(mapLease),
      participation: participationRows.map(mapParticipation),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
