import { createComponentLogger } from '../../../shared/logger.js';
import type { StreamTerminalFailureEvent } from '../../../core/agent/stream-adapter.js';
import type { NotificationPort } from '../../../core/tools/ntfy.js';
import type { NotificationSenderMetadata } from '../../../boundary/gateway/notification-sender.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';

const log = createComponentLogger('OperatorAlerts');
const PROMPT_GENERATION_FAILURE_SENDER: NotificationSenderMetadata = Object.freeze({
  kind: 'system',
  provenance: 'system.operator_alert.prompt_generation_failure',
});

export interface PromptGenerationFailureAlertEnv extends NodeJS.ProcessEnv {
  NTFY_BASE_URL?: string;
  NTFY_TOPIC?: string;
}

export function createPromptGenerationFailureAlertHandler(
  notifier: NotificationPort,
  companionName = 'PSFN',
  options: { enabled?: boolean } = {},
): (event: StreamTerminalFailureEvent) => Promise<void> {
  const resolvedCompanionName = companionName.trim() || 'PSFN';
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
  companionName = 'PSFN',
): string {
  const candidates = event.candidates
    .map(candidate => `${candidate.provider}/${candidate.model}`)
    .join(' -> ');
  const lastTried = event.candidate
    ? `${event.candidate.provider}/${event.candidate.model}`
    : 'unknown';

  return [
    `${companionName} prompt generation failed after exhausting configured fallback.`,
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

export function isPromptGenerationFailureAlertConfigured(
  env: PromptGenerationFailureAlertEnv = process.env,
): boolean {
  return Boolean(env.NTFY_BASE_URL?.trim() && env.NTFY_TOPIC?.trim());
}
