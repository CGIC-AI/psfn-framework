// Gateway connection status model: roles, lifecycle states, health, and the
// allowed lifecycle transitions shared by admission, routing, and health.
import type { CompanionId } from '../../../shared/routing/companion-id.js';

export type GatewayConnectionState = 'registering' | 'ready' | 'degraded' | 'offline';
export type GatewayConnectionHealth = 'healthy' | 'stale' | 'failed';
export type GatewayConnectionRole = 'unidentified' | 'agent' | 'internal_session_integrity';
export type MalformedFrameKind = 'ndjson' | 'jsonrpc';

export interface GatewayConnectionStatus {
  role: GatewayConnectionRole;
  state: GatewayConnectionState;
  stateReason: string;
  health: GatewayConnectionHealth;
  connectedAt: number;
  lastHealthcheckAt: number;
  lastTransitionAt: number;
  healthcheckStaleAfterMs: number;
  runtimeReadyDeclared: boolean;
  failureReason?: string;
  /** Multi-companion (W1): companionId this connection identified as. */
  companionId?: CompanionId;
}

export const GATEWAY_CONNECTION_STATE_TRANSITIONS:
Readonly<Record<GatewayConnectionState, readonly GatewayConnectionState[]>> = {
  registering: ['ready', 'degraded', 'offline'],
  ready: ['degraded', 'offline'],
  degraded: ['registering', 'ready', 'offline'],
  offline: [],
};

export function isIdentifiableGatewayConnectionRole(
  value: unknown,
): value is Exclude<GatewayConnectionRole, 'unidentified'> {
  return value === 'agent' || value === 'internal_session_integrity';
}
