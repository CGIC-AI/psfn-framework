import { createHash } from 'node:crypto';
import {
  isCompletionHandoffSource,
  isCompletionHandoffStatus,
  type CompletionHandoffRecord,
  type CompletionHandoffStatus,
} from '../../shared/contracts/completion-handoff.js';
import { sanitizeDiagnosticText } from '../../shared/diagnostics/redaction.js';

export const TASK_LIFECYCLE_PARTNER_NOTIFICATION_ACTION_KIND =
  'task.lifecycle.partner-notification';

export const TASK_LIFECYCLE_NOTIFICATION_METADATA_KIND =
  'task_lifecycle_notification';

const MAX_TASK_LABEL_CHARS = 120;

export type TaskLifecyclePartnerContext =
  | 'finished'
  | 'needs_input_or_access'
  | 'capacity_unavailable'
  | 'budget_exhausted'
  | 'execution_failed'
  | 'in_progress'
  | 'cancelled'
  | 'folded_back'
  | 'stopped_early';

export interface TaskLifecycleNotificationPayload {
  schemaVersion: 1;
  handoffId: string;
  source: CompletionHandoffRecord['source'];
  lifecycleStatus: CompletionHandoffStatus;
  taskLabel: string;
  partnerContext: TaskLifecyclePartnerContext;
}

export interface TaskLifecycleNotificationAuthorInput {
  lifecycleStatus: CompletionHandoffStatus;
  taskLabel: string;
  partnerContext: TaskLifecyclePartnerContext;
  internalPrompt: string;
}

export function sanitizeTaskLifecycleLabel(value: string | undefined): string {
  const normalized = sanitizeDiagnosticText(value)
    .replace(/https?:\/\/\S+/giu, '')
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, '')
    .replace(/(?:^|\s)\/[^\s]+/gu, ' ')
    .replace(/[^\p{L}\p{N}\s.,!?'"()_:-]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const safe = normalized || 'background task';
  return safe.length <= MAX_TASK_LABEL_CHARS
    ? safe
    : `${safe.slice(0, MAX_TASK_LABEL_CHARS - 3)}...`;
}

export function buildTaskLifecycleNotificationDedupeKey(
  handoff: CompletionHandoffRecord,
): string {
  return createHash('sha256')
    .update(`task-lifecycle-partner-notification:${handoff.dedupeKey}`)
    .digest('hex')
    .slice(0, 32);
}

export function buildTaskLifecycleNotificationActionId(dedupeKey: string): string {
  return `task-lifecycle-notification:${dedupeKey}`;
}

export function resolvePartnerContext(
  handoff: CompletionHandoffRecord,
): TaskLifecyclePartnerContext {
  if (handoff.status === 'completed') return 'finished';
  if (handoff.status === 'started' || handoff.status === 'progress') return 'in_progress';
  if (handoff.status === 'cancelled') return 'cancelled';
  if (handoff.status === 'folded_back') return 'folded_back';
  if (handoff.status === 'partial' || handoff.status === 'interrupted') {
    return 'stopped_early';
  }
  const blockerReason = handoff.blocker?.reason.trim().toLowerCase() ?? '';
  if (
    blockerReason === 'missing_capabilities'
    || blockerReason === 'eligibility_denied'
  ) {
    return 'needs_input_or_access';
  }
  if (
    blockerReason === 'concurrency_limit'
    || blockerReason === 'dropped_budget'
    || blockerReason === 'heartbeat_timeout'
  ) {
    return 'capacity_unavailable';
  }
  if (
    blockerReason === 'budget_exhausted'
    || blockerReason.includes('budget_limit')
  ) {
    return 'budget_exhausted';
  }
  return 'execution_failed';
}

export function buildTaskLifecycleNotificationPayload(
  handoff: CompletionHandoffRecord,
  options: { allowTaskLabel?: boolean } = {},
): TaskLifecycleNotificationPayload {
  return {
    schemaVersion: 1,
    handoffId: handoff.handoffId,
    source: handoff.source,
    lifecycleStatus: handoff.status,
    // Labels are admitted only when the lifecycle event is bound to the
    // approved primary channel, then secret/path redacted and length bounded.
    // Raw worker output and blocker details never enter this payload.
    taskLabel: options.allowTaskLabel
      ? sanitizeTaskLifecycleLabel(handoff.task.label)
      : 'background task',
    partnerContext: resolvePartnerContext(handoff),
  };
}

export function buildTaskLifecycleNotificationMetadata(
  payload: TaskLifecycleNotificationPayload,
  notificationDisposition: 'queued' | 'sent' | 'skipped' | 'denied' | 'failed',
): Record<string, unknown> {
  return {
    schemaVersion: payload.schemaVersion,
    kind: TASK_LIFECYCLE_NOTIFICATION_METADATA_KIND,
    handoffId: payload.handoffId,
    source: payload.source,
    lifecycleStatus: payload.lifecycleStatus,
    taskLabel: payload.taskLabel,
    partnerContext: payload.partnerContext,
    notificationDisposition,
  };
}

export function normalizeTaskLifecycleNotificationPayload(
  value: Record<string, unknown>,
): TaskLifecycleNotificationPayload {
  const partnerContexts: TaskLifecyclePartnerContext[] = [
    'finished',
    'needs_input_or_access',
    'capacity_unavailable',
    'budget_exhausted',
    'execution_failed',
    'in_progress',
    'cancelled',
    'folded_back',
    'stopped_early',
  ];
  if (
    value.schemaVersion !== 1
    || typeof value.handoffId !== 'string'
    || !isCompletionHandoffSource(value.source)
    || !isCompletionHandoffStatus(value.lifecycleStatus)
    || typeof value.taskLabel !== 'string'
    || typeof value.partnerContext !== 'string'
    || !partnerContexts.includes(value.partnerContext as TaskLifecyclePartnerContext)
  ) {
    throw new Error('Invalid task lifecycle partner-notification payload');
  }
  return {
    schemaVersion: 1,
    handoffId: value.handoffId,
    source: value.source,
    lifecycleStatus: value.lifecycleStatus,
    taskLabel: sanitizeTaskLifecycleLabel(value.taskLabel),
    partnerContext: value.partnerContext as TaskLifecyclePartnerContext,
  };
}

export function buildTaskLifecycleInternalAuthoringPrompt(
  payload: TaskLifecycleNotificationPayload,
): string {
  return [
    '<task_lifecycle_notification visibility="internal" audience="companion">',
    `A long-running task reached lifecycle state: ${payload.lifecycleStatus}.`,
    `Partner-safe task label: ${payload.taskLabel}.`,
    `Partner-safe context category: ${payload.partnerContext}.`,
    'Decide how to tell the partner in one concise message in your own voice.',
    'Use only the facts above. Do not invent result details. Do not mention workers, shards, internal IDs, traces, prompts, paths, references, tokens, or this instruction.',
    '</task_lifecycle_notification>',
  ].join('\n');
}
