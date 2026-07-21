import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP,
  evaluatePendingFollowUpWakeState,
  filterPendingFollowUpsForActiveChannel,
} from './pending-follow-ups.js';
import { createTestPostgresIntentionPorts } from '../../test-support/postgres-intention-ports.js';

describe('PendingFollowUpStore', () => {
  it('creates and lists pending follow-ups by contact scope', async () => {
    const store = createTestPostgresIntentionPorts({
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    await store.enqueue({
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

    expect(await store.list({ contactId: 'contact-a' })).toEqual([
      expect.objectContaining({
        id: 'follow-up-1',
        contextSummary: 'Follow up after the meeting outcome settles.',
        wakeConditions: ['next_user_turn'],
      }),
    ]);
    expect(await store.list({ contactId: 'contact-b' })).toHaveLength(0);
  });

  it('marks follow-ups activated and excludes them from pending lists', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const created = await store.enqueue({
      content: 'Circle back gently later.',
      priority: 'low',
      timing: 'scheduled',
      channelId: 'discord:dm',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
    });

    const activated = await store.dequeue(created!.id, {
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'post_turn_action',
    });
    expect(activated).toMatchObject({
      id: created!.id,
      activationReason: 'post_turn_action',
      activatedAt: '2026-03-25T12:05:00.000Z',
    });
    expect(await store.list()).toHaveLength(0);
    expect(await store.list({ includeActivated: true })).toHaveLength(1);
  });

  it('captures formation VAD at creation and completion VAD at dequeue, retaining the arc (vw3w.3)', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const created = await store.enqueue({
      content: 'Return to this once the worry settles.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'discord:dm',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      formationVAD: { valence: -0.4, arousal: 0.5, dominance: -0.2 },
    });
    // Formation VAD is persisted and survives a fresh read.
    expect(created).toMatchObject({
      formationVAD: { valence: -0.4, arousal: 0.5, dominance: -0.2 },
    });
    expect(await store.peek(created!.id)).toMatchObject({
      formationVAD: { valence: -0.4, arousal: 0.5, dominance: -0.2 },
    });
    expect((created as { completionVAD?: unknown }).completionVAD).toBeUndefined();

    const completed = await store.dequeue(created!.id, {
      activatedAt: '2026-03-25T12:30:00.000Z',
      activationReason: 'post_turn_action',
      completionVAD: { valence: 0.3, arousal: -0.1, dominance: 0.2 },
    });
    // Completion VAD is captured and the formation→completion arc is retained
    // on the soft-terminal row (not a destructive discard) and stays queryable.
    expect(completed).toMatchObject({
      activatedAt: '2026-03-25T12:30:00.000Z',
      formationVAD: { valence: -0.4, arousal: 0.5, dominance: -0.2 },
      completionVAD: { valence: 0.3, arousal: -0.1, dominance: 0.2 },
    });
    expect(await store.list({ includeActivated: true })).toEqual([
      expect.objectContaining({
        id: created!.id,
        formationVAD: { valence: -0.4, arousal: 0.5, dominance: -0.2 },
        completionVAD: { valence: 0.3, arousal: -0.1, dominance: 0.2 },
      }),
    ]);
  });

  it('leaves follow-up VAD absent when no emotion telemetry is supplied (never fabricated) (vw3w.3)', async () => {
    const store = createTestPostgresIntentionPorts({
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const created = await store.enqueue({
      content: 'Circle back with no affect snapshot available.',
      priority: 'low',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
    });
    const completed = await store.dequeue(created!.id, { activationReason: 'post_turn_action' });
    expect((completed as { formationVAD?: unknown }).formationVAD).toBeUndefined();
    expect((completed as { completionVAD?: unknown }).completionVAD).toBeUndefined();
  });

  it('exposes pending follow-up queue operations through the port', async () => {
    const port = createTestPostgresIntentionPorts({
      idFactory: () => 'follow-up-1',
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

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

    await expect(port.peek(created!.id)).resolves.toMatchObject({
      id: created!.id,
      content: 'Check back through the port.',
    });
    await expect(port.list({ contactId: 'contact-a' })).resolves.toHaveLength(1);
    await expect(port.dequeue(created!.id, {
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'port_dequeue',
    })).resolves.toMatchObject({
      activatedAt: '2026-03-25T12:05:00.000Z',
      activationReason: 'port_dequeue',
    });
    await expect(port.list({ contactId: 'contact-a' })).resolves.toEqual([]);
  });

  it('deduplicates near-identical enqueue requests by superseding the existing row', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const first = await store.enqueue({
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
    const second = await store.enqueue({
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
    expect(await store.list({ contactId: 'contact-a', includeExpired: true })).toEqual([
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

  it('enforces the per-channel/contact pending backlog cap with supersede or drop telemetry paths', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const first = await store.enqueue({
      content: 'Plan the garden watering reminder.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    const distinctBacklogItems = [
      'Review the tax upload checklist.',
      'Book the annual veterinary appointment.',
      'Confirm the database rollback rehearsal.',
      'Replace the kitchen water filter.',
      'Ask about the cardiology test results.',
      'Renew the library membership online.',
      'Inspect the bicycle brake cable.',
      'Prepare the conference travel receipt.',
      'Send the landlord a heating update.',
      'Schedule the piano tuning visit.',
      'Verify the overnight backup checksum.',
    ];
    for (const content of distinctBacklogItems.slice(0, DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP - 1)) {
      await store.enqueue({
        content,
        priority: 'medium',
        timing: 'scheduled',
        channelId: 'discord:primary',
        channelType: 'discord',
        authorId: 'system:intention',
        authorName: 'Whisper',
        contactId: 'contact-a',
        dueAt: '2026-03-26T12:00:00.000Z',
      });
    }

    expect(await store.enqueue({
      content: 'Schedule the piano tuning question.',
      priority: 'low',
      timing: 'soon',
      channelId: 'discord:primary',
      channelType: 'discord',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    })).toBeNull();

    const cappedSupersede = await store.enqueue({
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
    const retained = await store.list({ contactId: 'contact-a', includeExpired: true });
    expect(retained).toHaveLength(DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP);
    expect(retained[0]?.content).toBe('Plan garden tomorrow.');
    expect(nextId).toBe(DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP);
  });

  it('quarantines invalid persisted rows instead of silently dropping them', async () => {
    let nextId = 0;
    const { pool, ports } = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });
    const port = ports.pendingFollowUpStore;

    await port.enqueue({
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
    await port.enqueue({
      content: 'This row should survive.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    pool.corruptPendingFollowUp('follow-up-1', { wake_conditions: 'not-json' });

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

  it('expires stale pending follow-ups by age and overdue dueAt', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    await store.enqueue({
      content: 'This should age out.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      createdAt: '2026-03-24T11:00:00.000Z',
    });
    await store.enqueue({
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
    await store.enqueue({
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

    expect((await store.list()).map(followUp => followUp.content)).toEqual([
      'This should stay pending.',
    ]);
    expect((await store.list({ includeExpired: true })).map(followUp => followUp.content)).toEqual([
      'This should expire after its overdue window.',
      'This should age out.',
      'This should stay pending.',
    ]);
  });

  it('updates an active pending follow-up through the deduplicating enqueue path', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    const created = await store.enqueue({
      content: 'Check back in later.',
      priority: 'medium',
      timing: 'scheduled',
      dueAt: '2026-03-25T12:30:00.000Z',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
    });
    const updated = await store.enqueue({
      content: 'Check back in later.',
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
      id: created!.id,
      priority: 'high',
      timing: 'scheduled',
      dueAt: '2026-03-25T13:00:00.000Z',
      contextSummary: 'They asked to revisit this after the next status update.',
      wakeConditions: ['next_user_turn', 'sustained_negative_mood'],
    });
  });

  it('filters pending follow-ups to the active session or thread', async () => {
    let nextId = 0;
    const store = createTestPostgresIntentionPorts({
      idFactory: () => `follow-up-${++nextId}`,
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    }).ports.pendingFollowUpStore;

    await store.enqueue({
      content: 'Stay with session-a.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:principal-a:session-a',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
    });
    await store.enqueue({
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
        await store.list({ contactId: 'contact-a' }),
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
