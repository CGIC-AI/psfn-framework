import type { SubstrateConfig } from '../../../src/system/config/runtime-config-contracts.js';
import type { SubstrateMessage } from '../../../src/shared/contracts/runtime.js';
import type {
  SatelliteDelegationDecision,
  SatelliteRoutingMetadata,
  SatelliteRoutingPort,
} from '../../../src/core/agent/satellite-adapter-port.js';
import {
  buildSatellitePresenceMetadata,
  resolvePresenceMetadataResult,
  resolvePresenceSubjectId,
} from '../../../src/core/agent/presence-metadata.js';

export function resolveWyomingRoutingMetadata(
  message: SubstrateMessage,
  companionId: string,
): { routing?: SatelliteRoutingMetadata; error?: string } | undefined {
  const routing = message.routing?.wyoming;
  if (routing) {
    const presenceResolution = routing.presence
      ? resolvePresenceMetadataResult(routing.presence)
      : {};
    if (presenceResolution.error) {
      return { error: presenceResolution.error };
    }
    if (presenceResolution.presence) {
      const canonicalPresence = presenceResolution.presence;
      return {
        routing: {
          ...routing,
          ...(canonicalPresence.siteId ? { siteId: canonicalPresence.siteId } : {}),
          satelliteId: routing.satelliteId ?? resolvePresenceSubjectId(canonicalPresence),
          presence: canonicalPresence,
        },
      };
    }

    if (routing.siteId && routing.satelliteId) {
      const fallbackResolution = resolvePresenceMetadataResult({
        kind: 'satellite',
        siteId: routing.siteId,
        satelliteId: routing.satelliteId,
        companionId,
      });
      if (fallbackResolution.error) {
        return { error: fallbackResolution.error };
      }
      return {
        routing: {
          ...routing,
          presence: fallbackResolution.presence ?? buildSatellitePresenceMetadata({
            siteId: routing.siteId,
            satelliteId: routing.satelliteId,
            companionId,
          }),
        },
      };
    }

    return {
      routing,
    };
  }
  if (message.channelType !== 'api' || !message.channelId.startsWith('api:wyoming:')) {
    return undefined;
  }

  const parts = message.channelId.split(':');
  if (parts.length < 4) {
    return undefined;
  }

  const presenceResolution = resolvePresenceMetadataResult({
    kind: 'satellite',
    siteId: parts[2],
    satelliteId: parts.slice(3).join(':'),
    companionId,
  });
  if (presenceResolution.error) {
    return { error: presenceResolution.error };
  }

  return {
    routing: {
      siteId: parts[2],
      satelliteId: parts.slice(3).join(':'),
      presence: presenceResolution.presence ?? buildSatellitePresenceMetadata({
        siteId: parts[2],
        satelliteId: parts.slice(3).join(':'),
        companionId,
      }),
    },
  };
}

export function createWyomingSatelliteRoutingPort(): SatelliteRoutingPort {
  return {
    evaluateDelegation(
      message: SubstrateMessage,
      config: SubstrateConfig,
      companionId: string,
    ): SatelliteDelegationDecision | undefined {
      const routingResolution = resolveWyomingRoutingMetadata(message, companionId);
      if (!routingResolution) {
        return {
          adapterId: 'wyoming',
          isSatellite: false,
          delegate: false,
          reason: 'not_satellite',
        };
      }

      if ('error' in routingResolution && routingResolution.error) {
        return {
          adapterId: 'wyoming',
          isSatellite: true,
          delegate: false,
          reason: routingResolution.error,
        };
      }

      const routing = routingResolution.routing;
      if (!routing) {
        return {
          adapterId: 'wyoming',
          isSatellite: false,
          delegate: false,
          reason: 'not_satellite',
        };
      }

      if (!config.wyomingShardRouting?.enabled) {
        return {
          adapterId: 'wyoming',
          isSatellite: true,
          delegate: false,
          reason: 'agent_policy_disabled',
          routing,
        };
      }

      if (routing.shardDelegation?.eligible !== true) {
        return {
          adapterId: 'wyoming',
          isSatellite: true,
          delegate: false,
          reason: routing.shardDelegation?.reason ?? 'gateway_policy_denied',
          routing,
        };
      }

      return {
        adapterId: 'wyoming',
        isSatellite: true,
        delegate: true,
        reason: 'delegation_enabled',
        routing,
      };
    },
  };
}
