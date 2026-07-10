import type { EventBus } from '../../../shared/event-bus.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { redactToolActivity } from './redaction.js';
import type { CompanionRelayPublishParams } from './relay.js';

const log = createComponentLogger('CompanionEventForwarder');

export interface CompanionEventPublishPort {
  publishCompanionEvent(params: CompanionRelayPublishParams): void;
}

/**
 * Agent-process side of the companion relay (w9hj.1).
 *
 * Sources tool lifecycle and artifact events from the typed agent event bus,
 * applies redaction AT EMISSION (before anything crosses the process
 * boundary), and forwards the redacted payloads to the gateway relay over
 * the existing gateway RPC connection. Publish failures are logged loudly —
 * the turn itself is never blocked on relay delivery.
 */
export function attachCompanionEventForwarder(options: {
  eventBus: EventBus;
  publisher: CompanionEventPublishPort;
}): () => void {
  const publish = (params: CompanionRelayPublishParams): void => {
    try {
      options.publisher.publishCompanionEvent(params);
    } catch (error) {
      log.error('Failed to forward companion event to gateway relay', {
        kind: params.kind,
        error: toErrorMessage(error),
      });
    }
  };

  const unsubscribes = [
    options.eventBus.on('agent.tool.start', ({ channelId, toolCallId, toolName }) => {
      publish({
        kind: 'tool.activity',
        payload: redactToolActivity({
          toolCallId,
          toolName,
          phase: 'started',
          timestampMs: Date.now(),
        }),
        ...(channelId ? { channelId } : {}),
      });
    }),
    options.eventBus.on('agent.tool.end', ({ channelId, toolCallId, toolName, isError }) => {
      publish({
        kind: 'tool.activity',
        payload: redactToolActivity({
          toolCallId,
          toolName,
          phase: isError ? 'failed' : 'completed',
          timestampMs: Date.now(),
        }),
        ...(channelId ? { channelId } : {}),
      });
    }),
    options.eventBus.on('companion.artifact.created', ({ payload, preview, channelId }) => {
      publish({
        kind: 'artifact.created',
        payload,
        ...(preview ? { preview } : {}),
        ...(channelId ? { channelId } : {}),
      });
    }),
  ];

  return () => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      unsubscribe();
    }
  };
}
