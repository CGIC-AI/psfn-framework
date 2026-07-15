import { describe, expect, it } from 'vitest';
import { advanceYear, mapRow, type CareReminderRow } from './care-reminders.js';

function reminderRow(overrides: Partial<CareReminderRow> = {}): CareReminderRow {
  return {
    id: 'care-reminder-1',
    kind: 'important_date',
    classification: 'birthday',
    title: 'Alex birthday',
    content: 'Remember to celebrate Alex on their birthday.',
    schedule: 'annual',
    status: 'active',
    due_at: '2026-04-01T09:00:00.000Z',
    created_at: '2026-03-25T12:00:00.000Z',
    channel_id: 'api:test',
    channel_type: 'api',
    author_id: 'system:intention',
    author_name: 'Whisper',
    provenance_source: 'companion_appraisal',
    provenance_reason: 'The partner explicitly shared their birthday.',
    contact_id: 'contact-a',
    source_message_id: 'msg-1',
    last_activated_at: null,
    activation_count: 0,
    completed_at: null,
    ...overrides,
  };
}

describe('care reminder domain contract', () => {
  it('maps durable care reminders with explicit provenance', () => {
    const created = mapRow(reminderRow());

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
    expect(created.completedAt).toBeUndefined();
  });

  it('maps the completed state produced after a one-time reminder trigger', () => {
    const triggered = mapRow(reminderRow({
      id: 'care-reminder-2',
      kind: 'self_reminder',
      classification: 'self_note',
      schedule: 'one_time',
      status: 'completed',
      due_at: '2026-03-26T15:00:00.000Z',
      last_activated_at: '2026-03-26T15:00:00.000Z',
      activation_count: 1,
      completed_at: '2026-03-26T15:00:00.000Z',
      contact_id: null,
      source_message_id: null,
    }));

    expect(triggered).toMatchObject({
      id: 'care-reminder-2',
      status: 'completed',
      completedAt: '2026-03-26T15:00:00.000Z',
      lastActivatedAt: '2026-03-26T15:00:00.000Z',
      activationCount: 1,
    });
    expect(triggered).not.toHaveProperty('contactId');
  });

  it('advances annual reminders beyond the current time', () => {
    expect(advanceYear(
      '2026-04-02T09:00:00.000Z',
      '2026-04-02T09:00:00.000Z',
    )).toBe('2027-04-02T09:00:00.000Z');
  });
});
