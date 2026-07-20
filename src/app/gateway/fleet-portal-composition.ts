import type { FleetPortalAuthorizationBatchPort } from '../../boundary/gateway/fleet-portal-authorization.js';
import {
  GatewayFleetPortalProjection,
  type FleetPortalChannelHealthSource,
  type FleetPortalConnectionSnapshotSource,
  type GatewayFleetPortalProjectionOptions,
} from '../../boundary/gateway/fleet-portal-projection.js';

export function createGatewayFleetPortalChannelHealthSource(
  entries: readonly {
    readonly companionId: string;
    /**
     * `undefined` means this routed channel has no honest live-health signal.
     * One confirmed-up channel makes the aggregate up; otherwise incomplete
     * coverage keeps the aggregate unknown rather than inventing down.
     */
    readonly isConnected: () => boolean | undefined;
  }[],
): FleetPortalChannelHealthSource {
  const byCompanionId = new Map<string, Array<() => boolean | undefined>>();
  for (const entry of entries) {
    const observations = byCompanionId.get(entry.companionId) ?? [];
    observations.push(entry.isConnected);
    byCompanionId.set(entry.companionId, observations);
  }
  return Object.freeze({
    healthOf(companionId: string) {
      const observations = byCompanionId.get(companionId);
      if (!observations) return 'unknown';
      let observedUnknown = false;
      for (const isConnected of observations) {
        const connected = isConnected();
        if (connected === true) return 'up';
        if (connected === undefined) observedUnknown = true;
      }
      return observedUnknown ? 'unknown' : 'down';
    },
  });
}

export function createGatewayFleetPortalProjection(input: {
  readonly fleetAuthEnabled: boolean;
  readonly authorization?: FleetPortalAuthorizationBatchPort;
  readonly fleet?: GatewayFleetPortalProjectionOptions['fleet'];
  readonly source: FleetPortalConnectionSnapshotSource;
  readonly channelHealth?: FleetPortalChannelHealthSource;
}): GatewayFleetPortalProjection | undefined {
  if (!input.fleetAuthEnabled) return undefined;
  if (!input.authorization || !input.fleet) {
    throw new Error('Fleet authentication requires the complete fleet portal projection wiring');
  }
  return new GatewayFleetPortalProjection({
    authorizer: input.authorization,
    fleet: input.fleet,
    source: input.source,
    ...(input.channelHealth ? { channelHealth: input.channelHealth } : {}),
  });
}
