import {
  GatewayFleetIcpPostureSource,
  IcpPolicyOutcomeRecorder,
  type FleetIcpPostureSource,
} from '../../boundary/gateway/fleet-icp-posture.js';
import { PostgresIcpFleetHealthReader } from '../../persistence/postgres/icp-fleet-health-reader.js';
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
  readonly icpPosture?: FleetIcpPostureSource;
}): GatewayFleetPortalProjection | undefined {
  if (!input.fleetAuthEnabled) return undefined;
  if (!input.authorization || !input.fleet || !input.icpPosture) {
    throw new Error('Fleet authentication requires the complete fleet portal projection wiring');
  }
  return new GatewayFleetPortalProjection({
    authorizer: input.authorization,
    fleet: input.fleet,
    source: input.source,
    icpPosture: input.icpPosture,
    ...(input.channelHealth ? { channelHealth: input.channelHealth } : {}),
  });
}

export interface GatewayFleetIcpPostureWiring {
  readonly source: FleetIcpPostureSource;
  readonly policyOutcomes: IcpPolicyOutcomeRecorder;
  close(): Promise<void>;
}

/**
 * h248l.4: passive Fleet ICP posture. A multi-companion gateway (the only
 * topology with a live ICP control plane) reads the shared coordination rows
 * through a dedicated content-free reader; a single-companion gateway reports
 * the inert singleton posture without any database access.
 */
export function createGatewayFleetIcpPosture(input: {
  readonly fleetCompanionIds: readonly string[];
  readonly sharedDatabaseUrl?: string;
  readonly reportReadFailure: (error: unknown) => void;
}): GatewayFleetIcpPostureWiring {
  const policyOutcomes = new IcpPolicyOutcomeRecorder(new Set(input.fleetCompanionIds));
  const reader = input.sharedDatabaseUrl
    ? PostgresIcpFleetHealthReader.connect(input.sharedDatabaseUrl)
    : undefined;
  const source = new GatewayFleetIcpPostureSource({
    fleetCompanionIds: input.fleetCompanionIds,
    icpActive: reader !== undefined,
    ...(reader ? { reader } : {}),
    policyOutcomes,
    reportReadFailure: input.reportReadFailure,
  });
  return Object.freeze({
    source,
    policyOutcomes,
    close: async () => { await reader?.close(); },
  });
}
