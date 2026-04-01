import { createComponentLogger } from '../logger.js';
import type { StreamTerminalFailureEvent } from '../agent/stream-adapter.js';
import type { NotifyDispatcher } from '../tools/ntfy.js';
import { toErrorMessage } from '../utils/errors.js';

const log = createComponentLogger('OperatorAlerts');

export function createPromptGenerationFailureAlertHandler(
  dispatcher: NotifyDispatcher,
  companionName = 'PSFN',
): (event: StreamTerminalFailureEvent) => Promise<void> {
  const resolvedCompanionName = companionName.trim() || 'PSFN';

  return async (event: StreamTerminalFailureEvent): Promise<void> => {
    try {
      await dispatcher.dispatch({
        action: 'brief',
        title: `${resolvedCompanionName} prompt generation failure`,
        priority: 5,
        message: formatPromptGenerationFailureAlert(event, resolvedCompanionName),
      });
    } catch (error) {
      log.warn('Failed to send notify brief for prompt generation failure', {
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
