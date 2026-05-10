import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import {
  isPendingFollowUpExpired,
  type PendingFollowUp,
  type PendingFollowUpActivateOptions,
  type PendingFollowUpCreateInput,
  type PendingFollowUpListOptions,
} from '../pending-follow-ups.js';
import type {
  PendingFollowUpQuarantineInput,
  PendingFollowUpQuarantineListOptions,
  PendingFollowUpQuarantineRecord,
  PendingFollowUpStorePort,
} from '../pending-follow-up-store-port.js';
import {
  DEFAULT_PENDING_LIST_LIMIT,
  MAX_PENDING_ID_CHARS,
  MAX_PENDING_REASON_CHARS,
  MAX_PENDING_SUMMARY_CHARS,
  MAX_PENDING_TEXT_CHARS,
  PendingFollowUpRow,
  clampListLimit,
  encodeWakeConditions,
  mapPendingFollowUpRow,
  normalizeChannelType,
  normalizeContactId,
  normalizeIsoTimestamp,
  normalizeOptionalText,
  normalizePendingPriority,
  normalizeRequiredText,
  normalizeTiming,
} from './shared.js';

interface PendingFollowUpQuarantineRow {
  id: string;
  follow_up_id: string | null;
  reason: string;
  source: string | null;
  raw_entry: string;
  quarantined_at: string;
}

const MAX_QUARANTINE_REASON_CHARS = 1000;
const MAX_QUARANTINE_SOURCE_CHARS = 128;

function normalizeQuarantineReason(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'Invalid pending follow-up entry';
  }
  return normalized.length > MAX_QUARANTINE_REASON_CHARS
    ? normalized.slice(0, MAX_QUARANTINE_REASON_CHARS)
    : normalized;
}

function serializeQuarantineRawEntry(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    return typeof serialized === 'string' ? serialized : 'null';
  } catch (error) {
    return JSON.stringify({
      serializationError: String(error),
      value: String(value),
    });
  }
}

function deserializeQuarantineRawEntry(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toQuarantineReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mapQuarantineRow(row: PendingFollowUpQuarantineRow): PendingFollowUpQuarantineRecord {
  const followUpId = row.follow_up_id === null
    ? undefined
    : normalizeOptionalText(row.follow_up_id, 'follow_up_id', MAX_PENDING_ID_CHARS);
  const source = row.source === null
    ? undefined
    : normalizeOptionalText(row.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
  return {
    id: normalizeRequiredText(row.id, 'quarantine_id', MAX_PENDING_ID_CHARS),
    reason: normalizeRequiredText(row.reason, 'quarantine_reason', MAX_QUARANTINE_REASON_CHARS),
    raw: deserializeQuarantineRawEntry(row.raw_entry),
    quarantinedAt: normalizeIsoTimestamp(row.quarantined_at, 'quarantined_at'),
    ...(followUpId ? { followUpId } : {}),
    ...(source ? { source } : {}),
  };
}

export class PostgresPendingFollowUpStore implements PendingFollowUpStorePort {
  private pendingFollowUpCache = new Map<string, PendingFollowUp>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
  ) {}

  snapshotPendingFollowUps(contactId?: string): PendingFollowUp[] {
    const normalizedContactId = normalizeContactId(contactId);
    const asOfMs = this.now().getTime();
    return [...this.pendingFollowUpCache.values()]
      .filter((followUp) => {
        if (followUp.activatedAt) return false;
        if (isPendingFollowUpExpired(followUp, asOfMs)) return false;
        if (!normalizedContactId) return true;
        return !followUp.contactId || followUp.contactId === normalizedContactId;
      })
      .sort((left, right) => (
        Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
  }

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions, activated_at, activation_reason
        FROM intention_pending_follow_ups
      `,
    );
    const followUps: Array<readonly [string, PendingFollowUp]> = [];
    for (const row of rows) {
      const followUp = await this.mapRowOrQuarantine(row, 'hydrate');
      if (followUp) {
        followUps.push([followUp.id, followUp] as const);
      }
    }
    this.pendingFollowUpCache = new Map(followUps);
  }

  async create(input: PendingFollowUpCreateInput): Promise<PendingFollowUp> {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_PENDING_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_PENDING_TEXT_CHARS);
    const priority = normalizePendingPriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const createdAt = input.createdAt ? normalizeIsoTimestamp(input.createdAt, 'createdAt') : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_PENDING_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_PENDING_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_PENDING_ID_CHARS);
    const dueAt = input.dueAt ? normalizeIsoTimestamp(input.dueAt, 'dueAt') : undefined;
    const contactId = normalizeContactId(input.contactId);
    const sourceMessageId = normalizeContactId(input.sourceMessageId);
    const contextSummary = normalizeOptionalText(input.contextSummary, 'contextSummary', MAX_PENDING_SUMMARY_CHARS);
    const wakeConditions = encodeWakeConditions(input.wakeConditions);

    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        INSERT INTO intention_pending_follow_ups (
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        )
        RETURNING
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions, activated_at, activation_reason
      `,
      [
        id,
        content,
        priority,
        timing,
        createdAt,
        channelId,
        channelType,
        authorId,
        authorName,
        dueAt ?? null,
        contactId ?? null,
        sourceMessageId ?? null,
        contextSummary ?? null,
        wakeConditions,
      ],
    );

    if (!row) {
      throw new Error(`Failed to insert pending follow-up "${id}"`);
    }
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async enqueue(input: PendingFollowUpCreateInput): Promise<PendingFollowUp> {
    return await this.create(input);
  }

  async getById(id: string): Promise<PendingFollowUp | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_PENDING_ID_CHARS);
    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions, activated_at, activation_reason
        FROM intention_pending_follow_ups
        WHERE id = $1
      `,
      [normalizedId],
    );
    if (!row) return null;
    const followUp = await this.mapRowOrQuarantine(row, 'peek');
    if (!followUp) return null;
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async peek(id: string): Promise<PendingFollowUp | null> {
    return await this.getById(id);
  }

  async getPendingFollowUps(contactId?: string): Promise<PendingFollowUp[]> {
    return await this.list({
      contactId,
      includeActivated: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  async list(options: PendingFollowUpListOptions = {}): Promise<PendingFollowUp[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const asOfMs = Date.parse(asOf);
    const normalizedContactId = normalizeContactId(options.contactId);
    const includeActivated = options.includeActivated === true;
    const includeExpired = options.includeExpired === true;
    const limit = clampListLimit(options.limit, DEFAULT_PENDING_LIST_LIMIT);
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (!includeActivated) whereClauses.push('activated_at IS NULL');
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }

    const rows = await queryRows<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions, activated_at, activation_reason
        FROM intention_pending_follow_ups
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY created_at ASC, id ASC
      `,
      params,
    );
    const followUps: PendingFollowUp[] = [];
    for (const row of rows) {
      const followUp = await this.mapRowOrQuarantine(row, 'list');
      if (followUp) {
        followUps.push(followUp);
      }
    }
    return followUps
      .filter((followUp) => includeExpired || !isPendingFollowUpExpired(followUp, asOfMs))
      .slice(0, limit);
  }

  async markActivated(id: string, options: PendingFollowUpActivateOptions = {}): Promise<PendingFollowUp | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_PENDING_ID_CHARS);
    const activatedAt = options.activatedAt ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt') : this.now().toISOString();
    const activationReason = normalizeOptionalText(options.activationReason, 'activationReason', MAX_PENDING_REASON_CHARS);

    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        UPDATE intention_pending_follow_ups
        SET activated_at = $2, activation_reason = $3
        WHERE id = $1 AND activated_at IS NULL
        RETURNING
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id,
          context_summary, wake_conditions, activated_at, activation_reason
      `,
      [normalizedId, activatedAt, activationReason ?? null],
    );
    if (!row) return null;
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async dequeue(id: string, options: PendingFollowUpActivateOptions = {}): Promise<PendingFollowUp | null> {
    return await this.markActivated(id, options);
  }

  async quarantine(input: PendingFollowUpQuarantineInput): Promise<PendingFollowUpQuarantineRecord> {
    const id = normalizeRequiredText(randomUUID(), 'quarantine_id', MAX_PENDING_ID_CHARS);
    const followUpId = normalizeOptionalText(input.followUpId, 'follow_up_id', MAX_PENDING_ID_CHARS);
    const reason = normalizeQuarantineReason(input.reason);
    const source = normalizeOptionalText(input.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
    const quarantinedAt = input.quarantinedAt
      ? normalizeIsoTimestamp(input.quarantinedAt, 'quarantinedAt')
      : this.now().toISOString();
    const rawEntry = serializeQuarantineRawEntry(input.raw);

    const row = await queryOne<PendingFollowUpQuarantineRow>(
      this.pool,
      `
        INSERT INTO intention_pending_follow_up_quarantine (
          id, follow_up_id, reason, source, raw_entry, quarantined_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        )
        RETURNING id, follow_up_id, reason, source, raw_entry, quarantined_at
      `,
      [
        id,
        followUpId ?? null,
        reason,
        source ?? null,
        rawEntry,
        quarantinedAt,
      ],
    );
    if (!row) {
      throw new Error(`Failed to insert pending follow-up quarantine "${id}"`);
    }
    if (followUpId) {
      await this.deleteRawFollowUp(followUpId);
    }
    return mapQuarantineRow(row);
  }

  async listQuarantined(
    options: PendingFollowUpQuarantineListOptions = {},
  ): Promise<PendingFollowUpQuarantineRecord[]> {
    const followUpId = normalizeOptionalText(options.followUpId, 'follow_up_id', MAX_PENDING_ID_CHARS);
    const source = normalizeOptionalText(options.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
    const limit = clampListLimit(options.limit, DEFAULT_PENDING_LIST_LIMIT);
    const params: unknown[] = [];
    const whereClauses: string[] = [];
    if (followUpId) {
      params.push(followUpId);
      whereClauses.push(`follow_up_id = $${params.length}`);
    }
    if (source) {
      params.push(source);
      whereClauses.push(`source = $${params.length}`);
    }
    params.push(limit);
    const rows = await queryRows<PendingFollowUpQuarantineRow>(
      this.pool,
      `
        SELECT id, follow_up_id, reason, source, raw_entry, quarantined_at
        FROM intention_pending_follow_up_quarantine
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY quarantined_at ASC, id ASC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapQuarantineRow);
  }

  private async mapRowOrQuarantine(
    row: PendingFollowUpRow,
    source: string,
  ): Promise<PendingFollowUp | null> {
    try {
      return mapPendingFollowUpRow(row);
    } catch (error) {
      await this.quarantine({
        followUpId: row.id,
        reason: toQuarantineReason(error),
        raw: row,
        source,
      });
      return null;
    }
  }

  private async deleteRawFollowUp(id: string): Promise<void> {
    await this.pool.query(
      `
        DELETE FROM intention_pending_follow_ups
        WHERE id = $1
      `,
      [id],
    );
    this.pendingFollowUpCache.delete(id);
  }
}
