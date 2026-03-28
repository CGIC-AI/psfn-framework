import { CHANNEL_TYPES, type ChannelType, type SubstrateMessage, type WyomingRoutingMetadata } from '../shared/contracts/runtime.js';
import type { ShardSourceContext } from './types.js';
import { normalizePresenceMetadata, type CompanionPresenceMetadata } from '../agent/presence-metadata.js';

export interface ShardResultLineageSourceMessage {
  id: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  timestampMs: number;
  isDirectMessage: boolean;
}

export interface ShardResultLineageWyomingRouting {
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
  presence?: CompanionPresenceMetadata;
}

export interface ShardResultLineageEnvelope {
  schemaVersion: 1;
  kind: 'spawn' | 'wyoming';
  shardId: string;
  shardChannelId: string;
  sourceMessage: ShardResultLineageSourceMessage;
  sourceContext?: ShardSourceContext;
  wyomingRouting?: ShardResultLineageWyomingRouting;
}

function normalizeNonEmptyString(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Shard lineage ${fieldName} cannot be empty`);
  }
  return normalized;
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

function normalizeWyomingRouting(routing: WyomingRoutingMetadata | undefined): ShardResultLineageWyomingRouting | undefined {
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
  shardId: string;
  shardChannelId: string;
  sourceMessage: Pick<
    SubstrateMessage,
    'id' | 'channelId' | 'channelType' | 'authorId' | 'authorName' | 'timestamp' | 'isDirectMessage'
  >;
  sourceContext?: ShardSourceContext;
  wyomingRouting?: WyomingRoutingMetadata;
}): ShardResultLineageEnvelope {
  const sourceContext = normalizeSourceContext(input.sourceContext);
  const wyomingRouting = normalizeWyomingRouting(input.wyomingRouting);

  return {
    schemaVersion: 1,
    kind: input.kind,
    shardId: normalizeNonEmptyString(input.shardId, 'shard id'),
    shardChannelId: normalizeNonEmptyString(input.shardChannelId, 'shard channel id'),
    sourceMessage: normalizeSourceMessage(input.sourceMessage),
    ...(sourceContext ? { sourceContext } : {}),
    ...(wyomingRouting ? { wyomingRouting } : {}),
  };
}
