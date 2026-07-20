import {
  GatewayFleetModelUsageProjection,
  type FleetModelUsageAuthorizationPort,
} from '../../boundary/gateway/fleet-model-usage-projection.js';
import type { FleetPortalAuthorizationBatchPort } from '../../boundary/gateway/fleet-portal-authorization.js';
import type { FleetModelUsageSummaryQueryPort } from '../../shared/telemetry/model-usage.js';

export function createGatewayFleetModelUsageProjection(input: {
  readonly fleetAuthEnabled: boolean;
  readonly portalAuthorization?: FleetPortalAuthorizationBatchPort;
  readonly modelAuthorization?: FleetModelUsageAuthorizationPort;
  readonly usage?: FleetModelUsageSummaryQueryPort;
}): GatewayFleetModelUsageProjection | undefined {
  if (!input.fleetAuthEnabled) return undefined;
  if (!input.portalAuthorization || !input.modelAuthorization || !input.usage) {
    throw new Error('Fleet authentication requires the complete fleet model-usage projection wiring');
  }
  return new GatewayFleetModelUsageProjection({
    portalAuthorizer: input.portalAuthorization,
    modelAuthorizer: input.modelAuthorization,
    usage: input.usage,
  });
}
