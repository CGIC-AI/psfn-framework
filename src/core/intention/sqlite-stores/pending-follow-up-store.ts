import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  PendingFollowUpQuarantineInput,
  PendingFollowUpQuarantineListOptions,
  PendingFollowUpQuarantineRecord,
  PendingFollowUpStorePort,
} from '../pending-follow-up-store-port.js';
import {
  MAX_ID_CHARS,
  MAX_LIST_LIMIT,
  MAX_QUARANTINE_SOURCE_CHARS,
  MAX_REASON_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TEXT_CHARS,
  PENDING_FOLLOW_UPS_TABLE,
  PENDING_FOLLOW_UP_QUARANTINE_TABLE,
  clampListLimit,
  encodeWakeConditions,
  isPendingFollowUpExpired,
  log,
  mapQuarantineRow,
  mapRow,
  normalizeBacklogCap,
  normalizeChannelType,
  normalizeIsoTimestamp,
  normalizeOptionalId,
  normalizeOptionalText,
  normalizePriority,
  normalizeQuarantineReason,
  normalizeRequiredText,
  normalizeTiming,
  normalizeWakeConditions,
  resolvePendingFollowUpDueAtForWrite,
  resolvePendingFollowUpEnqueueResolution,
  serializeQuarantineRawEntry,
  toQuarantineReason,
} from '../pending-follow-ups.js';
import type {
  PendingFollowUp,
  PendingFollowUpActivateOptions,
  PendingFollowUpContextProvider,
  PendingFollowUpCreateInput,
  PendingFollowUpListOptions,
  PendingFollowUpQuarantineRow,
  PendingFollowUpRow,
  PendingFollowUpStoreOptions,
  PendingFollowUpUpdateInput,
} from '../pending-follow-ups.js';

export class PendingFollowUpStore implements PendingFollowUpContextProvider, PendingFollowUpStorePort {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly backlogCap: number;

  constructor(db: Database.Database, options: PendingFollowUpStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.backlogCap = normalizeBacklogCap(options.backlogCap);
    this.initializeSchema();
  }

  create(input: PendingFollowUpCreateInput): PendingFollowUp {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const dueAt = resolvePendingFollowUpDueAtForWrite({ timing, createdAt, dueAt: input.dueAt }, this.now());
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);
    const contextSummary = normalizeOptionalText(
      input.contextSummary,
      'contextSummary',
      MAX_SUMMARY_CHARS,
    );
    const wakeConditions = normalizeWakeConditions(input.wakeConditions);

    this.db.prepare(`
      INSERT INTO ${PENDING_FOLLOW_UPS_TABLE} (
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions
      ) VALUES (
        @id,
        @content,
        @priority,
        @timing,
        @created_at,
        @channel_id,
        @channel_type,
        @author_id,
        @author_name,
        @due_at,
        @contact_id,
        @source_message_id,
        @context_summary,
        @wake_conditions
      )
    `).run({
      id,
      content,
      priority,
      timing,
      created_at: createdAt,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      due_at: dueAt,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
      context_summary: contextSummary ?? null,
      wake_conditions: encodeWakeConditions(wakeConditions),
    });

    return this.requireById(id);
  }

  enqueue(input: PendingFollowUpCreateInput): PendingFollowUp | null {
    const resolution = resolvePendingFollowUpEnqueueResolution(
      input,
      this.list({
        includeActivated: false,
        includeExpired: true,
        limit: MAX_LIST_LIMIT,
      }),
      { backlogCap: this.backlogCap },
    );
    if (resolution.kind === 'supersede') {
      const updated = this.update(resolution.existing.id, input);
      if (!updated) {
        throw new Error(`Failed to supersede pending follow-up "${resolution.existing.id}" during enqueue`);
      }
      log.info('Pending follow-up enqueue superseded existing row', {
        followUpId: updated.id,
        reason: resolution.reason,
        similarity: resolution.similarity,
        backlogSize: resolution.backlogSize,
        channelId: updated.channelId,
        contactId: updated.contactId ?? null,
        timing: updated.timing,
      });
      return updated;
    }
    if (resolution.kind === 'drop') {
      log.info('Pending follow-up enqueue dropped at backlog cap', {
        reason: resolution.reason,
        similarity: resolution.similarity,
        backlogSize: resolution.backlogSize,
        channelId: input.channelId,
        contactId: input.contactId ?? null,
        timing: input.timing,
        closestFollowUpId: resolution.closest?.id ?? null,
      });
      return null;
    }
    return this.create(input);
  }

  update(id: string, input: PendingFollowUpUpdateInput): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const dueAt = resolvePendingFollowUpDueAtForWrite({ timing, dueAt: input.dueAt }, this.now());
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);
    const contextSummary = normalizeOptionalText(
      input.contextSummary,
      'contextSummary',
      MAX_SUMMARY_CHARS,
    );
    const wakeConditions = normalizeWakeConditions(input.wakeConditions);

    const result = this.db.prepare(`
      UPDATE ${PENDING_FOLLOW_UPS_TABLE}
      SET
        content = @content,
        priority = @priority,
        timing = @timing,
        channel_id = @channel_id,
        channel_type = @channel_type,
        author_id = @author_id,
        author_name = @author_name,
        due_at = @due_at,
        contact_id = @contact_id,
        source_message_id = @source_message_id,
        context_summary = @context_summary,
        wake_conditions = @wake_conditions
      WHERE
        id = @id
        AND activated_at IS NULL
    `).run({
      id: normalizedId,
      content,
      priority,
      timing,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      due_at: dueAt,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
      context_summary: contextSummary ?? null,
      wake_conditions: encodeWakeConditions(wakeConditions),
    });

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  getById(id: string): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const row = this.db.prepare(`
      SELECT
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions,
        activated_at,
        activation_reason
      FROM ${PENDING_FOLLOW_UPS_TABLE}
      WHERE id = @id
    `).get({ id: normalizedId }) as PendingFollowUpRow | undefined;
    return row ? this.mapRowOrQuarantine(row, 'peek') : null;
  }

  peek(id: string): PendingFollowUp | null {
    return this.getById(id);
  }

  getPendingFollowUps(contactId?: string): PendingFollowUp[] {
    return this.list({
      contactId,
      includeActivated: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  list(options: PendingFollowUpListOptions = {}): PendingFollowUp[] {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const asOfMs = Date.parse(asOf);
    const normalizedContactId = normalizeOptionalId(options.contactId);
    const includeExpired = options.includeExpired === true;
    const limit = clampListLimit(options.limit);
    const whereClauses: string[] = [];
    if (options.includeActivated !== true) {
      whereClauses.push('activated_at IS NULL');
    }
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = @contactId)');
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = this.db.prepare(`
      SELECT
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions,
        activated_at,
        activation_reason
      FROM ${PENDING_FOLLOW_UPS_TABLE}
      ${whereSql}
      ORDER BY
        created_at ASC,
        id ASC
    `).all({
      contactId: normalizedContactId ?? null,
    }) as PendingFollowUpRow[];

    const followUps = rows
      .map(row => this.mapRowOrQuarantine(row, 'list'))
      .filter((followUp): followUp is PendingFollowUp => followUp !== null)
      .filter(followUp => includeExpired || !isPendingFollowUpExpired(followUp, asOfMs));
    return followUps.slice(0, limit);
  }

  markActivated(id: string, options: PendingFollowUpActivateOptions = {}): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const activatedAt = options.activatedAt
      ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt')
      : this.now().toISOString();
    const activationReason = normalizeOptionalText(
      options.activationReason,
      'activationReason',
      MAX_REASON_CHARS,
    );

    const result = this.db.prepare(`
      UPDATE ${PENDING_FOLLOW_UPS_TABLE}
      SET
        activated_at = @activated_at,
        activation_reason = @activation_reason
      WHERE
        id = @id
        AND activated_at IS NULL
    `).run({
      id: normalizedId,
      activated_at: activatedAt,
      activation_reason: activationReason ?? null,
    });

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  dequeue(id: string, options: PendingFollowUpActivateOptions = {}): PendingFollowUp | null {
    return this.markActivated(id, options);
  }

  quarantine(input: PendingFollowUpQuarantineInput): PendingFollowUpQuarantineRecord {
    const id = normalizeRequiredText(randomUUID(), 'quarantine_id', MAX_ID_CHARS);
    const followUpId = normalizeOptionalId(input.followUpId);
    const reason = normalizeQuarantineReason(input.reason);
    const source = normalizeOptionalText(input.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
    const quarantinedAt = input.quarantinedAt
      ? normalizeIsoTimestamp(input.quarantinedAt, 'quarantinedAt')
      : this.now().toISOString();
    const rawEntry = serializeQuarantineRawEntry(input.raw);

    this.db.prepare(`
      INSERT INTO ${PENDING_FOLLOW_UP_QUARANTINE_TABLE} (
        id,
        follow_up_id,
        reason,
        source,
        raw_entry,
        quarantined_at
      ) VALUES (
        @id,
        @follow_up_id,
        @reason,
        @source,
        @raw_entry,
        @quarantined_at
      )
    `).run({
      id,
      follow_up_id: followUpId ?? null,
      reason,
      source: source ?? null,
      raw_entry: rawEntry,
      quarantined_at: quarantinedAt,
    });

    if (followUpId) {
      this.deleteRawFollowUp(followUpId);
    }
    return this.requireQuarantineById(id);
  }

  listQuarantined(
    options: PendingFollowUpQuarantineListOptions = {},
  ): PendingFollowUpQuarantineRecord[] {
    const followUpId = normalizeOptionalId(options.followUpId);
    const source = normalizeOptionalText(options.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
    const limit = clampListLimit(options.limit);
    const whereClauses: string[] = [];
    if (followUpId) {
      whereClauses.push('follow_up_id = @followUpId');
    }
    if (source) {
      whereClauses.push('source = @source');
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        id,
        follow_up_id,
        reason,
        source,
        raw_entry,
        quarantined_at
      FROM ${PENDING_FOLLOW_UP_QUARANTINE_TABLE}
      ${whereSql}
      ORDER BY
        quarantined_at ASC,
        id ASC
      LIMIT @limit
    `).all({
      followUpId: followUpId ?? null,
      source: source ?? null,
      limit,
    }) as PendingFollowUpQuarantineRow[];
    return rows.map(mapQuarantineRow);
  }

  private requireById(id: string): PendingFollowUp {
    const record = this.getById(id);
    if (!record) {
      throw new Error(`Failed to load pending follow-up "${id}" after write`);
    }
    return record;
  }

  private requireQuarantineById(id: string): PendingFollowUpQuarantineRecord {
    const row = this.db.prepare(`
      SELECT
        id,
        follow_up_id,
        reason,
        source,
        raw_entry,
        quarantined_at
      FROM ${PENDING_FOLLOW_UP_QUARANTINE_TABLE}
      WHERE id = @id
    `).get({ id }) as PendingFollowUpQuarantineRow | undefined;
    if (!row) {
      throw new Error(`Failed to load pending follow-up quarantine "${id}" after write`);
    }
    return mapQuarantineRow(row);
  }

  private mapRowOrQuarantine(row: PendingFollowUpRow, source: string): PendingFollowUp | null {
    try {
      return mapRow(row);
    } catch (error) {
      this.quarantine({
        followUpId: row.id,
        reason: toQuarantineReason(error),
        raw: row,
        source,
      });
      return null;
    }
  }

  private deleteRawFollowUp(id: string): void {
    this.db.prepare(`
      DELETE FROM ${PENDING_FOLLOW_UPS_TABLE}
      WHERE id = @id
    `).run({ id });
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${PENDING_FOLLOW_UPS_TABLE} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        priority TEXT NOT NULL,
        timing TEXT NOT NULL,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        due_at TEXT,
        contact_id TEXT,
        source_message_id TEXT,
        context_summary TEXT,
        wake_conditions TEXT,
        activated_at TEXT,
        activation_reason TEXT,
        CHECK (priority IN ('low', 'medium', 'high')),
        CHECK (timing IN ('immediate', 'soon', 'scheduled')),
        CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
      );

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active
      ON ${PENDING_FOLLOW_UPS_TABLE} (activated_at, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact
      ON ${PENDING_FOLLOW_UPS_TABLE} (contact_id, activated_at, created_at, id);

      CREATE TABLE IF NOT EXISTS ${PENDING_FOLLOW_UP_QUARANTINE_TABLE} (
        id TEXT PRIMARY KEY,
        follow_up_id TEXT,
        reason TEXT NOT NULL,
        source TEXT,
        raw_entry TEXT NOT NULL,
        quarantined_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_up_quarantine_follow_up
      ON ${PENDING_FOLLOW_UP_QUARANTINE_TABLE} (follow_up_id, quarantined_at, id);
    `);
    this.ensureColumn('context_summary', 'TEXT');
    this.ensureColumn('wake_conditions', 'TEXT');
  }

  private ensureColumn(columnName: string, columnDefinition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${PENDING_FOLLOW_UPS_TABLE})`).all() as Array<{
      name?: string;
    }>;
    if (columns.some(column => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${PENDING_FOLLOW_UPS_TABLE} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}
