import type { Pool, QueryResultRow } from 'pg';

import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import {
  parseIcpAvailabilityLease,
  parseIcpConversationEpisode,
  parseIcpInitiationPermit,
  type IcpAvailabilityLease,
  type IcpConversationEpisode,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import type {
  AdminIcpCostView,
  AdminIcpFatigueView,
} from '../../operator/garden/services/types/icp-autonomy.js';
import { isRfc4122Uuid } from '../../shared/utils/types.js';
import { createPostgresPool, queryRows } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';

const MAX_ADMIN_ROWS = 100;

interface AvailabilityRow extends QueryResultRow {
  companion_id: string;
  state: string;
  issued_at_ms: string | number;
  expires_at_ms: string | number;
  source: string;
  revision: string | number;
}

interface EpisodeRow extends QueryResultRow {
  conversation_id: string;
  channel_id: string;
  participant_companion_ids: unknown;
  root_initiation_id: string;
  initiated_by_companion_id: string;
  initiation_source: string;
  provenance_ref: string;
  opened_at_ms: string | number;
  last_activity_at_ms: string | number;
  status: string;
  close_reason_code: string | null;
  revision: string | number;
}

interface PermitRow extends QueryResultRow {
  permit_id: string;
  candidate_id: string;
  conversation_id: string;
  sender_companion_id: string;
  recipient_companion_id: string;
  channel_id: string;
  provenance_ref: string;
  issued_at_ms: string | number;
  expires_at_ms: string | number;
  status: string;
  consumed_at_ms: string | number | null;
  revoked_at_ms: string | number | null;
  reason_code: string | null;
  revision: string | number;
}

interface FatigueRow extends QueryResultRow {
  conversation_id: string;
  root_initiation_id: string;
  local_companion_id: string;
  peer_companion_id: string;
  channel_id: string;
  charged_units: string | number;
  overcharge_units: string | number;
  turn_count: string | number;
  pending_count: string | number;
  delivered_count: string | number;
  failed_count: string | number;
  latest_reserved_at_ms: string | number;
}

interface CostRow extends QueryResultRow {
  conversation_id: string;
  root_initiation_id: string;
  recorded_at_ms: string | number;
  actual_cost_usd: string | number;
  pending_projected_cost_usd: string | number;
  projected_total_cost_usd: string | number;
  warning_threshold_usd: string | number;
  hard_limit_usd: string | number;
  unknown_cost_attempt_count: string | number;
  allowed: boolean;
  reason: string;
  participant_companion_ids: unknown;
}

export interface IcpAdminCostProjection extends AdminIcpCostView {
  /** Internal tenant-correlation field; stripped by the Garden service. */
  participantCompanionIds: string[];
}

export interface IcpAdminSharedProjection {
  availability: IcpAvailabilityLease[];
  episodes: IcpConversationEpisode[];
  permits: IcpInitiationPermit[];
  fatigue: AdminIcpFatigueView[];
  costs: IcpAdminCostProjection[];
}

export interface IcpAdminProjectionStore {
  readonly localCompanionId: string;
  readonly shared: IcpSharedAutonomyStorePort;
  readProjection(limit?: number): Promise<IcpAdminSharedProjection>;
  close(): Promise<void>;
}

function integer(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

function finiteNumber(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return parsed;
}

function participantCompanionIds(value: unknown): string[] {
  if (!Array.isArray(value)
    || value.length < 2
    || value.some(id => !isRfc4122Uuid(id))) {
    throw new Error('cost.participantCompanionIds must contain at least two companion UUIDs');
  }
  return value as string[];
}

function mapAvailability(row: AvailabilityRow): IcpAvailabilityLease {
  return parseIcpAvailabilityLease({
    companionId: row.companion_id,
    state: row.state,
    issuedAtMs: integer(row.issued_at_ms, 'availability.issuedAtMs'),
    expiresAtMs: integer(row.expires_at_ms, 'availability.expiresAtMs'),
    source: row.source,
    revision: integer(row.revision, 'availability.revision'),
  });
}

function mapEpisode(row: EpisodeRow): IcpConversationEpisode {
  return parseIcpConversationEpisode({
    conversationId: row.conversation_id,
    channelId: row.channel_id,
    participantCompanionIds: row.participant_companion_ids,
    rootInitiationId: row.root_initiation_id,
    initiatedByCompanionId: row.initiated_by_companion_id,
    initiationSource: row.initiation_source,
    provenanceRef: row.provenance_ref,
    openedAtMs: integer(row.opened_at_ms, 'episode.openedAtMs'),
    lastActivityAtMs: integer(row.last_activity_at_ms, 'episode.lastActivityAtMs'),
    status: row.status,
    ...(row.close_reason_code ? { closeReasonCode: row.close_reason_code } : {}),
    revision: integer(row.revision, 'episode.revision'),
  });
}

function mapPermit(row: PermitRow): IcpInitiationPermit {
  return parseIcpInitiationPermit({
    permitId: row.permit_id,
    candidateId: row.candidate_id,
    conversationId: row.conversation_id,
    senderCompanionId: row.sender_companion_id,
    recipientCompanionId: row.recipient_companion_id,
    channelId: row.channel_id,
    provenanceRef: row.provenance_ref,
    issuedAtMs: integer(row.issued_at_ms, 'permit.issuedAtMs'),
    expiresAtMs: integer(row.expires_at_ms, 'permit.expiresAtMs'),
    status: row.status,
    ...(row.consumed_at_ms !== null
      ? { consumedAtMs: integer(row.consumed_at_ms, 'permit.consumedAtMs') }
      : {}),
    ...(row.revoked_at_ms !== null
      ? { revokedAtMs: integer(row.revoked_at_ms, 'permit.revokedAtMs') }
      : {}),
    ...(row.reason_code ? { reasonCode: row.reason_code } : {}),
    revision: integer(row.revision, 'permit.revision'),
  });
}

function mapFatigue(row: FatigueRow): AdminIcpFatigueView {
  return {
    conversationId: row.conversation_id,
    rootInitiationId: row.root_initiation_id,
    localCompanionId: row.local_companion_id,
    peerCompanionId: row.peer_companion_id,
    channelId: row.channel_id,
    chargedUnits: integer(row.charged_units, 'fatigue.chargedUnits'),
    overchargeUnits: integer(row.overcharge_units, 'fatigue.overchargeUnits'),
    turnCount: integer(row.turn_count, 'fatigue.turnCount'),
    pendingCount: integer(row.pending_count, 'fatigue.pendingCount'),
    deliveredCount: integer(row.delivered_count, 'fatigue.deliveredCount'),
    failedCount: integer(row.failed_count, 'fatigue.failedCount'),
    latestReservedAtMs: integer(row.latest_reserved_at_ms, 'fatigue.latestReservedAtMs'),
  };
}

function mapCost(row: CostRow): IcpAdminCostProjection {
  return {
    conversationId: row.conversation_id,
    rootInitiationId: row.root_initiation_id,
    recordedAtMs: integer(row.recorded_at_ms, 'cost.recordedAtMs'),
    actualCostUsd: finiteNumber(row.actual_cost_usd, 'cost.actualCostUsd'),
    pendingProjectedCostUsd: finiteNumber(
      row.pending_projected_cost_usd,
      'cost.pendingProjectedCostUsd',
    ),
    projectedTotalCostUsd: finiteNumber(row.projected_total_cost_usd, 'cost.projectedTotalCostUsd'),
    warningThresholdUsd: finiteNumber(row.warning_threshold_usd, 'cost.warningThresholdUsd'),
    hardLimitUsd: finiteNumber(row.hard_limit_usd, 'cost.hardLimitUsd'),
    unknownCostAttemptCount: integer(
      row.unknown_cost_attempt_count,
      'cost.unknownCostAttemptCount',
    ),
    allowed: row.allowed,
    reason: row.reason,
    participantCompanionIds: participantCompanionIds(row.participant_companion_ids),
  };
}

export class PostgresIcpAdminProjectionStore implements IcpAdminProjectionStore {
  private constructor(
    private readonly sharedPool: Pool,
    private readonly costPool: Pool,
    readonly shared: IcpSharedAutonomyStorePort,
    readonly localCompanionId: string,
  ) {}

  static async connect(
    databaseUrl: string,
    options: {
      localCompanionId: string;
      knownCompanionIds: readonly string[];
    },
  ): Promise<PostgresIcpAdminProjectionStore> {
    if (!isRfc4122Uuid(options.localCompanionId)
      || !options.knownCompanionIds.includes(options.localCompanionId)) {
      throw new Error('ICP admin projection requires a known local companion identity');
    }
    const sharedPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-admin-projection',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
      max: 2,
    });
    const costPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-admin-cost-projection',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      const shared = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
        knownCompanionIds: options.knownCompanionIds,
      });
      return new PostgresIcpAdminProjectionStore(
        sharedPool,
        costPool,
        shared,
        options.localCompanionId,
      );
    } catch (error) {
      await Promise.allSettled([sharedPool.end(), costPool.end()]);
      throw error;
    }
  }

  async readProjection(limit = 50): Promise<IcpAdminSharedProjection> {
    const boundedLimit = Math.min(MAX_ADMIN_ROWS, Math.max(1, Math.floor(limit)));
    const [availabilityRows, episodeRows, permitRows, fatigueRows, costRows] = await Promise.all([
      queryRows<AvailabilityRow>(this.sharedPool, `
        SELECT companion_id, state, issued_at_ms, expires_at_ms, source, revision
        FROM icp_availability_leases
        WHERE companion_id = $1
        ORDER BY companion_id
        LIMIT $2
      `, [this.localCompanionId, boundedLimit]),
      queryRows<EpisodeRow>(this.sharedPool, `
        SELECT conversation_id, channel_id, participant_companion_ids,
          root_initiation_id, initiated_by_companion_id, initiation_source,
          provenance_ref, opened_at_ms, last_activity_at_ms, status,
          close_reason_code, revision
        FROM icp_conversation_episodes
        WHERE $1::uuid = ANY(participant_companion_ids)
        ORDER BY last_activity_at_ms DESC, conversation_id
        LIMIT $2
      `, [this.localCompanionId, boundedLimit]),
      queryRows<PermitRow>(this.sharedPool, `
        SELECT permit_id, candidate_id, conversation_id, sender_companion_id,
          recipient_companion_id, channel_id, provenance_ref, issued_at_ms,
          expires_at_ms, status, consumed_at_ms, revoked_at_ms, reason_code, revision
        FROM icp_initiation_permits
        WHERE sender_companion_id = $1 OR recipient_companion_id = $1
        ORDER BY issued_at_ms DESC, permit_id
        LIMIT $2
      `, [this.localCompanionId, boundedLimit]),
      queryRows<FatigueRow>(this.sharedPool, `
        SELECT conversation_id, root_initiation_id, local_companion_id,
          peer_companion_id, channel_id,
          COALESCE(SUM(amount) FILTER (WHERE decision = 'charged'), 0) AS charged_units,
          COALESCE(SUM(amount) FILTER (WHERE decision = 'overcharge'), 0) AS overcharge_units,
          COUNT(*) AS turn_count,
          COUNT(*) FILTER (WHERE outcome IN ('pending', 'delivering')) AS pending_count,
          COUNT(*) FILTER (WHERE outcome = 'delivered') AS delivered_count,
          COUNT(*) FILTER (WHERE outcome = 'failed') AS failed_count,
          MAX(reserved_at_ms) AS latest_reserved_at_ms
        FROM icp_fatigue_turn_reservations
        WHERE local_companion_id = $1 OR peer_companion_id = $1
        GROUP BY conversation_id, root_initiation_id, local_companion_id,
          peer_companion_id, channel_id
        ORDER BY MAX(reserved_at_ms) DESC, conversation_id
        LIMIT $2
      `, [this.localCompanionId, boundedLimit]),
      queryRows<CostRow>(this.costPool, `
        SELECT DISTINCT ON (decision.conversation_id)
          decision.conversation_id, decision.root_initiation_id,
          decision.recorded_at_ms, decision.actual_cost_usd,
          decision.pending_projected_cost_usd, decision.projected_total_cost_usd,
          decision.warning_threshold_usd, decision.hard_limit_usd,
          decision.unknown_cost_attempt_count, decision.allowed, decision.reason,
          episode.participant_companion_ids
        FROM icp_conversation_cost_decisions AS decision
        INNER JOIN shared.icp_conversation_episodes AS episode
          ON episode.conversation_id::text = decision.conversation_id
        WHERE $1::uuid = ANY(episode.participant_companion_ids)
        ORDER BY decision.conversation_id, decision.recorded_at_ms DESC,
          decision.decision_id DESC
        LIMIT $2
      `, [this.localCompanionId, boundedLimit]),
    ]);
    return {
      availability: availabilityRows.map(mapAvailability),
      episodes: episodeRows.map(mapEpisode),
      permits: permitRows.map(mapPermit),
      fatigue: fatigueRows.map(mapFatigue),
      costs: costRows.map(mapCost),
    };
  }

  async close(): Promise<void> {
    await Promise.all([
      this.shared.close(),
      this.sharedPool.end(),
      this.costPool.end(),
    ]);
  }
}
