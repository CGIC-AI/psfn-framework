import { CHANNEL_TYPES, type ChannelType, type SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SatelliteRoutingMetadata } from '../../core/agent/satellite-adapter-port.js';
import { normalizePresenceMetadata } from '../../core/agent/presence-metadata.js';
import type {
  ShardResultLineageEnvelope,
  ShardResultLineageSatelliteRouting,
  ShardResultLineageSourceMessage,
  ShardSourceContext,
} from './lineage-contracts.js';

export type {
  ShardCompanionProvenance,
  ShardResultLineageEnvelope,
  ShardResultLineageSatelliteRouting,
  ShardResultLineageSourceMessage,
  ShardSourceContext,
} from './lineage-contracts.js';

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Shard lineage ${fieldName} cannot be empty`);
  }
  return normalized;
}

export function deriveShardCompanionId(coreCompanionId: string, shardId: string): string {
  return `${normalizeNonEmptyString(coreCompanionId, 'core companion id')}::${normalizeNonEmptyString(shardId, 'shard id')}`;
}

function normalizeChannelType(value: SubstrateMessage['channelType']): ChannelType {
  if (!CHANNEL_TYPES.includes(value)) {
    throw new Error(`Shard lineage source message channelType must be one of: ${CHANNEL_TYPES.join(', ')}`);
  }
  return value;
}

function normalizeSourceMessage(message: Pick<
  SubstrateMessage,
  'id' | 'channelId' | 'channelType' | 'authorId' | 'authorName' | 'timestamp' | 'isDirectMessage'
>): ShardResultLineageSourceMessage {
  const timestampMs = message.timestamp.getTime();
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Shard lineage source message timestamp must be a valid Date');
  }

  return {
    id: normalizeNonEmptyString(message.id, 'source message id'),
    channelId: normalizeNonEmptyString(message.channelId, 'source message channelId'),
    channelType: normalizeChannelType(message.channelType),
    authorId: normalizeNonEmptyString(message.authorId, 'source message authorId'),
    authorName: normalizeNonEmptyString(message.authorName, 'source message authorName'),
    timestampMs,
    isDirectMessage: message.isDirectMessage ?? false,
  };
}

function normalizeSourceContext(sourceContext: ShardSourceContext | undefined): ShardSourceContext | undefined {
  if (!sourceContext) {
    return undefined;
  }

  const channelId = normalizeNonEmptyString(sourceContext.channelId, 'source context channelId');
  const requestId = sourceContext.requestId?.trim();
  const turnId = sourceContext.turnId?.trim();

  return {
    channelId,
    ...(requestId ? { requestId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

function normalizeSatelliteRouting(routing: SatelliteRoutingMetadata | undefined): ShardResultLineageSatelliteRouting | undefined {
  if (!routing) {
    return undefined;
  }

  const connectionId = routing.connectionId?.trim();
  const sessionId = routing.sessionId?.trim();
  const turnId = routing.turnId?.trim();
  const siteId = routing.siteId?.trim();
  const satelliteId = routing.satelliteId?.trim();
  const presence = routing.presence ? normalizePresenceMetadata(routing.presence) : undefined;

  return {
    ...(connectionId ? { connectionId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(siteId ? { siteId } : {}),
    ...(satelliteId ? { satelliteId } : {}),
    ...(presence ? { presence } : {}),
  };
}

export function buildShardLineageEnvelope(input: {
  kind: ShardResultLineageEnvelope['kind'];
  coreCompanionId: string;
  shardId: string;
  shardChannelId: string;
  sourceMessage: Pick<
    SubstrateMessage,
    'id' | 'channelId' | 'channelType' | 'authorId' | 'authorName' | 'timestamp' | 'isDirectMessage'
  >;
  sourceContext?: ShardSourceContext;
  satelliteRouting?: SatelliteRoutingMetadata;
}): ShardResultLineageEnvelope {
  const sourceContext = normalizeSourceContext(input.sourceContext);
  const satelliteRouting = normalizeSatelliteRouting(input.satelliteRouting);
  const coreCompanionId = normalizeNonEmptyString(input.coreCompanionId, 'core companion id');
  const shardId = normalizeNonEmptyString(input.shardId, 'shard id');
  const shardCompanionId = deriveShardCompanionId(coreCompanionId, shardId);

  return {
    schemaVersion: 2,
    kind: input.kind,
    coreCompanionId,
    shardCompanionId,
    shardId,
    shardChannelId: normalizeNonEmptyString(input.shardChannelId, 'shard channel id'),
    companionProvenance: {
      parentCompanionId: coreCompanionId,
      shardCompanionId,
    },
    sourceMessage: normalizeSourceMessage(input.sourceMessage),
    ...(sourceContext ? { sourceContext } : {}),
    ...(satelliteRouting ? { satelliteRouting } : {}),
  };
}
