import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { CareReminderStore } from './care-reminders.js';

describe('CareReminderStore', () => {
  it('creates durable care reminders with explicit provenance', () => {
    const db = new Database(':memory:');
    const store = new CareReminderStore(db, {
      idFactory: () => 'care-reminder-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const created = store.create({
      kind: 'important_date',
      classification: 'birthday',
      title: 'Alex birthday',
      content: 'Remember to celebrate Alex on their birthday.',
      schedule: 'annual',
      dueAt: '2026-04-01T09:00:00.000Z',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      provenanceSource: 'companion_appraisal',
      provenanceReason: 'The partner explicitly shared their birthday.',
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
    });

    expect(created).toMatchObject({
      id: 'care-reminder-1',
      kind: 'important_date',
      classification: 'birthday',
      schedule: 'annual',
      status: 'active',
      authorId: 'system:intention',
      authorName: 'Whisper',
      provenanceSource: 'companion_appraisal',
      provenanceReason: 'The partner explicitly shared their birthday.',
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
      activationCount: 0,
    });
    expect(store.getActiveCareReminders('contact-a')).toHaveLength(1);
  });

  it('marks one-time reminders completed after trigger', () => {
    const db = new Database(':memory:');
    const store = new CareReminderStore(db, {
      idFactory: () => 'care-reminder-2',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const created = store.create({
      kind: 'self_reminder',
      classification: 'self_note',
      title: 'Check in tomorrow',
      content: 'Check in tomorrow afternoon after the interview.',
      schedule: 'one_time',
      dueAt: '2026-03-26T15:00:00.000Z',
      channelId: 'discord:dm',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      provenanceSource: 'companion_appraisal',
      provenanceReason: 'The companion wanted a durable self-reminder.',
    });

    const triggered = store.markTriggered(created.id, {
      activatedAt: '2026-03-26T15:00:00.000Z',
    });
    expect(triggered).toMatchObject({
      id: created.id,
      status: 'completed',
      completedAt: '2026-03-26T15:00:00.000Z',
      lastActivatedAt: '2026-03-26T15:00:00.000Z',
      activationCount: 1,
    });
    expect(store.getActiveCareReminders()).toHaveLength(0);
  });

  it('advances annual reminders to the next due date after trigger', () => {
    const db = new Database(':memory:');
    const store = new CareReminderStore(db, {
      idFactory: () => 'care-reminder-3',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const created = store.create({
      kind: 'important_date',
      classification: 'anniversary',
      title: 'Anniversary',
      content: 'Remember our anniversary and plan something gentle.',
      schedule: 'annual',
      dueAt: '2026-04-02T09:00:00.000Z',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      provenanceSource: 'companion_appraisal',
      provenanceReason: 'Important date should recur every year.',
    });

    const triggered = store.markTriggered(created.id, {
      activatedAt: '2026-04-02T09:05:00.000Z',
    });
    expect(triggered).toMatchObject({
      id: created.id,
      status: 'active',
      lastActivatedAt: '2026-04-02T09:05:00.000Z',
      activationCount: 1,
      dueAt: '2027-04-02T09:00:00.000Z',
    });
  });
});
