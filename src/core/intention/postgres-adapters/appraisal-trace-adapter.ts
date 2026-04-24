import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import {
  isPendingFollowUpExpired,
  type PendingFollowUp,
  type PendingFollowUpActivateOptions,
  type PendingFollowUpCreateInput,
  type PendingFollowUpListOptions,
} from '../pending-follow-ups.js';
import {
  DEFAULT_PENDING_LIST_LIMIT,
  MAX_PENDING_ID_CHARS,
  MAX_PENDING_REASON_CHARS,
  MAX_PENDING_TEXT_CHARS,
  PendingFollowUpRow,
  clampListLimit,
  mapPendingFollowUpRow,
  normalizeChannelType,
  normalizeContactId,
  normalizeIsoTimestamp,
  normalizeOptionalText,
  normalizePendingPriority,
  normalizeRequiredText,
  normalizeTiming,
} from './shared.js';

export class PostgresPendingFollowUpStore {
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
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
      `,
    );
    this.pendingFollowUpCache = new Map(
      rows.map((row) => {
        const followUp = mapPendingFollowUpRow(row);
        return [followUp.id, followUp] as const;
      }),
    );
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

    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        INSERT INTO intention_pending_follow_ups (
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
        RETURNING
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
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
      ],
    );

    if (!row) {
      throw new Error(`Failed to insert pending follow-up "${id}"`);
    }
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async getById(id: string): Promise<PendingFollowUp | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_PENDING_ID_CHARS);
    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
        WHERE id = $1
      `,
      [normalizedId],
    );
    if (!row) return null;
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
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
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY created_at ASC, id ASC
      `,
      params,
    );
    return rows
      .map(mapPendingFollowUpRow)
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
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
      `,
      [normalizedId, activatedAt, activationReason ?? null],
    );
    if (!row) return null;
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }
}