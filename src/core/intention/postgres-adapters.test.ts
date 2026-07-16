import { describe, expect, it, vi } from 'vitest';
import { FakeIntentionPool } from '../../test-support/fake-postgres-intention-pool.js';
import { createPostgresIntentionPortsFromPool } from './postgres-adapters.js';

describe('postgres intention adapters', () => {
  it('keeps connection acquisition failures before the behavioral write boundary', async () => {
    const connectionError = new Error('connection unavailable');
    const pool = {
      connect: vi.fn(async () => {
        throw connectionError;
      }),
    };
    const ports = createPostgresIntentionPortsFromPool(pool as never);
    const crossEffectBoundary = vi.fn(async () => undefined);

    await expect(ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-connection-failure',
      responseContent: 'Retry this after the connection recovers.',
    }, { crossEffectBoundary })).rejects.toBe(connectionError);

    expect(crossEffectBoundary).not.toHaveBeenCalled();
  });

  it('crosses immediately before the behavioral write begins', async () => {
    const writeError = new Error('write outcome is ambiguous');
    const order: string[] = [];
    const query = vi.fn(async () => {
      order.push('query');
      throw writeError;
    });
    const release = vi.fn(() => {
      order.push('release');
    });
    const pool = {
      connect: vi.fn(async () => {
        order.push('connect');
        return { query, release };
      }),
    };
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    await expect(ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-ambiguous-write',
      responseContent: 'Do not replay an ambiguous durable write.',
    }, {
      crossEffectBoundary: async () => {
        order.push('cross');
      },
    })).rejects.toBe(writeError);

    expect(order).toEqual(['connect', 'cross', 'query', 'release']);
  });

  it('persists concerns and resolves similar follow-up lookups', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const created = await ports.concernStore.create({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      source: 'agent',
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(created.id).toBeTruthy();

    const active = await ports.concernStore.getActiveConcerns('contact-a');
    expect(active).toHaveLength(1);
    expect(ports.concernProvider.getActiveConcerns('contact-a')).toHaveLength(1);
    expect(active[0]).toMatchObject({
      text: 'Check hydration reminder',
      contactId: 'contact-a',
      priority: 'medium',
      source: 'agent',
      status: 'active',
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const duplicate = await ports.concernStore.create({
      text: 'Check the hydration reminder',
      contactId: 'contact-a',
      priority: 'high',
      status: 'blocked',
      evidenceRefs: [{ kind: 'runtime', ref: 'pg-dedupe-1' }],
    });
    expect(duplicate.id).toBe(created.id);
    expect(duplicate).toMatchObject({
      priority: 'high',
      status: 'blocked',
      evidenceRefs: [{ kind: 'runtime', ref: 'pg-dedupe-1' }],
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    await expect(ports.concernStore.create({
      text: 'Check the hydration reminder again',
      contactId: 'contact-a',
      originIcpRootInitiationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    })).rejects.toThrow('conflicting ICP roots');

    const resolved = await ports.concernStore.resolveConcern(created.id, {
      outcome: 'Handled already',
      resolvedAt: '2026-03-28T01:00:00.000Z',
    });
    expect(resolved?.resolutionOutcome).toBe('Handled already');
    expect(ports.concernProvider.getActiveConcerns('contact-a')).toEqual([]);

    const recent = await ports.concernStore.listRecentlyResolvedConcerns('contact-a', {
      asOf: '2026-03-28T02:00:00.000Z',
      withinMs: 4 * 60 * 60 * 1000,
    });
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      id: created.id,
      resolvedAt: '2026-03-28T01:00:00.000Z',
    });

    const match = await ports.concernStore.findRecentlyResolvedSimilarConcern({
      text: 'Check the hydration reminder',
      contactId: 'contact-a',
      asOf: '2026-03-28T02:00:00.000Z',
      withinMs: 4 * 60 * 60 * 1000,
    });
    expect(match?.id).toBe(created.id);
  });

  it('resolves stale duplicate concerns before Postgres creation opens another thread', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const stale = await ports.concernStore.create({
      text: 'Follow up on hydration tomorrow morning',
      contactId: 'contact-a',
      status: 'watching',
      createdAt: '2026-03-28T00:00:00.000Z',
      expiresAt: '2026-03-28T01:00:00.000Z',
    });

    const duplicate = await ports.concernStore.create({
      text: 'Follow up on hydration tomorrow',
      contactId: 'contact-a',
      priority: 'high',
      createdAt: '2026-03-28T02:00:00.000Z',
      evidenceRefs: [{ kind: 'message', ref: 'msg-repeat-hydration' }],
    });

    expect(duplicate.id).toBe(stale.id);
    expect(duplicate.status).toBe('resolved');
    expect(duplicate.resolutionOutcome).toBe('Resolved as stale after review window elapsed.');
    await expect(ports.concernStore.getActiveConcerns('contact-a')).resolves.toEqual([]);
    await expect(ports.concernStore.list({
      contactId: 'contact-a',
      includeResolved: true,
      includeExpired: true,
    })).resolves.toHaveLength(1);
  });

  it('persists pending follow-ups and activation state', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:00:00.000Z'),
    });

    const followUp = await ports.pendingFollowUpStore.enqueue({
      content: 'Check in tomorrow about medication.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
      contextSummary: 'Medication check-in context',
      wakeConditions: ['next_user_turn'],
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      dueAt: '2026-03-28T03:00:00.000Z',
    });
    expect(followUp).toMatchObject({
      content: 'Check in tomorrow about medication.',
      contactId: 'contact-a',
      sourceMessageId: 'msg-3',
      contextSummary: 'Medication check-in context',
      wakeConditions: ['next_user_turn'],
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const pending = await ports.pendingFollowUpStore.list({ contactId: 'contact-a' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(followUp.id);

    const restartedPorts = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:30:00.000Z'),
    });
    await expect(restartedPorts.pendingFollowUpStore.peek(followUp.id)).resolves.toMatchObject({
      originIcpRootInitiationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const activated = await ports.pendingFollowUpStore.dequeue(followUp.id, {
      activationReason: 'post_turn_action',
      activatedAt: '2026-03-28T04:00:00.000Z',
    });
    expect(activated?.activatedAt).toBe('2026-03-28T04:00:00.000Z');
    expect(activated?.activationReason).toBe('post_turn_action');
  });

  it('deduplicates near-identical pending follow-up enqueues through the Postgres port', async () => {
    const pool = new FakeIntentionPool();
    let nextId = 0;
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:00:00.000Z'),
      idFactory: () => `follow-up-${++nextId}`,
    });

    const first = await ports.pendingFollowUpStore.enqueue({
      content: 'Check in about the medication plan tomorrow.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
    });
    const second = await ports.pendingFollowUpStore.enqueue({
      content: 'Check in tomorrow about the medication plan.',
      priority: 'high',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      dueAt: '2026-03-28T04:00:00.000Z',
    });

    expect(second?.id).toBe(first?.id);
    await expect(ports.pendingFollowUpStore.list({
      contactId: 'contact-a',
      includeExpired: true,
    })).resolves.toEqual([
      expect.objectContaining({
        id: first?.id,
        content: 'Check in tomorrow about the medication plan.',
        priority: 'high',
        dueAt: '2026-03-28T04:00:00.000Z',
        sourceMessageId: 'msg-2',
      }),
    ]);
    expect(nextId).toBe(1);
  });

  it('filters stale pending follow-ups the same way for store and runtime provider access', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-25T12:00:00.000Z'),
    });

    await ports.pendingFollowUpStore.enqueue({
      content: 'Age this out.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-24T11:00:00.000Z',
    });
    await ports.pendingFollowUpStore.enqueue({
      content: 'Expire after the overdue window.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-24T09:00:00.000Z',
      dueAt: '2026-03-24T10:30:00.000Z',
    });
    await ports.pendingFollowUpStore.enqueue({
      content: 'Keep this pending.',
      priority: 'medium',
      timing: 'scheduled',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      createdAt: '2026-03-25T08:00:00.000Z',
      dueAt: '2026-03-25T18:00:00.000Z',
    });

    await expect(ports.pendingFollowUpStore.list({ contactId: 'contact-a' })).resolves.toEqual([
      expect.objectContaining({ content: 'Keep this pending.' }),
    ]);
    expect(ports.pendingFollowUpProvider.getPendingFollowUps('contact-a')).toEqual([
      expect.objectContaining({ content: 'Keep this pending.' }),
    ]);
    await expect(ports.pendingFollowUpStore.list({
      contactId: 'contact-a',
      includeExpired: true,
    })).resolves.toHaveLength(3);
  });

  it('quarantines invalid pending follow-up rows through the Postgres port', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never, {
      now: () => new Date('2026-03-28T02:00:00.000Z'),
      idFactory: () => 'follow-up-1',
    });

    await ports.pendingFollowUpStore.enqueue({
      content: 'Corrupt wake condition row.',
      priority: 'medium',
      timing: 'soon',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'system:intention',
      authorName: 'Whisper',
      contactId: 'contact-a',
      wakeConditions: ['next_user_turn'],
    });
    pool.corruptPendingFollowUp('follow-up-1', {
      wake_conditions: 'not-json',
    });

    await expect(ports.pendingFollowUpStore.list({ contactId: 'contact-a' })).resolves.toEqual([]);
    await expect(ports.pendingFollowUpStore.peek('follow-up-1')).resolves.toBeNull();
    await expect(ports.pendingFollowUpStore.listQuarantined()).resolves.toEqual([
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

  it('tracks behavioral samples and summaries', async () => {
    const pool = new FakeIntentionPool();
    const ports = createPostgresIntentionPortsFromPool(pool as never);

    const sample = await ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-1',
      responseContent: 'I hear you. Let us focus on the next step.',
    });
    expect(sample.strategy).toBe('empathy');

    const pending = await ports.behavioralPatternTracker.tryRecordOutcomeForLatestPending({
      contactId: 'contact-a',
      outcomeScore: 0.6,
      observedAt: '2026-03-28T05:00:00.000Z',
    });
    expect(pending?.outcomeScore).toBe(0.6);

    await ports.behavioralPatternTracker.recordResponseStrategy({
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      responseContent: '```ts\nconst value = 1;\n```',
      strategy: 'technical',
    });
    await ports.behavioralPatternTracker.recordOutcomeForSample({
      contactId: 'contact-a',
      sourceMessageId: 'msg-2',
      strategy: 'technical',
      outcomeScore: 0.8,
      observedAt: '2026-03-28T06:00:00.000Z',
    });

    const summaries = await ports.behavioralPatternTracker.listStrategySummaries('contact-a');
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        strategy: 'empathy',
        resolvedCount: 1,
        pendingCount: 0,
      }),
      expect.objectContaining({
        strategy: 'technical',
        resolvedCount: 1,
        pendingCount: 0,
      }),
    ]));
  });
});
