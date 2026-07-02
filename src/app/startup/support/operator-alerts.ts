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

export interface PromptGenerationFailureAlertEnv extends NodeJS.ProcessEnv {
  NTFY_BASE_URL?: string;
  NTFY_TOPIC?: string;
}

export function createPromptGenerationFailureAlertHandler(
  notifier: NotificationPort,
  companionName: string,
  options: { enabled?: boolean } = {},
): (event: StreamTerminalFailureEvent) => Promise<void> {
  const resolvedCompanionName = requireOperatorAlertCompanionName(companionName);
  const enabled = options.enabled !== false;

  return async (event: StreamTerminalFailureEvent): Promise<void> => {
    if (!enabled) {
      log.warn('Prompt generation failure alert skipped: ntfy is not configured', {
        companionName: resolvedCompanionName,
        purpose: event.purpose,
        attempts: event.attempts,
        process: event.process,
        service: event.service,
        channelId: event.correlation?.channelId,
      });
      return;
    }
    try {
      await notifier.notify({
        sender: PROMPT_GENERATION_FAILURE_SENDER,
        title: `${resolvedCompanionName} prompt generation failure`,
        priority: 5,
        message: formatPromptGenerationFailureAlert(event, resolvedCompanionName),
      });
    } catch (error) {
      log.warn('Failed to send ntfy alert for prompt generation failure', {
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
  enabled?: boolean;
}

/**
 * E5.5: persistent active-memory refresh failure is an operator alert, never
 * silent degradation. Subscribed to `memory.active_context.refresh` on the
 * event bus: `degraded` phases increment a per-key consecutive-failure count,
 * `ready` phases reset it. Crossing the config-owned threshold raises one
 * alert through the system-derived gateway notification path (ntfy); the
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
  const enabled = options.enabled !== false;
  const consecutiveFailuresByKey = new Map<string, number>();
  const alertedKeys = new Set<string>();

  return async (event: ActiveMemoryRefreshEvent): Promise<void> => {
    if (event.phase === 'ready') {
      consecutiveFailuresByKey.delete(event.key);
      alertedKeys.delete(event.key);
      return;
    }
    if (event.phase !== 'degraded') {
      return;
    }

    const failureCount = (consecutiveFailuresByKey.get(event.key) ?? 0) + 1;
    consecutiveFailuresByKey.set(event.key, failureCount);
    if (failureCount < failureThreshold || alertedKeys.has(event.key)) {
      return;
    }

    if (!enabled) {
      log.warn('Active memory refresh failure alert skipped: ntfy is not configured', {
        companionName,
        key: event.key,
        channelId: event.channelId,
        consecutiveFailures: failureCount,
        failureThreshold,
      });
      alertedKeys.add(event.key);
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
      log.warn('Failed to send ntfy alert for persistent active memory refresh failure', {
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

export function isPromptGenerationFailureAlertConfigured(
  env: PromptGenerationFailureAlertEnv = process.env,
): boolean {
  return Boolean(env.NTFY_BASE_URL?.trim() && env.NTFY_TOPIC?.trim());
}
