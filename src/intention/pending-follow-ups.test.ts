import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  PendingFollowUpStore,
  evaluatePendingFollowUpWakeState,
} from './pending-follow-ups.js';

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
