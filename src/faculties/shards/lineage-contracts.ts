import type { CompanionPresenceMetadata, EmbodimentPresenceMetadata } from '../../core/agent/presence-metadata.js';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import type {
  CompanionId,
  ShardCompanionId,
} from '../../shared/routing/companion-id.js';

export interface ShardSourceContext {
  channelId: string;
  /** Captured parent session owner; never re-resolve this from mutable focus. */
  logicalSessionId?: string;
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
  parentCompanionId: CompanionId;
  shardCompanionId: ShardCompanionId;
}

export interface ShardResultLineageEnvelope {
  schemaVersion: 2;
  kind: 'spawn' | 'wyoming';
  coreCompanionId: CompanionId;
  shardCompanionId: ShardCompanionId;
  shardId: string;
  shardChannelId: string;
  companionProvenance: ShardCompanionProvenance;
  sourceMessage: ShardResultLineageSourceMessage;
  /** Source envelopes consumed by this worker; retained across every foldback. */
  ingestedIntakeEnvelopes?: readonly IntakeEnvelopeSnapshot[];
  sourceContext?: ShardSourceContext;
  satelliteRouting?: ShardResultLineageSatelliteRouting;
}
