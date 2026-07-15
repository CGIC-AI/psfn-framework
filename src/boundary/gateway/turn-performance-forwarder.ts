import type { GatewayServer } from './server.js';
import type { EventBus } from '../../shared/event-bus.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export interface TurnPerformanceForwarderLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Bridge gateway-owned timing stages onto the agent EventBus that backs
 * Garden. The RPC boundary validates a closed, content-free envelope before
 * accepting the event; forwarding failures remain telemetry-only and never
 * change turn behavior.
 */
export function attachGatewayTurnPerformanceForwarder(input: {
  eventBus: EventBus;
  gateway: Pick<GatewayServer, 'requestAgentTurnPerformance'>;
  log: TurnPerformanceForwarderLogger;
}): () => void {
  return input.eventBus.on('agent.turn.performance', (event) => {
    void input.gateway.requestAgentTurnPerformance(event).catch(error => {
      input.log.warn('Failed to forward gateway turn performance telemetry', {
        traceId: event.traceId,
        stage: event.stage,
        error: toErrorMessage(error),
      });
    });
  });
}
