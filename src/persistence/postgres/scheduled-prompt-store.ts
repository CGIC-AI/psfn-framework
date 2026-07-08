import type { Pool, QueryResultRow } from 'pg';
import {
  CHANNEL_TYPES,
  type ChannelType,
} from '../../shared/contracts/runtime.js';
import {
  createPostgresPool,
  ensurePostgresSchema,
  queryOne,
  queryRows,
} from '../postgres.js';
import { POSTGRES_SCHEDULED_PROMPT_MIGRATIONS } from './migrations.js';
import type {
  ScheduledPromptCreateInput,
  ScheduledPromptRecord,
  ScheduledPromptSource,
  ScheduledPromptStatus,
  ScheduledPromptStorePort,
} from '../../core/scheduler/scheduled-prompt-store-port.js';

const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 1_000;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_PROMPT_CHARS = 32_000;
const MAX_CHANNEL_ID_CHARS = 512;
const MAX_AUTHOR_CHARS = 256;
const VALID_CHANNEL_TYPES = new Set<string>(CHANNEL_TYPES);

interface ScheduledPromptRow extends QueryResultRow {
  id: string;
  name: string;
  prompt: string;
  run_at: string;
  created_at: string;
  source: string;
  channel_id: string;
  channel_type: string;
  author_id: string;
  author_name: string;
  status: string;
  delivery_channel_id: string | null;
  completed_at: string | null;
}

function normalizeRequiredText(value: unknown, fieldName: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Scheduled prompt ${fieldName} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Scheduled prompt ${fieldName} must be a non-empty string`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Scheduled prompt ${fieldName} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: unknown,
  fieldName: string,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredText(value, fieldName, maxLength);
}

function normalizeIsoTimestamp(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 64);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Scheduled prompt ${fieldName} must be an ISO-8601 timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeSource(value: unknown): ScheduledPromptSource {
  if (value !== 'schedule_tool') {
    throw new Error('Scheduled prompt source must be schedule_tool');
  }
  return value;
}

function normalizeStatus(value: unknown): ScheduledPromptStatus {
  if (value !== 'pending' && value !== 'completed') {
    throw new Error('Scheduled prompt status must be pending or completed');
  }
  return value;
}

function normalizeChannelType(value: unknown): ChannelType {
  if (typeof value !== 'string' || !VALID_CHANNEL_TYPES.has(value)) {
    throw new Error(`Scheduled prompt channelType must be one of: ${CHANNEL_TYPES.join(', ')}`);
  }
  return value as ChannelType;
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT) {
    throw new Error(`Scheduled prompt list limit must be an integer between 1 and ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function mapRow(row: ScheduledPromptRow): ScheduledPromptRecord {
  const completedAt = row.completed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.completed_at, 'completedAt');
  return {
    id: normalizeRequiredText(row.id, 'id', MAX_ID_CHARS),
    name: normalizeRequiredText(row.name, 'name', MAX_NAME_CHARS),
    prompt: normalizeRequiredText(row.prompt, 'prompt', MAX_PROMPT_CHARS),
    runAt: normalizeIsoTimestamp(row.run_at, 'runAt'),
    createdAt: normalizeIsoTimestamp(row.created_at, 'createdAt'),
    source: normalizeSource(row.source),
    channelId: normalizeRequiredText(row.channel_id, 'channelId', MAX_CHANNEL_ID_CHARS),
    channelType: normalizeChannelType(row.channel_type),
    authorId: normalizeRequiredText(row.author_id, 'authorId', MAX_AUTHOR_CHARS),
    authorName: normalizeRequiredText(row.author_name, 'authorName', MAX_AUTHOR_CHARS),
    status: normalizeStatus(row.status),
    ...(row.delivery_channel_id !== null
      ? { deliveryChannelId: normalizeRequiredText(row.delivery_channel_id, 'deliveryChannelId', MAX_CHANNEL_ID_CHARS) }
      : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

export class PostgresScheduledPromptStore implements ScheduledPromptStorePort {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string } = {},
  ): Promise<PostgresScheduledPromptStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-scheduled-prompts',
      allowExitOnIdle: true,
      schema: options.schema,
    });
    await ensurePostgresSchema(pool, POSTGRES_SCHEDULED_PROMPT_MIGRATIONS);
    return new PostgresScheduledPromptStore(pool);
  }

  async create(input: ScheduledPromptCreateInput): Promise<ScheduledPromptRecord> {
    const id = normalizeRequiredText(input.id, 'id', MAX_ID_CHARS);
    const name = normalizeRequiredText(input.name, 'name', MAX_NAME_CHARS);
    const prompt = normalizeRequiredText(input.prompt, 'prompt', MAX_PROMPT_CHARS);
    const runAt = normalizeIsoTimestamp(input.runAt, 'runAt');
    const createdAt = input.createdAt === undefined
      ? new Date().toISOString()
      : normalizeIsoTimestamp(input.createdAt, 'createdAt');
    const source = normalizeSource(input.source);
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_CHANNEL_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_AUTHOR_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_AUTHOR_CHARS);
    const deliveryChannelId = normalizeOptionalText(
      input.deliveryChannelId,
      'deliveryChannelId',
      MAX_CHANNEL_ID_CHARS,
    );

    const row = await queryOne<ScheduledPromptRow>(this.pool, `
      INSERT INTO scheduler_scheduled_prompts (
        id, name, prompt, run_at, created_at, source, channel_id, channel_type,
        author_id, author_name, status, delivery_channel_id, completed_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, NULL
      )
      RETURNING
        id, name, prompt, run_at, created_at, source, channel_id, channel_type,
        author_id, author_name, status, delivery_channel_id, completed_at
    `, [
      id,
      name,
      prompt,
      runAt,
      createdAt,
      source,
      channelId,
      channelType,
      authorId,
      authorName,
      deliveryChannelId ?? null,
    ]);
    if (!row) {
      throw new Error(`Failed to create scheduled prompt "${id}"`);
    }
    return mapRow(row);
  }

  async listPending(options: { limit?: number } = {}): Promise<ScheduledPromptRecord[]> {
    const limit = normalizeLimit(options.limit);
    const rows = await queryRows<ScheduledPromptRow>(this.pool, `
      SELECT
        id, name, prompt, run_at, created_at, source, channel_id, channel_type,
        author_id, author_name, status, delivery_channel_id, completed_at
      FROM scheduler_scheduled_prompts
      WHERE status = 'pending'
      ORDER BY run_at ASC, created_at ASC, id ASC
      LIMIT $1
    `, [limit]);
    return rows.map(mapRow);
  }

  async markCompleted(
    id: string,
    options: { completedAt?: string } = {},
  ): Promise<ScheduledPromptRecord | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const completedAt = options.completedAt === undefined
      ? new Date().toISOString()
      : normalizeIsoTimestamp(options.completedAt, 'completedAt');
    const row = await queryOne<ScheduledPromptRow>(this.pool, `
      UPDATE scheduler_scheduled_prompts
      SET status = 'completed',
          completed_at = $2
      WHERE id = $1
        AND status = 'pending'
      RETURNING
        id, name, prompt, run_at, created_at, source, channel_id, channel_type,
        author_id, author_name, status, delivery_channel_id, completed_at
    `, [normalizedId, completedAt]);
    return row ? mapRow(row) : null;
  }
}
