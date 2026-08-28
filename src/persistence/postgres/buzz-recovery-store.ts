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
  BuzzInboundRecoveryRecord,
  BuzzInboundRecoveryState,
  BuzzRecoveryScope,
  BuzzRecoveryStore,
} from '../../channels/buzz/recovery-store.js';
import { isNostrEvent } from '../../channels/buzz/protocol.js';
import { POSTGRES_BUZZ_RECOVERY_MIGRATIONS } from './migrations.js';
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
  suppression_reason: string | null;
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
      applicationName: 'psfn-buzz-recovery',
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

  async claimCausalEdge(input: {
    chainId: string;
    parentEventId: string;
    authorPubkey: string;
    eventId: string;
  }): Promise<boolean> {
    await this.waitUntilReady();
    const result = await this.pool.query(`
      INSERT INTO buzz_causal_edges (
        community, companion_id, chain_id, parent_event_id,
        author_pubkey, event_id, observed_at_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
      RETURNING event_id
    `, [
      this.scope.community,
      this.scope.companionId,
      input.chainId,
      input.parentEventId,
      input.authorPubkey,
      input.eventId,
      Date.now(),
    ]);
    return result.rowCount === 1;
  }

  async registerHumanRoot(rootEventId: string, authorPubkey: string): Promise<void> {
    await this.waitUntilReady();
    await executeQuery(this.pool, `
      INSERT INTO buzz_causal_roots (
        community, companion_id, root_event_id, human_author_pubkey, observed_at_ms
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (community, companion_id, root_event_id) DO NOTHING
    `, [
      this.scope.community,
      this.scope.companionId,
      rootEventId,
      authorPubkey,
      Date.now(),
    ]);
  }

  async hasHumanRoot(rootEventId: string): Promise<boolean> {
    await this.waitUntilReady();
    const row = await queryOne<{ present: boolean }>(this.pool, `
      SELECT true AS present
      FROM buzz_causal_roots
      WHERE community = $1 AND companion_id = $2 AND root_event_id = $3
    `, [this.scope.community, this.scope.companionId, rootEventId]);
    return row?.present === true;
  }

  async markReady(eventId: string, outboundEvent: NostrEvent): Promise<void> {
    await this.transition(eventId, 'ready', {
      outboundEventJson: JSON.stringify(outboundEvent),
    });
  }

  async markCompleted(eventId: string): Promise<void> {
    await this.transition(eventId, 'completed', { expectedState: 'ready' });
  }

  async markSuppressed(eventId: string, reason: string): Promise<void> {
    await this.transition(eventId, 'suppressed', { suppressionReason: reason });
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

  async replaceMemberships(channelIds: readonly string[], observedAtMs: number): Promise<void> {
    await this.waitUntilReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        UPDATE buzz_room_memberships
        SET active = false, observed_at_ms = $3
        WHERE community = $1 AND companion_id = $2
      `, [this.scope.community, this.scope.companionId, observedAtMs]);
      for (const channelId of channelIds) {
        await client.query(`
          INSERT INTO buzz_room_memberships (
            community, companion_id, channel_id, active, observed_at_ms
          ) VALUES ($1, $2, $3, true, $4)
          ON CONFLICT (community, companion_id, channel_id) DO UPDATE SET
            active = true, observed_at_ms = excluded.observed_at_ms
        `, [this.scope.community, this.scope.companionId, channelId, observedAtMs]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setMembership(channelId: string, active: boolean, observedAtMs: number): Promise<void> {
    await this.waitUntilReady();
    await executeQuery(this.pool, `
      INSERT INTO buzz_room_memberships (
        community, companion_id, channel_id, active, observed_at_ms
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (community, companion_id, channel_id) DO UPDATE SET
        active = excluded.active,
        observed_at_ms = excluded.observed_at_ms
      WHERE buzz_room_memberships.observed_at_ms <= excluded.observed_at_ms
    `, [this.scope.community, this.scope.companionId, channelId, active, observedAtMs]);
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
    options: {
      expectedState?: BuzzInboundRecoveryState;
      outboundEventJson?: string;
      suppressionReason?: string;
    },
  ): Promise<void> {
    await this.waitUntilReady();
    const expectedState = options.expectedState ?? 'processing';
    const result = await this.pool.query(`
      UPDATE buzz_inbound_recovery
      SET state = $4,
        outbound_event_json = COALESCE($5::jsonb, outbound_event_json),
        suppression_reason = $6,
        updated_at_ms = $7
      WHERE community = $1 AND companion_id = $2 AND event_id = $3 AND state = $8
    `, [
      this.scope.community,
      this.scope.companionId,
      eventId,
      nextState,
      options.outboundEventJson ?? null,
      options.suppressionReason ?? null,
      Date.now(),
      expectedState,
    ]);
    if (result.rowCount !== 1) {
      throw new Error(`Buzz recovery event ${eventId} cannot transition from ${expectedState} to ${nextState}`);
    }
  }
}
