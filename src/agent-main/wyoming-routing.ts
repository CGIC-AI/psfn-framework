import type {
  SubstrateConfig,
  SubstrateMessage,
  WyomingRoutingMetadata,
} from '../types.js';

export interface WyomingDelegationDecision {
  isWyoming: boolean;
  delegate: boolean;
  reason: string;
  routing?: WyomingRoutingMetadata;
}

export function resolveWyomingRoutingMetadata(
  message: SubstrateMessage,
): WyomingRoutingMetadata | undefined {
  const routing = message.routing?.wyoming;
  if (routing) {
    return routing;
  }
  if (message.channelType !== 'api' || !message.channelId.startsWith('api:wyoming:')) {
    return undefined;
  }

  const parts = message.channelId.split(':');
  if (parts.length < 4) {
    return undefined;
  }

  return {
    siteId: parts[2],
    satelliteId: parts.slice(3).join(':'),
  };
}

export function evaluateWyomingDelegation(
  message: SubstrateMessage,
  config: SubstrateConfig,
): WyomingDelegationDecision {
  const routing = resolveWyomingRoutingMetadata(message);
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
