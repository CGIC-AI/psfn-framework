import { describe, expect, it, vi } from 'vitest';
import { buildAdminJournalStatus } from './journal-status-service.js';

const NOW_MS = Date.parse('2026-08-10T16:00:00.000Z');

describe('buildAdminJournalStatus', () => {
  it('reports content-free counts and latest timestamps without exposing journal bodies', () => {
    const status = buildAdminJournalStatus({
      now: () => NOW_MS,
      valuesJournal: {
        list: () => [{ createdAt: '2026-08-09T12:00:00.000Z', reflection: 'private values' }] as never,
      },
      reflectionMetacognitionJournal: {
        listRecent: () => [{ occurredAt: '2026-08-10T10:00:00.000Z', reflection: 'private metacognition' }] as never,
      },
      reflectionDailyJournal: {
        listRecent: () => [
          { createdAt: '2026-08-08T10:00:00.000Z', reflection: 'private daily' },
          { createdAt: '2026-08-07T10:00:00.000Z', reflection: 'older private daily' },
        ] as never,
      },
      reflectionJournal: {
        listRecent: vi.fn(() => [
          { templateId: 'musing', createdAt: '2026-08-10T11:00:00.000Z', reflection: 'private reflection' },
          { templateId: 'concern_route', createdAt: '2026-08-09T11:00:00.000Z', reflection: 'private concern' },
        ] as never),
      },
      scheduler: {
        listTasks: () => [
          {
            id: 'reflection:daily-review',
            state: 'idle',
            lastRunAt: Date.parse('2026-08-10T12:00:00.000Z'),
            lastOutcome: 'succeeded',
            cadence: { kind: 'daily', hour: 7, minute: 0, timezone: 'utc' },
          },
          {
            id: 'reflection:weekly-review',
            state: 'idle',
            lastRunAt: Date.parse('2026-08-09T12:00:00.000Z'),
            lastOutcome: 'succeeded',
            cadence: { kind: 'weekly', dayOfWeek: 0, hour: 7, minute: 0, timezone: 'utc' },
          },
        ] as never,
      },
    });

    expect(status.streams).toMatchObject({
      values: { count: 1, latestAt: '2026-08-09T12:00:00.000Z' },
      metacognition: { count: 1, latestAt: '2026-08-10T10:00:00.000Z' },
      daily: { count: 2, latestAt: '2026-08-08T10:00:00.000Z' },
      reflection: { count: 1, latestAt: '2026-08-10T11:00:00.000Z' },
      concerns: { count: 1, latestAt: '2026-08-09T11:00:00.000Z' },
    });
    expect(JSON.stringify(status)).not.toContain('private');
    expect(status.attentionCount).toBe(0);
  });

  it('makes missed, failed, paused, and unavailable schedules attention-visible', () => {
    const missed = buildAdminJournalStatus({
      now: () => NOW_MS,
      scheduler: {
        listTasks: () => [
          {
            id: 'reflection:daily-review',
            state: 'idle',
            lastRunAt: Date.parse('2026-08-08T12:00:00.000Z'),
            lastOutcome: 'succeeded',
            cadence: { kind: 'daily', hour: 7, minute: 0, timezone: 'utc' },
          },
          {
            id: 'reflection:weekly-review',
            state: 'idle',
            lastRunAt: Date.parse('2026-08-10T12:00:00.000Z'),
            lastOutcome: 'failed',
            cadence: { kind: 'weekly', dayOfWeek: 0, hour: 7, minute: 0, timezone: 'utc' },
          },
        ] as never,
      },
    });

    expect(missed.tasks.daily.health).toBe('missed');
    expect(missed.tasks.weekly.health).toBe('failed');
    expect(missed.attentionCount).toBe(2);

    const unavailable = buildAdminJournalStatus({ now: () => NOW_MS });
    expect(unavailable.tasks.daily.health).toBe('unavailable');
    expect(unavailable.tasks.weekly.health).toBe('unavailable');
    expect(unavailable.streams.daily.count).toBeNull();
  });

  it('reports an in-progress reflection without raising a false missed-run alert', () => {
    const status = buildAdminJournalStatus({
      now: () => NOW_MS,
      scheduler: {
        listTasks: () => [
          { id: 'reflection:daily-review', state: 'active' },
          { id: 'reflection:weekly-review', state: 'active' },
        ] as never,
      },
    });

    expect(status.tasks.daily.health).toBe('running');
    expect(status.tasks.weekly.health).toBe('running');
    expect(status.attentionCount).toBe(0);
  });
});
