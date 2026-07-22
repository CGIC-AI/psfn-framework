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

  getLatest(dedupeKey: string): OutreachOutboxRecord | undefined {
    return this.records.findLast(record => record.dedupeKey === dedupeKey);
  }

  getIcpDeliveredCompletion(): OutreachOutboxRecord | undefined {
    return undefined;
  }

  countSentSince(input: { sinceMs: number; reasonPrefix?: string }): number {
    return this.records.filter(record => (
      record.phase === 'sent'
      && record.recordedAt >= input.sinceMs
      && (input.reasonPrefix === undefined || (record.reason ?? '').startsWith(input.reasonPrefix))
    )).length;
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

});
