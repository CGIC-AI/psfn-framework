export type BackgroundCompletionNotificationReason =
  | 'notify_deferred_user_task'
  | 'suppress_empty_response'
  | 'suppress_internal_session'
  | 'suppress_non_user_task'
  | 'suppress_stale_completion'
  | 'suppress_low_urgency_task';

export type BackgroundCompletionOrigin = 'user_delegated' | 'internal' | 'unknown';
export type BackgroundCompletionUrgency = 'high' | 'normal' | 'low';
export type BackgroundCompletionChannelContext = 'internal' | 'session';

export interface BackgroundCompletionPolicyInput {
  continuationId: string;
  sourceMessageId: string;
  deliverySessionId: string;
  channelId: string;
  channelType: string;
  sourceTimestampMs: number | null;
  taskKind: string | null;
  intent: string | null;
  responseContent: string;
  completedAt: number;
}

export interface BackgroundCompletionPolicyContext {
  origin: BackgroundCompletionOrigin;
  urgency: BackgroundCompletionUrgency;
  channelContext: BackgroundCompletionChannelContext;
  completionAgeMs: number | null;
  stale: boolean;
  taskKind: string | null;
  intent: string | null;
}

export interface BackgroundCompletionPolicyDecision {
  shouldNotify: boolean;
  reason: BackgroundCompletionNotificationReason;
  context: BackgroundCompletionPolicyContext;
}

const USER_FACING_TASK_KINDS = new Set<string>([
  'deferred_tool_handoff',
]);
const LOW_URGENCY_TASK_KINDS = new Set<string>([
  'heartbeat',
  'reflection',
  'planning',
  'maintenance',
]);
const HIGH_URGENCY_TOKENS = ['urgent', 'critical', 'failed', 'error'];
const USER_DELEGATED_SOURCE_PREFIX = 'deferred-tool-handoff:';
const STALE_COMPLETION_MAX_AGE_MS = 15 * 60 * 1000;

function normalizeToken(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  return normalized.length > 0 ? normalized : null;
}

function resolveCompletionAgeMs(
  sourceTimestampMs: number | null,
  completedAt: number,
): number | null {
  if (
    typeof sourceTimestampMs !== 'number'
    || !Number.isFinite(sourceTimestampMs)
    || !Number.isFinite(completedAt)
  ) {
    return null;
  }
  return Math.max(0, Math.trunc(completedAt - sourceTimestampMs));
}

function resolveChannelContext(input: BackgroundCompletionPolicyInput): BackgroundCompletionChannelContext {
  const deliverySessionId = normalizeToken(input.deliverySessionId);
  const channelId = normalizeToken(input.channelId);
  if (deliverySessionId?.startsWith('internal:') || channelId?.startsWith('internal:')) {
    return 'internal';
  }
  return 'session';
}

function resolveOrigin(
  input: BackgroundCompletionPolicyInput,
  channelContext: BackgroundCompletionChannelContext,
): BackgroundCompletionOrigin {
  if (channelContext === 'internal') {
    return 'internal';
  }
  const sourceMessageId = normalizeToken(input.sourceMessageId);
  if (sourceMessageId?.startsWith(USER_DELEGATED_SOURCE_PREFIX)) {
    return 'user_delegated';
  }
  return 'unknown';
}

function resolveUrgency(taskKind: string | null, intent: string | null): BackgroundCompletionUrgency {
  if ((taskKind && LOW_URGENCY_TASK_KINDS.has(taskKind)) || intent === 'maintenance') {
    return 'low';
  }
  const urgencyProbe = `${taskKind ?? ''} ${intent ?? ''}`;
  if (HIGH_URGENCY_TOKENS.some(token => urgencyProbe.includes(token))) {
    return 'high';
  }
  if (taskKind && USER_FACING_TASK_KINDS.has(taskKind)) {
    return 'normal';
  }
  return 'low';
}

export function decideBackgroundCompletionNotification(
  input: BackgroundCompletionPolicyInput,
): BackgroundCompletionPolicyDecision {
  const taskKind = normalizeToken(input.taskKind);
  const intent = normalizeToken(input.intent);
  const channelContext = resolveChannelContext(input);
  const completionAgeMs = resolveCompletionAgeMs(input.sourceTimestampMs, input.completedAt);
  const stale = completionAgeMs !== null && completionAgeMs > STALE_COMPLETION_MAX_AGE_MS;
  const origin = resolveOrigin(input, channelContext);
  const urgency = resolveUrgency(taskKind, intent);
  const context: BackgroundCompletionPolicyContext = {
    origin,
    urgency,
    channelContext,
    completionAgeMs,
    stale,
    taskKind,
    intent,
  };

  const content = input.responseContent.trim();
  if (content.length === 0) {
    return {
      shouldNotify: false,
      reason: 'suppress_empty_response',
      context,
    };
  }

  if (channelContext === 'internal') {
    return {
      shouldNotify: false,
      reason: 'suppress_internal_session',
      context,
    };
  }

  if (origin !== 'user_delegated') {
    return {
      shouldNotify: false,
      reason: 'suppress_non_user_task',
      context,
    };
  }

  if (stale) {
    return {
      shouldNotify: false,
      reason: 'suppress_stale_completion',
      context,
    };
  }

  if (urgency === 'low') {
    return {
      shouldNotify: false,
      reason: 'suppress_low_urgency_task',
      context,
    };
  }

  if (!taskKind || !USER_FACING_TASK_KINDS.has(taskKind)) {
    return {
      shouldNotify: false,
      reason: 'suppress_non_user_task',
      context,
    };
  }

  return {
    shouldNotify: true,
    reason: 'notify_deferred_user_task',
    context,
  };
}
