// Gateway agent-connection routing: resolves the ready, healthy agent
// connection (and its RPC client) that owns a companion, channel surface, or
// satellite, plus the authenticated companion identity bound to a connection.
// Every ambiguity fails closed with a companion violation alarm.
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import { DEFAULT_COMPANION_ID } from '../../../core/identity/companion-naming.js';
import type { SatelliteRoutingMetadata } from '../../../shared/contracts/satellite-registry.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import {
  resolveConfiguredGatewayCompanion,
  type AuthenticatedGatewayAccountRoute,
  type GatewayChannelSurface,
} from '../multi-companion.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayServerPorts } from './ports.js';

export class GatewayConnectionRouter {
  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'companionConnections'
      | 'connectionStatuses'
      | 'fleetCompanionIds'
      | 'multiCompanion'
      | 'notifyAll'
      | 'notifyOne'
      | 'options'
      | 'rpcClients'
      | 'alarmCompanionViolation'
      | 'refreshConnectionHealth'
    >,
  ) {}

  /** Ready+healthy agent connection for a companion, or null. Never throws. */
  resolveReadyCompanionConnection(companionId: CompanionId): GatewayRpcConnection | null {
    const conn = this.ports.companionConnections.get(companionId);
    if (!conn) {
      return null;
    }
    const status = this.ports.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
      return null;
    }
    return conn;
  }

  requireAuthenticatedAgentCompanionId(conn: GatewayRpcConnection): string {
    const status = this.ports.connectionStatuses.get(conn);
    if (status?.role !== 'agent' || !status.companionId) {
      throw new Error('ICP autonomy RPC requires an authenticated agent companion connection');
    }
    return status.companionId;
  }

  authenticatedCompanionId(conn: GatewayRpcConnection): string | undefined {
    const status = this.ports.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state === 'offline') {
      return undefined;
    }
    if (this.ports.multiCompanion.enabled) {
      return status.companionId;
    }
    return status.companionId ?? this.ports.options.companionId ?? DEFAULT_COMPANION_ID;
  }

  /**
   * Notify the connection that originated the in-flight request (e.g.
   * llm.chunk streaming deltas). Single-companion mode preserves the existing
   * broadcast path byte-identically; multi-companion mode pins delivery to the
   * requesting connection so one companion's stream can never reach another.
   */
  notifyRequestingConnection(
    conn: GatewayRpcConnection,
    method: string,
    params: unknown,
  ): void {
    if (this.ports.multiCompanion.enabled) {
      this.ports.notifyOne(conn, method, params);
      return;
    }
    this.ports.notifyAll(method, params);
  }

  /**
   * Resolve the ready agent connection owning a channel surface. Fail-closed:
   * unrouted surface, unknown/disconnected companion, or unhealthy connection
   * all alarm loudly and throw — traffic is never rerouted to another agent.
   *
   * When multi-account discord routing is active (W1-P2), the discord surface
   * routes per bot account: the adapter that received the message names its
   * accountId, and only that account's companion receives it. A missing or
   * unknown accountId fails closed — never a broadcast, never another account.
   */
  resolveCompanionAgent(
    surface: GatewayChannelSurface,
    route?: AuthenticatedGatewayAccountRoute,
  ): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const companionId = this.resolveRoutedCompanionId(surface, route);
    this.ports.refreshConnectionHealth();
    return this.requireReadyCompanionRoute(surface, companionId);
  }

  resolveSatelliteCompanionAgent(satellite: SatelliteRoutingMetadata): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const routeLabel = `satellite:${satellite.satelliteId}`;
    if (!satellite.sharedDevice && this.ports.fleetCompanionIds.size === 1) {
      // One-companion fleet: there is nobody to arbitrate between, so an
      // ungoverned satellite routes to the sole companion (psfn-framework-bbprt).
      const [soleCompanionId] = this.ports.fleetCompanionIds;
      this.ports.refreshConnectionHealth();
      return this.requireReadyCompanionRoute(routeLabel, soleCompanionId!);
    }
    if (!satellite.sharedDevice) {
      this.ports.alarmCompanionViolation(
        'unbound_satellite',
        `Satellite "${satellite.satelliteId}" has no shared-device policy in satellites.json`,
        { satelliteId: satellite.satelliteId, endpointId: satellite.endpointId },
      );
      throw new Error(
        `Multi-companion satellite "${satellite.satelliteId}" has no shared-device policy in satellites.json`,
      );
    }
    const companionId = satellite.sharedDevice.primaryCompanionId;
    if (!this.ports.fleetCompanionIds.has(companionId)) {
      this.ports.alarmCompanionViolation(
        'satellite_unknown_companion',
        `Satellite "${satellite.satelliteId}" names a companion absent from companions.json`,
        {
          satelliteId: satellite.satelliteId,
          endpointId: satellite.endpointId,
          companionId,
        },
      );
      throw new Error(
        `Satellite "${satellite.satelliteId}" routes to companion "${companionId}" `
        + 'which is absent from companions.json',
      );
    }
    this.ports.refreshConnectionHealth();
    return this.requireReadyCompanionRoute(routeLabel, companionId);
  }

  resolveRoutedCompanionId(
    surface: GatewayChannelSurface,
    route?: AuthenticatedGatewayAccountRoute,
  ): CompanionId {
    return resolveConfiguredGatewayCompanion(this.ports.multiCompanion, surface, route, violation => {
      this.ports.alarmCompanionViolation(
        violation.code,
        violation.message,
        violation.details,
      );
      throw new Error(violation.errorMessage);
    });
  }

  requireReadyCompanionRoute(surface: string, companionId: CompanionId): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
    companionId: CompanionId;
  } {
    const conn = this.ports.companionConnections.get(companionId);
    if (!conn) {
      this.ports.alarmCompanionViolation(
        'companion_not_connected',
        `Companion "${companionId}" (surface "${surface}") has no connected agent`,
        { surface, companionId },
      );
      throw new Error(`No agent connection for companion "${companionId}" (surface "${surface}")`);
    }
    const status = this.ports.connectionStatuses.get(conn);
    if (!status || status.role !== 'agent' || status.state !== 'ready' || status.health !== 'healthy') {
      this.ports.alarmCompanionViolation(
        'companion_not_ready',
        `Companion "${companionId}" (surface "${surface}") connection is not ready`,
        {
          surface,
          companionId,
          state: status?.state ?? 'missing',
          health: status?.health ?? 'missing',
        },
      );
      throw new Error(`Agent connection for companion "${companionId}" is not ready (surface "${surface}")`);
    }
    const client = this.ports.rpcClients.get(conn);
    if (!client) {
      this.ports.alarmCompanionViolation(
        'companion_rpc_client_missing',
        `Companion "${companionId}" (surface "${surface}") has no RPC client bound`,
        { surface, companionId },
      );
      throw new Error(`No RPC client for companion "${companionId}" (surface "${surface}")`);
    }
    return { conn, client, companionId };
  }

  resolveReadyRpcClient(): JSONRPCServerAndClient {
    return this.resolveReadyAgentConnection().client;
  }

  resolveReadyAgentConnection(): {
    conn: GatewayRpcConnection;
    client: JSONRPCServerAndClient;
  } {
    this.ports.refreshConnectionHealth();
    if (this.ports.rpcClients.size === 0) {
      throw new Error('No agent connected');
    }

    for (const [conn, client] of this.ports.rpcClients.entries()) {
      const status = this.ports.connectionStatuses.get(conn);
      if (!status) {
        continue;
      }
      if (status.role === 'agent' && status.state === 'ready' && status.health === 'healthy') {
        return { conn, client };
      }
    }

    throw new Error('No ready agent connected');
  }
}
