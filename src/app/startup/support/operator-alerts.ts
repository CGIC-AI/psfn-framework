import { createComponentLogger } from '../../../shared/logger.js';
import type { StreamTerminalFailureEvent } from '../../../core/agent/stream-adapter.js';
import type { NotificationPort } from '../../../core/tools/ntfy.js';
import type { NotificationSenderMetadata } from '../../../boundary/gateway/notification-sender.js';
import type { EventMap } from '../../../shared/event-bus.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('OperatorAlerts');
const PROMPT_GENERATION_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.prompt_generation_failure',
});
const ACTIVE_MEMORY_REFRESH_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.active_memory_refresh_failure',
});
const BACKUP_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.backup_failure',
});
const SCHEDULED_TASK_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.scheduled_task_failure',
});
const SLEEP_CONSOLIDATION_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.sleep_consolidation_failure',
});
const QUARANTINE_EXPIRY_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.quarantine_expiry',
});
const REPEATED_SCREENING_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.repeated_screening_failure',
});
const MODEL_BUDGET_THRESHOLD_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.model_budget_threshold',
});

export function createPromptGenerationFailureAlertHandler(
  notifier: NotificationPort,
  companionName: string,
): (event: StreamTerminalFailureEvent) => Promise<void> {
  const resolvedCompanionName = requireOperatorAlertCompanionName(companionName);

  return async (event: StreamTerminalFailureEvent): Promise<void> => {
    try {
      await notifier.notify({
        sender: PROMPT_GENERATION_FAILURE_SENDER,
        title: `${resolvedCompanionName} prompt generation failure`,
        priority: 5,
        message: formatPromptGenerationFailureAlert(event, resolvedCompanionName),
      });
    } catch (error) {
      log.error('Failed to deliver operator alert for prompt generation failure', {
        companionName: resolvedCompanionName,
        purpose: event.purpose,
        attempts: event.attempts,
        process: event.process,
        service: event.service,
        channelId: event.correlation?.channelId,
        error: toErrorMessage(error),
      });
    }
  };
}

export function formatPromptGenerationFailureAlert(
  event: StreamTerminalFailureEvent,
  companionName: string,
): string {
  const resolvedCompanionName = requireOperatorAlertCompanionName(companionName);
  const candidates = event.candidates
    .map(candidate => `${candidate.provider}/${candidate.model}`)
    .join(' -> ');
  const lastTried = event.candidate
    ? `${event.candidate.provider}/${event.candidate.model}`
    : 'unknown';

  return [
    `${resolvedCompanionName} prompt generation failed after exhausting configured fallback.`,
    `Service: ${event.service}`,
    `Process: ${event.process}`,
    `Purpose: ${event.purpose}`,
    `Channel: ${event.correlation?.channelId ?? 'unknown'}`,
    `Attempts: ${event.attempts}`,
    `Candidates: ${candidates || 'unknown'}`,
    `Last tried: ${lastTried}`,
    `Error: ${event.error.message}`,
  ].join('\n');
}

export type ActiveMemoryRefreshEvent = EventMap['memory.active_context.refresh'];

export interface ActiveMemoryRefreshFailureAlertOptions {
  notifier: NotificationPort;
  companionName: string;
  /**
   * Consecutive degraded refreshes per active-context key before the operator
   * alert fires. Config-owned (settings.json `memoryRefreshFailureAlertThreshold`);
   * a missing or invalid value fails closed at composition.
   */
  failureThreshold: number | undefined;
}

/**
 * E5.5: persistent active-memory refresh failure is an operator alert, never
 * silent degradation. Subscribed to `memory.active_context.refresh` on the
 * event bus: `degraded` phases increment a per-key consecutive-failure count,
 * `ready` phases reset it. Crossing the config-owned threshold raises one
 * alert through the system-derived multi-sink gateway notification path; the
 * alert re-arms only after a successful refresh for that key.
 */
export function createActiveMemoryRefreshFailureAlertHandler(
  options: ActiveMemoryRefreshFailureAlertOptions,
): (event: ActiveMemoryRefreshEvent) => Promise<void> {
  const { notifier } = options;
  const companionName = requireOperatorAlertCompanionName(options.companionName);
  const failureThreshold = options.failureThreshold;
  if (typeof failureThreshold !== 'number' || !Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error(
      `Invalid memoryRefreshFailureAlertThreshold: expected a positive integer, got ${String(failureThreshold)}`,
    );
  }
  const consecutiveFailuresByKey = new Map<string, number>();
  const alertedKeys = new Set<string>();

  return async (event: ActiveMemoryRefreshEvent): Promise<void> => {
    if (event.phase === 'ready') {
      consecutiveFailuresByKey.delete(event.key);
      alertedKeys.delete(event.key);
      return;
    }

    const failureCount = (consecutiveFailuresByKey.get(event.key) ?? 0) + 1;
    consecutiveFailuresByKey.set(event.key, failureCount);
    if (failureCount < failureThreshold || alertedKeys.has(event.key)) {
      return;
    }

    try {
      await notifier.notify({
        sender: ACTIVE_MEMORY_REFRESH_FAILURE_SENDER,
        title: `${companionName} active-memory refresh failing`,
        priority: 5,
        message: formatActiveMemoryRefreshFailureAlert(event, companionName, failureCount),
      });
      alertedKeys.add(event.key);
    } catch (error) {
      // Delivery failure must not fake an alerted state: the next degraded
      // refresh for this key retries the notification.
      log.error('Failed to deliver operator alert for persistent active memory refresh failure', {
        companionName,
        key: event.key,
        channelId: event.channelId,
        consecutiveFailures: failureCount,
        failureThreshold,
        error: toErrorMessage(error),
      });
    }
  };
}

type BackupFailureEvent = EventMap['backup.failed'];
type ScheduledTaskFailureEvent = EventMap['schedule.task.failed'];
type SleepConsolidationFailureEvent = EventMap['memory.sleep_consolidation.failure'];
type QuarantineExpiryEvent = EventMap['intake.quarantine.expired'];
type FailClosedScreeningEvent = EventMap['intake.screening.fail_closed'];
type ModelBudgetThresholdEvent = EventMap['model.budget.threshold_exceeded'];
type ModelBudgetAlertDeliveryEvent = EventMap['model.budget.alert_delivery'];

export function createBackupFailureAlertHandler(
  notifier: NotificationPort,
  companionName: string,
): (event: BackupFailureEvent) => Promise<void> {
  const name = requireOperatorAlertCompanionName(companionName);
  return async (event) => {
    await deliverOperatorAlert(notifier, {
      sender: BACKUP_FAILURE_SENDER,
      title: `${name} backup failure`,
      priority: 5,
      message: [
        `${name} scheduled backup failed.`,
        `Task: ${event.taskName} (${event.taskId})`,
        `Error: ${event.error}`,
      ].join('\n'),
    }, { alertKind: 'backup_failure', taskId: event.taskId });
  };
}

export function createScheduledTaskFailureAlertHandler(
  notifier: NotificationPort,
  companionName: string,
): (event: ScheduledTaskFailureEvent) => Promise<void> {
  const name = requireOperatorAlertCompanionName(companionName);
  return async (event) => {
    if (event.taskId === 'scheduled-backup') return;
    await deliverOperatorAlert(notifier, {
      sender: SCHEDULED_TASK_FAILURE_SENDER,
      title: `${name} scheduled job failure`,
      priority: 5,
      message: [
        `${name} scheduled job failed.`,
        `Task: ${event.taskName} (${event.taskId})`,
        `Type: ${event.type}`,
        `Error: ${event.error}`,
      ].join('\n'),
    }, { alertKind: 'scheduled_task_failure', taskId: event.taskId });
  };
}

export function createSleepConsolidationFailureAlertHandler(
  notifier: NotificationPort,
  companionName: string,
): (event: SleepConsolidationFailureEvent) => Promise<void> {
  const name = requireOperatorAlertCompanionName(companionName);
  return async (event) => {
    await deliverOperatorAlert(notifier, {
      sender: SLEEP_CONSOLIDATION_FAILURE_SENDER,
      title: `${name} sleeptime failure`,
      priority: 5,
      message: [
        `${name} sleeptime consolidation failed closed.`,
        `Session: ${event.sessionId}`,
        `Scope: ${event.scopeKey}`,
        `Stage: ${event.stage}`,
        `Candidate episodes: ${event.candidateEpisodeIds.length}`,
        `Error: ${event.error}`,
      ].join('\n'),
    }, { alertKind: 'sleep_consolidation_failure', sessionId: event.sessionId });
  };
}

export function createQuarantineExpiryAlertHandler(
  notifier: NotificationPort,
  companionName: string,
): (event: QuarantineExpiryEvent) => Promise<void> {
  const name = requireOperatorAlertCompanionName(companionName);
  return async (event) => {
    await deliverOperatorAlert(notifier, {
      sender: QUARANTINE_EXPIRY_SENDER,
      title: `${name} quarantine item expired`,
      priority: 5,
      message: [
        `${name} held CogSec intake expired before operator review.`,
        `Envelope: ${event.envelopeId}`,
        `Source channel: ${event.sourceChannelId ?? 'unknown'}`,
        `Held at: ${new Date(event.heldAtMs).toISOString()}`,
        `Expired at: ${new Date(event.expiredAtMs).toISOString()}`,
        `Reason: ${event.reason}`,
      ].join('\n'),
    }, { alertKind: 'quarantine_expiry', envelopeId: event.envelopeId });
  };
}

export function createRepeatedScreeningFailureAlertHandler(options: {
  notifier: NotificationPort;
  companionName: string;
  /** settings.json-owned threshold, counted independently per stage/source class. */
  failureThreshold: number | undefined;
}): (event: FailClosedScreeningEvent) => Promise<void> {
  const name = requireOperatorAlertCompanionName(options.companionName);
  const failureThreshold = options.failureThreshold;
  if (
    typeof failureThreshold !== 'number'
    || !Number.isInteger(failureThreshold)
    || failureThreshold < 1
  ) {
    throw new Error(
      'Invalid intakeScreeningFailureAlertThreshold: expected a positive integer, '
      + `got ${String(failureThreshold)}`,
    );
  }
  const counts = new Map<string, number>();
  const alerted = new Set<string>();
  return async (event) => {
    const key = `${event.stage}:${event.sourceClass}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count < failureThreshold || alerted.has(key)) return;

    const delivered = await deliverOperatorAlert(options.notifier, {
      sender: REPEATED_SCREENING_FAILURE_SENDER,
      title: `${name} repeated intake screening failures`,
      priority: 5,
      message: [
        `${name} intake screening has failed closed repeatedly.`,
        `Stage: ${event.stage}`,
        `Source class: ${event.sourceClass}`,
        `Observed runtime failures: ${count}`,
        `Configured alert threshold: ${failureThreshold}`,
        `Last error: ${event.error}`,
      ].join('\n'),
    }, { alertKind: 'repeated_screening_failure', stage: event.stage });
    if (delivered) alerted.add(key);
  };
}

export function createModelBudgetThresholdAlertHandler(options: {
  notifier: NotificationPort;
  companionName: string;
  recordDelivery: (event: ModelBudgetAlertDeliveryEvent) => void | Promise<void>;
}): (event: ModelBudgetThresholdEvent) => Promise<void> {
  const companionName = requireOperatorAlertCompanionName(options.companionName);
  const deliveredKeys = new Set<string>();

  return async (event) => {
    const alertSubject = event.companionId?.trim() || companionName;
    const windowKey = event.reason === 'daily_budget_exceeded'
      ? event.budget.dayKey
      : event.budget.monthKey;
    const dedupeKey = `${alertSubject}:${event.reason}:${windowKey}`;
    if (deliveredKeys.has(dedupeKey)) return;

    const periodLabel = event.reason === 'daily_budget_exceeded' ? 'daily' : 'monthly';
    const spent = event.reason === 'daily_budget_exceeded'
      ? event.budget.dailySpentUsd
      : event.budget.monthlySpentUsd;
    const limit = event.reason === 'daily_budget_exceeded'
      ? event.budget.dailyLimitUsd
      : event.budget.monthlyLimitUsd;
    const mode = event.enforcementEnabled
      ? 'Blocking mode: this request was denied at the configured limit.'
      : 'Tracking mode: requests continue after this alert.';

    try {
      const result = await options.notifier.notify({
        sender: MODEL_BUDGET_THRESHOLD_SENDER,
        title: `${alertSubject} ${periodLabel} model budget threshold`,
        message: [
          `${alertSubject} crossed the configured ${periodLabel} model budget threshold.`,
          `Window: ${windowKey}`,
          `Recorded spend: $${spent.toFixed(4)} / $${limit.toFixed(4)}`,
          `Projected request: $${event.estimatedRequestCostUsd.toFixed(4)}`,
          `Route: ${event.provider}/${event.model} (${event.purpose})`,
          mode,
        ].join('\n'),
      });
      deliveredKeys.add(dedupeKey);
      await recordModelBudgetAlertDelivery(options.recordDelivery, {
        timestampMs: Date.now(),
        dedupeKey,
        thresholdReason: event.reason,
        windowKey,
        status: result.status,
        topic: result.topic,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      });
    } catch (error) {
      await recordModelBudgetAlertDelivery(options.recordDelivery, {
        timestampMs: Date.now(),
        dedupeKey,
        thresholdReason: event.reason,
        windowKey,
        status: 'failed',
        error: toErrorMessage(error),
      });
      log.error('Failed to deliver model budget threshold operator alert', {
        companionName: alertSubject,
        dedupeKey,
        error: toErrorMessage(error),
      });
    }
  };
}

async function recordModelBudgetAlertDelivery(
  recordDelivery: (event: ModelBudgetAlertDeliveryEvent) => void | Promise<void>,
  event: ModelBudgetAlertDeliveryEvent,
): Promise<void> {
  try {
    await recordDelivery(event);
  } catch (error) {
    log.error('Failed to record model budget alert delivery evidence', {
      dedupeKey: event.dedupeKey,
      status: event.status,
      error: toErrorMessage(error),
    });
  }
}

async function deliverOperatorAlert(
  notifier: NotificationPort,
  params: Parameters<NotificationPort['notify']>[0],
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    await notifier.notify(params);
    return true;
  } catch (error) {
    log.error('Failed to deliver operator alert', {
      ...context,
      error: toErrorMessage(error),
    });
    return false;
  }
}

export function formatActiveMemoryRefreshFailureAlert(
  event: ActiveMemoryRefreshEvent,
  companionName: string,
  consecutiveFailures: number,
): string {
  return [
    `${companionName} active-memory context refresh is failing persistently.`,
    `Context key: ${event.key}`,
    `Channel: ${event.channelId}`,
    `Consecutive failures: ${consecutiveFailures}`,
    `Last error: ${event.error ?? 'unknown'}`,
    'Turns continue on the last-good memory context until refresh recovers.',
  ].join('\n');
}

function requireOperatorAlertCompanionName(companionName: string): string {
  const resolved = companionName.trim();
  if (resolved) return resolved;
  throw new Error('Missing companion name for operator alert: explicit identity is required');
}
