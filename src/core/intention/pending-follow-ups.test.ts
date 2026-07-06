import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PendingFollowUpStore } from './sqlite-stores/pending-follow-up-store.js';
import { createPendingFollowUpStorePort, evaluatePendingFollowUpWakeState, filterPendingFollowUpsForActiveChannel } from './pending-follow-ups.js';

describe('PendingFollowUpStore', () => {
  it('creates and lists pending follow-ups by contact scope', () => {
    const db = new Database(':memory:');
    const store = new PendingFollowUpStore(db, {
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    store.create({
      content: 'Check back in after the meeting.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
      contextSummary: 'Follow up after the meeting outcome settles.',
      wakeConditions: ['next_user_turn'],
    });

    expect(store.getPendingFollowUps('contact-a')).toEqual([
      expect.objectContaining({
        id: 'follow-up-1',
        contextSummary: 'Follow up after the meeting outcome settles.',
        wakeConditions: ['next_user_turn'],
      }),
    ]);
    expect(store.getPendingFollowUps('contact-b')).toHaveLength(0);
  });

  it('marks follow-ups activated and excludes them from pending lists', () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const created = store.create({
      content: 'Circle back gently later.',
      priority: 'low',
      timing: 'scheduled',
      channelId: 'discord:dm',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
    });

    const activated = store.markActivated(created.id, {
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'post_turn_action',
    });
    expect(activated).toMatchObject({
      id: created.id,
      activationReason: 'post_turn_action',
      activatedAt: '2026-03-25T12:05:00.000Z',
    });
    expect(store.getPendingFollowUps()).toHaveLength(0);
    expect(store.list({ includeActivated: true })).toHaveLength(1);
  });

  it('exposes pending follow-up queue operations through the port', async () => {
    const db = new Database(':memory:');
    const store = new PendingFollowUpStore(db, {
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });
    const port = createPendingFollowUpStorePort(store);

    const created = await port.enqueue({
      content: 'Check back through the port.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });

    await expect(port.peek(created.id)).resolves.toMatchObject({
      id: created.id,
      content: 'Check back through the port.',
    });
    await expect(port.list({ contactId: 'contact-a' })).resolves.toHaveLength(1);
    await expect(port.dequeue(created.id, {
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'port_dequeue',
    })).resolves.toMatchObject({
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'port_dequeue',
    });
    await expect(port.list({ contactId: 'contact-a' })).resolves.toEqual([]);
  });

  it('deduplicates near-identical enqueue requests by superseding the existing row', async () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const first = store.enqueue({
      content: 'Check in about the medication plan tomorrow.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
    });
    const second = store.enqueue({
      content: 'Check in tomorrow about the medication plan.',
      priority: 'high',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      dueAt: '2026-03-25T14:00:00.000Z',
    });

    expect(second?.id).toBe(first?.id);
    expect(store.list({ contactId: 'contact-a', includeExpired: true })).toEqual([
      expect.objectContaining({
        id: first?.id,
        content: 'Check in tomorrow about the medication plan.',
        priority: 'high',
        dueAt: '2026-03-25T14:00:00.000Z',
        sourceMessageId: 'msg-2',
      }),
    ]);
    expect(nextId).toBe(1);
  });

  it('enforces the per-channel/contact pending backlog cap with supersede or drop telemetry paths', () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
      backlogCap: 2,
    });

    const first = store.enqueue({
      content: 'Plan the garden watering reminder.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    store.enqueue({
      content: 'Review the tax upload checklist.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      dueAt: '2026-03-26T12:00:00.000Z',
    });

    expect(store.enqueue({
      content: 'Schedule the piano tuning question.',
      priority: 'low',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    })).toBeNull();

    const cappedSupersede = store.enqueue({
      content: 'Plan garden tomorrow.',
      priority: 'high',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });

    expect(cappedSupersede?.id).toBe(first?.id);
    expect(store.list({ contactId: 'contact-a', includeExpired: true }).map(followUp => followUp.content)).toEqual([
      'Plan garden tomorrow.',
      'Review the tax upload checklist.',
    ]);
    expect(nextId).toBe(2);
  });

  it('quarantines invalid persisted rows instead of silently dropping them', async () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });
    const port = createPendingFollowUpStorePort(store);

    store.create({
      content: 'This row will be quarantined.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      wakeConditions: ['next_user_turn'],
    });
    store.create({
      content: 'This row should survive.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    db.prepare(`
      UPDATE intention_pending_follow_ups
      SET wake_conditions = @wakeConditions
      WHERE id = @id
    `).run({
      id: 'follow-up-1',
      wakeConditions: 'not-json',
    });

    await expect(port.list({ contactId: 'contact-a' })).resolves.toEqual([
      expect.objectContaining({
        id: 'follow-up-2',
        content: 'This row should survive.',
      }),
    ]);
    await expect(port.peek('follow-up-1')).resolves.toBeNull();
    await expect(port.listQuarantined()).resolves.toEqual([
      expect.objectContaining({
        followUpId: 'follow-up-1',
        source: 'list',
        reason: expect.stringContaining('wake_conditions'),
        raw: expect.objectContaining({
          id: 'follow-up-1',
          wake_conditions: 'not-json',
        }),
      }),
    ]);
  });

  it('expires stale pending follow-ups by age and overdue dueAt', () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    store.create({
      content: 'This should age out.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      createdAt: '2026-03-24T11:00:00.000Z',
    });
    store.create({
      content: 'This should expire after its overdue window.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      createdAt: '2026-03-24T09:00:00.000Z',
      dueAt: '2026-03-24T10:30:00.000Z',
    });
    store.create({
      content: 'This should stay pending.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      createdAt: '2026-03-25T08:00:00.000Z',
      dueAt: '2026-03-25T18:00:00.000Z',
    });

    expect(store.getPendingFollowUps().map(followUp => followUp.content)).toEqual([
      'This should stay pending.',
    ]);
    expect(store.list({ includeExpired: true }).map(followUp => followUp.content)).toEqual([
      'This should expire after its overdue window.',
      'This should age out.',
      'This should stay pending.',
    ]);
  });

  it('updates an existing pending follow-up while it is still active', () => {
    const db = new Database(':memory:');
    const store = new PendingFollowUpStore(db, {
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    const created = store.create({
      content: 'Check back in later.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
    });

    const updated = store.update(created.id, {
      content: 'Check back in on their next message.',
      priority: 'high',
      timing: 'scheduled',
      dueAt: '2026-03-25T13:00:00.000Z',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contextSummary: 'They asked to revisit this after the next status update.',
      wakeConditions: ['next_user_turn', 'sustained_negative_mood'],
    });

    expect(updated).toMatchObject({
      id: created.id,
      priority: 'high',
      timing: 'scheduled',
      dueAt: '2026-03-25T13:00:00.000Z',
      contextSummary: 'They asked to revisit this after the next status update.',
      wakeConditions: ['next_user_turn', 'sustained_negative_mood'],
    });
  });

  it('filters pending follow-ups to the active session or thread', () => {
    const db = new Database(':memory:');
    let nextId = 0;
    const store = new PendingFollowUpStore(db, {
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    store.create({
      content: 'Stay with session-a.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:principal-a:session-a',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    store.create({
      content: 'Do not leak from session-b.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:principal-a:session-b',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });

    expect(
      filterPendingFollowUpsForActiveChannel(
        store.getPendingFollowUps('contact-a'),
        'api:principal-a:session-a',
      ),
    ).toEqual([
      expect.objectContaining({
        content: 'Stay with session-a.',
      }),
    ]);
  });

  it('evaluates state-based wake conditions conservatively', () => {
    expect(evaluatePendingFollowUpWakeState({
      dueAt: '2026-03-25T13:00:00.000Z',
      wakeConditions: ['next_user_turn'],
    }, {
      now: Date.parse('2026-03-25T12:30:00.000Z'),
      isBackgroundTurn: false,
    })).toEqual({
      eligibleNow: true,
      dueAtReached: false,
      matchedWakeConditions: ['next_user_turn'],
    });

    expect(evaluatePendingFollowUpWakeState({
      wakeConditions: ['sustained_negative_mood'],
    }, {
      now: Date.parse('2026-03-25T12:30:00.000Z'),
      isBackgroundTurn: false,
      currentMoodValence: -0.3,
    })).toEqual({
      eligibleNow: true,
      dueAtReached: false,
      matchedWakeConditions: ['sustained_negative_mood'],
    });
  });
});
