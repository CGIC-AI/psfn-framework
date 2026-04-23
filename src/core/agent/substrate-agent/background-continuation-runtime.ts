import type { EventBus } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import type { AgentResponse, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { BackgroundCompletionDeliveryQueue } from '../background-completion-delivery-queue.js';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  resolveRuntimeLaneBudgetProfile,
  type BackgroundContinuationRuntimeClass,
} from '../worker-lanes.js';
import {
  decideBackgroundCompletionNotification,
  type BackgroundCompletionChannelContext,
  type BackgroundCompletionNotificationReason,
  type BackgroundCompletionOrigin,
  type BackgroundCompletionUrgency,
} from '../background-completion-policy.js';

const BACKGROUND_CONTINUATION_PROFILE = resolveRuntimeLaneBudgetProfile(
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
);

export interface BackgroundContinuationCompletionSignal {
  runtimeClass: BackgroundContinuationRuntimeClass;
  continuationId: string;
  sourceMessageId: string;
  deliverySessionId: string;
  queuedForPostTurnDelivery: boolean;
  hasDeliverableContent: boolean;
  notifyUser: boolean;
  notificationReason: BackgroundCompletionNotificationReason;
  origin: BackgroundCompletionOrigin;
  urgency: BackgroundCompletionUrgency;
  channelContext: BackgroundCompletionChannelContext;
  completionAgeMs: number | null;
  stale: boolean;
  taskKind: string | null;
  intent: string | null;
  completedAt: number;
  queueDepth: number;
  droppedContinuationIds: string[];
}

export interface PendingBackgroundContinuationDelivery {
  runtimeClass: BackgroundContinuationRuntimeClass;
  continuationId: string;
  sourceMessageId: string;
  deliverySessionId: string;
  content: string;
  completedAt: number;
  origin: BackgroundCompletionOrigin;
  urgency: BackgroundCompletionUrgency;
  channelContext: BackgroundCompletionChannelContext;
  completionAgeMs: number | null;
  stale: boolean;
  taskKind: string | null;
  intent: string | null;
  notificationReason: BackgroundCompletionNotificationReason;
}

export interface BackgroundContinuationTaskRecord {
  runtimeClass: BackgroundContinuationRuntimeClass;
  continuationId: string;
  sourceMessageId: string;
  sourceTimestampMs: number | null;
  channelId: string;
  channelType: SubstrateMessage['channelType'];
  deliverySessionId: string;
  origin: BackgroundCompletionOrigin;
  urgency: BackgroundCompletionUrgency;
  channelContext: BackgroundCompletionChannelContext;
  completionAgeMs: number | null;
  stale: boolean;
  taskKind: string | null;
  intent: string | null;
  completedAt: number;
  responseChars: number;
  hasDeliverableContent: boolean;
  notifyUser: boolean;
  notificationReason: BackgroundCompletionNotificationReason;
  droppedContinuationIds: string[];
}

export type BackgroundContinuationEventName =
  | 'agent.background.continuation.completed'
  | 'agent.background.continuation.post_turn_delivery';

interface SessionContextControls {
  getActiveContextSession?: () => string | null;
  setActiveContextSession?: (sessionId: string | null) => void;
}

interface SessionChannelResolver {
  resolveSessionChannelId?: (sourceChannelId: string) => string;
}

interface QueueBackgroundContinuationCompletionParams {
  deferredContinuationId: string;
  message: SubstrateMessage;
  response: AgentResponse;
  taskKind: string | null;
  intent: string | null;
  resolveSessionChannelId: (channelId: string) => string;
  backgroundContinuationTasks: Map<string, BackgroundContinuationTaskRecord>;
  pendingBackgroundContinuationDeliveries:
  BackgroundCompletionDeliveryQueue<PendingBackgroundContinuationDelivery>;
  now?: () => number;
}

export function pinDeferredContinuationSessionContext(
  deferredContinuationId: string | null,
  channelId: string,
  sessionManager: SessionManager,
): () => void {
  if (!deferredContinuationId) {
    return () => {};
  }
  const manager = sessionManager as unknown as SessionContextControls;
  if (
    typeof manager.getActiveContextSession !== 'function'
    || typeof manager.setActiveContextSession !== 'function'
  ) {
    throw new Error(
      'Deferred continuation session isolation failed: active-context session controls are unavailable',
    );
  }
  const pinnedSessionId = channelId.trim();
  if (!pinnedSessionId) {
    throw new Error(
      `Deferred continuation session isolation failed: invalid channel/session id for "${deferredContinuationId}"`,
    );
  }
  const previousSessionId = manager.getActiveContextSession();
  const setActiveContextSession = manager.setActiveContextSession;
  setActiveContextSession(pinnedSessionId);
  return () => {
    setActiveContextSession(previousSessionId ?? null);
  };
}

export function resolveSessionChannelId(
  sessionManager: SessionManager,
  channelId: string,
): string {
  const manager = sessionManager as unknown as SessionChannelResolver;
  if (typeof manager.resolveSessionChannelId !== 'function') {
    return channelId;
  }
  const resolved = manager.resolveSessionChannelId(channelId);
  const trimmed = resolved.trim();
  return trimmed.length > 0 ? trimmed : channelId;
}

export function queueBackgroundContinuationCompletion(
  params: QueueBackgroundContinuationCompletionParams,
): BackgroundContinuationCompletionSignal {
  const completedAt = params.now ? params.now() : Date.now();
  const deliverySessionId = params.resolveSessionChannelId(params.message.channelId);
  const hasDeliverableContent = params.response.content.trim().length > 0;
  const runtimeClass = BACKGROUND_CONTINUATION_RUNTIME_CLASS;
  const sourceTimestampMs = Number.isFinite(params.message.timestamp.getTime())
    ? Math.trunc(params.message.timestamp.getTime())
    : null;
  const decision = decideBackgroundCompletionNotification({
    continuationId: params.deferredContinuationId,
    sourceMessageId: params.message.id,
    deliverySessionId,
    channelId: params.message.channelId,
    channelType: params.message.channelType,
    sourceTimestampMs,
    taskKind: params.taskKind,
    intent: params.intent,
    responseContent: params.response.content,
    completedAt,
  });

  params.backgroundContinuationTasks.set(params.deferredContinuationId, {
    runtimeClass,
    continuationId: params.deferredContinuationId,
    sourceMessageId: params.message.id,
    sourceTimestampMs,
    channelId: params.message.channelId,
    channelType: params.message.channelType,
    deliverySessionId,
    origin: decision.context.origin,
    urgency: decision.context.urgency,
    channelContext: decision.context.channelContext,
    completionAgeMs: decision.context.completionAgeMs,
    stale: decision.context.stale,
    taskKind: params.taskKind,
    intent: params.intent,
    completedAt,
    responseChars: params.response.content.length,
    hasDeliverableContent,
    notifyUser: decision.shouldNotify,
    notificationReason: decision.reason,
    droppedContinuationIds: [],
  });

  if (decision.shouldNotify) {
    const enqueueResult = params.pendingBackgroundContinuationDeliveries.enqueue({
      runtimeClass,
      continuationId: params.deferredContinuationId,
      sourceMessageId: params.message.id,
      deliverySessionId,
      content: params.response.content,
      completedAt,
      origin: decision.context.origin,
      urgency: decision.context.urgency,
      channelContext: decision.context.channelContext,
      completionAgeMs: decision.context.completionAgeMs,
      stale: decision.context.stale,
      taskKind: params.taskKind,
      intent: params.intent,
      notificationReason: decision.reason,
    } satisfies PendingBackgroundContinuationDelivery, {
      maxDepth: BACKGROUND_CONTINUATION_PROFILE.maxPendingSessionDeliveries,
    });
    if (enqueueResult.droppedContinuationIds.length > 0) {
      for (const droppedContinuationId of enqueueResult.droppedContinuationIds) {
        const droppedTask = params.backgroundContinuationTasks.get(droppedContinuationId);
        if (!droppedTask) {
          continue;
        }
        params.backgroundContinuationTasks.set(droppedContinuationId, {
          ...droppedTask,
          notifyUser: false,
          notificationReason: 'suppress_lane_budget',
          droppedContinuationIds: [],
        });
      }
      params.backgroundContinuationTasks.set(params.deferredContinuationId, {
        ...(params.backgroundContinuationTasks.get(params.deferredContinuationId) ?? {
          runtimeClass,
          continuationId: params.deferredContinuationId,
        }),
        continuationId: params.deferredContinuationId,
        sourceMessageId: params.message.id,
        sourceTimestampMs,
        channelId: params.message.channelId,
        channelType: params.message.channelType,
        deliverySessionId,
        origin: decision.context.origin,
        urgency: decision.context.urgency,
        channelContext: decision.context.channelContext,
        completionAgeMs: decision.context.completionAgeMs,
        stale: decision.context.stale,
        taskKind: params.taskKind,
        intent: params.intent,
        completedAt,
        responseChars: params.response.content.length,
        hasDeliverableContent,
        notifyUser: true,
        notificationReason: decision.reason,
        runtimeClass,
        droppedContinuationIds: [...enqueueResult.droppedContinuationIds],
      });
    }
    return {
      runtimeClass,
      continuationId: params.deferredContinuationId,
      sourceMessageId: params.message.id,
      deliverySessionId,
      queuedForPostTurnDelivery: true,
      hasDeliverableContent,
      notifyUser: true,
      notificationReason: decision.reason,
      origin: decision.context.origin,
      urgency: decision.context.urgency,
      channelContext: decision.context.channelContext,
      completionAgeMs: decision.context.completionAgeMs,
      stale: decision.context.stale,
      taskKind: params.taskKind,
      intent: params.intent,
      completedAt,
      queueDepth: enqueueResult.queueDepth,
      droppedContinuationIds: [...enqueueResult.droppedContinuationIds],
    };
  }

  const cancelled = params.pendingBackgroundContinuationDeliveries.cancel(
    params.deferredContinuationId,
    deliverySessionId,
  );

  return {
    runtimeClass,
    continuationId: params.deferredContinuationId,
    sourceMessageId: params.message.id,
    deliverySessionId,
    queuedForPostTurnDelivery: false,
    hasDeliverableContent,
    notifyUser: false,
    notificationReason: decision.reason,
    origin: decision.context.origin,
    urgency: decision.context.urgency,
    channelContext: decision.context.channelContext,
    completionAgeMs: decision.context.completionAgeMs,
    stale: decision.context.stale,
    taskKind: params.taskKind,
    intent: params.intent,
    completedAt,
    queueDepth: cancelled.queueDepth,
    droppedContinuationIds: [],
  };
}

export function dequeueBackgroundContinuationDeliveries(
  pendingBackgroundContinuationDeliveries:
  BackgroundCompletionDeliveryQueue<PendingBackgroundContinuationDelivery>,
  deliverySessionId: string,
  limit?: number,
): PendingBackgroundContinuationDelivery[] {
  return pendingBackgroundContinuationDeliveries.dequeue(deliverySessionId, limit);
}

export async function emitBackgroundContinuationEvent(
  eventBus: EventBus,
  eventName: BackgroundContinuationEventName,
  payload: Record<string, unknown>,
): Promise<void> {
  const telemetryBus = eventBus as unknown as {
    emit: (event: string, eventPayload: Record<string, unknown>) => Promise<void>;
  };
  await telemetryBus.emit(eventName, payload);
}
