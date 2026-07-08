import type {
  ChannelAdapterManifestEntry,
  ChannelAdapterPort,
} from '../../channels/backplane/types.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  CompanionPresenceMetadata,
  EmbodimentPresenceMetadata,
  SatellitePresenceMetadata,
} from './presence-metadata.js';
import {
  resolveCanonicalEmbodimentContext,
  resolveCanonicalSatelliteContext,
} from './active-emanation-state.js';

export interface SatelliteShardDelegationHint {
  eligible: boolean;
  reason?: string;
}

export interface SatelliteRoutingMetadata {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  presence?: CompanionPresenceMetadata;
  shardDelegation?: SatelliteShardDelegationHint;
}

export interface SatelliteDelegationDecision {
  adapterId: string;
  isSatellite: boolean;
  delegate: boolean;
  reason: string;
  routing?: SatelliteRoutingMetadata;
}

export interface SatelliteRoutingPort {
  evaluateDelegation(
    message: SubstrateMessage,
    config: SubstrateConfig,
    companionId: string,
  ): SatelliteDelegationDecision | undefined;
}

export interface SatellitePresencePort {
  resolveCanonicalEmbodiment(value: unknown): EmbodimentPresenceMetadata | undefined;
  resolveCanonicalSatellite(value: unknown): SatellitePresenceMetadata | undefined;
}

export interface SatelliteChannelAdapterPort {
  manifest: ChannelAdapterManifestEntry;
  create(): Promise<ChannelAdapterPort> | ChannelAdapterPort;
}

export interface SatelliteAdapterPort {
  id: string;
  routing?: SatelliteRoutingPort;
  presence?: SatellitePresencePort;
  channel?: SatelliteChannelAdapterPort;
}

export function createNoopSatelliteRoutingPort(): SatelliteRoutingPort {
  return {
    evaluateDelegation: () => undefined,
  };
}

export function createActiveEmanationSatellitePresencePort(): SatellitePresencePort {
  return {
    resolveCanonicalEmbodiment(value) {
      return resolveCanonicalEmbodimentContext(value);
    },
    resolveCanonicalSatellite(value) {
      return resolveCanonicalSatelliteContext(value);
    },
  };
}
