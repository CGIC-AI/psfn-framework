import type { EventBus } from '../../shared/event-bus.js';
import type {
  AgentResponse,
  InferredPostTurnAction,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type {
  OutreachOutboxPhase,
  OutreachOutboxStore,
} from '../intention/outreach-outbox.js';
import type { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import type {
  PostTurnActionHandlerResult,
  PostTurnActionRuntime,
} from './post-turn-action-runtime.js';
import { BACKGROUND_CONTINUATION_RUNTIME_CLASS } from './worker-lanes.js';
import {
  buildTaskLifecycleInternalAuthoringPrompt,
  buildTaskLifecycleNotificationActionId,
  buildTaskLifecycleNotificationDedupeKey,
  buildTaskLifecycleNotificationMetadata,
  buildTaskLifecycleNotificationPayload,
  normalizeTaskLifecycleNotificationPayload,
  TASK_LIFECYCLE_NOTIFICATION_METADATA_KIND,
  TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
  type TaskLifecycleNotificationAuthorInput,
  type TaskLifecycleNotificationPayload,
} from './task-lifecycle-partner-notification-contract.js';

export {
  TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
  type TaskLifecycleNotificationAuthorInput,
} from './task-lifecycle-partner-notification-contract.js';

export interface WireTaskLifecyclePartnerNotificationsOptions {
  eventBus: EventBus;
  postTurnActions: PostTurnActionRuntime;
  outreachOutbox: OutreachOutboxStore;
  proactiveOutbound: ProactiveOutboundDispatcher | null;
  targetChannelId?: string | null;
  authorNotification(
    input: TaskLifecycleNotificationAuthorInput,
  ): Promise<string>;
  now?: () => number;
}

function appendOutbox(
  outbox: OutreachOutboxStore,
  input: {
    phase: OutreachOutboxPhase;
    actionId: string;
    dedupeKey: string;
    channelId: string;
    sourceMessageId: string;
    payload: TaskLifecycleNotificationPayload;
    disposition: 'queued' | 'sent' | 'skipped' | 'denied' | 'failed';
    now: number;
    reason?: string;
    runAt?: number;
    error?: string;
    contentLength?: number;
  },
): void {
  outbox.append({
    phase: input.phase,
    actionId: input.actionId,
    dedupeKey: input.dedupeKey,
    channelId: input.channelId,
    channelType: 'discord',
    sourceMessageId: input.sourceMessageId,
    recordedAt: input.now,
    metadata: buildTaskLifecycleNotificationMetadata(input.payload, input.disposition),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.runAt !== undefined ? { runAt: input.runAt } : {}),
    ...(input.error ? { error: input.error } : {}),
    ...(input.contentLength !== undefined ? { contentLength: input.contentLength } : {}),
  });
}

function buildSyntheticInferenceEvent(input: {
  action: InferredPostTurnAction;
  targetChannelId: string;
  now: number;
}): {
  message: SubstrateMessage;
  response: AgentResponse;
  actions: InferredPostTurnAction[];
} {
  return {
    message: {
      id: input.action.sourceMessageId,
      channelId: input.targetChannelId,
      channelType: 'discord',
      authorId: 'system:task-lifecycle',
      authorName: 'Task lifecycle',
      content: '',
      timestamp: new Date(input.now),
      isDirectMessage: true,
    },
    response: {
      channelId: input.targetChannelId,
      content: '',
      metadata: {
        model: 'task-lifecycle-policy',
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      },
    },
    actions: [input.action],
  };
}

export function wireTaskLifecyclePartnerNotifications(
  options: WireTaskLifecyclePartnerNotificationsOptions,
): () => void {
  const now = options.now ?? Date.now;
  const targetChannelId = options.targetChannelId?.trim() ?? '';
  const outboxChannelId = targetChannelId || 'unconfigured:primary-partner';
  const proactiveOutbound = options.proactiveOutbound;
  const queuedDedupeKeys = new Set<string>();
  const pendingPayloads = new Map<string, TaskLifecycleNotificationPayload>();

  const detachHandler = options.postTurnActions.registerHandler(
    TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
    async (action): Promise<PostTurnActionHandlerResult> => {
      const payload = normalizeTaskLifecycleNotificationPayload(action.payload);
      if (options.outreachOutbox.hasTerminal(action.dedupeKey)) {
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Task lifecycle partner notification already reached a terminal state.' };
      }
      if (!targetChannelId || !proactiveOutbound) {
        appendOutbox(options.outreachOutbox, {
          phase: 'skipped',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: outboxChannelId,
          sourceMessageId: action.sourceMessageId,
          payload,
          disposition: 'skipped',
          now: now(),
          reason: 'primary_partner_channel_unconfigured',
        });
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Task lifecycle update skipped because no primary partner channel is configured.' };
      }

      try {
        const content = (await options.authorNotification({
          lifecycleStatus: payload.lifecycleStatus,
          taskLabel: payload.taskLabel,
          partnerContext: payload.partnerContext,
          internalPrompt: buildTaskLifecycleInternalAuthoringPrompt(payload),
        })).trim();
        const result = await proactiveOutbound.dispatch({
          actionId: action.id,
          channelId: targetChannelId,
          channelType: 'discord',
          content,
          reason: `task_lifecycle:${payload.lifecycleStatus}`,
        });
        if (result.outcome === 'sent') {
          appendOutbox(options.outreachOutbox, {
            phase: 'sent',
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            channelId: targetChannelId,
            sourceMessageId: action.sourceMessageId,
            payload,
            disposition: 'sent',
            now: now(),
            contentLength: content.length,
          });
          queuedDedupeKeys.delete(action.dedupeKey);
          pendingPayloads.delete(action.dedupeKey);
          return { detail: 'Companion-authored task lifecycle update sent.' };
        }
        if (result.reason === 'rate_limited' && result.retryAfterMs !== undefined) {
          const runAt = now() + result.retryAfterMs;
          appendOutbox(options.outreachOutbox, {
            phase: 'scheduled',
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            channelId: targetChannelId,
            sourceMessageId: action.sourceMessageId,
            payload,
            disposition: 'queued',
            now: now(),
            reason: result.reason,
            runAt,
          });
          return {
            detail: 'Task lifecycle update deferred by the outbound rate limit.',
            rescheduleAt: runAt,
          };
        }
        appendOutbox(options.outreachOutbox, {
          phase: 'blocked',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: targetChannelId,
          sourceMessageId: action.sourceMessageId,
          payload,
          disposition: 'denied',
          now: now(),
          reason: result.reason,
        });
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: `Task lifecycle update denied by outbound policy: ${result.reason}.` };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        appendOutbox(options.outreachOutbox, {
          phase: 'failed',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: targetChannelId,
          sourceMessageId: action.sourceMessageId,
          payload,
          disposition: 'failed',
          now: now(),
          error: detail,
        });
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: `Task lifecycle update failed: ${detail}` };
      }
    },
    {
      executionMode: 'background',
      runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
    },
  );

  const detachTelemetry = options.eventBus.on('agent.post_turn.action.telemetry', event => {
    if (
      event.actionKind !== TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND
      || options.outreachOutbox.hasTerminal(event.dedupeKey)
      || !['failed', 'dropped_budget', 'cancelled', 'acknowledged'].includes(event.phase)
    ) {
      return;
    }
    let payload = pendingPayloads.get(event.dedupeKey);
    if (!payload) {
      const queuedRecord = options.outreachOutbox
        .listRecent(1_000)
        .find(record => (
          record.dedupeKey === event.dedupeKey
          && record.metadata?.kind === TASK_LIFECYCLE_NOTIFICATION_METADATA_KIND
        ));
      if (queuedRecord?.metadata) {
        try {
          payload = normalizeTaskLifecycleNotificationPayload(queuedRecord.metadata);
        } catch {
          return;
        }
      }
    }
    if (!payload) return;

    const skipped = event.phase === 'cancelled' || event.phase === 'acknowledged';
    appendOutbox(options.outreachOutbox, {
      phase: skipped ? 'skipped' : 'failed',
      actionId: event.actionId,
      dedupeKey: event.dedupeKey,
      channelId: outboxChannelId,
      sourceMessageId: event.sourceMessageId ?? payload.handoffId,
      payload,
      disposition: skipped ? 'skipped' : 'failed',
      now: event.timestamp,
      reason: `action_queue_${event.phase}`,
      ...(event.error ? { error: event.error } : {}),
    });
    queuedDedupeKeys.delete(event.dedupeKey);
    pendingPayloads.delete(event.dedupeKey);
  });

  const detachHandoff = options.eventBus.on('agent.completion_handoff', async event => {
    const handoff = event.handoff;
    const dedupeKey = buildTaskLifecycleNotificationDedupeKey(handoff);
    const actionId = buildTaskLifecycleNotificationActionId(dedupeKey);
    const payload = buildTaskLifecycleNotificationPayload(handoff);

    const skipReason = !targetChannelId || !proactiveOutbound
      ? 'primary_partner_channel_unconfigured'
      : handoff.source === 'post_turn_action'
      && !handoff.origin.originatingTaskId
      && !handoff.origin.originatingBeadId
      ? 'internal_post_turn_bookkeeping'
      : handoff.status === 'cancelled'
        ? 'cancelled_task'
        : undefined;
    if (skipReason) {
      if (!options.outreachOutbox.hasTerminal(dedupeKey)) {
        appendOutbox(options.outreachOutbox, {
          phase: 'skipped',
          actionId,
          dedupeKey,
          channelId: outboxChannelId,
          sourceMessageId: handoff.handoffId,
          payload,
          disposition: 'skipped',
          now: now(),
          reason: skipReason,
        });
      }
      return;
    }
    if (queuedDedupeKeys.has(dedupeKey) || options.outreachOutbox.hasTerminal(dedupeKey)) {
      return;
    }

    const inferredAt = now();
    const action: InferredPostTurnAction = {
      id: actionId,
      kind: TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
      payload,
      dedupeKey,
      channelId: targetChannelId,
      sourceMessageId: handoff.handoffId,
      inferredAt,
      maxRetries: 2,
    };
    queuedDedupeKeys.add(dedupeKey);
    pendingPayloads.set(dedupeKey, payload);
    appendOutbox(options.outreachOutbox, {
      phase: 'queued',
      actionId,
      dedupeKey,
      channelId: targetChannelId,
      sourceMessageId: handoff.handoffId,
      payload,
      disposition: 'queued',
      now: inferredAt,
    });
    await options.eventBus.emit(
      'agent.post_turn.actions.inferred',
      buildSyntheticInferenceEvent({
        action,
        targetChannelId,
        now: inferredAt,
      }),
    );
  });

  return () => {
    detachHandoff();
    detachTelemetry();
    detachHandler();
  };
}
