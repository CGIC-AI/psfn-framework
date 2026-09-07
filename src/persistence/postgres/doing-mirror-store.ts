import type { Pool, QueryResultRow } from 'pg';

import {
  type DoingMirrorDispositionRecord,
  type DoingMirrorItemType,
  type DoingMirrorLetterFailureInput,
  type DoingMirrorState,
  type DoingMirrorStorePort,
  type DoingMirrorTransitionStoreInput,
} from '../../core/doing-mirror/contracts.js';
import { createPostgresPool, ensurePostgresSchema, queryOne, queryRows } from '../postgres.js';
import { POSTGRES_DOING_MIRROR_MIGRATIONS } from './migrations.js';

interface DoingMirrorRow extends QueryResultRow {
  item_type: string;
  item_id: string;
  state: string;
  reason: string | null;
  version: number;
  updated_at_ms: string | number;
  updated_by: string;
  letter_id: string;
  letter_subject: string;
  letter_body: string;
  letter_delivered_at_ms: string | number | null;
  letter_failure_count: number;
  letter_last_error: string | null;
  letter_last_failed_at_ms: string | number | null;
  letter_quarantined_at_ms: string | number | null;
}

const COLUMNS = `
  item_type, item_id, state, reason, version, updated_at_ms, updated_by,
  letter_id, letter_subject, letter_body, letter_delivered_at_ms,
  letter_failure_count, letter_last_error, letter_last_failed_at_ms,
  letter_quarantined_at_ms
`;

function parseItemType(value: string): DoingMirrorItemType {
  if (value !== 'wishlist' && value !== 'fold_package') {
    throw new Error('Doing-mirror item_type row is invalid');
  }
  return value;
}

function parseState(value: string): Exclude<DoingMirrorState, 'open'> {
  if (value !== 'considering' && value !== 'done' && value !== 'declined') {
    throw new Error('Doing-mirror state row is invalid');
  }
  return value;
}

function parseTimestamp(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Doing-mirror ${field} row is invalid`);
  }
  return parsed;
}

function parseVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('Doing-mirror version row is invalid');
  }
  return value;
}

function parseFailureCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Doing-mirror letter_failure_count row is invalid');
  }
  return value;
}

/**
 * The failure columns have no database CHECK (see POSTGRES_DOING_MIRROR_MIGRATIONS),
 * so the pairing invariant is proved here: a non-zero consecutive-failure count
 * always carries the evidence an operator needs, and a zero count never claims
 * a failure or a quarantine.
 */
function mapFailureState(row: DoingMirrorRow): {
  failureCount: number;
  lastError?: string;
  lastFailedAt?: number;
  quarantinedAt?: number;
} {
  const failureCount = parseFailureCount(row.letter_failure_count);
  const lastError = row.letter_last_error?.trim() || undefined;
  const lastFailedAt = row.letter_last_failed_at_ms === null
    ? undefined
    : parseTimestamp(row.letter_last_failed_at_ms, 'letter_last_failed_at_ms');
  const quarantinedAt = row.letter_quarantined_at_ms === null
    ? undefined
    : parseTimestamp(row.letter_quarantined_at_ms, 'letter_quarantined_at_ms');
  if (failureCount === 0) {
    if (lastError !== undefined || lastFailedAt !== undefined || quarantinedAt !== undefined) {
      throw new Error('Doing-mirror row reports delivery-failure evidence without a failure count');
    }
  } else if (lastError === undefined || lastFailedAt === undefined) {
    throw new Error('Doing-mirror failed-delivery row is missing its last error or timestamp');
  }
  return {
    failureCount,
    ...(lastError !== undefined ? { lastError } : {}),
    ...(lastFailedAt !== undefined ? { lastFailedAt } : {}),
    ...(quarantinedAt !== undefined ? { quarantinedAt } : {}),
  };
}

function mapRow(row: DoingMirrorRow): DoingMirrorDispositionRecord {
  if (row.updated_by !== 'partner') throw new Error('Doing-mirror updated_by row is invalid');
  if (!row.item_id.trim() || !row.letter_subject.trim() || !row.letter_body.trim()) {
    throw new Error('Doing-mirror row contains empty required text');
  }
  const state = parseState(row.state);
  const reason = row.reason?.trim() || undefined;
  if (state === 'declined' && !reason) throw new Error('Doing-mirror declined row has no reason');
  const deliveredAt = row.letter_delivered_at_ms === null
    ? undefined
    : parseTimestamp(row.letter_delivered_at_ms, 'letter_delivered_at_ms');
  return {
    itemType: parseItemType(row.item_type),
    itemId: row.item_id,
    state,
    ...(reason ? { reason } : {}),
    version: parseVersion(row.version),
    updatedAt: parseTimestamp(row.updated_at_ms, 'updated_at_ms'),
    updatedBy: 'partner',
    notification: {
      letterId: row.letter_id,
      subject: row.letter_subject,
      body: row.letter_body,
      ...(deliveredAt !== undefined ? { deliveredAt } : {}),
      ...mapFailureState(row),
    },
  };
}

function assertTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Doing-mirror ${field} must be a non-negative safe integer`);
  }
}

export class PostgresDoingMirrorStore implements DoingMirrorStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresDoingMirrorStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'doing-mirror',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    try {
      await ensurePostgresSchema(pool, POSTGRES_DOING_MIRROR_MIGRATIONS);
      return new PostgresDoingMirrorStore(pool);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw error;
    }
  }

  async get(
    itemType: DoingMirrorItemType,
    itemId: string,
  ): Promise<DoingMirrorDispositionRecord | null> {
    const row = await queryOne<DoingMirrorRow>(this.pool, `
      SELECT ${COLUMNS}
      FROM doing_mirror_dispositions
      WHERE item_type = $1 AND item_id = $2
    `, [itemType, itemId]);
    return row ? mapRow(row) : null;
  }

  async list(): Promise<DoingMirrorDispositionRecord[]> {
    const rows = await queryRows<DoingMirrorRow>(this.pool, `
      SELECT ${COLUMNS}
      FROM doing_mirror_dispositions
      ORDER BY updated_at_ms DESC, item_type, item_id
    `);
    return rows.map(mapRow);
  }

  async listPendingLetterDeliveries(limit: number): Promise<DoingMirrorDispositionRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Doing-mirror pending Letter delivery limit must be a positive safe integer');
    }
    const rows = await queryRows<DoingMirrorRow>(this.pool, `
      SELECT ${COLUMNS}
      FROM doing_mirror_dispositions
      WHERE letter_delivered_at_ms IS NULL
        AND letter_quarantined_at_ms IS NULL
      ORDER BY updated_at_ms, item_type, item_id
      LIMIT $1
    `, [limit]);
    return rows.map(mapRow);
  }

  async recordLetterDeliveryFailure(
    input: DoingMirrorLetterFailureInput,
  ): Promise<DoingMirrorDispositionRecord> {
    assertTimestamp(input.failedAt, 'failedAt');
    if (!Number.isSafeInteger(input.maxDeliveryFailures) || input.maxDeliveryFailures < 1) {
      throw new Error('Doing-mirror maxDeliveryFailures must be a positive safe integer');
    }
    const error = input.error.trim();
    if (!error) throw new Error('Doing-mirror delivery failure requires a non-empty error message');
    // Scoped to letter_id and to an undelivered row so a late failure from a
    // superseded transition can neither resurrect nor poison the current Letter.
    const row = await queryOne<DoingMirrorRow>(this.pool, `
      UPDATE doing_mirror_dispositions
      SET letter_failure_count = letter_failure_count + 1,
          letter_last_error = $4,
          letter_last_failed_at_ms = $5,
          letter_quarantined_at_ms = CASE
            WHEN letter_failure_count + 1 >= $6 THEN COALESCE(letter_quarantined_at_ms, $5)
            ELSE letter_quarantined_at_ms
          END
      WHERE item_type = $1
        AND item_id = $2
        AND letter_id = $3::uuid
        AND letter_delivered_at_ms IS NULL
      RETURNING ${COLUMNS}
    `, [
      input.itemType,
      input.itemId,
      input.letterId,
      error,
      input.failedAt,
      input.maxDeliveryFailures,
    ]);
    if (!row) {
      throw new Error(
        `Doing-mirror ${input.itemType}:${input.itemId} delivery failure does not match a pending transition`,
      );
    }
    return mapRow(row);
  }

  async resetLetterDeliveryFailures(
    itemType: DoingMirrorItemType,
    itemId: string,
  ): Promise<DoingMirrorDispositionRecord> {
    const row = await queryOne<DoingMirrorRow>(this.pool, `
      UPDATE doing_mirror_dispositions
      SET letter_failure_count = 0,
          letter_last_error = NULL,
          letter_last_failed_at_ms = NULL,
          letter_quarantined_at_ms = NULL
      WHERE item_type = $1 AND item_id = $2
      RETURNING ${COLUMNS}
    `, [itemType, itemId]);
    if (!row) throw new Error(`Doing-mirror ${itemType}:${itemId} has no disposition to retry`);
    return mapRow(row);
  }

  async transition(input: DoingMirrorTransitionStoreInput): Promise<DoingMirrorDispositionRecord> {
    assertTimestamp(input.updatedAt, 'updatedAt');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('Doing-mirror expectedVersion must be a non-negative safe integer');
    }
    const values = [
      input.itemType,
      input.itemId,
      input.state,
      input.reason ?? null,
      input.updatedAt,
      input.letterId,
      input.letterSubject,
      input.letterBody,
    ];
    let row: DoingMirrorRow | undefined;
    if (input.expectedState === 'open' && input.expectedVersion === 0) {
      row = await queryOne<DoingMirrorRow>(this.pool, `
        INSERT INTO doing_mirror_dispositions (
          item_type, item_id, state, reason, version, updated_at_ms, updated_by,
          letter_id, letter_subject, letter_body, letter_delivered_at_ms,
          letter_failure_count, letter_last_error, letter_last_failed_at_ms,
          letter_quarantined_at_ms
        ) VALUES ($1, $2, $3, $4, 1, $5, 'partner', $6::uuid, $7, $8, NULL, 0, NULL, NULL, NULL)
        ON CONFLICT (item_type, item_id) DO NOTHING
        RETURNING ${COLUMNS}
      `, values);
    } else {
      row = await queryOne<DoingMirrorRow>(this.pool, `
        UPDATE doing_mirror_dispositions
        SET state = $3,
            reason = $4,
            version = version + 1,
            updated_at_ms = $5,
            updated_by = 'partner',
            letter_id = $6::uuid,
            letter_subject = $7,
            letter_body = $8,
            letter_delivered_at_ms = NULL,
            letter_failure_count = 0,
            letter_last_error = NULL,
            letter_last_failed_at_ms = NULL,
            letter_quarantined_at_ms = NULL
        WHERE item_type = $1
          AND item_id = $2
          AND state = $9
          AND version = $10
          AND updated_at_ms <= $5
        RETURNING ${COLUMNS}
      `, [...values, input.expectedState, input.expectedVersion]);
    }
    if (!row) {
      throw new Error(`Doing-mirror ${input.itemType}:${input.itemId} transition lost its expected-state race`);
    }
    return mapRow(row);
  }

  async markLetterDelivered(
    itemType: DoingMirrorItemType,
    itemId: string,
    letterId: string,
    deliveredAt: number,
  ): Promise<DoingMirrorDispositionRecord> {
    assertTimestamp(deliveredAt, 'deliveredAt');
    const row = await queryOne<DoingMirrorRow>(this.pool, `
      UPDATE doing_mirror_dispositions
      SET letter_delivered_at_ms = COALESCE(letter_delivered_at_ms, $4),
          letter_failure_count = 0,
          letter_last_error = NULL,
          letter_last_failed_at_ms = NULL,
          letter_quarantined_at_ms = NULL
      WHERE item_type = $1
        AND item_id = $2
        AND letter_id = $3::uuid
        AND updated_at_ms <= $4
      RETURNING ${COLUMNS}
    `, [itemType, itemId, letterId, deliveredAt]);
    if (!row) throw new Error(`Doing-mirror ${itemType}:${itemId} Letter delivery does not match the current transition`);
    return mapRow(row);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
