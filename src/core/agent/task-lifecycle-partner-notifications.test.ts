import { describe, expect, it, vi } from 'vitest';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { CompletionHandoffRecord } from '../../shared/contracts/completion-handoff.js';
import { buildCompletionHandoff } from './completion-handoff.js';
import type {
  PostTurnActionHandler,
  PostTurnActionRuntime,
} from './post-turn-action-runtime.js';
import type { OutreachOutboxAppendInput, OutreachOutboxRecord, OutreachOutboxStore } from '../intention/outreach-outbox.js';
import type { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import {
  TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
  wireTaskLifecyclePartnerNotifications,
} from './task-lifecycle-partner-notifications.js';

const PRIMARY_CHANNEL_ID = '123456789012345678';
const REPLACEMENT_PRIMARY_CHANNEL_ID = '234567890123456789';

class MemoryOutbox implements OutreachOutboxStore {
  readonly records: OutreachOutboxRecord[] = [];
  private failPhaseOnce: OutreachOutboxRecord['phase'] | undefined;

  constructor(options: { failPhaseOnce?: OutreachOutboxRecord['phase'] } = {}) {
    this.failPhaseOnce = options.failPhaseOnce;
  }

  append(input: OutreachOutboxAppendInput): OutreachOutboxRecord {
    if (input.phase === this.failPhaseOnce) {
      this.failPhaseOnce = undefined;
      throw new Error(`temporary ${input.phase} outbox failure`);
    }
    const record: OutreachOutboxRecord = {
      version: 1,
      ...input,
      recordedAt: input.recordedAt ?? 1_000,
    };
    this.records.push(record);
    return record;
  }

  hasTerminal(dedupeKey: string): boolean {
    return this.records.some(record => (
      record.dedupeKey === dedupeKey
      && ['sent', 'blocked', 'failed', 'skipped'].includes(record.phase)
    ));
  }

  getTerminal(dedupeKey: string): OutreachOutboxRecord | undefined {
    return this.records.find(record => record.dedupeKey === dedupeKey && this.hasTerminal(dedupeKey));
  }

  getIcpDeliveredCompletion(): OutreachOutboxRecord | undefined {
    return undefined;
  }

  listRecent(limit = 25): OutreachOutboxRecord[] {
    return this.records.slice(-limit).reverse();
  }
}

function createPostTurnActionHarness(options: {
  onHandler?: (handler: PostTurnActionHandler) => void;
  persistenceEnabled?: boolean;
  enqueueResult?: 'queued' | 'deduplicated' | 'dropped_budget';
} = {}): {
  runtime: PostTurnActionRuntime;
  actions: InferredPostTurnAction[];
} {
  const actions: InferredPostTurnAction[] = [];
  return {
    actions,
    runtime: {
      enqueue: vi.fn((action: InferredPostTurnAction) => {
        actions.push(action);
        return options.enqueueResult ?? 'queued';
      }),
      registerHandler: vi.fn((_kind: string, handler: PostTurnActionHandler) => {
        options.onHandler?.(handler);
        return () => {};
      }),
      getStatus: vi.fn(() => ({
        persistence: { enabled: options.persistenceEnabled ?? false },
      })),
    } as unknown as PostTurnActionRuntime,
  };
}

function handoff(
  status: CompletionHandoffRecord['status'],
  overrides: Partial<CompletionHandoffRecord> = {},
): CompletionHandoffRecord {
  return {
    ...buildCompletionHandoff({
      source: 'subagent',
      taskId: `task-${status}`,
      taskLabel: 'dependency audit',
      subagentId: `subagent-${status}`,
      status,
      resultSummary: 'Private raw result /srv/secret.txt token=do-not-leak',
      outputRefs: [{ kind: 'file', ref: '/srv/secret.txt' }],
      blocker: status === 'blocked'
        ? { reason: 'Private blocker at /srv/private', details: { token: 'secret' } }
        : undefined,
      partialResult: status === 'partial' || status === 'interrupted',
      recommendedNextAction: 'Inspect /srv/private and use token=secret.',
      origin: {
        sourceChannelId: 'discord:internal-source',
        requestId: 'private-request-id',
      },
      dedupeKey: `handoff-${status}`,
      createdAt: 1_000,
    }),
    ...overrides,
  };
}

describe('task lifecycle partner notifications', () => {
  it.each(['completed', 'blocked', 'failed', 'folded_back'] as const)(
    'queues a companion-authored policy-gated notification for %s work',
    async (status) => {
      const eventBus = new EventBus();
      const outbox = new MemoryOutbox();
      let handler: PostTurnActionHandler | undefined;
      const harness = createPostTurnActionHarness({
        onHandler: registered => { handler = registered; },
      });
      const postTurnActions = harness.runtime;
      const actions = harness.actions;
      const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));

      wireTaskLifecyclePartnerNotifications({
        eventBus,
        postTurnActions,
        outreachOutbox: outbox,
        proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
        targetChannelId: PRIMARY_CHANNEL_ID,
        authorNotification: vi.fn(async () => `Companion-authored ${status} update.`),
        now: () => 2_000,
      });

      await eventBus.emit('agent.completion_handoff', {
        handoff: handoff(status),
        targetChannelId: 'discord:internal-source',
        timestamp: 1_000,
      });

      expect(actions).toHaveLength(1);
      expect(actions[0]?.kind).toBe(TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND);
      expect(JSON.stringify(actions[0]?.payload)).not.toMatch(/secret|private-request|token=|\/srv\//i);

      await handler?.(actions[0]!);
      expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
        channelId: PRIMARY_CHANNEL_ID,
        channelType: 'discord',
        content: `Companion-authored ${status} update.`,
      }));
      expect(outbox.records.at(-1)).toMatchObject({
        phase: 'sent',
        metadata: {
          kind: 'task_lifecycle_notification',
          lifecycleStatus: status,
          notificationDisposition: 'sent',
        },
      });
    },
  );

  it('routes cancellation through policy and records policy denial without ad hoc sends', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    });
    const postTurnActions = harness.runtime;
    const actions = harness.actions;
    const dispatch = vi.fn(async () => ({
      outcome: 'blocked' as const,
      reason: 'channel_not_approved_for_primary',
    }));

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'A companion-authored update.'),
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('cancelled'),
      timestamp: 1_000,
    });
    expect(actions).toHaveLength(1);
    await handler?.(actions[0]!);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'blocked',
      metadata: {
        lifecycleStatus: 'cancelled',
        notificationDisposition: 'denied',
      },
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('blocked', { dedupeKey: 'blocked-after-cancelled' }),
      timestamp: 2_000,
    });
    await handler?.(actions[1]!);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'blocked',
      metadata: { notificationDisposition: 'denied' },
    });
  });

  it.each(['started', 'progress'] as const)(
    'records %s lifecycle visibility without sending a partner notification',
    async (status) => {
      const eventBus = new EventBus();
      const outbox = new MemoryOutbox();
      const harness = createPostTurnActionHarness();
      const postTurnActions = harness.runtime;
      const actions = harness.actions;

      wireTaskLifecyclePartnerNotifications({
        eventBus,
        postTurnActions,
        outreachOutbox: outbox,
        proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
        targetChannelId: PRIMARY_CHANNEL_ID,
        authorNotification: vi.fn(async () => 'No outbound message.'),
      });

      await eventBus.emit('agent.completion_handoff', {
        handoff: handoff(status),
        targetChannelId: PRIMARY_CHANNEL_ID,
        timestamp: 1_000,
      });

      expect(actions).toHaveLength(0);
      expect(outbox.records.at(-1)).toMatchObject({
        phase: 'skipped',
        reason: 'non_terminal_lifecycle_update',
        metadata: {
          lifecycleStatus: status,
          notificationDisposition: 'skipped',
        },
      });
    },
  );

  it('durably defers non-terminal visibility when its initial skip record fails', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'skipped' });
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      persistenceEnabled: true,
      onHandler: registered => { handler = registered; },
    });

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'No outbound message.'),
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('started'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });

    expect(harness.actions).toHaveLength(1);
    await handler?.(harness.actions[0]!);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      reason: 'non_terminal_lifecycle_update',
    });
  });

  it('durably defers an unconfigured-channel skip when its initial record fails', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'skipped' });
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      persistenceEnabled: true,
      onHandler: registered => { handler = registered; },
    });

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: null,
      targetChannelId: null,
      authorNotification: vi.fn(async () => 'No outbound message.'),
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      timestamp: 1_000,
    });

    expect(harness.actions).toHaveLength(1);
    await handler?.(harness.actions[0]!);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      reason: 'primary_partner_channel_unconfigured',
    });
  });

  it('deduplicates rapid replay before queueing and after a terminal send', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    });
    const postTurnActions = harness.runtime;
    const actions = harness.actions;
    const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });
    const event = {
      handoff: handoff('completed'),
      timestamp: 1_000,
    };
    await eventBus.emit('agent.completion_handoff', event);
    await eventBus.emit('agent.completion_handoff', event);
    expect(actions).toHaveLength(1);

    await handler?.(actions[0]!);
    await handler?.(actions[0]!);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('uses a generic label for work originating outside the primary partner channel', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness();
    const postTurnActions = harness.runtime;
    const actions = harness.actions;

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    const foreignHandoff = handoff('completed');
    foreignHandoff.task.label = 'Rotate sk-prod-secret';
    await eventBus.emit('agent.completion_handoff', {
      handoff: foreignHandoff,
      targetChannelId: 'discord:foreign-contact',
      timestamp: 1_000,
    });

    expect(actions[0]?.payload).toMatchObject({ taskLabel: 'background task' });
    expect(JSON.stringify(actions[0]?.payload)).not.toMatch(/sk-prod-secret|foreign-contact/i);
  });

  it('uses a redacted, sanitized task label for work from the approved primary channel', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness();
    const postTurnActions = harness.runtime;
    const actions = harness.actions;

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    const localHandoff = handoff('completed');
    localHandoff.task.label = 'Dependency audit token=private-value /srv/private.txt';
    localHandoff.origin.sourceChannelId = PRIMARY_CHANNEL_ID;
    await eventBus.emit('agent.completion_handoff', {
      handoff: localHandoff,
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });

    expect(actions[0]?.payload).toMatchObject({
      taskLabel: expect.stringContaining('Dependency audit'),
    });
    expect(JSON.stringify(actions[0]?.payload)).not.toMatch(/private-value|\/srv\//i);
  });

  it('propagates transient authoring failure so a retry can succeed without a duplicate send', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    });
    const postTurnActions = harness.runtime;
    const actions = harness.actions;
    const authorNotification = vi.fn()
      .mockRejectedValueOnce(new Error('temporary model outage'))
      .mockResolvedValueOnce('Recovered update.');
    const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification,
    });
    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });

    await expect(handler?.(actions[0]!)).rejects.toThrow('temporary model outage');
    expect(outbox.hasTerminal(actions[0]!.dedupeKey)).toBe(false);
    await expect(handler?.(actions[0]!)).resolves.toMatchObject({
      detail: 'Companion-authored task lifecycle update sent.',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('propagates transient dispatch failure so the action runtime can retry it', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    });
    const postTurnActions = harness.runtime;
    const actions = harness.actions;
    const dispatch = vi.fn()
      .mockRejectedValueOnce(new Error('temporary transport outage'))
      .mockResolvedValueOnce({ outcome: 'sent' as const });

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Recovered update.'),
    });
    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });

    await expect(handler?.(actions[0]!)).rejects.toThrow('temporary transport outage');
    expect(outbox.hasTerminal(actions[0]!.dedupeKey)).toBe(false);
    await expect(handler?.(actions[0]!)).resolves.toMatchObject({
      detail: 'Companion-authored task lifecycle update sent.',
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('records a completed send on retry without redispatching after a transient outbox failure', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'sent' });
    let handler: PostTurnActionHandler | undefined;
    const harness = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    });
    const postTurnActions = harness.runtime;
    const actions = harness.actions;
    const dispatch = vi.fn(async () => ({ outcome: 'sent' as const }));

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Delivered update.'),
    });
    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });

    await expect(handler?.(actions[0]!)).rejects.toThrow('temporary sent outbox failure');
    await expect(handler?.(actions[0]!)).resolves.toMatchObject({
      detail: 'Previously delivered task lifecycle update recorded without redispatch.',
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(outbox.records.at(-1)).toMatchObject({ phase: 'sent' });
  });

  it('durably records intent before enqueue and denies recovery after the target binding changes', async () => {
    const firstBus = new EventBus();
    const outbox = new MemoryOutbox();
    const firstEnqueue = vi.fn(() => {
      expect(outbox.records.at(-1)).toMatchObject({ phase: 'queued' });
      throw new Error('queue persistence unavailable');
    });
    const detach = wireTaskLifecyclePartnerNotifications({
      eventBus: firstBus,
      postTurnActions: {
        enqueue: firstEnqueue,
        registerHandler: vi.fn(() => () => {}),
      } as unknown as PostTurnActionRuntime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
      now: () => 2_000,
    });

    await expect(firstBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    })).rejects.toThrow('queue persistence unavailable');
    expect(firstEnqueue).toHaveBeenCalledOnce();
    expect(outbox.records).toHaveLength(1);
    detach();

    let recoveredHandler: PostTurnActionHandler | undefined;
    const recoveryHarness = createPostTurnActionHarness({
      onHandler: registered => { recoveredHandler = registered; },
    });
    const dispatch = vi.fn();
    wireTaskLifecyclePartnerNotifications({
      eventBus: new EventBus(),
      postTurnActions: recoveryHarness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: REPLACEMENT_PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
      now: () => 3_000,
    });

    expect(recoveryHarness.actions).toEqual([
      expect.objectContaining({
        kind: TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
        dedupeKey: outbox.records[0]?.dedupeKey,
        channelId: PRIMARY_CHANNEL_ID,
        sourceMessageId: outbox.records[0]?.sourceMessageId,
      }),
    ]);
    await expect(recoveredHandler?.(recoveryHarness.actions[0]!)).resolves.toMatchObject({
      detail: 'Task lifecycle update denied because its target channel binding changed.',
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'blocked',
      channelId: PRIMARY_CHANNEL_ID,
      reason: 'target_channel_binding_mismatch',
    });
  });

  it('retries in the same process when enqueue throws after durable outbox acceptance', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const actions: InferredPostTurnAction[] = [];
    const enqueue = vi.fn((action: InferredPostTurnAction) => {
      if (enqueue.mock.calls.length === 1) {
        throw new Error('temporary queue write failure');
      }
      actions.push(action);
      return 'queued' as const;
    });
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: {
        enqueue,
        registerHandler: vi.fn(() => () => {}),
      } as unknown as PostTurnActionRuntime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });
    const event = {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    };

    await expect(eventBus.emit('agent.completion_handoff', event))
      .rejects.toThrow('temporary queue write failure');
    await eventBus.emit('agent.completion_handoff', event);
    expect(actions).toHaveLength(1);
    expect(outbox.records).toHaveLength(2);
  });

  it('fails startup recovery when the queue drops a durable outbox intent', async () => {
    const sourceBus = new EventBus();
    const outbox = new MemoryOutbox();
    const detach = wireTaskLifecyclePartnerNotifications({
      eventBus: sourceBus,
      postTurnActions: createPostTurnActionHarness().runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });
    await sourceBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    });
    detach();

    expect(() => wireTaskLifecyclePartnerNotifications({
      eventBus: new EventBus(),
      postTurnActions: createPostTurnActionHarness({
        enqueueResult: 'dropped_budget',
      }).runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    })).toThrow('queue dropped a recovered durable task lifecycle intent');
  });

  it('rejects for same-process retry when enqueue drops a durably recorded intent', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness({ enqueueResult: 'dropped_budget' });
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await expect(eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    })).rejects.toThrow('queue dropped the durable task lifecycle intent');
    expect(outbox.records).toHaveLength(1);
  });

  it('retains durable queued work when the initial outbox write fails', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'queued' });
    const harness = createPostTurnActionHarness({ persistenceEnabled: true });
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });
    const event = {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    };

    await eventBus.emit('agent.completion_handoff', event);
    expect(harness.actions).toHaveLength(1);
    expect(outbox.records).toHaveLength(0);
  });

  it('rejects when the outbox fails and the fallback queue is not persistent', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'queued' });
    const harness = createPostTurnActionHarness();
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await expect(eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    })).rejects.toThrow('could not be persisted to either durable sink');
    expect(harness.actions).toHaveLength(0);
  });

  it('rejects when the outbox fails and the persistent queue drops the action', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'queued' });
    const harness = createPostTurnActionHarness({
      persistenceEnabled: true,
      enqueueResult: 'dropped_budget',
    });
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: harness.runtime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await expect(eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    })).rejects.toThrow('could not be persisted to either durable sink');
  });

  it('permits same-process replay when both durable intent sinks initially fail', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox({ failPhaseOnce: 'queued' });
    const actions: InferredPostTurnAction[] = [];
    const enqueue = vi.fn((action: InferredPostTurnAction) => {
      if (enqueue.mock.calls.length === 1) {
        throw new Error('queue persistence unavailable');
      }
      actions.push(action);
      return 'queued' as const;
    });
    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions: {
        enqueue,
        registerHandler: vi.fn(() => () => {}),
        getStatus: vi.fn(() => ({
          persistence: { enabled: true },
        })),
      } as unknown as PostTurnActionRuntime,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });
    const event = {
      handoff: handoff('completed'),
      targetChannelId: PRIMARY_CHANNEL_ID,
      timestamp: 1_000,
    };

    await expect(eventBus.emit('agent.completion_handoff', event))
      .rejects.toThrow('could not be persisted to either durable sink');
    await eventBus.emit('agent.completion_handoff', event);
    expect(actions).toHaveLength(1);
    expect(outbox.records).toHaveLength(1);
  });

  it('fails closed when a persisted action contains an unknown handoff source', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const postTurnActions = createPostTurnActionHarness({
      onHandler: registered => { handler = registered; },
    }).runtime;
    const dispatch = vi.fn();

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await expect(handler?.({
      id: 'invalid-source',
      kind: TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
      payload: {
        schemaVersion: 1,
        handoffId: 'handoff:invalid',
        source: 'unknown-worker-source',
        lifecycleStatus: 'completed',
        taskLabel: 'background task',
        partnerContext: 'finished',
      },
      dedupeKey: 'invalid-source',
      channelId: PRIMARY_CHANNEL_ID,
      sourceMessageId: 'handoff:invalid',
      inferredAt: 1_000,
    })).rejects.toThrow('Invalid task lifecycle partner-notification payload');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('records a terminal failure and permits recovery after the action queue drops work', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness();
    const postTurnActions = harness.runtime;
    const actions = harness.actions;

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
      now: () => 2_000,
    });
    const event = { handoff: handoff('completed'), timestamp: 1_000 };
    await eventBus.emit('agent.completion_handoff', event);
    const action = actions[0]!;

    await eventBus.emit('agent.post_turn.action.telemetry', {
      actionId: action.id,
      actionKind: action.kind,
      channelId: action.channelId,
      sourceMessageId: action.sourceMessageId,
      dedupeKey: action.dedupeKey,
      capability: 'generic',
      runtimeClass: 'background_continuation',
      chargeLane: 'background',
      phase: 'dropped_budget',
      attempt: 0,
      maxAttempts: 3,
      queueDepth: 0,
      timestamp: 2_000,
      error: 'queue budget exhausted',
    });

    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'failed',
      metadata: { notificationDisposition: 'failed' },
      reason: 'action_queue_dropped_budget',
    });
    await eventBus.emit('agent.completion_handoff', event);
    expect(actions).toHaveLength(1);
  });

  it('notifies for untracked post-turn work and skips only explicitly marked notification bookkeeping', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness();
    const postTurnActions = harness.runtime;
    const actions = harness.actions;

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: { dispatch: vi.fn() } as unknown as ProactiveOutboundDispatcher,
      targetChannelId: PRIMARY_CHANNEL_ID,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('blocked', {
        source: 'post_turn_action',
        origin: {},
      }),
      timestamp: 1_000,
    });
    const bookkeepingHandoff = handoff('completed', {
      source: 'post_turn_action',
      dedupeKey: 'bookkeeping-handoff',
      origin: {},
    });
    bookkeepingHandoff.task.label = TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND;
    await eventBus.emit('agent.completion_handoff', {
      handoff: bookkeepingHandoff,
      timestamp: 2_000,
    });

    expect(actions).toHaveLength(1);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      reason: 'internal_post_turn_bookkeeping',
    });
  });

  it('records a visible skip when no approved primary partner channel is configured', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const harness = createPostTurnActionHarness();
    const postTurnActions = harness.runtime;
    const actions = harness.actions;

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: null,
      targetChannelId: null,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    const skippedHandoff = handoff('completed');
    skippedHandoff.task.label = 'Secret token=do-not-disclose';
    await eventBus.emit('agent.completion_handoff', {
      handoff: skippedHandoff,
      timestamp: 1_000,
    });

    expect(actions).toHaveLength(0);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      channelId: 'unconfigured:primary-partner',
      reason: 'primary_partner_channel_unconfigured',
      metadata: {
        notificationDisposition: 'skipped',
        taskLabel: 'background task',
      },
    });
    expect(JSON.stringify(outbox.records.at(-1)?.metadata)).not.toContain('do-not-disclose');
  });
});
