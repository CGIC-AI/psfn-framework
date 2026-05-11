import type { CompanionPresenceMetadata, EmbodimentPresenceMetadata } from '../../core/agent/presence-metadata.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';

export interface ShardSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
  embodimentContext?: EmbodimentPresenceMetadata;
}

export interface ShardResultLineageSourceMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  timestampMs: number;
  isDirectMessage: boolean;
}

export interface ShardResultLineageSatelliteRouting {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  presence?: CompanionPresenceMetadata;
}

export interface ShardCompanionProvenance {
  parentCompanionId: string;
  shardCompanionId: string;
}

export interface ShardResultLineageEnvelope {
  schemaVersion: 2;
  kind: 'spawn' | 'wyoming';
  coreCompanionId: string;
  shardCompanionId: string;
  shardId: string;
  shardChannelId: string;
  companionProvenance: ShardCompanionProvenance;
  sourceMessage: ShardResultLineageSourceMessage;
  sourceContext?: ShardSourceContext;
  satelliteRouting?: ShardResultLineageSatelliteRouting;
}
