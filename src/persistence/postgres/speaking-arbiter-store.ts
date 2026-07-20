import { randomUUID } from 'node:crypto';

import type { Pool, QueryResultRow } from 'pg';

import {
  isEgressLeaseLive,
  speakingCompletionIsSpeech,
  speakingCompletionReason,
  SPEAKING_EGRESS_LEASE_COMPLETIONS,
  type AcquireEgressLeaseInput,
  type AcquireEgressLeaseResult,
  type CloseRoomEpisodeInput,
  type CompleteEgressLeaseInput,
  type EnsureRoomEpisodeInput,
  type ReadRoomEpisodeInput,
  type RecordHumanActivityInput,
  type ReleaseReservationInput,
  type ReserveInput,
  type ReserveResult,
  type RoomEpisodeParticipant,
  type RoomEpisodeSnapshot,
  type SpeakingArbiterReason,
  type SpeakingArbiterStorePort,
  type SpeakingEgressLeaseSnapshot,
  type SpeakingEgressLeaseStatus,
  type SpeakingReservationSnapshot,
  type SpeakingReservationStatus,
  type SweepExpiredInput,
  type SweepExpiredResult,
} from '../../core/agent/arbiter/speaking-arbiter-store-port.js';
import { isBoundedString, isRfc4122Uuid } from '../../shared/utils/types.js';
import { createPostgresPool, withPostgresClient } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { ensureSharedSchema } from './shared-schema.js';

/**
 * Advisory-lock seed serializing per-channel arbiter mutations across processes.
 * Distinct from the social-pot (2) and ICP-fatigue-lease (1) seeds so the three
 * lock spaces never contend on one another. Every mutating operation takes the
 * per-channel lock FIRST, before any row lock, so all arbiter row locks are
 * acquired in one consistent order and cannot deadlock across operations.
 */
const SPEAKING_ARBITER_CHANNEL_LOCK_SEED = 3;

const EPISODE_COLUMNS = `
  episode_id, channel_id, status, pressure, consecutive_autonomous_turns,
  last_speaker_companion_id, opened_at_ms, last_activity_at_ms, closed_at_ms,
  revision
`;

const RESERVATION_COLUMNS = `
  reservation_id, channel_id, trigger_event_id, companion_id, episode_id,
  status, reason, reserved_at_ms, expires_at_ms, finalized_at_ms, revision
`;

const LEASE_COLUMNS = `
  lease_id, reservation_id, channel_id, trigger_event_id, companion_id,
  episode_id, fencing_token, status, reason, acquired_at_ms, expires_at_ms,
  finalized_at_ms, revision
`;

interface EpisodeRow extends QueryResultRow {
  episode_id: string;
  channel_id: string;
  status: string;
  pressure: string | number;
  consecutive_autonomous_turns: string | number;
  last_speaker_companion_id: string | null;
  opened_at_ms: string | number;
  last_activity_at_ms: string | number;
  closed_at_ms: string | number | null;
  revision: string | number;
}

interface ParticipantRow extends QueryResultRow {
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
  status: string;
  reason: string | null;
  acquired_at_ms: string | number;
  expires_at_ms: string | number;
  finalized_at_ms: string | number | null;
  revision: string | number;
}

function requireCompanionId(value: string, field: string): string {
  if (!isRfc4122Uuid(value)) {
    throw new Error(`${field} must be an RFC 4122 UUID`);
  }
  return value;
}

function requireUuid(value: string, field: string): string {
  if (!isRfc4122Uuid(value)) {
    throw new Error(`${field} must be an RFC 4122 UUID`);
  }
  return value;
}

function requireIdentifier(value: string, field: string): string {
  // Channel and trigger-event ids are opaque external identifiers; bound them so
  // a malformed value fails closed rather than reaching a query as unbounded text.
  if (!isBoundedString(value, 512)) {
    throw new Error(`${field} must be a non-empty string of at most 512 characters`);
  }
  return value;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requireFutureDeadline(expiresAtMs: number, nowMs: number, field: string): number {
  const value = requireTimestamp(expiresAtMs, field);
  if (value <= nowMs) {
    throw new Error(`${field} must be strictly greater than nowMs`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`);
  }
  return value;
}

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} must be a safe integer`);
  }
  return parsed;
}

function nullableSafeInteger(value: string | number | null, field: string): number | null {
  return value === null ? null : safeInteger(value, field);
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a finite number`);
  }
  return parsed;
}

function assertReservationStatus(value: string): SpeakingReservationStatus {
  if (value === 'reserved' || value === 'released' || value === 'expired') {
    return value;
  }
  throw new Error(`unexpected speaking reservation status "${value}"`);
}

function assertLeaseStatus(value: string): SpeakingEgressLeaseStatus {
  switch (value) {
    case 'held':
    case 'released':
    case 'expired':
    case 'delivered':
    case 'failed':
    case 'overridden':
      return value;
    default:
      throw new Error(`unexpected speaking egress lease status "${value}"`);
  }
}

function assertReason(value: string | null): SpeakingArbiterReason | null {
  if (value === null) return null;
  switch (value) {
    case 'silence':
    case 'ignore':
    case 'model_failure':
    case 'delivered':
    case 'delivery_failure':
    case 'expiry':
    case 'superseded':
    case 'urgent_override':
      return value;
    default:
      throw new Error(`unexpected speaking arbiter reason "${value}"`);
  }
}

/**
 * Durable, gateway-owned Postgres authority for the speaking arbiter (design
 * bible §8.5, §12.2; adjudication §3 R2). Lives in the shared schema — never a
 * companion-local store — so a companion never arbitrates a peer's turn, and a
 * gateway reboot loses nothing (pressure, turns, leases survive).
 *
 * Every mutation takes a transaction-scoped advisory lock keyed on the channel
 * and then `SELECT ... FOR UPDATE` on the rows it touches, so all arbiter writes
 * for one channel serialize across processes. "Two companions never both send for
 * one trigger" is enforced on two axes under that lock: the partial unique index
 * on a held lease gives instantaneous exclusivity, and an acquire-time
 * send-once check declines any acquisition whose event already has a
 * speech-terminal (`delivered`/`overridden`) lease — so the guarantee survives
 * the winner completing and releasing its held lease. Reclaim-then-grant still
 * re-grants an event whose holder crashed *without* delivering (its lease only
 * `expired`), and a monotonically increasing per-event fencing token means a
 * revived crashed holder cannot double-send.
 */
export class PostgresSpeakingArbiterStore implements SpeakingArbiterStorePort {
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresSpeakingArbiterStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-speaking-arbiter',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      await ensureSharedSchema(pool);
      return new PostgresSpeakingArbiterStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async ensureRoomEpisode(input: EnsureRoomEpisodeInput): Promise<RoomEpisodeSnapshot> {
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const episode = await this.ensureOpenEpisode(client, channelId, nowMs);
      return await this.loadEpisodeSnapshot(client, episode.episode_id);
    });
  }

  async readRoomEpisode(input: ReadRoomEpisodeInput): Promise<RoomEpisodeSnapshot | null> {
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      const row = await this.loadOpenEpisodeRow(client, channelId, false);
      if (!row) return null;
      return await this.loadEpisodeSnapshot(client, row.episode_id);
    });
  }

  async closeRoomEpisode(input: CloseRoomEpisodeInput): Promise<RoomEpisodeSnapshot | null> {
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const row = await this.loadOpenEpisodeRow(client, channelId, true);
      if (!row) return null;
      const closedAt = Math.max(nowMs, safeInteger(row.opened_at_ms, 'episode.openedAtMs'));
      await client.query(
        `UPDATE speaking_room_episodes
         SET status = 'closed', closed_at_ms = $2, last_activity_at_ms = GREATEST(last_activity_at_ms, $2),
             revision = revision + 1
         WHERE episode_id = $1`,
        [row.episode_id, closedAt],
      );
      return await this.loadEpisodeSnapshot(client, row.episode_id);
    });
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const reservationId = requireUuid(input.reservationId, 'speakingArbiter.reservationId');
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const triggerEventId = requireIdentifier(input.triggerEventId, 'speakingArbiter.triggerEventId');
    const companionId = requireCompanionId(input.companionId, 'speakingArbiter.companionId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    const expiresAtMs = requireFutureDeadline(input.expiresAtMs, nowMs, 'speakingArbiter.reservation.expiresAtMs');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const episode = await this.ensureOpenEpisode(client, channelId, nowMs);
      // The trigger is real room activity: keep the episode fresh.
      if (nowMs > safeInteger(episode.last_activity_at_ms, 'episode.lastActivityAtMs')) {
        await client.query(
          `UPDATE speaking_room_episodes
           SET last_activity_at_ms = $2, revision = revision + 1
           WHERE episode_id = $1`,
          [episode.episode_id, nowMs],
        );
      }
      await this.ensureParticipant(client, episode.episode_id, companionId);
      const inserted = await client.query<ReservationRow>(
        `INSERT INTO speaking_reservations (
           reservation_id, channel_id, trigger_event_id, companion_id, episode_id,
           status, reason, reserved_at_ms, expires_at_ms, finalized_at_ms, revision
         )
         VALUES ($1, $2, $3, $4, $5, 'reserved', NULL, $6, $7, NULL, 1)
         ON CONFLICT (channel_id, trigger_event_id, companion_id) DO NOTHING
         RETURNING ${RESERVATION_COLUMNS}`,
        [reservationId, channelId, triggerEventId, companionId, episode.episode_id, nowMs, expiresAtMs],
      );
      const insertedRow = inserted.rows.at(0);
      if (insertedRow) {
        const reservation = this.toReservationSnapshot(insertedRow);
        const episodeSnapshot = await this.loadEpisodeSnapshot(client, reservation.episodeId);
        return { outcome: 'reserved' as const, reservation, episode: episodeSnapshot };
      }
      // A reservation already exists for this (channel, event, companion): replay
      // the durable one (keeping its original reservation id and episode binding).
      const existing = await client.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS}
         FROM speaking_reservations
         WHERE channel_id = $1 AND trigger_event_id = $2 AND companion_id = $3
         FOR UPDATE`,
        [channelId, triggerEventId, companionId],
      );
      const existingRow = existing.rows.at(0);
      if (!existingRow) {
        throw new Error('speaking reservation missing after insert conflict');
      }
      const reservation = this.toReservationSnapshot(existingRow);
      const episodeSnapshot = await this.loadEpisodeSnapshot(client, reservation.episodeId);
      return { outcome: 'replayed' as const, reservation, episode: episodeSnapshot };
    });
  }

  async releaseReservation(input: ReleaseReservationInput): Promise<SpeakingReservationSnapshot> {
    const reservationId = requireUuid(input.reservationId, 'speakingArbiter.reservationId');
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    const reason = assertReason(input.reason);
    if (reason === null) {
      throw new Error('speakingArbiter.releaseReservation requires a reason');
    }
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const current = await client.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS}
         FROM speaking_reservations
         WHERE reservation_id = $1
         FOR UPDATE`,
        [reservationId],
      );
      const row = current.rows.at(0);
      if (!row) {
        throw new Error(`speaking reservation ${reservationId} not found`);
      }
      if (row.channel_id !== channelId) {
        throw new Error(`speaking reservation ${reservationId} channel mismatch`);
      }
      if (row.status !== 'reserved') {
        // Idempotent replay only when the recorded terminal reason matches.
        if (assertReason(row.reason) === reason) {
          return this.toReservationSnapshot(row);
        }
        throw new Error(
          `speaking reservation ${reservationId} already terminal (${row.status}/${row.reason ?? 'null'})`,
        );
      }
      const updated = await client.query<ReservationRow>(
        `UPDATE speaking_reservations
         SET status = 'released', reason = $2, finalized_at_ms = $3, revision = revision + 1
         WHERE reservation_id = $1 AND status = 'reserved'
         RETURNING ${RESERVATION_COLUMNS}`,
        [reservationId, reason, nowMs],
      );
      const updatedRow = updated.rows.at(0);
      if (!updatedRow) {
        throw new Error(`speaking reservation ${reservationId} release conflict`);
      }
      return this.toReservationSnapshot(updatedRow);
    });
  }

  async acquireEgressLease(input: AcquireEgressLeaseInput): Promise<AcquireEgressLeaseResult> {
    const leaseId = requireUuid(input.leaseId, 'speakingArbiter.leaseId');
    const reservationId = requireUuid(input.reservationId, 'speakingArbiter.reservationId');
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    const expiresAtMs = requireFutureDeadline(input.expiresAtMs, nowMs, 'speakingArbiter.lease.expiresAtMs');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);

      // Idempotent replay: a lease already granted under this id is returned as-is.
      const replay = await client.query<LeaseRow>(
        `SELECT ${LEASE_COLUMNS} FROM speaking_egress_leases WHERE lease_id = $1 FOR UPDATE`,
        [leaseId],
      );
      const replayRow = replay.rows.at(0);
      if (replayRow) {
        if (replayRow.reservation_id !== reservationId || replayRow.channel_id !== channelId) {
          throw new Error(`speaking egress lease ${leaseId} replay binding mismatch`);
        }
        return { outcome: 'acquired' as const, lease: this.toLeaseSnapshot(replayRow), heldBy: null };
      }

      const reservation = await client.query<ReservationRow>(
        `SELECT ${RESERVATION_COLUMNS} FROM speaking_reservations WHERE reservation_id = $1 FOR UPDATE`,
        [reservationId],
      );
      const reservationRow = reservation.rows.at(0);
      if (!reservationRow) {
        throw new Error(`speaking reservation ${reservationId} not found`);
      }
      if (reservationRow.channel_id !== channelId) {
        throw new Error(`speaking reservation ${reservationId} channel mismatch`);
      }
      const triggerEventId = reservationRow.trigger_event_id;

      // Send-once fencing (evaluated before the per-reservation reservability
      // guards, because it is a property of the *event*, not this reservation):
      // if any lease for this event already reached a speech-terminal completion
      // (`delivered`/`overridden`), the event is spent. A crashed-then-reclaimed
      // holder that never delivered leaves only `expired` leases and does NOT
      // block here, so a genuine re-acquire still works. This is the durable
      // guarantee behind "two companions never both send for one trigger" — the
      // instantaneous HELD probe below is not enough once the winner has
      // completed and its held lease is gone. Checking it first also means a
      // co-reserver whose reservation was retired as `superseded` when the winner
      // delivered declines cleanly here rather than tripping the guard below.
      const spent = await client.query<LeaseRow>(
        `SELECT ${LEASE_COLUMNS}
         FROM speaking_egress_leases
         WHERE channel_id = $1 AND trigger_event_id = $2
           AND status IN ('delivered', 'overridden')
         ORDER BY fencing_token DESC
         LIMIT 1
         FOR UPDATE`,
        [channelId, triggerEventId],
      );
      const spentRow = spent.rows.at(0);
      if (spentRow) {
        return {
          outcome: 'declined' as const,
          lease: null,
          heldBy: {
            companionId: spentRow.companion_id,
            leaseId: spentRow.lease_id,
            fencingToken: safeInteger(spentRow.fencing_token, 'lease.fencingToken'),
          },
          declineReason: 'already_delivered' as const,
        };
      }

      if (reservationRow.status !== 'reserved') {
        throw new Error(`speaking reservation ${reservationId} is not reservable (${reservationRow.status})`);
      }
      if (safeInteger(reservationRow.expires_at_ms, 'reservation.expiresAtMs') <= nowMs) {
        throw new Error(`speaking reservation ${reservationId} has expired`);
      }

      // At most one HELD lease per triggering event. A live holder wins; the
      // caller declines with NO retry (silence is not retried into speech).
      const held = await client.query<LeaseRow>(
        `SELECT ${LEASE_COLUMNS}
         FROM speaking_egress_leases
         WHERE channel_id = $1 AND trigger_event_id = $2 AND status = 'held'
         FOR UPDATE`,
        [channelId, triggerEventId],
      );
      const heldRow = held.rows.at(0);
      if (heldRow) {
        const heldStatus = assertLeaseStatus(heldRow.status);
        const heldExpiry = safeInteger(heldRow.expires_at_ms, 'lease.expiresAtMs');
        if (isEgressLeaseLive({ status: heldStatus, expiresAtMs: heldExpiry }, nowMs)) {
          return {
            outcome: 'declined' as const,
            lease: null,
            heldBy: {
              companionId: heldRow.companion_id,
              leaseId: heldRow.lease_id,
              fencingToken: safeInteger(heldRow.fencing_token, 'lease.fencingToken'),
            },
            declineReason: 'held' as const,
          };
        }
        // The holder's deadline lapsed: reclaim it (crash-recovery) and grant afresh.
        await client.query(
          `UPDATE speaking_egress_leases
           SET status = 'expired', reason = 'expiry', finalized_at_ms = $2, revision = revision + 1
           WHERE lease_id = $1 AND status = 'held'`,
          [heldRow.lease_id, nowMs],
        );
      }

      const tokenResult = await client.query<{ next: string | number }>(
        `SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next
         FROM speaking_egress_leases
         WHERE channel_id = $1 AND trigger_event_id = $2`,
        [channelId, triggerEventId],
      );
      const fencingToken = safeInteger(tokenResult.rows.at(0)?.next ?? 1, 'lease.fencingToken');

      const granted = await client.query<LeaseRow>(
        `INSERT INTO speaking_egress_leases (
           lease_id, reservation_id, channel_id, trigger_event_id, companion_id,
           episode_id, fencing_token, status, reason, acquired_at_ms, expires_at_ms,
           finalized_at_ms, revision
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held', NULL, $8, $9, NULL, 1)
         RETURNING ${LEASE_COLUMNS}`,
        [
          leaseId,
          reservationId,
          channelId,
          triggerEventId,
          reservationRow.companion_id,
          reservationRow.episode_id,
          fencingToken,
          nowMs,
          expiresAtMs,
        ],
      );
      const grantedRow = granted.rows.at(0);
      if (!grantedRow) {
        throw new Error(`speaking egress lease ${leaseId} grant failed`);
      }
      return { outcome: 'acquired' as const, lease: this.toLeaseSnapshot(grantedRow), heldBy: null };
    });
  }

  async completeEgressLease(input: CompleteEgressLeaseInput): Promise<SpeakingEgressLeaseSnapshot> {
    const leaseId = requireUuid(input.leaseId, 'speakingArbiter.leaseId');
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const fencingToken = safeInteger(input.fencingToken, 'speakingArbiter.fencingToken');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    if (!SPEAKING_EGRESS_LEASE_COMPLETIONS.includes(input.completion)) {
      throw new Error(`unexpected speaking egress lease completion "${input.completion}"`);
    }
    const completion = input.completion;
    const pressureDelta = input.pressureDelta === undefined
      ? 0
      : requireNonNegativeFinite(input.pressureDelta, 'speakingArbiter.pressureDelta');
    const reason = speakingCompletionReason(completion);
    const isSpeech = speakingCompletionIsSpeech(completion);
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const current = await client.query<LeaseRow>(
        `SELECT ${LEASE_COLUMNS} FROM speaking_egress_leases WHERE lease_id = $1 FOR UPDATE`,
        [leaseId],
      );
      const row = current.rows.at(0);
      if (!row) {
        throw new Error(`speaking egress lease ${leaseId} not found`);
      }
      if (row.channel_id !== channelId) {
        throw new Error(`speaking egress lease ${leaseId} channel mismatch`);
      }
      // The fencing token is the double-speak guard: a stale token (the lease was
      // reclaimed and re-granted after a crash) is rejected fail-closed.
      if (safeInteger(row.fencing_token, 'lease.fencingToken') !== fencingToken) {
        throw new Error(`speaking egress lease ${leaseId} stale fencing token`);
      }
      if (row.status !== 'held') {
        // Idempotent replay only when the recorded terminal reason matches.
        if (assertReason(row.reason) === reason) {
          return this.toLeaseSnapshot(row);
        }
        throw new Error(
          `speaking egress lease ${leaseId} already terminal (${row.status}/${row.reason ?? 'null'})`,
        );
      }
      const updated = await client.query<LeaseRow>(
        `UPDATE speaking_egress_leases
         SET status = $2, reason = $3, finalized_at_ms = $4, revision = revision + 1
         WHERE lease_id = $1 AND status = 'held' AND fencing_token = $5
         RETURNING ${LEASE_COLUMNS}`,
        [leaseId, completion, reason, nowMs, fencingToken],
      );
      const updatedRow = updated.rows.at(0);
      if (!updatedRow) {
        throw new Error(`speaking egress lease ${leaseId} completion conflict`);
      }
      // Resolve the promoted reservation with the same terminal reason.
      await client.query(
        `UPDATE speaking_reservations
         SET status = 'released', reason = $2, finalized_at_ms = $3, revision = revision + 1
         WHERE reservation_id = $1 AND status = 'reserved'`,
        [updatedRow.reservation_id, reason, nowMs],
      );
      if (isSpeech) {
        // The event has now been spoken: no co-reserver may still promote to a
        // second send for the same trigger. Retire their open reservations as
        // `superseded` — belt-and-suspenders with the acquire-time
        // `already_delivered` decline, so no stale `reserved` row lingers to
        // invite a redundant acquisition attempt. A non-speech completion
        // (`failed`/`released`) never spoke, so co-reservers stay reservable.
        await client.query(
          `UPDATE speaking_reservations
           SET status = 'released', reason = 'superseded', finalized_at_ms = $3, revision = revision + 1
           WHERE channel_id = $1 AND trigger_event_id = $2 AND status = 'reserved'
             AND reservation_id <> $4`,
          [updatedRow.channel_id, updatedRow.trigger_event_id, nowMs, updatedRow.reservation_id],
        );
        // A speech completion is machine participation: charge episode pressure,
        // advance the autonomous-turn streak, and update speak-least fairness.
        await client.query(
          `UPDATE speaking_room_episodes
           SET pressure = pressure + $2,
               consecutive_autonomous_turns = consecutive_autonomous_turns + 1,
               last_speaker_companion_id = $3,
               last_activity_at_ms = GREATEST(last_activity_at_ms, $4),
               revision = revision + 1
           WHERE episode_id = $1`,
          [updatedRow.episode_id, pressureDelta, updatedRow.companion_id, nowMs],
        );
        await client.query(
          `INSERT INTO speaking_episode_participation (episode_id, companion_id, speak_count, last_spoke_at_ms)
           VALUES ($1, $2, 1, $3)
           ON CONFLICT (episode_id, companion_id) DO UPDATE
           SET speak_count = speaking_episode_participation.speak_count + 1,
               last_spoke_at_ms = $3`,
          [updatedRow.episode_id, updatedRow.companion_id, nowMs],
        );
      }
      return this.toLeaseSnapshot(updatedRow);
    });
  }

  async recordHumanActivity(input: RecordHumanActivityInput): Promise<RoomEpisodeSnapshot> {
    const channelId = requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      await this.lockChannel(client, channelId);
      const episode = await this.ensureOpenEpisode(client, channelId, nowMs);
      await client.query(
        `UPDATE speaking_room_episodes
         SET consecutive_autonomous_turns = 0,
             last_activity_at_ms = GREATEST(last_activity_at_ms, $2),
             revision = revision + 1
         WHERE episode_id = $1`,
        [episode.episode_id, nowMs],
      );
      return await this.loadEpisodeSnapshot(client, episode.episode_id);
    });
  }

  async sweepExpired(input: SweepExpiredInput): Promise<SweepExpiredResult> {
    const nowMs = requireTimestamp(input.nowMs, 'speakingArbiter.nowMs');
    const channelId = input.channelId === undefined
      ? null
      : requireIdentifier(input.channelId, 'speakingArbiter.channelId');
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      // Leases first: a reclaimed held lease may unblock reservation sweeping.
      const leases = await client.query(
        `UPDATE speaking_egress_leases
         SET status = 'expired', reason = 'expiry', finalized_at_ms = $1, revision = revision + 1
         WHERE status = 'held' AND expires_at_ms <= $1
           AND ($2::text IS NULL OR channel_id = $2)`,
        [nowMs, channelId],
      );
      // Only reservations with no HELD lease may expire: a promoted reservation
      // whose lease is mid-delivery must not be swept out from under it.
      const reservations = await client.query(
        `UPDATE speaking_reservations AS reservation
         SET status = 'expired', reason = 'expiry', finalized_at_ms = $1, revision = revision + 1
         WHERE reservation.status = 'reserved' AND reservation.expires_at_ms <= $1
           AND ($2::text IS NULL OR reservation.channel_id = $2)
           AND NOT EXISTS (
             SELECT 1 FROM speaking_egress_leases AS lease
             WHERE lease.reservation_id = reservation.reservation_id AND lease.status = 'held'
           )`,
        [nowMs, channelId],
      );
      return {
        expiredReservations: reservations.rowCount ?? 0,
        expiredLeases: leases.rowCount ?? 0,
      };
    });
  }

  private async lockChannel(client: Pick<Pool, 'query'>, channelId: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text, ${SPEAKING_ARBITER_CHANNEL_LOCK_SEED}))`,
      [channelId],
    );
  }

  private async loadOpenEpisodeRow(
    client: Pick<Pool, 'query'>,
    channelId: string,
    forUpdate: boolean,
  ): Promise<EpisodeRow | undefined> {
    const result = await client.query<EpisodeRow>(
      `SELECT ${EPISODE_COLUMNS}
       FROM speaking_room_episodes
       WHERE channel_id = $1 AND status = 'open'
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [channelId],
    );
    return result.rows.at(0);
  }

  private async ensureOpenEpisode(
    client: Pick<Pool, 'query'>,
    channelId: string,
    nowMs: number,
  ): Promise<EpisodeRow> {
    const existing = await this.loadOpenEpisodeRow(client, channelId, true);
    if (existing) return existing;
    // Under the per-channel advisory lock this insert cannot race a sibling open,
    // and the partial unique index is the belt-and-suspenders backstop.
    const inserted = await client.query<EpisodeRow>(
      `INSERT INTO speaking_room_episodes (
         episode_id, channel_id, status, pressure, consecutive_autonomous_turns,
         last_speaker_companion_id, opened_at_ms, last_activity_at_ms, closed_at_ms, revision
       )
       VALUES ($1, $2, 'open', 0, 0, NULL, $3, $3, NULL, 1)
       RETURNING ${EPISODE_COLUMNS}`,
      [randomUUID(), channelId, nowMs],
    );
    const row = inserted.rows.at(0);
    if (!row) {
      throw new Error('speaking room episode insert returned no row');
    }
    return row;
  }

  private async ensureParticipant(
    client: Pick<Pool, 'query'>,
    episodeId: string,
    companionId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO speaking_episode_participation (episode_id, companion_id, speak_count, last_spoke_at_ms)
       VALUES ($1, $2, 0, NULL)
       ON CONFLICT (episode_id, companion_id) DO NOTHING`,
      [episodeId, companionId],
    );
  }

  private async loadEpisodeSnapshot(
    client: Pick<Pool, 'query'>,
    episodeId: string,
  ): Promise<RoomEpisodeSnapshot> {
    const episode = await client.query<EpisodeRow>(
      `SELECT ${EPISODE_COLUMNS} FROM speaking_room_episodes WHERE episode_id = $1`,
      [episodeId],
    );
    const row = episode.rows.at(0);
    if (!row) {
      throw new Error(`speaking room episode ${episodeId} not found`);
    }
    // Deterministic speak-least ordering: never-spoken first, then least recent,
    // with a stable companion-id tie-break (bible §8.5 priority #4, §20.1).
    const participants = await client.query<ParticipantRow>(
      `SELECT companion_id, speak_count, last_spoke_at_ms
       FROM speaking_episode_participation
       WHERE episode_id = $1
       ORDER BY last_spoke_at_ms ASC NULLS FIRST, companion_id ASC`,
      [episodeId],
    );
    return this.toEpisodeSnapshot(row, participants.rows);
  }

  private toEpisodeSnapshot(row: EpisodeRow, participantRows: readonly ParticipantRow[]): RoomEpisodeSnapshot {
    const participants: RoomEpisodeParticipant[] = participantRows.map((participant) => ({
      companionId: participant.companion_id,
      speakCount: safeInteger(participant.speak_count, 'episodeParticipant.speakCount'),
      lastSpokeAtMs: nullableSafeInteger(participant.last_spoke_at_ms, 'episodeParticipant.lastSpokeAtMs'),
    }));
    const status = row.status === 'open' || row.status === 'closed' ? row.status : undefined;
    if (!status) {
      throw new Error(`unexpected speaking room episode status "${row.status}"`);
    }
    return {
      episodeId: row.episode_id,
      channelId: row.channel_id,
      status,
      pressure: finiteNumber(row.pressure, 'episode.pressure'),
      openedAtMs: safeInteger(row.opened_at_ms, 'episode.openedAtMs'),
      lastActivityAtMs: safeInteger(row.last_activity_at_ms, 'episode.lastActivityAtMs'),
      consecutiveAutonomousTurns: safeInteger(
        row.consecutive_autonomous_turns,
        'episode.consecutiveAutonomousTurns',
      ),
      lastSpeakerCompanionId: row.last_speaker_companion_id,
      revision: safeInteger(row.revision, 'episode.revision'),
      participants,
    };
  }

  private toReservationSnapshot(row: ReservationRow): SpeakingReservationSnapshot {
    return {
      reservationId: row.reservation_id,
      channelId: row.channel_id,
      triggerEventId: row.trigger_event_id,
      companionId: row.companion_id,
      episodeId: row.episode_id,
      reservedAtMs: safeInteger(row.reserved_at_ms, 'reservation.reservedAtMs'),
      expiresAtMs: safeInteger(row.expires_at_ms, 'reservation.expiresAtMs'),
      status: assertReservationStatus(row.status),
      reason: assertReason(row.reason),
      finalizedAtMs: nullableSafeInteger(row.finalized_at_ms, 'reservation.finalizedAtMs'),
      revision: safeInteger(row.revision, 'reservation.revision'),
    };
  }

  private toLeaseSnapshot(row: LeaseRow): SpeakingEgressLeaseSnapshot {
    return {
      leaseId: row.lease_id,
      reservationId: row.reservation_id,
      channelId: row.channel_id,
      triggerEventId: row.trigger_event_id,
      companionId: row.companion_id,
      episodeId: row.episode_id,
      fencingToken: safeInteger(row.fencing_token, 'lease.fencingToken'),
      status: assertLeaseStatus(row.status),
      reason: assertReason(row.reason),
      acquiredAtMs: safeInteger(row.acquired_at_ms, 'lease.acquiredAtMs'),
      expiresAtMs: safeInteger(row.expires_at_ms, 'lease.expiresAtMs'),
      finalizedAtMs: nullableSafeInteger(row.finalized_at_ms, 'lease.finalizedAtMs'),
      revision: safeInteger(row.revision, 'lease.revision'),
    };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('speaking arbiter store is closed');
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.pool.end();
    return await this.closePromise;
  }
}
