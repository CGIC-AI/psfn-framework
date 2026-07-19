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

class MemoryOutbox implements OutreachOutboxStore {
  readonly records: OutreachOutboxRecord[] = [];

  append(input: OutreachOutboxAppendInput): OutreachOutboxRecord {
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
  it.each(['completed', 'blocked', 'failed'] as const)(
    'queues a companion-authored policy-gated notification for %s work',
    async (status) => {
      const eventBus = new EventBus();
      const outbox = new MemoryOutbox();
      let handler: PostTurnActionHandler | undefined;
      const postTurnActions = {
        registerHandler: vi.fn((_kind: string, registered: PostTurnActionHandler) => {
          handler = registered;
          return () => {};
        }),
      } as unknown as PostTurnActionRuntime;
      const actions: InferredPostTurnAction[] = [];
      eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));
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

  it('records cancellation as skipped and records policy denial without ad hoc sends', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const postTurnActions = {
      registerHandler: vi.fn((_kind: string, registered: PostTurnActionHandler) => {
        handler = registered;
        return () => {};
      }),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));
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
    expect(actions).toHaveLength(0);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      metadata: { notificationDisposition: 'skipped' },
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('blocked'),
      timestamp: 2_000,
    });
    await handler?.(actions[0]!);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'blocked',
      metadata: { notificationDisposition: 'denied' },
    });
  });

  it('deduplicates rapid replay before queueing and after a terminal send', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const postTurnActions = {
      registerHandler: vi.fn((_kind: string, registered: PostTurnActionHandler) => {
        handler = registered;
        return () => {};
      }),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));
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
    const postTurnActions = {
      registerHandler: vi.fn(() => () => {}),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));

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

  it('fails closed when a persisted action contains an unknown handoff source', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    let handler: PostTurnActionHandler | undefined;
    const postTurnActions = {
      registerHandler: vi.fn((_kind: string, registered: PostTurnActionHandler) => {
        handler = registered;
        return () => {};
      }),
    } as unknown as PostTurnActionRuntime;
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
    const postTurnActions = {
      registerHandler: vi.fn(() => () => {}),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));

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

  it('notifies for tracked post-turn work but skips internal bookkeeping', async () => {
    const eventBus = new EventBus();
    const outbox = new MemoryOutbox();
    const postTurnActions = {
      registerHandler: vi.fn(() => () => {}),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));

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
        origin: { originatingTaskId: 'tracked-long-running-task' },
      }),
      timestamp: 1_000,
    });
    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed', {
        source: 'post_turn_action',
        dedupeKey: 'bookkeeping-handoff',
        origin: {},
      }),
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
    const postTurnActions = {
      registerHandler: vi.fn(() => () => {}),
    } as unknown as PostTurnActionRuntime;
    const actions: InferredPostTurnAction[] = [];
    eventBus.on('agent.post_turn.actions.inferred', event => actions.push(...event.actions));

    wireTaskLifecyclePartnerNotifications({
      eventBus,
      postTurnActions,
      outreachOutbox: outbox,
      proactiveOutbound: null,
      targetChannelId: null,
      authorNotification: vi.fn(async () => 'Done.'),
    });

    await eventBus.emit('agent.completion_handoff', {
      handoff: handoff('completed'),
      timestamp: 1_000,
    });

    expect(actions).toHaveLength(0);
    expect(outbox.records.at(-1)).toMatchObject({
      phase: 'skipped',
      channelId: 'unconfigured:primary-partner',
      reason: 'primary_partner_channel_unconfigured',
      metadata: { notificationDisposition: 'skipped' },
    });
  });
});
