import type { Pool, QueryResultRow } from 'pg';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
  queryOne,
  queryRows,
} from '../postgres.js';
import type {
  BuzzCausalEvent,
  BuzzCausalClaimResult,
  BuzzInboundRecoveryRecord,
  BuzzInboundRecoveryState,
  BuzzRecoveryScope,
  BuzzRecoveryStore,
  BuzzSuppressionReason,
} from '../../channels/buzz/recovery-store.js';
import { isBuzzSuppressionReason } from '../../channels/buzz/recovery-store.js';
import type { BuzzMembershipChange, BuzzMembershipSnapshot } from '../../channels/buzz/protocol.js';
import { isNostrEvent } from '../../channels/buzz/protocol.js';
import { POSTGRES_BUZZ_RECOVERY_MIGRATIONS } from './buzz-recovery-migrations.js';
import {
  startPostgresStoreReadiness,
  type PostgresStoreReadinessHandle,
} from './runtime-readiness.js';

interface RecoveryRow extends QueryResultRow {
  event_id: string;
  channel_id: string;
  event_created_at: string;
  state: BuzzInboundRecoveryState;
  outbound_event_json: unknown;
  suppression_reason: unknown;
}

function toRecoveryRecord(row: RecoveryRow): BuzzInboundRecoveryRecord {
  const eventCreatedAt = Number(row.event_created_at);
  if (!Number.isSafeInteger(eventCreatedAt) || eventCreatedAt < 0) {
    throw new Error('Persisted Buzz recovery timestamp is invalid');
  }
  const outboundEvent = row.outbound_event_json === null
    ? undefined
    : row.outbound_event_json;
  if (
    outboundEvent !== undefined
    && (!isNostrEvent(outboundEvent) || !verifyEvent(outboundEvent))
  ) {
    throw new Error('Persisted Buzz outbound event is invalid');
  }
  if (row.suppression_reason !== null && !isBuzzSuppressionReason(row.suppression_reason)) {
    throw new Error('Persisted Buzz suppression reason is invalid');
  }
  return {
    eventId: row.event_id,
    channelId: row.channel_id,
    eventCreatedAt,
    state: row.state,
    ...(outboundEvent ? { outboundEvent } : {}),
    ...(row.suppression_reason ? { suppressionReason: row.suppression_reason } : {}),
  };
}

export class PostgresBuzzRecoveryStore implements BuzzRecoveryStore {
  private readonly readiness: PostgresStoreReadinessHandle;

  constructor(
    private readonly pool: Pool,
    private readonly scope: BuzzRecoveryScope,
    private readonly ownsPool: boolean,
  ) {
    this.readiness = startPostgresStoreReadiness(
      'buzz_recovery',
      () => ensurePostgresSchema(pool, POSTGRES_BUZZ_RECOVERY_MIGRATIONS),
    );
  }

  static connect(databaseUrl: string, scope: BuzzRecoveryScope): PostgresBuzzRecoveryStore {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'buzz-recovery',
      allowExitOnIdle: true,
      max: 2,
    });
    return new PostgresBuzzRecoveryStore(pool, scope, true);
  }

  static async fromPool(pool: Pool, scope: BuzzRecoveryScope): Promise<PostgresBuzzRecoveryStore> {
    const store = new PostgresBuzzRecoveryStore(pool, scope, false);
    await store.waitUntilReady();
    return store;
  }

  async waitUntilReady(): Promise<void> {
    await this.readiness.waitUntilReady();
  }

  async claimInbound(input: {
    eventId: string;
    channelId: string;
    eventCreatedAt: number;
  }): Promise<{ claimed: boolean; record: BuzzInboundRecoveryRecord }> {
    await this.waitUntilReady();
    const result = await this.pool.query<RecoveryRow>(`
      INSERT INTO buzz_inbound_recovery (
        community, companion_id, event_id, channel_id, event_created_at,
        state, claimed_at_ms, updated_at_ms
      ) VALUES ($1, $2, $3, $4, $5, 'processing', $6, $6)
      ON CONFLICT (community, companion_id, event_id) DO NOTHING
      RETURNING event_id, channel_id, event_created_at, state,
        outbound_event_json, suppression_reason
    `, [
      this.scope.community,
      this.scope.companionId,
      input.eventId,
      input.channelId,
      input.eventCreatedAt,
      Date.now(),
    ]);
    if (result.rows[0]) return { claimed: true, record: toRecoveryRecord(result.rows[0]) };
    const existing = await this.requireRecord(input.eventId);
    return { claimed: false, record: existing };
  }

  async registerHumanRoot(
    input: Omit<BuzzCausalEvent, 'rootEventId' | 'parentEventId' | 'hop'>,
  ): Promise<void> {
    await this.waitUntilReady();
    await executeQuery(this.pool, `
      INSERT INTO buzz_causal_events (
        community, companion_id, event_id, channel_id, root_event_id,
        parent_event_id, hop, author_pubkey, observed_at_ms
      ) VALUES ($1, $2, $3, $4, $3, NULL, 0, $5, $6)
      ON CONFLICT (community, companion_id, event_id) DO NOTHING
    `, [
      this.scope.community,
      this.scope.companionId,
      input.eventId,
      input.channelId,
      input.authorPubkey,
      Date.now(),
    ]);
  }

  async claimCausalEvent(input: BuzzCausalEvent): Promise<BuzzCausalClaimResult> {
    await this.waitUntilReady();
    const parent = await queryOne<{ present: boolean }>(this.pool, `
      SELECT true AS present
      FROM buzz_causal_events
      WHERE community = $1 AND companion_id = $2
        AND event_id = $3 AND root_event_id = $4
        AND channel_id = $5 AND hop + 1 = $6
    `, [
      this.scope.community,
      this.scope.companionId,
      input.parentEventId,
      input.rootEventId,
      input.channelId,
      input.hop,
    ]);
    if (!parent) return 'invalid_parent';
    const result = await this.pool.query(`
      INSERT INTO buzz_causal_events (
        community, companion_id, event_id, channel_id, root_event_id,
        parent_event_id, hop, author_pubkey, observed_at_ms
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
      FROM buzz_causal_events parent
      WHERE parent.community = $1
        AND parent.companion_id = $2
        AND parent.event_id = $6
        AND parent.root_event_id = $5
        AND parent.channel_id = $4
        AND parent.hop + 1 = $7
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `, [
      this.scope.community,
      this.scope.companionId,
      input.eventId,
      input.channelId,
      input.rootEventId,
      input.parentEventId,
      input.hop,
      input.authorPubkey,
      Date.now(),
    ]);
    return result.rowCount === 1 ? 'claimed' : 'duplicate';
  }

  async markReady(
    eventId: string,
    outboundEvent: NostrEvent,
    causalEvent: BuzzCausalEvent,
  ): Promise<void> {
    await this.waitUntilReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const recovery = await client.query(`
        UPDATE buzz_inbound_recovery
        SET state = 'ready', outbound_event_json = $4::jsonb,
          suppression_reason = NULL, updated_at_ms = $5
        WHERE community = $1 AND companion_id = $2 AND event_id = $3 AND state = 'processing'
        RETURNING event_id
      `, [
        this.scope.community,
        this.scope.companionId,
        eventId,
        JSON.stringify(outboundEvent),
        Date.now(),
      ]);
      const causal = await client.query(`
        INSERT INTO buzz_causal_events (
          community, companion_id, event_id, channel_id, root_event_id,
          parent_event_id, hop, author_pubkey, observed_at_ms
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        FROM buzz_causal_events parent
        WHERE parent.community = $1
          AND parent.companion_id = $2
          AND parent.event_id = $6
          AND parent.root_event_id = $5
          AND parent.channel_id = $4
          AND parent.hop + 1 = $7
        ON CONFLICT DO NOTHING
        RETURNING event_id
      `, [
        this.scope.community,
        this.scope.companionId,
        causalEvent.eventId,
        causalEvent.channelId,
        causalEvent.rootEventId,
        causalEvent.parentEventId,
        causalEvent.hop,
        causalEvent.authorPubkey,
        Date.now(),
      ]);
      if (recovery.rowCount !== 1 || causal.rowCount !== 1) {
        throw new Error(`Buzz recovery event ${eventId} could not become causally ready`);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markCompleted(eventId: string): Promise<void> {
    await this.transition(eventId, 'completed', 'ready');
  }

  async markSuppressed(eventId: string, reason: BuzzSuppressionReason): Promise<void> {
    await this.waitUntilReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const prior = await client.query<{ outbound_event_id: string | null }>(`
        SELECT outbound_event_json->>'id' AS outbound_event_id
        FROM buzz_inbound_recovery
        WHERE community = $1 AND companion_id = $2 AND event_id = $3
          AND state IN ('processing', 'ready')
        FOR UPDATE
      `, [this.scope.community, this.scope.companionId, eventId]);
      if (prior.rowCount !== 1) {
        throw new Error(`Buzz recovery event ${eventId} cannot transition to suppressed`);
      }
      await client.query(`
        UPDATE buzz_inbound_recovery
        SET state = 'suppressed', outbound_event_json = NULL,
          suppression_reason = $4, updated_at_ms = $5
        WHERE community = $1 AND companion_id = $2 AND event_id = $3
      `, [this.scope.community, this.scope.companionId, eventId, reason, Date.now()]);
      const outboundEventId = prior.rows[0]?.outbound_event_id;
      if (outboundEventId) {
        await client.query(`
          DELETE FROM buzz_causal_events
          WHERE community = $1 AND companion_id = $2 AND event_id = $3
        `, [this.scope.community, this.scope.companionId, outboundEventId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listRecoverable(): Promise<BuzzInboundRecoveryRecord[]> {
    await this.waitUntilReady();
    const rows = await queryRows<RecoveryRow>(this.pool, `
      SELECT event_id, channel_id, event_created_at, state,
        outbound_event_json, suppression_reason
      FROM buzz_inbound_recovery
      WHERE community = $1 AND companion_id = $2
        AND state IN ('processing', 'ready')
      ORDER BY event_created_at, event_id
    `, [this.scope.community, this.scope.companionId]);
    return rows.map(toRecoveryRecord);
  }

  async loadReplayCursor(): Promise<number | null> {
    await this.waitUntilReady();
    const row = await queryOne<{ event_created_at: string }>(this.pool, `
      SELECT event_created_at
      FROM buzz_replay_checkpoints
      WHERE community = $1 AND companion_id = $2
    `, [this.scope.community, this.scope.companionId]);
    if (!row) return null;
    const value = Number(row.event_created_at);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('Persisted Buzz replay cursor is invalid');
    }
    return value;
  }

  async advanceReplayCursor(eventCreatedAt: number): Promise<void> {
    await this.waitUntilReady();
    await executeQuery(this.pool, `
      INSERT INTO buzz_replay_checkpoints (
        community, companion_id, event_created_at, updated_at_ms
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (community, companion_id) DO UPDATE SET
        event_created_at = GREATEST(buzz_replay_checkpoints.event_created_at, excluded.event_created_at),
        updated_at_ms = excluded.updated_at_ms
    `, [this.scope.community, this.scope.companionId, eventCreatedAt, Date.now()]);
  }

  async replaceMemberships(memberships: readonly BuzzMembershipSnapshot[]): Promise<void> {
    await this.waitUntilReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        DELETE FROM buzz_room_memberships
        WHERE community = $1 AND companion_id = $2
      `, [this.scope.community, this.scope.companionId]);
      for (const membership of memberships) {
        await client.query(`
          INSERT INTO buzz_room_memberships (
            community, companion_id, channel_id, active, event_created_at, event_id
          ) VALUES ($1, $2, $3, true, $4, $5)
        `, [
          this.scope.community,
          this.scope.companionId,
          membership.channelId,
          membership.position.createdAt,
          membership.position.eventId,
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setMembership(change: BuzzMembershipChange): Promise<void> {
    await this.waitUntilReady();
    await executeQuery(this.pool, `
      INSERT INTO buzz_room_memberships (
        community, companion_id, channel_id, active, event_created_at, event_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (community, companion_id, channel_id) DO UPDATE SET
        active = excluded.active,
        event_created_at = excluded.event_created_at,
        event_id = excluded.event_id
      WHERE (buzz_room_memberships.event_created_at, buzz_room_memberships.event_id)
        < (excluded.event_created_at, excluded.event_id)
    `, [
      this.scope.community,
      this.scope.companionId,
      change.channelId,
      change.active,
      change.position.createdAt,
      change.position.eventId,
    ]);
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end();
  }

  private async requireRecord(eventId: string): Promise<BuzzInboundRecoveryRecord> {
    const row = await queryOne<RecoveryRow>(this.pool, `
      SELECT event_id, channel_id, event_created_at, state,
        outbound_event_json, suppression_reason
      FROM buzz_inbound_recovery
      WHERE community = $1 AND companion_id = $2 AND event_id = $3
    `, [this.scope.community, this.scope.companionId, eventId]);
    if (!row) throw new Error(`Buzz recovery event ${eventId} was not found after claim conflict`);
    return toRecoveryRecord(row);
  }

  private async transition(
    eventId: string,
    nextState: BuzzInboundRecoveryState,
    expectedState: BuzzInboundRecoveryState,
  ): Promise<void> {
    await this.waitUntilReady();
    const result = await this.pool.query(`
      UPDATE buzz_inbound_recovery
      SET state = $4, updated_at_ms = $5
      WHERE community = $1 AND companion_id = $2 AND event_id = $3 AND state = $6
    `, [
      this.scope.community,
      this.scope.companionId,
      eventId,
      nextState,
      Date.now(),
      expectedState,
    ]);
    if (result.rowCount !== 1) {
      throw new Error(`Buzz recovery event ${eventId} cannot transition from ${expectedState} to ${nextState}`);
    }
  }
}
