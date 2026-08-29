import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type {
  FleetMaintenanceAcquireResult,
  FleetMaintenanceCheckpoint,
  FleetMaintenanceCheckpointResult,
  FleetMaintenanceLease,
  FleetMaintenanceStoreBinding,
  FleetMaintenanceStorePort,
} from '../../core/scheduler/fleet-maintenance-coordinator.js';
import { FleetMaintenanceFenceLostError } from '../../core/scheduler/fleet-maintenance-coordinator.js';
import { createPostgresPool, withPostgresClient } from '../postgres.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { requireSafeInteger } from './row-guards.js';
import { assertSharedSchemaReady } from './shared-schema.js';

interface BatonRow extends QueryResultRow {
  manifest_fingerprint: string | null;
  fleet_size: string | number;
  holder_companion_id: string | null;
  fencing_token: string | number;
  acquired_at_ms: string | number | null;
  lease_expires_at_ms: string | number | null;
  phase: string | null;
  preempt_requested: boolean;
  last_served_ordinal: string | number;
}

interface DemandRow extends QueryResultRow {
  companion_id: string;
  manifest_ordinal: string | number;
  ready_until_ms: string | number;
}

interface CheckpointRow extends QueryResultRow {
  companion_id: string;
  phase: string;
  checkpoint_ref: string | null;
  fencing_token: string | number;
  updated_at_ms: string | number;
}

const BATON_COLUMNS = `
  manifest_fingerprint, fleet_size, holder_companion_id, fencing_token,
  acquired_at_ms, lease_expires_at_ms, phase, preempt_requested,
  last_served_ordinal
`;

function nullableSafeInteger(
  value: string | number | null,
  field: string,
): number | null {
  return value === null ? null : requireSafeInteger(value, field);
}

function toLease(row: BatonRow, checkpointRef: string | null): FleetMaintenanceLease {
  if (row.holder_companion_id === null || row.phase === null) {
    throw new Error('fleet maintenance baton row has no holder');
  }
  const acquiredAtMs = nullableSafeInteger(row.acquired_at_ms, 'fleetMaintenance.acquiredAtMs');
  const expiresAtMs = nullableSafeInteger(
    row.lease_expires_at_ms,
    'fleetMaintenance.expiresAtMs',
  );
  if (acquiredAtMs === null || expiresAtMs === null) {
    throw new Error('fleet maintenance baton holder is missing its lease timestamps');
  }
  return {
    companionId: row.holder_companion_id,
    fencingToken: requireSafeInteger(row.fencing_token, 'fleetMaintenance.fencingToken'),
    acquiredAtMs,
    expiresAtMs,
    phase: row.phase,
    checkpointRef,
    preemptRequested: row.preempt_requested,
  };
}

/**
 * Shared-schema scheduling authority for heavyweight maintenance. The store
 * contains no memory or prompt content; checkpointRef is an opaque pointer to
 * companion-private progress owned by the heavy-work runner.
 */
export class PostgresFleetMaintenanceStore implements FleetMaintenanceStorePort {
  private closed = false;
  private closePromise: Promise<void> | null = null;

  private constructor(private readonly pool: Pool) {}

  static async connect(databaseUrl: string): Promise<PostgresFleetMaintenanceStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-fleet-maintenance',
      allowExitOnIdle: true,
      schema: SHARED_SCHEMA_NAME,
    });
    try {
      await assertSharedSchemaReady(pool);
      return new PostgresFleetMaintenanceStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async announceDemand(
    input: FleetMaintenanceStoreBinding & { nowMs: number; demandExpiresAtMs: number },
  ): Promise<void> {
    this.assertOpen();
    await withPostgresClient(this.pool, async (client) => {
      await this.lockAndReconcileManifest(client, input, input.nowMs);
      await client.query(
        `INSERT INTO fleet_maintenance_demands (
           scope, companion_id, manifest_fingerprint, manifest_ordinal,
           fleet_size, requested_at_ms, ready_until_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (scope, companion_id) DO UPDATE SET
           manifest_fingerprint = EXCLUDED.manifest_fingerprint,
           manifest_ordinal = EXCLUDED.manifest_ordinal,
           fleet_size = EXCLUDED.fleet_size,
           requested_at_ms = CASE
             WHEN fleet_maintenance_demands.ready_until_ms <= $6
             THEN EXCLUDED.requested_at_ms
             ELSE fleet_maintenance_demands.requested_at_ms
           END,
           ready_until_ms = EXCLUDED.ready_until_ms`,
        [
          input.scope,
          input.companionId,
          input.manifestFingerprint,
          input.manifestOrdinal,
          input.fleetSize,
          input.nowMs,
          input.demandExpiresAtMs,
        ],
      );
    });
  }

  async tryAcquire(
    input: FleetMaintenanceStoreBinding & {
      nowMs: number;
      leaseExpiresAtMs: number;
      phase: string;
    },
  ): Promise<FleetMaintenanceAcquireResult> {
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      let state = await this.lockAndReconcileManifest(client, input, input.nowMs);
      const holderExpiry = nullableSafeInteger(
        state.lease_expires_at_ms,
        'fleetMaintenance.expiresAtMs',
      );
      if (state.holder_companion_id !== null && holderExpiry !== null
        && holderExpiry <= input.nowMs) {
        const expired = await client.query<BatonRow>(
          `UPDATE fleet_maintenance_baton
           SET holder_companion_id = NULL, acquired_at_ms = NULL,
               lease_expires_at_ms = NULL, phase = NULL,
               preempt_requested = FALSE, revision = revision + 1
           WHERE scope = $1
           RETURNING ${BATON_COLUMNS}`,
          [input.scope],
        );
        state = expired.rows.at(0) ?? (() => {
          throw new Error('fleet maintenance baton disappeared during expiry');
        })();
      }

      if (state.holder_companion_id !== null) {
        if (state.holder_companion_id === input.companionId) {
          const checkpoint = await this.readCheckpointRow(client, input);
          return { outcome: 'acquired', lease: toLease(state, checkpoint?.checkpoint_ref ?? null) };
        }
        return {
          outcome: 'waiting',
          reason: 'held',
          holderCompanionId: state.holder_companion_id,
          nextCompanionId: state.holder_companion_id,
          retryAtMs: holderExpiry,
        };
      }

      const next = await client.query<DemandRow>(
        `SELECT companion_id, manifest_ordinal, ready_until_ms
         FROM fleet_maintenance_demands
         WHERE scope = $1 AND manifest_fingerprint = $2 AND ready_until_ms > $3
         ORDER BY CASE
           WHEN manifest_ordinal > $4 THEN manifest_ordinal - $4
           ELSE manifest_ordinal + $5 - $4
         END ASC
         LIMIT 1`,
        [
          input.scope,
          input.manifestFingerprint,
          input.nowMs,
          requireSafeInteger(state.last_served_ordinal, 'fleetMaintenance.lastServedOrdinal'),
          input.fleetSize,
        ],
      );
      const candidate = next.rows.at(0);
      if (!candidate) {
        return {
          outcome: 'waiting',
          reason: 'no_demand',
          holderCompanionId: null,
          nextCompanionId: null,
          retryAtMs: null,
        };
      }
      if (candidate.companion_id !== input.companionId) {
        return {
          outcome: 'waiting',
          reason: 'manifest_order',
          holderCompanionId: null,
          nextCompanionId: candidate.companion_id,
          retryAtMs: null,
        };
      }

      const checkpoint = await this.readCheckpointRow(client, input);
      const granted = await client.query<BatonRow>(
        `UPDATE fleet_maintenance_baton
         SET holder_companion_id = $2, fencing_token = fencing_token + 1,
             acquired_at_ms = $3, lease_expires_at_ms = $4,
             phase = $5, preempt_requested = FALSE, revision = revision + 1
         WHERE scope = $1 AND holder_companion_id IS NULL
         RETURNING ${BATON_COLUMNS}`,
        [
          input.scope,
          input.companionId,
          input.nowMs,
          input.leaseExpiresAtMs,
          checkpoint?.phase ?? input.phase,
        ],
      );
      const row = granted.rows.at(0);
      if (!row) {
        throw new Error('fleet maintenance baton acquisition conflict');
      }
      return {
        outcome: 'acquired',
        lease: toLease(row, checkpoint?.checkpoint_ref ?? null),
      };
    });
  }

  async renew(
    input: FleetMaintenanceStoreBinding & {
      fencingToken: number;
      nowMs: number;
      leaseExpiresAtMs: number;
    },
  ): Promise<FleetMaintenanceLease> {
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      const current = await this.lockOwnedLiveLease(client, input);
      const currentExpiry = nullableSafeInteger(
        current.lease_expires_at_ms,
        'fleetMaintenance.expiresAtMs',
      );
      if (currentExpiry === null || input.leaseExpiresAtMs <= currentExpiry) {
        throw new Error('fleet maintenance renewal must extend the current lease deadline');
      }
      const renewed = await client.query<BatonRow>(
        `UPDATE fleet_maintenance_baton
         SET lease_expires_at_ms = $4, revision = revision + 1
         WHERE scope = $1 AND holder_companion_id = $2 AND fencing_token = $3
         RETURNING ${BATON_COLUMNS}`,
        [input.scope, input.companionId, input.fencingToken, input.leaseExpiresAtMs],
      );
      const row = renewed.rows.at(0);
      if (!row) throw new FleetMaintenanceFenceLostError();
      const checkpoint = await this.readCheckpointRow(client, input);
      return toLease(row, checkpoint?.checkpoint_ref ?? null);
    });
  }

  async commitCheckpoint(
    input: FleetMaintenanceStoreBinding & {
      fencingToken: number;
      nowMs: number;
      leaseExpiresAtMs: number;
      phase: string;
      checkpointRef: string | null;
    },
  ): Promise<FleetMaintenanceCheckpointResult> {
    this.assertOpen();
    return await withPostgresClient(this.pool, async (client) => {
      const current = await this.lockOwnedLiveLease(client, input);
      const currentExpiry = nullableSafeInteger(
        current.lease_expires_at_ms,
        'fleetMaintenance.expiresAtMs',
      );
      if (currentExpiry === null || input.leaseExpiresAtMs < currentExpiry) {
        throw new Error('fleet maintenance checkpoint cannot shorten the current lease deadline');
      }
      await client.query(
        `INSERT INTO fleet_maintenance_checkpoints (
           scope, companion_id, phase, checkpoint_ref, fencing_token, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (scope, companion_id) DO UPDATE SET
           phase = EXCLUDED.phase,
           checkpoint_ref = EXCLUDED.checkpoint_ref,
           fencing_token = EXCLUDED.fencing_token,
           updated_at_ms = EXCLUDED.updated_at_ms`,
        [
          input.scope,
          input.companionId,
          input.phase,
          input.checkpointRef,
          input.fencingToken,
          input.nowMs,
        ],
      );
      const checkpointed = await client.query<BatonRow>(
        `UPDATE fleet_maintenance_baton
         SET phase = $4, lease_expires_at_ms = $5, revision = revision + 1
         WHERE scope = $1 AND holder_companion_id = $2 AND fencing_token = $3
         RETURNING ${BATON_COLUMNS}`,
        [
          input.scope,
          input.companionId,
          input.fencingToken,
          input.phase,
          input.leaseExpiresAtMs,
        ],
      );
      const row = checkpointed.rows.at(0);
      if (!row) throw new FleetMaintenanceFenceLostError();
      return {
        lease: toLease(row, input.checkpointRef),
        disposition: row.preempt_requested ? 'yield_requested' : 'continue',
      };
    });
  }

  async release(
    input: FleetMaintenanceStoreBinding & {
      fencingToken: number;
      nowMs: number;
      outcome: 'complete' | 'yield';
    },
  ): Promise<void> {
    this.assertOpen();
    await withPostgresClient(this.pool, async (client) => {
      await this.lockOwnedLiveLease(client, input);
      if (input.outcome === 'complete') {
        await client.query(
          `DELETE FROM fleet_maintenance_checkpoints
           WHERE scope = $1 AND companion_id = $2`,
          [input.scope, input.companionId],
        );
      }
      await client.query(
        `DELETE FROM fleet_maintenance_demands
         WHERE scope = $1 AND companion_id = $2`,
        [input.scope, input.companionId],
      );
      const released = await client.query(
        `UPDATE fleet_maintenance_baton
         SET holder_companion_id = NULL, acquired_at_ms = NULL,
             lease_expires_at_ms = NULL, phase = NULL,
             preempt_requested = FALSE,
             last_served_ordinal = CASE WHEN $4 = 'complete'
               THEN $5 ELSE last_served_ordinal END,
             revision = revision + 1
         WHERE scope = $1 AND holder_companion_id = $2 AND fencing_token = $3`,
        [
          input.scope,
          input.companionId,
          input.fencingToken,
          input.outcome,
          input.manifestOrdinal,
        ],
      );
      if (released.rowCount !== 1) throw new FleetMaintenanceFenceLostError();
    });
  }

  async requestPreemption(
    input: FleetMaintenanceStoreBinding & { nowMs: number },
  ): Promise<boolean> {
    this.assertOpen();
    const updated = await this.pool.query(
      `UPDATE fleet_maintenance_baton
       SET preempt_requested = TRUE, revision = revision + 1
       WHERE scope = $1 AND holder_companion_id = $2
         AND lease_expires_at_ms > $3 AND preempt_requested = FALSE`,
      [input.scope, input.companionId, input.nowMs],
    );
    return updated.rowCount === 1;
  }

  async withdrawDemand(input: FleetMaintenanceStoreBinding): Promise<void> {
    this.assertOpen();
    await this.pool.query(
      `DELETE FROM fleet_maintenance_demands
       WHERE scope = $1 AND companion_id = $2`,
      [input.scope, input.companionId],
    );
  }

  async readCheckpoint(
    input: FleetMaintenanceStoreBinding,
  ): Promise<FleetMaintenanceCheckpoint | null> {
    this.assertOpen();
    const checkpoint = await this.pool.query<CheckpointRow>(
      `SELECT companion_id, phase, checkpoint_ref, fencing_token, updated_at_ms
       FROM fleet_maintenance_checkpoints
       WHERE scope = $1 AND companion_id = $2`,
      [input.scope, input.companionId],
    );
    const row = checkpoint.rows.at(0);
    return row ? this.toCheckpoint(row) : null;
  }

  private async lockAndReconcileManifest(
    client: PoolClient,
    input: FleetMaintenanceStoreBinding,
    nowMs: number,
  ): Promise<BatonRow> {
    const result = await client.query<BatonRow>(
      `SELECT ${BATON_COLUMNS}
       FROM fleet_maintenance_baton
       WHERE scope = $1
       FOR UPDATE`,
      [input.scope],
    );
    let row = result.rows.at(0);
    if (!row) throw new Error('fleet maintenance baton readiness row is missing');
    if (row.manifest_fingerprint === input.manifestFingerprint) {
      if (requireSafeInteger(row.fleet_size, 'fleetMaintenance.fleetSize') !== input.fleetSize) {
        throw new Error('fleet maintenance manifest fingerprint has inconsistent fleet size');
      }
      return row;
    }

    const expiry = nullableSafeInteger(row.lease_expires_at_ms, 'fleetMaintenance.expiresAtMs');
    if (row.holder_companion_id !== null && expiry !== null && expiry > nowMs) {
      throw new Error('fleet maintenance manifest changed while a live baton is held');
    }
    await client.query('DELETE FROM fleet_maintenance_demands WHERE scope = $1', [input.scope]);
    const reconciled = await client.query<BatonRow>(
      `UPDATE fleet_maintenance_baton
       SET manifest_fingerprint = $2, fleet_size = $3,
           holder_companion_id = NULL, acquired_at_ms = NULL,
           lease_expires_at_ms = NULL, phase = NULL,
           preempt_requested = FALSE, last_served_ordinal = -1,
           revision = revision + 1
       WHERE scope = $1
       RETURNING ${BATON_COLUMNS}`,
      [input.scope, input.manifestFingerprint, input.fleetSize],
    );
    row = reconciled.rows.at(0);
    if (!row) throw new Error('fleet maintenance manifest reconciliation failed');
    return row;
  }

  private async readCheckpointRow(
    client: PoolClient,
    input: Pick<FleetMaintenanceStoreBinding, 'scope' | 'companionId'>,
  ): Promise<CheckpointRow | undefined> {
    const result = await client.query<CheckpointRow>(
      `SELECT companion_id, phase, checkpoint_ref, fencing_token, updated_at_ms
       FROM fleet_maintenance_checkpoints
       WHERE scope = $1 AND companion_id = $2`,
      [input.scope, input.companionId],
    );
    return result.rows.at(0);
  }

  private async lockOwnedLiveLease(
    client: PoolClient,
    input: Pick<
      FleetMaintenanceStoreBinding,
      'scope' | 'companionId'
    > & { fencingToken: number; nowMs: number },
  ): Promise<BatonRow> {
    const result = await client.query<BatonRow>(
      `SELECT ${BATON_COLUMNS}
       FROM fleet_maintenance_baton
       WHERE scope = $1
       FOR UPDATE`,
      [input.scope],
    );
    const row = result.rows.at(0);
    const expiry = row
      ? nullableSafeInteger(row.lease_expires_at_ms, 'fleetMaintenance.expiresAtMs')
      : null;
    if (!row || row.holder_companion_id !== input.companionId
      || requireSafeInteger(row.fencing_token, 'fleetMaintenance.fencingToken')
        !== input.fencingToken
      || expiry === null || expiry <= input.nowMs) {
      throw new FleetMaintenanceFenceLostError();
    }
    return row;
  }

  private toCheckpoint(row: CheckpointRow): FleetMaintenanceCheckpoint {
    return {
      companionId: row.companion_id,
      phase: row.phase,
      checkpointRef: row.checkpoint_ref,
      fencingToken: requireSafeInteger(row.fencing_token, 'fleetMaintenance.fencingToken'),
      updatedAtMs: requireSafeInteger(row.updated_at_ms, 'fleetMaintenance.checkpointUpdatedAtMs'),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('fleet maintenance store is closed');
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closed = true;
    this.closePromise = this.pool.end();
    return await this.closePromise;
  }
}
