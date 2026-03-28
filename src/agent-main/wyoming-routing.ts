import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import type { SubstrateMessage, WyomingRoutingMetadata } from '../shared/contracts/runtime.js';
import {
  buildSatellitePresenceMetadata,
  resolvePresenceMetadataResult,
  resolvePresenceSubjectId,
} from '../core/agent/presence-metadata.js';

export interface WyomingDelegationDecision {
  isWyoming: boolean;
  delegate: boolean;
  reason: string;
  routing?: WyomingRoutingMetadata;
}

export function resolveWyomingRoutingMetadata(
  message: SubstrateMessage,
): { routing?: WyomingRoutingMetadata; error?: string } | undefined {
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
      }),
    },
  };
}

export function evaluateWyomingDelegation(
  message: SubstrateMessage,
  config: SubstrateConfig,
): WyomingDelegationDecision {
  const routingResolution = resolveWyomingRoutingMetadata(message);
  if (!routingResolution) {
    return {
      isWyoming: false,
      delegate: false,
      reason: 'not_wyoming',
    };
  }

  if ('error' in routingResolution && routingResolution.error) {
    return {
      isWyoming: true,
      delegate: false,
      reason: routingResolution.error,
    };
  }

  const routing = routingResolution.routing;
  if (!routing) {
    return {
      isWyoming: false,
      delegate: false,
      reason: 'not_wyoming',
    };
  }

  if (!config.wyomingShardRouting?.enabled) {
    return {
      isWyoming: true,
      delegate: false,
      reason: 'agent_policy_disabled',
      routing,
    };
  }

  if (routing.shardDelegation?.eligible !== true) {
    return {
      isWyoming: true,
      delegate: false,
      reason: routing.shardDelegation?.reason ?? 'gateway_policy_denied',
      routing,
    };
  }

  return {
    isWyoming: true,
    delegate: true,
    reason: 'delegation_enabled',
    routing,
  };
}
