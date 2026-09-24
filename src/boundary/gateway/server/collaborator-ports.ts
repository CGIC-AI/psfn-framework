// Sibling lifecycle modules GatewayServer constructs first and hands, as typed
// ports, to the modules that delegate to them (never GatewayServer itself).
import type { GatewayAuditTrail } from './audit-trail.js';
import type { GatewayCompanionMessageLane } from './companion-message-lane.js';
import type { GatewayConnectionRouter } from './connection-routing.js';
import type { GatewayConnectionScope } from './connection-scope.js';
import type { GatewaySharedSatelliteOrchestrator } from './shared-satellite-orchestration.js';

export interface GatewayServerCollaboratorPorts {
  readonly auditTrail: GatewayAuditTrail;
  readonly companionMessageLane: GatewayCompanionMessageLane;
  readonly connectionRouter: GatewayConnectionRouter;
  readonly connectionScope: GatewayConnectionScope;
  readonly sharedSatellite: GatewaySharedSatelliteOrchestrator;
}
