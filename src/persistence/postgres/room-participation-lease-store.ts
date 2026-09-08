import type { Pool, QueryResultRow } from 'pg';

import type {
  ClaimRoomParticipationContinuationInput,
  CloseRoomParticipationLeaseInput,
  OpenRoomParticipationLeaseInput,
  RecordRoomParticipationAppraisalInput,
  RefreshRoomParticipationLeaseInput,
  RoomParticipationDisposition,
  RoomParticipationLeaseCloseReason,
  RoomParticipationLeaseSnapshot,
  RoomParticipationLeaseStatus,
  RoomParticipationLeaseStorePort,
} from '../../core/participation/room-participation-lease.js';
import { isBoundedString, isRfc4122Uuid } from '../../shared/utils/types.js';
import { createPostgresPool } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { requireSafeInteger as safeInteger } from './row-guards.js';
import { assertSharedSchemaReady } from './shared-schema.js';

/**
 * Durable, gateway-owned Postgres authority for the bounded room-participation
 * lease (jp36.5.5). It lives in the shared schema beside the speaking-arbiter
 * store — the same reboot-survival contract — and holds one row per
 * (companion, room).
 *
 * Every mutation is a SINGLE conditional statement, so no advisory lock is
 * needed and two processes observing the same room cannot both claim one
 * message: `claimContinuation` advances the context watermark, charges the
 * bounded budget, and rolls the machine streak in one `UPDATE ... WHERE`
 * whose predicate re-states every deterministic bound the caller's pure gate
 * evaluated on its read snapshot. The loser gets zero rows and suppresses.
 *
 * Content-free: identifiers, counters, timestamps, and bounded reason codes.
 * Room text never reaches this table.
 */

const LEASE_COLUMNS = `
  companion_id, channel_id, status, opened_disposition, opened_at_ms,
  last_activity_at_ms, expires_at_ms, watermark_message_id,
  watermark_timestamp_ms, considered_count, ignore_streak, machine_streak,
  closed_at_ms, close_reason, revision
`;

interface LeaseRow extends QueryResultRow {
  companion_id: string;
  channel_id: string;
  status: string;
  opened_disposition: string;
  opened_at_ms: string | number;
  last_activity_at_ms: string | number;
  expires_at_ms: string | number;
  watermark_message_id: string;
  watermark_timestamp_ms: string | number;
  considered_count: string | number;
  ignore_streak: string | number;
  machine_streak: string | number;
  closed_at_ms: string | number | null;
  close_reason: string | null;
  revision: string | number;
}

function requireCompanionId(value: string): string {
  if (!isRfc4122Uuid(value)) {
    throw new Error('roomParticipationLease.companionId must be an RFC 4122 UUID');
  }
  return value;
}

function requireIdentifier(value: string, field: string): string {
  // Channel and message ids are opaque external identifiers; bound them so a
  // malformed value fails closed instead of reaching a query as unbounded text.
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

function requireNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertStatus(value: string): RoomParticipationLeaseStatus {
  if (value === 'active' || value === 'closed') return value;
  throw new Error(`unexpected room participation lease status "${value}"`);
}

function assertDisposition(value: string): RoomParticipationDisposition {
  switch (value) {
    case 'direct_summons':
    case 'passive_summons':
    case 'reaction':
    case 'reply':
    case 'endogenous_room_entry':
      return value;
    default:
      throw new Error(`unexpected room participation disposition "${value}"`);
  }
}

function assertCloseReason(value: string | null): RoomParticipationLeaseCloseReason | null {
  if (value === null) return null;
  switch (value) {
    case 'expiry':
    case 'silence':
    case 'message_cap':
    case 'machine_streak':
    case 'withdrawn':
    case 'fatigue':
    case 'room_pressure':
    case 'policy_off':
      return value;
    default:
      throw new Error(`unexpected room participation lease close reason "${value}"`);
  }
}

function toSnapshot(row: LeaseRow): RoomParticipationLeaseSnapshot {
  return {
    companionId: row.companion_id,
    channelId: row.channel_id,
    status: assertStatus(row.status),
    openedDisposition: assertDisposition(row.opened_disposition),
    openedAtMs: safeInteger(row.opened_at_ms, 'roomParticipationLease.openedAtMs'),
    lastActivityAtMs: safeInteger(
      row.last_activity_at_ms,
      'roomParticipationLease.lastActivityAtMs',
    ),
    expiresAtMs: safeInteger(row.expires_at_ms, 'roomParticipationLease.expiresAtMs'),
    watermarkMessageId: row.watermark_message_id,
    watermarkTimestampMs: safeInteger(
      row.watermark_timestamp_ms,
      'roomParticipationLease.watermarkTimestampMs',
    ),
    consideredCount: safeInteger(
      row.considered_count,
      'roomParticipationLease.consideredCount',
    ),
    ignoreStreak: safeInteger(row.ignore_streak, 'roomParticipationLease.ignoreStreak'),
    machineStreak: safeInteger(row.machine_streak, 'roomParticipationLease.machineStreak'),
    closedAtMs: row.closed_at_ms === null
      ? null
      : safeInteger(row.closed_at_ms, 'roomParticipationLease.closedAtMs'),
    closeReason: assertCloseReason(row.close_reason),
    revision: safeInteger(row.revision, 'roomParticipationLease.revision'),
  };
}

export class PostgresRoomParticipationLeaseStore implements RoomParticipationLeaseStorePort {
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly pool: Pool) {}

  /**
   * Connect a shared-schema-pinned runtime pool. The gateway's migration
   * authority provisions the shared schema before agents start; this store
   * proves readiness read-only and never runs DDL.
   */
  static async connect(databaseUrl: string): Promise<PostgresRoomParticipationLeaseStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-room-participation-lease',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      await assertSharedSchemaReady(pool);
      return new PostgresRoomParticipationLeaseStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async read(input: {
    companionId: string;
    channelId: string;
  }): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM room_participation_leases
       WHERE companion_id = $1 AND channel_id = $2`,
      [companionId, channelId],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  /**
   * Open (or re-open) membership. The bounded budget resets — an explicit
   * disposition is a fresh engagement — and the watermark starts at the
   * disposition's own message, so a message that preceded the opening act can
   * never be replayed into a continuation candidate.
   *
   * The bot-loop fence survives the opening (§8.5): a machine-authored
   * disposition carries the machine streak forward instead of clearing it, and
   * it cannot re-open a lease the fence itself closed. Only a human turn does
   * that, so a peer bot cut off by `machine_streak` cannot mention its way back
   * into the room. Returns null when the fence refused the opening.
   */
  async open(
    input: OpenRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    const watermarkMessageId = requireIdentifier(
      input.watermarkMessageId,
      'roomParticipationLease.watermarkMessageId',
    );
    const disposition = assertDisposition(input.disposition);
    const nowMs = requireTimestamp(input.nowMs, 'roomParticipationLease.nowMs');
    const watermarkTimestampMs = requireTimestamp(
      input.watermarkTimestampMs,
      'roomParticipationLease.watermarkTimestampMs',
    );
    const expiresAtMs = requireTimestamp(
      input.expiresAtMs,
      'roomParticipationLease.expiresAtMs',
    );
    if (expiresAtMs <= nowMs) {
      throw new Error('roomParticipationLease.expiresAtMs must be strictly greater than nowMs');
    }
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `INSERT INTO room_participation_leases (
         companion_id, channel_id, status, opened_disposition, opened_at_ms,
         last_activity_at_ms, expires_at_ms, watermark_message_id,
         watermark_timestamp_ms, considered_count, ignore_streak, machine_streak,
         closed_at_ms, close_reason, revision
       ) VALUES ($1, $2, 'active', $3, $4, $4, $5, $6, $7, 0, 0, 0, NULL, NULL, 1)
       ON CONFLICT (companion_id, channel_id) DO UPDATE SET
         status = 'active',
         opened_disposition = EXCLUDED.opened_disposition,
         opened_at_ms = EXCLUDED.opened_at_ms,
         last_activity_at_ms = EXCLUDED.last_activity_at_ms,
         expires_at_ms = EXCLUDED.expires_at_ms,
         watermark_message_id = CASE
           WHEN (EXCLUDED.watermark_timestamp_ms, EXCLUDED.watermark_message_id)
                > (room_participation_leases.watermark_timestamp_ms,
                   room_participation_leases.watermark_message_id)
             THEN EXCLUDED.watermark_message_id
           ELSE room_participation_leases.watermark_message_id
         END,
         watermark_timestamp_ms = GREATEST(
           EXCLUDED.watermark_timestamp_ms,
           room_participation_leases.watermark_timestamp_ms
         ),
         considered_count = 0,
         ignore_streak = 0,
         machine_streak = CASE
           WHEN $8::boolean THEN room_participation_leases.machine_streak ELSE 0
         END,
         closed_at_ms = NULL,
         close_reason = NULL,
         revision = room_participation_leases.revision + 1
       WHERE NOT (
         $8::boolean
         AND room_participation_leases.status = 'closed'
         AND room_participation_leases.close_reason = 'machine_streak'
       )
       RETURNING ${LEASE_COLUMNS}`,
      [
        companionId,
        channelId,
        disposition,
        nowMs,
        expiresAtMs,
        watermarkMessageId,
        watermarkTimestampMs,
        input.authorIsMachine === true,
      ],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  /**
   * Extend a LIVE lease and, for a human-authored act, clear the ignore streak
   * (the room re-engaged). A machine-authored refresh keeps that streak: a
   * sibling bot re-engaging is exactly what the withdrawal and bot-loop fences
   * distrust, so only a human turn clears a streak. A lapsed or closed lease is
   * never revived here: it returns null so the caller falls through to `open`,
   * which resets the bounded budget honestly.
   */
  async refresh(
    input: RefreshRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    const watermarkMessageId = requireIdentifier(
      input.watermarkMessageId,
      'roomParticipationLease.watermarkMessageId',
    );
    const nowMs = requireTimestamp(input.nowMs, 'roomParticipationLease.nowMs');
    const watermarkTimestampMs = requireTimestamp(
      input.watermarkTimestampMs,
      'roomParticipationLease.watermarkTimestampMs',
    );
    const expiresAtMs = requireTimestamp(
      input.expiresAtMs,
      'roomParticipationLease.expiresAtMs',
    );
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `UPDATE room_participation_leases SET
         last_activity_at_ms = $3,
         expires_at_ms = GREATEST(expires_at_ms, $4::bigint),
         watermark_message_id = CASE
           WHEN ($6::bigint, $5::text) > (watermark_timestamp_ms, watermark_message_id)
             THEN $5 ELSE watermark_message_id
         END,
         watermark_timestamp_ms = GREATEST(watermark_timestamp_ms, $6::bigint),
         ignore_streak = CASE WHEN $7::boolean THEN ignore_streak ELSE 0 END,
         revision = revision + 1
       WHERE companion_id = $1 AND channel_id = $2
         AND status = 'active' AND expires_at_ms > $3
       RETURNING ${LEASE_COLUMNS}`,
      [
        companionId,
        channelId,
        nowMs,
        expiresAtMs,
        watermarkMessageId,
        watermarkTimestampMs,
        input.authorIsMachine === true,
      ],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  /**
   * The atomic consider-once claim. The predicate re-checks membership, the
   * deadline, the forward-only watermark, the message cap, and the bot-loop
   * fence, so a race, a redelivery, or a restart cannot double-consider one
   * physical room message.
   */
  async claimContinuation(
    input: ClaimRoomParticipationContinuationInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    const messageId = requireIdentifier(input.messageId, 'roomParticipationLease.messageId');
    const nowMs = requireTimestamp(input.nowMs, 'roomParticipationLease.nowMs');
    const timestampMs = requireTimestamp(
      input.timestampMs,
      'roomParticipationLease.timestampMs',
    );
    const maxContinuationCandidates = requireNonNegativeInteger(
      input.maxContinuationCandidates,
      'roomParticipationLease.maxContinuationCandidates',
    );
    const maxConsecutiveMachineContinuations = requireNonNegativeInteger(
      input.maxConsecutiveMachineContinuations,
      'roomParticipationLease.maxConsecutiveMachineContinuations',
    );
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `UPDATE room_participation_leases SET
         watermark_message_id = $4,
         watermark_timestamp_ms = $5,
         last_activity_at_ms = $3,
         considered_count = considered_count + 1,
         machine_streak = CASE WHEN $6::boolean THEN machine_streak + 1 ELSE 0 END,
         revision = revision + 1
       WHERE companion_id = $1 AND channel_id = $2
         AND status = 'active'
         AND expires_at_ms > $3
         AND ($5::bigint, $4::text) > (watermark_timestamp_ms, watermark_message_id)
         AND considered_count < $7::integer
         AND (NOT $6::boolean OR machine_streak < $8::integer)
       RETURNING ${LEASE_COLUMNS}`,
      [
        companionId,
        channelId,
        nowMs,
        messageId,
        timestampMs,
        input.authorIsMachine,
        maxContinuationCandidates,
        maxConsecutiveMachineContinuations,
      ],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  /**
   * Roll the ignore streak after the appraiser's ternary. Silence accumulates;
   * a reaction or a reply clears it.
   */
  async recordAppraisal(
    input: RecordRoomParticipationAppraisalInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'roomParticipationLease.nowMs');
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `UPDATE room_participation_leases SET
         ignore_streak = CASE WHEN $3::boolean THEN ignore_streak + 1 ELSE 0 END,
         last_activity_at_ms = GREATEST(last_activity_at_ms, $4::bigint),
         revision = revision + 1
       WHERE companion_id = $1 AND channel_id = $2 AND status = 'active'
       RETURNING ${LEASE_COLUMNS}`,
      [companionId, channelId, input.action === 'ignore', nowMs],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  /** Terminal: a closed lease is never resumed, only replaced by a new open. */
  async close(
    input: CloseRoomParticipationLeaseInput,
  ): Promise<RoomParticipationLeaseSnapshot | null> {
    const companionId = requireCompanionId(input.companionId);
    const channelId = requireIdentifier(input.channelId, 'roomParticipationLease.channelId');
    const nowMs = requireTimestamp(input.nowMs, 'roomParticipationLease.nowMs');
    const reason = assertCloseReason(input.reason);
    if (!reason) {
      throw new Error('roomParticipationLease.close requires a reason');
    }
    this.assertOpen();
    const result = await this.pool.query<LeaseRow>(
      `UPDATE room_participation_leases SET
         status = 'closed',
         closed_at_ms = $3,
         close_reason = $4,
         revision = revision + 1
       WHERE companion_id = $1 AND channel_id = $2 AND status = 'active'
       RETURNING ${LEASE_COLUMNS}`,
      [companionId, channelId, nowMs, reason],
    );
    const row = result.rows.at(0);
    return row ? toSnapshot(row) : null;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('room participation lease store is closed');
    }
  }

  async shutdown(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    this.closed = true;
    this.closePromise = this.pool.end();
    return await this.closePromise;
  }
}
