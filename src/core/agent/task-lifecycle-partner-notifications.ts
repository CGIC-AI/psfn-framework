import type { EventBus } from '../../shared/event-bus.js';
import type { InferredPostTurnAction } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
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

const log = createComponentLogger('TaskLifecyclePartnerNotifications');

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

export function wireTaskLifecyclePartnerNotifications(
  options: WireTaskLifecyclePartnerNotificationsOptions,
): () => void {
  const now = options.now ?? Date.now;
  const targetChannelId = options.targetChannelId?.trim() ?? '';
  const outboxChannelId = targetChannelId || 'unconfigured:primary-partner';
  const proactiveOutbound = options.proactiveOutbound;
  const queuedDedupeKeys = new Set<string>();
  const pendingPayloads = new Map<string, TaskLifecycleNotificationPayload>();
  const sentAwaitingOutboxRecord = new Map<string, {
    payload: TaskLifecycleNotificationPayload;
    contentLength: number;
  }>();

  const enqueueAsDurableFallback = (
    action: InferredPostTurnAction,
    outboxError: unknown,
  ): void => {
    let persistenceEnabled: boolean;
    try {
      persistenceEnabled = options.postTurnActions.getStatus().persistence.enabled;
    } catch (statusError) {
      throw new AggregateError(
        [outboxError, statusError],
        'Task lifecycle intent could not be persisted to either durable sink',
      );
    }
    if (!persistenceEnabled) {
      throw new AggregateError(
        [outboxError, new Error('Post-turn action queue persistence is disabled')],
        'Task lifecycle intent could not be persisted to either durable sink',
      );
    }

    let enqueueResult;
    try {
      enqueueResult = options.postTurnActions.enqueue(action);
    } catch (enqueueError) {
      throw new AggregateError(
        [outboxError, enqueueError],
        'Task lifecycle intent could not be persisted to either durable sink',
      );
    }
    if (enqueueResult === 'dropped_budget') {
      throw new AggregateError(
        [outboxError, new Error('Post-turn action queue dropped the lifecycle intent')],
        'Task lifecycle intent could not be persisted to either durable sink',
      );
    }
    queuedDedupeKeys.add(action.dedupeKey);
    pendingPayloads.set(
      action.dedupeKey,
      normalizeTaskLifecycleNotificationPayload(action.payload),
    );
  };

  const detachHandler = options.postTurnActions.registerHandler(
    TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
    async (action): Promise<PostTurnActionHandlerResult> => {
      const payload = normalizeTaskLifecycleNotificationPayload(action.payload);
      if (options.outreachOutbox.hasTerminal(action.dedupeKey)) {
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Task lifecycle partner notification already reached a terminal state.' };
      }
      const sentAwaitingRecord = sentAwaitingOutboxRecord.get(action.dedupeKey);
      if (sentAwaitingRecord) {
        appendOutbox(options.outreachOutbox, {
          phase: 'sent',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: targetChannelId || outboxChannelId,
          sourceMessageId: action.sourceMessageId,
          payload: sentAwaitingRecord.payload,
          disposition: 'sent',
          now: now(),
          contentLength: sentAwaitingRecord.contentLength,
        });
        sentAwaitingOutboxRecord.delete(action.dedupeKey);
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Previously delivered task lifecycle update recorded without redispatch.' };
      }
      if (payload.lifecycleStatus === 'started' || payload.lifecycleStatus === 'progress') {
        appendOutbox(options.outreachOutbox, {
          phase: 'skipped',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: action.channelId,
          sourceMessageId: action.sourceMessageId,
          payload,
          disposition: 'skipped',
          now: now(),
          reason: 'non_terminal_lifecycle_update',
        });
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Non-terminal task lifecycle visibility recorded without partner notification.' };
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
      if (action.channelId !== targetChannelId) {
        appendOutbox(options.outreachOutbox, {
          phase: 'blocked',
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: action.channelId,
          sourceMessageId: action.sourceMessageId,
          payload,
          disposition: 'denied',
          now: now(),
          reason: 'target_channel_binding_mismatch',
        });
        queuedDedupeKeys.delete(action.dedupeKey);
        pendingPayloads.delete(action.dedupeKey);
        return { detail: 'Task lifecycle update denied because its target channel binding changed.' };
      }

      const content = (await options.authorNotification({
        lifecycleStatus: payload.lifecycleStatus,
        taskLabel: payload.taskLabel,
        partnerContext: payload.partnerContext,
        internalPrompt: buildTaskLifecycleInternalAuthoringPrompt(payload),
      })).trim();
      appendOutbox(options.outreachOutbox, {
        phase: 'dispatching',
        actionId: action.id,
        dedupeKey: action.dedupeKey,
        channelId: targetChannelId,
        sourceMessageId: action.sourceMessageId,
        payload,
        disposition: 'queued',
        now: now(),
        reason: 'transport_attempt_started',
      });
      const result = await proactiveOutbound.dispatch({
        actionId: action.id,
        channelId: targetChannelId,
        channelType: 'discord',
        content,
        reason: `task_lifecycle:${payload.lifecycleStatus}`,
      });
      if (result.outcome === 'sent') {
        // The sender contract has no idempotency key or delivery receipt. Keep
        // process-local evidence after send returns so an outbox write failure
        // can be retried without redispatch. A process crash in this narrow
        // post-send/pre-record window remains delivery-ambiguous and may be
        // retried at least once after restart.
        sentAwaitingOutboxRecord.set(action.dedupeKey, {
          payload,
          contentLength: content.length,
        });
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
        sentAwaitingOutboxRecord.delete(action.dedupeKey);
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

  // Reconstruct any lifecycle action whose durable outbox intent never
  // reached a terminal phase. A `dispatching` record is deliberately retried:
  // without a transport idempotency key or receipt, a restart in the
  // post-send/pre-record window is ambiguous and delivery is at-least-once.
  const seenOutboxDedupeKeys = new Set<string>();
  for (const record of options.outreachOutbox.listRecent(Number.MAX_SAFE_INTEGER)) {
    if (
      record.metadata?.kind !== TASK_LIFECYCLE_NOTIFICATION_METADATA_KIND
      || seenOutboxDedupeKeys.has(record.dedupeKey)
    ) {
      continue;
    }
    seenOutboxDedupeKeys.add(record.dedupeKey);
    if (
      options.outreachOutbox.hasTerminal(record.dedupeKey)
      || !['queued', 'scheduled', 'dispatching'].includes(record.phase)
    ) {
      continue;
    }
    const payload = normalizeTaskLifecycleNotificationPayload(record.metadata);
    const action: InferredPostTurnAction = {
      id: record.actionId,
      kind: TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
      payload,
      dedupeKey: record.dedupeKey,
      channelId: record.channelId,
      sourceMessageId: record.sourceMessageId,
      inferredAt: record.recordedAt,
      maxRetries: 2,
      ...(record.runAt !== undefined ? { runAt: record.runAt } : {}),
    };
    queuedDedupeKeys.add(record.dedupeKey);
    pendingPayloads.set(record.dedupeKey, payload);
    try {
      const enqueueResult = options.postTurnActions.enqueue(action);
      if (enqueueResult === 'dropped_budget') {
        throw new Error('Post-turn action queue dropped a recovered durable task lifecycle intent');
      }
    } catch (error) {
      queuedDedupeKeys.delete(record.dedupeKey);
      pendingPayloads.delete(record.dedupeKey);
      throw error;
    }
  }

  // This producer is a guard because durable intent is part of accepting the
  // lifecycle event, not best-effort telemetry. Guard failures propagate to
  // the source emitter so it can retry without burning its handoff dedupe key.
  const detachHandoff = options.eventBus.guard('agent.completion_handoff', event => {
    const handoff = event.handoff;
    const dedupeKey = buildTaskLifecycleNotificationDedupeKey(handoff);
    const actionId = buildTaskLifecycleNotificationActionId(dedupeKey);
    const payload = buildTaskLifecycleNotificationPayload(handoff, {
      allowTaskLabel: Boolean(targetChannelId)
        && event.targetChannelId === targetChannelId
        && handoff.origin.sourceChannelId === targetChannelId,
    });

    const skipReason = !targetChannelId || !proactiveOutbound
      ? 'primary_partner_channel_unconfigured'
      : handoff.status === 'started' || handoff.status === 'progress'
        ? 'non_terminal_lifecycle_update'
      : handoff.source === 'post_turn_action'
      && handoff.task.label === TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND
      ? 'internal_post_turn_bookkeeping'
      : undefined;
    if (skipReason) {
      if (!options.outreachOutbox.hasTerminal(dedupeKey)) {
        try {
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
        } catch (outboxError) {
          if (skipReason === 'internal_post_turn_bookkeeping') {
            log.error('Task lifecycle bookkeeping skip could not be recorded', {
              actionId,
              dedupeKey,
              error: String(outboxError),
            });
            return true;
          }
          const action: InferredPostTurnAction = {
            id: actionId,
            kind: TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND,
            payload,
            dedupeKey,
            channelId: outboxChannelId,
            sourceMessageId: handoff.handoffId,
            inferredAt: now(),
            maxRetries: 2,
          };
          enqueueAsDurableFallback(action, outboxError);
          log.warn('Task lifecycle skip outbox append failed; durable post-turn queue retained the intent', {
            actionId,
            dedupeKey,
            error: String(outboxError),
          });
        }
      }
      return true;
    }
    if (queuedDedupeKeys.has(dedupeKey) || options.outreachOutbox.hasTerminal(dedupeKey)) {
      return true;
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
    let outboxError: unknown;
    try {
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
    } catch (error) {
      outboxError = error;
    }
    if (outboxError !== undefined) {
      enqueueAsDurableFallback(action, outboxError);
    } else {
      let enqueueResult;
      try {
        enqueueResult = options.postTurnActions.enqueue(action);
      } catch (enqueueError) {
        log.error('Deferred task lifecycle enqueue failed; durable outbox intent retained for retry', {
          actionId,
          dedupeKey,
          error: String(enqueueError),
        });
        throw enqueueError;
      }
      if (enqueueResult === 'dropped_budget') {
        log.error('Deferred task lifecycle enqueue was dropped; durable outbox intent retained for retry', {
          actionId,
          dedupeKey,
        });
        throw new Error('Post-turn action queue dropped the durable task lifecycle intent');
      }
      queuedDedupeKeys.add(dedupeKey);
      pendingPayloads.set(dedupeKey, payload);
    }
    if (outboxError !== undefined) {
      log.warn('Task lifecycle outbox append failed; durable post-turn queue retained the intent', {
        actionId,
        dedupeKey,
        error: String(outboxError),
      });
    }
    return true;
  });

  return () => {
    detachHandoff();
    detachTelemetry();
    detachHandler();
  };
}
