import type { Pool, QueryResultRow } from 'pg';

import {
  type CreateLetterInput,
  type LetterParty,
  type LetterRecord,
  type LetterState,
  type LetterStorePort,
  type ListLettersInput,
} from '../../core/letters/contracts.js';
import { createPostgresPool, ensurePostgresSchema, queryOne, queryRows } from '../postgres.js';
import { POSTGRES_LETTER_MIGRATIONS } from './migrations.js';

interface LetterRow extends QueryResultRow {
  id: string;
  author_kind: string;
  recipient_kind: string;
  subject: string;
  body: string;
  state: string;
  created_at_ms: string | number;
  updated_at_ms: string | number;
  placed_at_ms: string | number | null;
  read_at_ms: string | number | null;
  archived_at_ms: string | number | null;
}

const LETTER_COLUMNS = `
  id, author_kind, recipient_kind, subject, body, state,
  created_at_ms, updated_at_ms, placed_at_ms, read_at_ms, archived_at_ms
`;

function parseParty(value: string, field: string): LetterParty {
  if (value !== 'companion' && value !== 'partner') {
    throw new Error(`Letter ${field} row is invalid`);
  }
  return value;
}

function parseState(value: string): LetterState {
  if (value !== 'draft' && value !== 'placed' && value !== 'read' && value !== 'archived') {
    throw new Error('Letter state row is invalid');
  }
  return value;
}

function timestamp(value: string | number, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Letter ${field} row is invalid`);
  return parsed;
}

function optionalTimestamp(value: string | number | null, field: string): number | undefined {
  return value === null ? undefined : timestamp(value, field);
}

function mapLetter(row: LetterRow): LetterRecord {
  return {
    id: row.id,
    author: parseParty(row.author_kind, 'author'),
    recipient: parseParty(row.recipient_kind, 'recipient'),
    subject: row.subject,
    body: row.body,
    state: parseState(row.state),
    createdAt: timestamp(row.created_at_ms, 'createdAt'),
    updatedAt: timestamp(row.updated_at_ms, 'updatedAt'),
    ...(optionalTimestamp(row.placed_at_ms, 'placedAt') !== undefined
      ? { placedAt: optionalTimestamp(row.placed_at_ms, 'placedAt') }
      : {}),
    ...(optionalTimestamp(row.read_at_ms, 'readAt') !== undefined
      ? { readAt: optionalTimestamp(row.read_at_ms, 'readAt') }
      : {}),
    ...(optionalTimestamp(row.archived_at_ms, 'archivedAt') !== undefined
      ? { archivedAt: optionalTimestamp(row.archived_at_ms, 'archivedAt') }
      : {}),
  };
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Letter timestamp is invalid');
}

export class PostgresLetterStore implements LetterStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string; role?: string } = {},
  ): Promise<PostgresLetterStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'letters',
      allowExitOnIdle: true,
      schema: options.schema,
      role: options.role,
    });
    await ensurePostgresSchema(pool, POSTGRES_LETTER_MIGRATIONS);
    return new PostgresLetterStore(pool);
  }

  async create(input: CreateLetterInput): Promise<LetterRecord> {
    assertTimestamp(input.createdAt);
    const row = await queryOne<LetterRow>(this.pool, `
      INSERT INTO letters (
        id, author_kind, recipient_kind, subject, body, state,
        created_at_ms, updated_at_ms, placed_at_ms
      ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $7, $8)
      RETURNING ${LETTER_COLUMNS}
    `, [
      input.id,
      input.author,
      input.recipient,
      input.subject,
      input.body,
      input.state,
      input.createdAt,
      input.state === 'placed' ? input.createdAt : null,
    ]);
    if (!row) throw new Error('Letter insert did not return a row');
    return mapLetter(row);
  }

  async get(id: string): Promise<LetterRecord | null> {
    const row = await queryOne<LetterRow>(
      this.pool,
      `SELECT ${LETTER_COLUMNS} FROM letters WHERE id = $1::uuid`,
      [id],
    );
    return row ? mapLetter(row) : null;
  }

  async list(input: ListLettersInput): Promise<LetterRecord[]> {
    const states = input.states && input.states.length > 0 ? input.states : null;
    const rows = await queryRows<LetterRow>(this.pool, `
      SELECT ${LETTER_COLUMNS}
      FROM letters
      WHERE (
        ($2::text = 'inbox' AND recipient_kind = $1)
        OR ($2::text = 'outbox' AND author_kind = $1)
        OR ($2::text IS NULL AND (recipient_kind = $1 OR author_kind = $1))
      )
        AND ($3::text[] IS NULL OR state = ANY($3::text[]))
      ORDER BY updated_at_ms DESC, id DESC
      LIMIT $4
    `, [input.party, input.direction ?? null, states, input.limit]);
    return rows.map(mapLetter);
  }

  async place(id: string, actor: LetterParty, at: number): Promise<LetterRecord> {
    assertTimestamp(at);
    const row = await queryOne<LetterRow>(this.pool, `
      UPDATE letters
      SET state = 'placed', updated_at_ms = $3, placed_at_ms = $3
      WHERE id = $1::uuid AND author_kind = $2 AND state = 'draft'
      RETURNING ${LETTER_COLUMNS}
    `, [id, actor, at]);
    if (!row) throw new Error('Letter can only be placed by its author from draft');
    return mapLetter(row);
  }

  async markRead(id: string, reader: LetterParty, at: number): Promise<LetterRecord> {
    assertTimestamp(at);
    const row = await queryOne<LetterRow>(this.pool, `
      UPDATE letters
      SET state = 'read', updated_at_ms = $3, read_at_ms = $3
      WHERE id = $1::uuid AND recipient_kind = $2 AND state = 'placed'
      RETURNING ${LETTER_COLUMNS}
    `, [id, reader, at]);
    if (!row) throw new Error('Letter can only be read once by its recipient after placement');
    return mapLetter(row);
  }

  async archive(id: string, actor: LetterParty, at: number): Promise<LetterRecord> {
    assertTimestamp(at);
    const row = await queryOne<LetterRow>(this.pool, `
      UPDATE letters
      SET state = 'archived', updated_at_ms = $3, archived_at_ms = $3
      WHERE id = $1::uuid
        AND (author_kind = $2 OR recipient_kind = $2)
        AND state = 'read'
      RETURNING ${LETTER_COLUMNS}
    `, [id, actor, at]);
    if (!row) throw new Error('Letter can only be archived by a participant after it is read');
    return mapLetter(row);
  }

  async countWaiting(recipient: LetterParty): Promise<number> {
    const row = await queryOne<{ count: string | number }>(this.pool, `
      SELECT COUNT(*)::bigint AS count
      FROM letters
      WHERE recipient_kind = $1 AND state = 'placed'
    `, [recipient]);
    if (!row) throw new Error('Letter waiting count did not return a row');
    return timestamp(row.count, 'waiting count');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
