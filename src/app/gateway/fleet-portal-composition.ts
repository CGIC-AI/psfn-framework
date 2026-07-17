import type { FleetPortalAuthorizationBatchPort } from '../../boundary/gateway/fleet-portal-authorization.js';
import {
  GatewayFleetPortalProjection,
  type FleetPortalConnectionSnapshotSource,
  type GatewayFleetPortalProjectionOptions,
} from '../../boundary/gateway/fleet-portal-projection.js';

export function createGatewayFleetPortalProjection(input: {
  readonly fleetAuthEnabled: boolean;
  readonly authorization?: FleetPortalAuthorizationBatchPort;
  readonly fleet?: GatewayFleetPortalProjectionOptions['fleet'];
  readonly source: FleetPortalConnectionSnapshotSource;
}): GatewayFleetPortalProjection | undefined {
  if (!input.fleetAuthEnabled) return undefined;
  if (!input.authorization || !input.fleet) {
    throw new Error('Fleet authentication requires the complete fleet portal projection wiring');
  }
  return new GatewayFleetPortalProjection({
    authorizer: input.authorization,
    fleet: input.fleet,
    source: input.source,
  });
}
