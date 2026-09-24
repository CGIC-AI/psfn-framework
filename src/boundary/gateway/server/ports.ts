// Typed ports GatewayServer hands to its lifecycle modules. The facade owns the
// connection registry state and passes the same Map/Set instances (never
// copies) plus narrow callbacks; modules pick only the members they need and
// never import GatewayServer itself.
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import type {
  AuthenticatedGatewayAccountRoute,
  GatewayChannelSurface,
  GatewayMultiCompanionConfig,
} from '../multi-companion.js';
import type { GatewayOperatorAlertDispatcher } from '../operator-alert-dispatcher.js';
import type { GatewayRpcConnection } from '../transport.js';
import type { GatewayPolicyDecision } from '../protocol.js';
import type { GatewayNtfyNotifier } from '../ntfy-notifier.js';
import type { GatewayFleetPostureCache } from '../fleet-posture-cache.js';
import type { GatewayServerOptions } from './options.js';
import type { GatewayConnectionStatus } from './connection-status.js';

export interface GatewayServerPorts {
  readonly connections: Set<GatewayRpcConnection>;
  readonly rpcClients: Map<GatewayRpcConnection, JSONRPCServerAndClient>;
  readonly connectionStatuses: Map<GatewayRpcConnection, GatewayConnectionStatus>;
  readonly companionConnections: Map<CompanionId, GatewayRpcConnection>;
  readonly companionLastSeen: Map<CompanionId, number>;
  readonly options: GatewayServerOptions;
  readonly multiCompanion: GatewayMultiCompanionConfig;
  readonly fleetCompanionIds: ReadonlySet<CompanionId>;
  readonly companionPostures: GatewayFleetPostureCache<GatewayRpcConnection>;
  readonly ntfyNotifier: GatewayNtfyNotifier;
  readonly operatorAlertDispatcher: GatewayOperatorAlertDispatcher;
  readonly flushInboundChannelReplay: (companionId: CompanionId) => void;
  readonly refreshConnectionHealth: (now?: number) => void;
  readonly alarmCompanionViolation: (
    event: string,
    message: string,
    details: Record<string, unknown>,
  ) => void;
  readonly recordCompanionViolation: (event: string, details: Record<string, unknown>) => void;
  readonly resolveReadyCompanionConnection: (companionId: CompanionId) => GatewayRpcConnection | null;
  readonly resolveRoutedCompanionId: (
    surface: GatewayChannelSurface,
    route?: AuthenticatedGatewayAccountRoute,
  ) => CompanionId;
  readonly notifyAll: (method: string, params: unknown) => number;
  readonly notifyOne: (conn: GatewayRpcConnection, method: string, params: unknown) => boolean;
  readonly audit: (
    method: string,
    decision: GatewayPolicyDecision,
    params?: Record<string, unknown>,
  ) => Promise<number>;
  readonly auditComplete: (id: number, startTime: number, error?: string) => Promise<void>;
}
