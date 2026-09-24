// Sibling lifecycle modules GatewayServer constructs first and hands, as typed
// ports, to the modules that delegate to them (never GatewayServer itself).
import type { GatewayAuditTrail } from './audit-trail.js';
import type { GatewayCompanionMessageLane } from './companion-message-lane.js';
import type { GatewayConnectionLifecycle } from './connection-lifecycle.js';
import type { GatewayConnectionRouter } from './connection-routing.js';
import type { GatewayConnectionScope } from './connection-scope.js';
import type { GatewayIcpInvalidationQueue } from './icp-invalidation-queue.js';
import type { GatewaySharedSatelliteOrchestrator } from './shared-satellite-orchestration.js';

export interface GatewayServerCollaboratorPorts {
  readonly auditTrail: GatewayAuditTrail;
  readonly companionMessageLane: GatewayCompanionMessageLane;
  readonly connectionLifecycle: GatewayConnectionLifecycle;
  readonly connectionRouter: GatewayConnectionRouter;
  readonly connectionScope: GatewayConnectionScope;
  readonly icpInvalidations: GatewayIcpInvalidationQueue;
  readonly sharedSatellite: GatewaySharedSatelliteOrchestrator;
}
