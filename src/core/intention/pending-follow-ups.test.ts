import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { PendingFollowUpStore } from './pending-follow-ups.js';

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
    });

    expect(store.getPendingFollowUps('contact-a')).toHaveLength(1);
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
});
