import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  IcpFatigueRegulationReservationPort,
  IcpFatigueReservationInput,
  IcpFatigueReservationResult,
  IcpInitiationPressureInput,
  IcpInitiationPressureSnapshot,
} from "../../core/agent/fatigue/regulation-reservation.js";
import type { IcpConversationCorrelation } from "../../shared/contracts/icp-autonomy.js";
import { parseIcpConversationCorrelation } from "../../shared/contracts/icp-autonomy.js";
import type { FatigueEnforcementMetadata } from "../../shared/contracts/runtime.js";
import { isRfc4122Uuid } from "../../shared/utils/types.js";
import { createPostgresPool, withPostgresClient } from "../postgres.js";
import { SHARED_SCHEMA_NAME } from "./migrations.js";
import { ensureSharedSchema } from "./shared-schema.js";

interface ReservationRow extends QueryResultRow {
  turn_id: string;
  conversation_id: string;
  root_initiation_id: string;
  local_companion_id: string;
  peer_companion_id: string;
  peer_contact_id: string;
  channel_id: string;
  decision: string;
  amount: string | number;
  reserved_at_ms: string | number;
  finalized_at_ms: string | number | null;
  outcome: string;
}

const RESERVATION_COLUMNS = `
  turn_id, conversation_id, root_initiation_id, local_companion_id,
  peer_companion_id, peer_contact_id, channel_id, decision, amount,
  reserved_at_ms, finalized_at_ms, outcome
`;

const FATIGUE_LEASE_LOCK_SEED = 1;
const FATIGUE_LEASE_POOL_MAX = 8;
const FATIGUE_LEASE_ACQUIRE_TIMEOUT_MS = 5_000;

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireNonNegativeFinite(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
  return value;
}

function requireCompanionId(value: string, field: string): string {
  if (!isRfc4122Uuid(value))
    throw new Error(`${field} must be an RFC 4122 UUID`);
  return value;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function safeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${field} must be a safe integer`);
  return parsed;
}

function canonicalPairKey(
  firstCompanionId: string,
  secondCompanionId: string,
): string {
  return [firstCompanionId, secondCompanionId].sort().join(":");
}

function assertReplayMatches(
  row: ReservationRow,
  input: IcpFatigueReservationInput,
): void {
  const correlation = input.correlation;
  if (
    row.conversation_id !== correlation.conversationId ||
    row.root_initiation_id !== correlation.rootInitiationId ||
    row.local_companion_id !== correlation.localCompanionId ||
    row.peer_companion_id !== correlation.peerCompanionId ||
    row.peer_contact_id !== correlation.peerContactId ||
    row.channel_id !== correlation.channelId ||
    row.decision !== input.decision ||
    safeInteger(row.amount, "reservation.amount") !== input.amount
  ) {
    throw new Error(
      `ICP fatigue reservation replay mismatch for turn ${correlation.turnId}`,
    );
  }
}

function assertFinalizationMatches(
  row: ReservationRow,
  correlation: IcpConversationCorrelation,
  fatigue: FatigueEnforcementMetadata,
  outcome: Parameters<IcpFatigueRegulationReservationPort["finalize"]>[0]["outcome"],
): void {
  const recordedEvent = fatigue.recordedEvent;
  if (
    row.conversation_id !== correlation.conversationId ||
    row.root_initiation_id !== correlation.rootInitiationId ||
    row.local_companion_id !== correlation.localCompanionId ||
    row.peer_companion_id !== correlation.peerCompanionId ||
    row.peer_contact_id !== correlation.peerContactId ||
    row.channel_id !== correlation.channelId ||
    row.decision !== fatigue.spendDecision ||
    safeInteger(row.amount, "reservation.amount") !== fatigue.budget.amount ||
    fatigue.socialRegulation.rootInitiationId !==
      correlation.rootInitiationId ||
    ((outcome === "delivered" || outcome === "no_reply") &&
      (!recordedEvent ||
        recordedEvent.decision !== fatigue.spendDecision ||
        recordedEvent.amount !== fatigue.budget.amount))
  ) {
    throw new Error(
      `ICP fatigue reservation finalization metadata binding mismatch for turn ${correlation.turnId}`,
    );
  }
}

/**
 * Shared Postgres concurrency fence for ICP fatigue. Policy remains in the
 * existing fatigue engine; this store only serializes and audits its finite
 * charged/closeout slots across processes, channels, and restarts.
 */
export class PostgresIcpFatigueRegulationReservationStore implements IcpFatigueRegulationReservationPort {
  private readonly leases = new Map<string, PoolClient>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(
    private readonly pool: Pool,
    private readonly leasePool: Pool,
  ) {}

  static async connect(
    databaseUrl: string,
  ): Promise<PostgresIcpFatigueRegulationReservationStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: "companion-icp-fatigue-regulation",
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    const leasePool = createPostgresPool(databaseUrl, {
      applicationName: "companion-icp-fatigue-regulation-lease",
      allowExitOnIdle: true,
      connectionTimeoutMillis: FATIGUE_LEASE_ACQUIRE_TIMEOUT_MS,
      max: FATIGUE_LEASE_POOL_MAX,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      await ensureSharedSchema(pool);
      return new PostgresIcpFatigueRegulationReservationStore(pool, leasePool);
    } catch (error) {
      await Promise.allSettled([pool.end(), leasePool.end()]);
      throw error;
    }
  }

  async reserve(
    input: IcpFatigueReservationInput,
  ): Promise<IcpFatigueReservationResult> {
    const correlation = parseIcpConversationCorrelation(input.correlation);
    const timestampMs = requireTimestamp(
      input.timestampMs,
      "reservation.timestampMs",
    );
    const amount = requirePositiveInteger(input.amount, "reservation.amount");
    const hardLimit = requirePositiveInteger(
      input.hardLimit,
      "reservation.hardLimit",
    );
    const overchargeLimit = requirePositiveInteger(
      input.overchargeLimit,
      "reservation.overchargeLimit",
    );
    const halfLifeMs = requirePositiveInteger(
      input.relationshipPressureHalfLifeMs,
      "reservation.relationshipPressureHalfLifeMs",
    );
    const windowMs = requirePositiveInteger(
      input.relationshipPressureWindowMs,
      "reservation.relationshipPressureWindowMs",
    );
    const unansweredInitiationAfterMs = requirePositiveInteger(
      input.unansweredInitiationAfterMs,
      "reservation.unansweredInitiationAfterMs",
    );
    requireNonNegativeFinite(
      input.declinedPressureUnits,
      "reservation.declinedPressureUnits",
    );
    requireNonNegativeFinite(
      input.deferredPressureUnits,
      "reservation.deferredPressureUnits",
    );
    requireNonNegativeFinite(
      input.unansweredPressureUnits,
      "reservation.unansweredPressureUnits",
    );
    if (windowMs < halfLifeMs) {
      throw new Error(
        "reservation relationship pressure window must be at least one half-life",
      );
    }

    const normalizedInput: IcpFatigueReservationInput = {
      ...input,
      correlation,
      timestampMs,
      amount,
      hardLimit,
      overchargeLimit,
      relationshipPressureHalfLifeMs: halfLifeMs,
      relationshipPressureWindowMs: windowMs,
      unansweredInitiationAfterMs,
    };
    const lease = await this.acquireLease(correlation.turnId);
    try {
      const transaction = await withPostgresClient(this.pool, async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
          [
            canonicalPairKey(
              correlation.localCompanionId,
              correlation.peerCompanionId,
            ),
          ],
        );
        const existingResult = await client.query<ReservationRow>(
          `
          SELECT ${RESERVATION_COLUMNS}
          FROM icp_fatigue_turn_reservations
          WHERE turn_id = $1
          FOR UPDATE
        `,
          [correlation.turnId],
        );
        const existing = existingResult.rows.at(0);
        if (existing && existing.outcome !== "failed") {
          assertReplayMatches(existing, normalizedInput);
          return {
            result: await this.snapshotResult(
              client,
              normalizedInput,
              "replayed",
              correlation.turnId,
            ),
            keepLease: existing.outcome === "pending",
          };
        }

        // A pending turn is reclaimable only when its dedicated database
        // session no longer owns the advisory lease. No wall clock participates.
        await client.query(
          `
          WITH orphaned AS (
            SELECT turn_id
            FROM icp_fatigue_turn_reservations
            WHERE ((local_companion_id = $1 AND peer_companion_id = $2)
                OR (local_companion_id = $2 AND peer_companion_id = $1))
              AND outcome = 'pending' AND turn_id <> $3::uuid
              AND pg_try_advisory_xact_lock(
                hashtextextended(turn_id::text, ${FATIGUE_LEASE_LOCK_SEED})
              )
          )
          UPDATE icp_fatigue_turn_reservations AS reservation
          SET outcome = 'failed', finalized_at_ms = $4
          FROM orphaned
          WHERE reservation.turn_id = orphaned.turn_id
        `,
          [
            correlation.localCompanionId,
            correlation.peerCompanionId,
            correlation.turnId,
            timestampMs,
          ],
        );
        const snapshot = await this.snapshotResult(
          client,
          normalizedInput,
          "reserved",
        );
        const exhausted =
          input.decision === "charged"
            ? snapshot.normalSpentBefore >= hardLimit
            : snapshot.overchargeSpentBefore >= overchargeLimit;
        if (exhausted) {
          return {
            result: { ...snapshot, outcome: "exhausted" as const },
            keepLease: false,
          };
        }

        const insertResult = await client.query<ReservationRow>(
          `
          INSERT INTO icp_fatigue_turn_reservations (
            turn_id, conversation_id, root_initiation_id, local_companion_id,
            peer_companion_id, peer_contact_id, channel_id, decision, amount,
            reserved_at_ms, finalized_at_ms, outcome
          )
          SELECT $1, episode.conversation_id, episode.root_initiation_id, $4, $5,
            $6, episode.channel_id, $8, $9, $10, NULL, 'pending'
          FROM icp_conversation_episodes AS episode
          WHERE episode.conversation_id = $2
            AND episode.root_initiation_id = $3
            AND episode.channel_id = $7
            AND episode.participant_companion_ids @> ARRAY[$4::uuid, $5::uuid]
            AND episode.status IN ('invited', 'active')
          ON CONFLICT (turn_id) DO UPDATE SET
            reserved_at_ms = EXCLUDED.reserved_at_ms,
            finalized_at_ms = NULL,
            outcome = 'pending'
          WHERE icp_fatigue_turn_reservations.outcome = 'failed'
          RETURNING ${RESERVATION_COLUMNS}
        `,
          [
            correlation.turnId,
            correlation.conversationId,
            correlation.rootInitiationId,
            correlation.localCompanionId,
            correlation.peerCompanionId,
            correlation.peerContactId,
            correlation.channelId,
            input.decision,
            amount,
            timestampMs,
          ],
        );
        const inserted = insertResult.rows.at(0);
        if (!inserted) {
          throw new Error(
            "ICP fatigue reservation episode/channel/participant binding mismatch",
          );
        }
        assertReplayMatches(inserted, normalizedInput);
        return { result: snapshot, keepLease: true };
      });
      if (!transaction.keepLease) {
        await this.releaseLease(correlation.turnId);
      }
      return transaction.result;
    } catch (error) {
      if (lease.created) {
        await this.releaseLease(correlation.turnId);
      }
      throw error;
    }
  }

  async readInitiationPressure(
    input: IcpInitiationPressureInput,
  ): Promise<IcpInitiationPressureSnapshot> {
    const normalized = {
      ...input,
      localCompanionId: requireCompanionId(
        input.localCompanionId,
        "initiationPressure.localCompanionId",
      ),
      peerCompanionId: requireCompanionId(
        input.peerCompanionId,
        "initiationPressure.peerCompanionId",
      ),
      timestampMs: requireTimestamp(
        input.timestampMs,
        "initiationPressure.timestampMs",
      ),
      relationshipPressureHalfLifeMs: requirePositiveInteger(
        input.relationshipPressureHalfLifeMs,
        "initiationPressure.relationshipPressureHalfLifeMs",
      ),
      relationshipPressureWindowMs: requirePositiveInteger(
        input.relationshipPressureWindowMs,
        "initiationPressure.relationshipPressureWindowMs",
      ),
      unansweredAfterMs: requirePositiveInteger(
        input.unansweredAfterMs,
        "initiationPressure.unansweredAfterMs",
      ),
      declinedPressureUnits: requireNonNegativeFinite(
        input.declinedPressureUnits,
        "initiationPressure.declinedPressureUnits",
      ),
      deferredPressureUnits: requireNonNegativeFinite(
        input.deferredPressureUnits,
        "initiationPressure.deferredPressureUnits",
      ),
      unansweredPressureUnits: requireNonNegativeFinite(
        input.unansweredPressureUnits,
        "initiationPressure.unansweredPressureUnits",
      ),
    };
    if (normalized.localCompanionId === normalized.peerCompanionId) {
      throw new Error("initiationPressure companion pair must be distinct");
    }
    if (
      normalized.relationshipPressureWindowMs <
      normalized.relationshipPressureHalfLifeMs
    ) {
      throw new Error(
        "initiation pressure window must be at least one half-life",
      );
    }
    return await withPostgresClient(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [
          canonicalPairKey(
            normalized.localCompanionId,
            normalized.peerCompanionId,
          ),
        ],
      );
      const snapshot = await this.pressureSnapshot(client, normalized);
      return {
        relationshipPressure: snapshot.relationshipPressure,
        chargedPressure: snapshot.chargedPressure,
        declinedPressure: snapshot.declinedPressure,
        deferredPressure: snapshot.deferredPressure,
        unansweredPressure: snapshot.unansweredPressure,
        contributingReservationCount: snapshot.contributingReservationCount,
        contributingEpisodeCount: snapshot.contributingEpisodeCount,
      };
    });
  }

  async prepareDelivery(
    input: Parameters<IcpFatigueRegulationReservationPort["prepareDelivery"]>[0],
  ): Promise<void> {
    const correlation = parseIcpConversationCorrelation(input.correlation);
    const lease = this.leases.get(correlation.turnId);
    if (lease) {
      await lease.query("SELECT 1");
    }
    await withPostgresClient(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [
          canonicalPairKey(
            correlation.localCompanionId,
            correlation.peerCompanionId,
          ),
        ],
      );
      const result = await client.query<ReservationRow>(
        `
        SELECT ${RESERVATION_COLUMNS}
        FROM icp_fatigue_turn_reservations
        WHERE turn_id = $1
        FOR UPDATE
      `,
        [correlation.turnId],
      );
      const row = result.rows.at(0);
      if (!row || !["pending", "delivering"].includes(row.outcome)) {
        throw new Error(
          `ICP fatigue delivery preparation conflict for turn ${correlation.turnId}`,
        );
      }
      if (row.outcome === "pending" && !lease) {
        throw new Error(
          `ICP fatigue delivery preparation requires the live reservation lease for turn ${correlation.turnId}`,
        );
      }
      assertFinalizationMatches(row, correlation, input.fatigue, "delivered");
      if (row.outcome === "pending") {
        await client.query(
          `
          UPDATE icp_fatigue_turn_reservations
          SET outcome = 'delivering'
          WHERE turn_id = $1 AND outcome = 'pending'
        `,
          [correlation.turnId],
        );
      }
    });
    await this.releaseLease(correlation.turnId);
  }

  async handoff(correlationInput: IcpConversationCorrelation): Promise<void> {
    const correlation = parseIcpConversationCorrelation(correlationInput);
    await this.releaseLease(correlation.turnId);
  }

  async finalize(
    input: Parameters<IcpFatigueRegulationReservationPort["finalize"]>[0],
  ): Promise<void> {
    const correlation = parseIcpConversationCorrelation(input.correlation);
    const finalizedAtMs = requireTimestamp(
      input.finalizedAtMs,
      "finalizedAtMs",
    );
    if (
      input.fatigue.scope.localCompanionId !== correlation.localCompanionId ||
      input.fatigue.scope.peerContactId !== correlation.peerContactId ||
      input.fatigue.scope.channelId !== correlation.channelId
    ) {
      throw new Error(
        "ICP fatigue reservation finalization metadata binding mismatch",
      );
    }
    if (input.outcome === "failed") {
      const lease = this.leases.get(correlation.turnId);
      if (!lease) {
        throw new Error(
          `ICP fatigue failure finalization requires the live reservation lease for turn ${correlation.turnId}`,
        );
      }
      await lease.query("SELECT 1");
    }
    await withPostgresClient(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))",
        [
          canonicalPairKey(
            correlation.localCompanionId,
            correlation.peerCompanionId,
          ),
        ],
      );
      const sourceOutcome = input.outcome === "failed" ? "pending" : "delivering";
      const result = await client.query<ReservationRow>(
        `
        UPDATE icp_fatigue_turn_reservations
        SET outcome = $2, finalized_at_ms = $3
        WHERE turn_id = $1 AND outcome = $4
        RETURNING ${RESERVATION_COLUMNS}
      `,
        [correlation.turnId, input.outcome, finalizedAtMs, sourceOutcome],
      );
      const finalized = result.rows.at(0);
      if (finalized) {
        assertFinalizationMatches(
          finalized,
          correlation,
          input.fatigue,
          input.outcome,
        );
        return;
      }
      const replay = await client.query<ReservationRow>(
        `
        SELECT ${RESERVATION_COLUMNS}
        FROM icp_fatigue_turn_reservations
        WHERE turn_id = $1
      `,
        [correlation.turnId],
      );
      const row = replay.rows.at(0);
      if (row) {
        assertFinalizationMatches(
          row,
          correlation,
          input.fatigue,
          input.outcome,
        );
      }
      if (!row || row.outcome !== input.outcome) {
        throw new Error(
          `ICP fatigue reservation finalization conflict for turn ${correlation.turnId}`,
        );
      }
    });
    await this.releaseLease(correlation.turnId);
  }

  private async acquireLease(
    turnId: string,
  ): Promise<{ client: PoolClient; created: boolean }> {
    if (this.closed) {
      throw new Error("ICP fatigue reservation store is closed");
    }
    const existing = this.leases.get(turnId);
    if (existing) {
      try {
        await existing.query("SELECT 1");
        return { client: existing, created: false };
      } catch {
        await this.releaseLease(turnId);
      }
    }
    let client: PoolClient;
    try {
      client = await this.leasePool.connect();
    } catch (error) {
      throw new Error(
        `ICP fatigue reservation lease capacity unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const result = await client.query<{ acquired: boolean }>(
        `SELECT pg_try_advisory_lock(
          hashtextextended($1::text, ${FATIGUE_LEASE_LOCK_SEED})
        ) AS acquired`,
        [turnId],
      );
      if (result.rows.at(0)?.acquired !== true) {
        throw new Error(
          `ICP fatigue reservation turn ${turnId} is already active in another process`,
        );
      }
      this.leases.set(turnId, client);
      return { client, created: true };
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  private async releaseLease(turnId: string): Promise<void> {
    const client = this.leases.get(turnId);
    if (!client) return;
    this.leases.delete(turnId);
    try {
      await client.query(
        `SELECT pg_advisory_unlock(
          hashtextextended($1::text, ${FATIGUE_LEASE_LOCK_SEED})
        )`,
        [turnId],
      );
      client.release();
    } catch (error) {
      client.release(true);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return await this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const turnIds = [...this.leases.keys()];
    const releases = await Promise.allSettled(turnIds.map(async (turnId) => {
      await this.releaseLease(turnId);
    }));
    const pools = await Promise.allSettled([this.pool.end(), this.leasePool.end()]);
    const failures = [...releases, ...pools]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to close ICP fatigue reservation resources",
      );
    }
  }

  private async snapshotResult(
    client: Pick<Pool, "query">,
    input: IcpFatigueReservationInput,
    outcome: Extract<
      IcpFatigueReservationResult["outcome"],
      "reserved" | "replayed"
    >,
    excludedTurnId?: string,
  ): Promise<IcpFatigueReservationResult> {
    const correlation = input.correlation;
    const snapshot = await this.pressureSnapshot(client, {
      localCompanionId: correlation.localCompanionId,
      peerCompanionId: correlation.peerCompanionId,
      rootInitiationId: correlation.rootInitiationId,
      timestampMs: input.timestampMs,
      relationshipPressureHalfLifeMs: input.relationshipPressureHalfLifeMs,
      relationshipPressureWindowMs: input.relationshipPressureWindowMs,
      unansweredAfterMs: input.unansweredInitiationAfterMs,
      declinedPressureUnits: input.declinedPressureUnits,
      deferredPressureUnits: input.deferredPressureUnits,
      unansweredPressureUnits: input.unansweredPressureUnits,
    }, excludedTurnId);
    return {
      outcome,
      normalSpentBefore: Math.max(
        snapshot.rootNormalSpent,
        Math.ceil(snapshot.directionalChargedPressure),
      ),
      overchargeSpentBefore: snapshot.rootOverchargeSpent,
      relationshipPressure: snapshot.relationshipPressure,
      rootNormalSpent: snapshot.rootNormalSpent,
      rootOverchargeSpent: snapshot.rootOverchargeSpent,
      contributingReservationCount: snapshot.contributingReservationCount,
    };
  }

  private async pressureSnapshot(
    client: Pick<Pool, "query">,
    input: IcpInitiationPressureInput & { rootInitiationId?: string },
    excludedTurnId?: string,
  ): Promise<{
    rootNormalSpent: number;
    rootOverchargeSpent: number;
    directionalChargedPressure: number;
    relationshipPressure: number;
    chargedPressure: number;
    declinedPressure: number;
    deferredPressure: number;
    unansweredPressure: number;
    contributingReservationCount: number;
    contributingEpisodeCount: number;
  }> {
    const sinceMs = Math.max(
      0,
      input.timestampMs - input.relationshipPressureWindowMs,
    );
    const result = await client.query<{
      normal_spent: string | number;
      overcharge_spent: string | number;
      charged_pressure: string | number;
      directional_charged_pressure: string | number;
      declined_pressure: string | number;
      deferred_pressure: string | number;
      unanswered_pressure: string | number;
      reservation_count: string | number;
      episode_count: string | number;
    }>(
      `
      WITH root_spend AS (
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE decision = 'charged'), 0) AS normal_spent,
          COALESCE(SUM(amount) FILTER (WHERE decision = 'overcharge'), 0) AS overcharge_spent
        FROM icp_fatigue_turn_reservations
        WHERE local_companion_id = $1 AND peer_companion_id = $2
          AND root_initiation_id = $3::uuid
          AND outcome IN ('pending', 'delivering', 'delivered', 'no_reply')
          AND ($11::uuid IS NULL OR turn_id <> $11::uuid)
      ), reservation_pressure AS (
        SELECT
          COALESCE(SUM(
            CASE WHEN decision = 'charged'
              THEN amount * POWER(2::double precision, -($4::bigint - reserved_at_ms)::double precision / $6::double precision)
              ELSE 0 END
          ), 0) AS charged_pressure,
          COALESCE(SUM(
            CASE WHEN decision = 'charged'
                AND local_companion_id = $1 AND peer_companion_id = $2
              THEN amount * POWER(2::double precision, -($4::bigint - reserved_at_ms)::double precision / $6::double precision)
              ELSE 0 END
          ), 0) AS directional_charged_pressure,
          COUNT(*) FILTER (WHERE decision = 'charged') AS reservation_count
        FROM icp_fatigue_turn_reservations
        WHERE ((local_companion_id = $1 AND peer_companion_id = $2)
            OR (local_companion_id = $2 AND peer_companion_id = $1))
          AND outcome IN ('pending', 'delivering', 'delivered', 'no_reply')
          AND reserved_at_ms BETWEEN $5::bigint AND $4::bigint
          AND ($11::uuid IS NULL OR turn_id <> $11::uuid)
      ), episode_pressure AS (
        SELECT
          COALESCE(SUM(CASE WHEN status = 'declined' THEN
            $7::double precision * POWER(2::double precision, -($4::bigint - last_activity_at_ms)::double precision / $6::double precision)
            ELSE 0 END), 0) AS declined_pressure,
          COALESCE(SUM(CASE WHEN status = 'deferred' THEN
            $8::double precision * POWER(2::double precision, -($4::bigint - last_activity_at_ms)::double precision / $6::double precision)
            ELSE 0 END), 0) AS deferred_pressure,
          COALESCE(SUM(CASE WHEN status = 'invited' AND last_activity_at_ms <= $4::bigint - $10::bigint THEN
            $9::double precision * POWER(2::double precision, -($4::bigint - last_activity_at_ms)::double precision / $6::double precision)
            ELSE 0 END), 0) AS unanswered_pressure,
          COUNT(*) AS episode_count
        FROM icp_conversation_episodes
        WHERE initiated_by_companion_id = ANY(ARRAY[$1::uuid, $2::uuid])
          AND participant_companion_ids @> ARRAY[$1::uuid, $2::uuid]
          AND last_activity_at_ms BETWEEN $5::bigint AND $4::bigint
          AND (status IN ('declined', 'deferred')
            OR (status = 'invited' AND last_activity_at_ms <= $4::bigint - $10::bigint))
      )
      SELECT root_spend.normal_spent, root_spend.overcharge_spent,
        reservation_pressure.charged_pressure,
        reservation_pressure.directional_charged_pressure,
        episode_pressure.declined_pressure, episode_pressure.deferred_pressure,
        episode_pressure.unanswered_pressure, reservation_pressure.reservation_count,
        episode_pressure.episode_count
      FROM root_spend, reservation_pressure, episode_pressure
    `,
      [
        input.localCompanionId,
        input.peerCompanionId,
        input.rootInitiationId ?? null,
        input.timestampMs,
        sinceMs,
        input.relationshipPressureHalfLifeMs,
        input.declinedPressureUnits,
        input.deferredPressureUnits,
        input.unansweredPressureUnits,
        input.unansweredAfterMs,
        excludedTurnId ?? null,
      ],
    );
    const row = result.rows.at(0);
    if (!row)
      throw new Error("ICP fatigue reservation snapshot query returned no row");
    const rootNormalSpent = safeInteger(
      row.normal_spent,
      "reservation.normalSpent",
    );
    const pressures = {
      chargedPressure: Number(row.charged_pressure),
      declinedPressure: Number(row.declined_pressure),
      deferredPressure: Number(row.deferred_pressure),
      unansweredPressure: Number(row.unanswered_pressure),
    };
    const directionalChargedPressure = Number(
      row.directional_charged_pressure,
    );
    if (
      Object.values(pressures).some(
        (value) => !Number.isFinite(value) || value < 0,
      )
      || !Number.isFinite(directionalChargedPressure)
      || directionalChargedPressure < 0
    ) {
      throw new Error(
        "reservation pressure components must be finite non-negative numbers",
      );
    }
    const relationshipPressure = Object.values(pressures).reduce(
      (total, value) => total + value,
      0,
    );
    return {
      rootNormalSpent,
      rootOverchargeSpent: safeInteger(
        row.overcharge_spent,
        "reservation.overchargeSpent",
      ),
      directionalChargedPressure,
      relationshipPressure,
      ...pressures,
      contributingReservationCount: safeInteger(
        row.reservation_count,
        "reservation.contributingReservationCount",
      ),
      contributingEpisodeCount: safeInteger(
        row.episode_count,
        "reservation.contributingEpisodeCount",
      ),
    };
  }
}
