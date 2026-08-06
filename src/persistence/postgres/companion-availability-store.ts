import type { Pool, QueryResultRow } from 'pg';

import type {
  CompanionAvailabilitySnapshot,
  CompanionAvailabilityState,
  CompanionAvailabilityStorePort,
  QueuedCompanionMessage,
} from '../../core/agent/companion-availability.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS } from './migrations.js';

interface AvailabilityRow extends QueryResultRow {
  state: string;
  since_ms: string | number;
  revision: string | number;
}

interface QueuedMessageRow extends QueryResultRow {
  sequence: string | number;
  enqueued_at_ms: string | number;
  message_json: unknown;
}

function safeInteger(value: string | number, field: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Companion availability ${field} must be a non-negative safe integer`);
  }
  return number;
}

function parseState(value: unknown): CompanionAvailabilityState {
  if (value !== 'available' && value !== 'idle' && value !== 'do_not_disturb') {
    throw new Error('Companion availability state row is invalid');
  }
  return value;
}

function parseMessage(value: unknown): SubstrateMessage {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.channelId !== 'string'
    || typeof value.channelType !== 'string'
    || typeof value.authorId !== 'string'
    || typeof value.authorName !== 'string'
    || typeof value.content !== 'string'
    || typeof value.timestamp !== 'string') {
    throw new Error('Companion protected message row is invalid');
  }
  const timestamp = new Date(value.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('Companion protected message timestamp is invalid');
  }
  return { ...(value as unknown as SubstrateMessage), timestamp };
}

export class PostgresCompanionAvailabilityStore implements CompanionAvailabilityStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresCompanionAvailabilityStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'companion-availability',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_COMPANION_AVAILABILITY_MIGRATIONS);
    return new PostgresCompanionAvailabilityStore(pool);
  }

  async readState(): Promise<CompanionAvailabilitySnapshot> {
    const row = await queryOne<AvailabilityRow>(this.pool, `
      SELECT state, since_ms, revision
      FROM companion_availability_state
      WHERE singleton_id = 1
    `);
    if (!row) throw new Error('Companion availability singleton row is missing');
    return {
      state: parseState(row.state),
      sinceMs: safeInteger(row.since_ms, 'sinceMs'),
      revision: safeInteger(row.revision, 'revision'),
    };
  }

  async writeState(snapshot: CompanionAvailabilitySnapshot): Promise<void> {
    const state = parseState(snapshot.state);
    const sinceMs = safeInteger(snapshot.sinceMs, 'sinceMs');
    const revision = safeInteger(snapshot.revision, 'revision');
    const result = await this.pool.query(`
      UPDATE companion_availability_state
      SET state = $1, since_ms = $2, revision = $3
      WHERE singleton_id = 1
        AND revision < $3
    `, [state, sinceMs, revision]);
    if (result.rowCount !== 1) throw new Error('Companion availability singleton update failed');
  }

  async enqueue(
    message: SubstrateMessage,
    enqueuedAtMs: number,
  ): Promise<'enqueued' | 'duplicate'> {
    const normalizedEnqueuedAtMs = safeInteger(enqueuedAtMs, 'enqueuedAtMs');
    const result = await this.pool.query(`
      INSERT INTO companion_protected_message_queue (
        channel_id, message_id, enqueued_at_ms, message_json
      ) VALUES ($1, $2, $3, $4::jsonb)
      ON CONFLICT (channel_id, message_id) DO NOTHING
      RETURNING sequence
    `, [message.channelId, message.id, normalizedEnqueuedAtMs, JSON.stringify(message)]);
    return result.rowCount === 1 ? 'enqueued' : 'duplicate';
  }

  async listPending(limit: number): Promise<QueuedCompanionMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error('Companion availability queue limit must be a positive integer');
    }
    const rows = await queryRows<QueuedMessageRow>(this.pool, `
      SELECT sequence, enqueued_at_ms, message_json
      FROM companion_protected_message_queue
      ORDER BY sequence ASC
      LIMIT $1
    `, [limit]);
    return rows.map(row => ({
      sequence: safeInteger(row.sequence, 'queue sequence'),
      enqueuedAtMs: safeInteger(row.enqueued_at_ms, 'enqueuedAtMs'),
      message: parseMessage(row.message_json),
    }));
  }

  async hasPending(): Promise<boolean> {
    const row = await queryOne<{ pending: boolean }>(this.pool, `
      SELECT EXISTS (
        SELECT 1 FROM companion_protected_message_queue
      ) AS pending
    `);
    if (!row || typeof row.pending !== 'boolean') {
      throw new Error('Companion availability queue status row is invalid');
    }
    return row.pending;
  }

  async acknowledge(sequence: number): Promise<boolean> {
    const normalizedSequence = safeInteger(sequence, 'queue sequence');
    const result = await this.pool.query(
      'DELETE FROM companion_protected_message_queue WHERE sequence = $1',
      [normalizedSequence],
    );
    return result.rowCount === 1;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
