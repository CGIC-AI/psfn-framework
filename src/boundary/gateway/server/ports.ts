// Typed ports GatewayServer hands to its lifecycle modules. The facade owns the
// connection registry state and passes the same Map/Set instances (never
// copies) plus narrow callbacks; modules pick only the members they need and
// never import GatewayServer itself.
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type { GatewayMultiCompanionConfig } from '../multi-companion.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayConnectionStatus } from './connection-status.js';

export interface GatewayServerPorts {
  readonly connections: Set<GatewayRpcConnection>;
  readonly rpcClients: Map<GatewayRpcConnection, JSONRPCServerAndClient>;
  readonly connectionStatuses: Map<GatewayRpcConnection, GatewayConnectionStatus>;
  readonly companionConnections: Map<CompanionId, GatewayRpcConnection>;
  readonly companionLastSeen: Map<CompanionId, number>;
  readonly multiCompanion: GatewayMultiCompanionConfig;
  readonly flushInboundChannelReplay: (companionId: CompanionId) => void;
}
