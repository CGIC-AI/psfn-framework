import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  MAX_ID_CHARS,
  MAX_TEXT_CHARS,
  MAX_TITLE_CHARS,
  advanceYear,
  clampListLimit,
  compareCareReminders,
  mapRow,
  normalizeChannelType,
  normalizeClassification,
  normalizeIsoTimestamp,
  normalizeKind,
  normalizeOptionalId,
  normalizeProvenanceSource,
  normalizeRequiredText,
  normalizeSchedule,
} from '../care-reminders.js';
import type {
  CareReminder,
  CareReminderActivationOptions,
  CareReminderCreateInput,
  CareReminderListOptions,
  CareReminderRow,
  CareReminderStoreOptions,
  CareReminderStorePort,
} from '../care-reminders.js';

export class CareReminderStore implements CareReminderStorePort {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(db: Database.Database, options: CareReminderStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.initializeSchema();
  }

  create(input: CareReminderCreateInput): CareReminder {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_ID_CHARS);
    const kind = normalizeKind(input.kind);
    const classification = normalizeClassification(input.classification);
    const title = normalizeRequiredText(input.title, 'title', MAX_TITLE_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const schedule = normalizeSchedule(input.schedule);
    const dueAt = normalizeIsoTimestamp(input.dueAt, 'dueAt');
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const provenanceSource = normalizeProvenanceSource(input.provenanceSource);
    const provenanceReason = normalizeRequiredText(input.provenanceReason, 'provenanceReason', MAX_TEXT_CHARS);
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);

    this.db.prepare(`
      INSERT INTO intention_care_reminders (
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        activation_count
      ) VALUES (
        @id,
        @kind,
        @classification,
        @title,
        @content,
        @schedule,
        'active',
        @due_at,
        @created_at,
        @channel_id,
        @channel_type,
        @author_id,
        @author_name,
        @provenance_source,
        @provenance_reason,
        @contact_id,
        @source_message_id,
        0
      )
    `).run({
      id,
      kind,
      classification,
      title,
      content,
      schedule,
      due_at: dueAt,
      created_at: createdAt,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      provenance_source: provenanceSource,
      provenance_reason: provenanceReason,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
    });

    return this.requireById(id);
  }

  getById(id: string): CareReminder | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const row = this.db.prepare(`
      SELECT
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        last_activated_at,
        activation_count,
        completed_at
      FROM intention_care_reminders
      WHERE id = @id
      LIMIT 1
    `).get({ id: normalizedId }) as CareReminderRow | undefined;

    return row ? mapRow(row) : null;
  }

  getActiveCareReminders(contactId?: string): CareReminder[] {
    return this.list({
      ...(contactId ? { contactId } : {}),
      includeCompleted: false,
      includeDismissed: false,
    });
  }

  list(options: CareReminderListOptions = {}): CareReminder[] {
    const clauses = ['status != \'completed\''];
    if (options.includeCompleted) {
      clauses.length = 0;
    }
    if (!options.includeDismissed) {
      clauses.push('status != \'dismissed\'');
    }
    const normalizedContactId = normalizeOptionalId(options.contactId);
    if (normalizedContactId) {
      clauses.push('contact_id = @contact_id');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        last_activated_at,
        activation_count,
        completed_at
      FROM intention_care_reminders
      ${where}
      ORDER BY due_at ASC, created_at ASC, id ASC
      LIMIT @limit
    `).all({
      contact_id: normalizedContactId ?? null,
      limit: clampListLimit(options.limit),
    }) as CareReminderRow[];

    return rows.map(mapRow).sort(compareCareReminders);
  }

  markTriggered(id: string, options: CareReminderActivationOptions = {}): CareReminder | null {
    const reminder = this.getById(id);
    if (!reminder || reminder.status !== 'active') {
      return reminder;
    }

    const activatedAt = options.activatedAt
      ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt')
      : this.now().toISOString();
    const activationCount = reminder.activationCount + 1;

    if (reminder.schedule === 'annual') {
      const nextDueAt = advanceYear(reminder.dueAt, activatedAt);
      this.db.prepare(`
        UPDATE intention_care_reminders
        SET
          due_at = @due_at,
          last_activated_at = @last_activated_at,
          activation_count = @activation_count
        WHERE id = @id
      `).run({
        id: reminder.id,
        due_at: nextDueAt,
        last_activated_at: activatedAt,
        activation_count: activationCount,
      });
      return this.requireById(reminder.id);
    }

    this.db.prepare(`
      UPDATE intention_care_reminders
      SET
        status = 'completed',
        completed_at = @completed_at,
        last_activated_at = @last_activated_at,
        activation_count = @activation_count
      WHERE id = @id
    `).run({
      id: reminder.id,
      completed_at: activatedAt,
      last_activated_at: activatedAt,
      activation_count: activationCount,
    });
    return this.requireById(reminder.id);
  }

  private requireById(id: string): CareReminder {
    const reminder = this.getById(id);
    if (!reminder) {
      throw new Error(`Failed to load care reminder "${id}" after write`);
    }
    return reminder;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intention_care_reminders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        classification TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        schedule TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        provenance_source TEXT NOT NULL,
        provenance_reason TEXT NOT NULL,
        contact_id TEXT,
        source_message_id TEXT,
        last_activated_at TEXT,
        activation_count INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intention_care_reminders_due_at
        ON intention_care_reminders(due_at);
      CREATE INDEX IF NOT EXISTS idx_intention_care_reminders_contact_status
        ON intention_care_reminders(contact_id, status, due_at);
    `);
  }
}
