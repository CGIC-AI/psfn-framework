// Gateway connection lifecycle and health: the per-connection state machine
// (registering -> ready/degraded -> offline), healthcheck staleness, in-flight
// health keepalive, and the agent connection summary used by runtime health.
import type { GatewayRpcConnection } from '../transport.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  GATEWAY_CONNECTION_STATE_TRANSITIONS,
  type GatewayConnectionState,
} from './connection-status.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');
export const DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS = 90_000;
const CONNECTION_IN_FLIGHT_HEALTH_TOUCH_INTERVAL_MS = Math.min(
  30_000,
  Math.max(1_000, Math.floor(DEFAULT_CONNECTION_HEALTHCHECK_STALE_AFTER_MS / 3)),
);

type GatewayConnectionLifecyclePorts = Pick<
  GatewayServerPorts,
  'connectionStatuses' | 'companionLastSeen' | 'multiCompanion' | 'flushInboundChannelReplay'
>;

export class GatewayConnectionLifecycle {
  private readonly connectionStatuses: GatewayConnectionLifecyclePorts['connectionStatuses'];
  private readonly companionLastSeen: GatewayConnectionLifecyclePorts['companionLastSeen'];
  private readonly multiCompanion: GatewayConnectionLifecyclePorts['multiCompanion'];
  private readonly flushInboundChannelReplay: GatewayConnectionLifecyclePorts['flushInboundChannelReplay'];

  constructor(ports: GatewayConnectionLifecyclePorts) {
    this.connectionStatuses = ports.connectionStatuses;
    this.companionLastSeen = ports.companionLastSeen;
    this.multiCompanion = ports.multiCompanion;
    this.flushInboundChannelReplay = ports.flushInboundChannelReplay;
  }

  refreshConnectionHealth(now = Date.now()): void {
    for (const [conn, status] of this.connectionStatuses.entries()) {
      if (status.role !== 'agent') {
        continue;
      }
      if (status.state !== 'ready' && status.state !== 'registering') {
        continue;
      }

      const staleForMs = now - status.lastHealthcheckAt;
      if (staleForMs <= status.healthcheckStaleAfterMs) {
        continue;
      }

      const reason = `No healthcheck observed for ${staleForMs}ms (limit ${status.healthcheckStaleAfterMs}ms).`;
      this.transitionConnectionState(conn, 'degraded', 'healthcheck_stale', reason);
    }
  }

  touchConnectionHealthcheck(conn: GatewayRpcConnection): void {
    const status = this.connectionStatuses.get(conn);
    if (!status || status.state === 'offline') {
      return;
    }
    status.lastHealthcheckAt = Date.now();
    if (status.companionId) {
      this.companionLastSeen.set(status.companionId, status.lastHealthcheckAt);
    }
    if (status.state === 'degraded' && status.stateReason === 'healthcheck_stale') {
      if (
        this.multiCompanion.enabled
        && status.role === 'agent'
        && !status.runtimeReadyDeclared
      ) {
        this.transitionConnectionState(
          conn,
          'registering',
          'healthcheck_recovered_pending_runtime_ready',
        );
      } else {
        this.transitionConnectionState(conn, 'ready', 'healthcheck_recovered');
      }
    }
  }

  beginInFlightHealthcheck(conn: GatewayRpcConnection): () => void {
    const timer = setInterval(() => {
      this.touchConnectionHealthcheck(conn);
    }, CONNECTION_IN_FLIGHT_HEALTH_TOUCH_INTERVAL_MS);
    timer.unref();

    return () => {
      clearInterval(timer);
      this.touchConnectionHealthcheck(conn);
    };
  }

  transitionConnectionState(
    conn: GatewayRpcConnection,
    nextState: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    if (!status) {
      return;
    }

    const currentState = status.state;
    if (currentState === nextState && status.stateReason === reason && !failureReason) {
      return;
    }
    if (currentState !== nextState) {
      const allowedTransitions = GATEWAY_CONNECTION_STATE_TRANSITIONS[currentState];
      if (!allowedTransitions.includes(nextState)) {
        throw new Error(
          `Invalid gateway connection transition: ${currentState} -> ${nextState}.`,
        );
      }
      status.state = nextState;
      status.lastTransitionAt = Date.now();
    }
    status.stateReason = reason;

    if (nextState === 'ready' || nextState === 'registering') {
      status.health = 'healthy';
      delete status.failureReason;
    } else if (nextState === 'degraded') {
      status.health = reason === 'healthcheck_stale' ? 'stale' : 'failed';
      if (failureReason) {
        status.failureReason = failureReason;
      }
    } else if (failureReason) {
      status.failureReason = failureReason;
    }

    this.appendConnectionTransition(conn, currentState, nextState, reason, failureReason);
    if (nextState === 'ready' && status.role === 'agent' && status.companionId) {
      this.flushInboundChannelReplay(status.companionId);
    }
  }

  appendConnectionTransition(
    conn: GatewayRpcConnection,
    from: GatewayConnectionState | 'none',
    to: GatewayConnectionState,
    reason: string,
    failureReason?: string,
  ): void {
    const status = this.connectionStatuses.get(conn);
    log.info('Gateway connection lifecycle transition', {
      from,
      to,
      reason,
      health: status?.health,
      ...(failureReason ? { failureReason } : {}),
    });
  }

  getConnectionSummary(): {
    total: number;
    registering: number;
    ready: number;
    degraded: number;
    offline: number;
  } {
    const summary = {
      total: 0,
      registering: 0,
      ready: 0,
      degraded: 0,
      offline: 0,
    };

    for (const status of this.connectionStatuses.values()) {
      if (status.role !== 'agent') {
        continue;
      }
      summary.total += 1;
      if (status.state === 'registering') summary.registering += 1;
      else if (status.state === 'ready') summary.ready += 1;
      else if (status.state === 'degraded') summary.degraded += 1;
      else summary.offline += 1;
    }

    return summary;
  }
}
