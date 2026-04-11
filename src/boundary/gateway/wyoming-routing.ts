import type { SubstrateMessage, WyomingRoutingMetadata } from '../../shared/contracts/runtime.js';
import type { WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import type { VoiceStreamMetadata } from './protocol.js';

interface WyomingStreamMetadataFields {
  source?: string;
  connectionId?: string;
  sessionId?: string;
  turnId?: string;
  siteId?: string;
  satelliteId?: string;
}

interface WyomingRoutingEvaluation {
  routing: WyomingRoutingMetadata;
  isWyoming: boolean;
}

export function applyWyomingRoutingPolicy(
  message: SubstrateMessage,
  metadata: VoiceStreamMetadata | undefined,
  config: WyomingShardRoutingConfig,
  companionId: string,
): SubstrateMessage {
  const evaluation = resolveWyomingRoutingMetadata(message, metadata);
  if (!evaluation.isWyoming) {
    return message;
  }

  const routing = evaluation.routing;
  const siteAllowlist = config.siteAllowlist ?? [];
  const satelliteAllowlist = config.satelliteAllowlist ?? [];
  let eligible = false;
  let reason = 'policy_disabled';

  if (config.enabled) {
    eligible = true;
    reason = 'eligible';

    if (siteAllowlist.length > 0) {
      const siteId = routing.siteId?.trim();
      if (!siteId || !siteAllowlist.includes(siteId)) {
        eligible = false;
        reason = 'site_not_allowlisted';
      }
    }

    if (eligible && satelliteAllowlist.length > 0) {
      const satelliteId = routing.satelliteId?.trim();
      if (!satelliteId || !satelliteAllowlist.includes(satelliteId)) {
        eligible = false;
        reason = 'satellite_not_allowlisted';
      }
    }
  }

  return {
    ...message,
    routing: {
      ...(message.routing ?? {}),
      source: 'wyoming',
      gateway: {
        schemaVersion: 1,
        companionId,
      },
      wyoming: {
        ...routing,
        shardDelegation: {
          eligible,
          reason,
        },
      },
    },
  };
}

function resolveWyomingRoutingMetadata(
  message: SubstrateMessage,
  metadata?: VoiceStreamMetadata,
): WyomingRoutingEvaluation {
  const existing = message.routing?.wyoming;
  const stream = parseWyomingStreamMetadata(metadata);
  const channel = parseWyomingChannelIdentity(message.channelId);
  const source = stream.source?.toLowerCase();
  const isWyoming = message.routing?.source === 'wyoming'
    || existing !== undefined
    || (message.channelType === 'api' && channel !== null)
    || source === 'wyoming';

  if (!isWyoming) {
    return { routing: {}, isWyoming: false };
  }

  const connectionId = existing?.connectionId
    ?? stream.connectionId
    ?? parseWyomingConnectionId(message.id);

  return {
    isWyoming: true,
    routing: {
      ...(existing ?? {}),
      ...(connectionId ? { connectionId } : {}),
      ...(stream.sessionId ? { sessionId: stream.sessionId } : {}),
      ...(stream.turnId ? { turnId: stream.turnId } : {}),
      ...(stream.siteId ? { siteId: stream.siteId } : channel?.siteId ? { siteId: channel.siteId } : {}),
      ...(stream.satelliteId
        ? { satelliteId: stream.satelliteId }
        : channel?.satelliteId
          ? { satelliteId: channel.satelliteId }
          : {}),
    },
  };
}

function parseWyomingStreamMetadata(metadata?: VoiceStreamMetadata): WyomingStreamMetadataFields {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return {};
  }

  const record = metadata as Record<string, unknown>;
  return {
    source: readMetadataString(record, ['source', 'voiceSource']),
    connectionId: readMetadataString(record, ['wyomingConnectionId', 'connectionId']),
    sessionId: readMetadataString(record, ['wyomingSessionId', 'sessionId']),
    turnId: readMetadataString(record, ['wyomingTurnId', 'turnId']),
    siteId: readMetadataString(record, ['wyomingSiteId', 'siteId']),
    satelliteId: readMetadataString(record, ['wyomingSatelliteId', 'satelliteId']),
  };
}

function readMetadataString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function parseWyomingChannelIdentity(channelId: string): { siteId: string; satelliteId: string } | null {
  if (!channelId.startsWith('api:wyoming:')) {
    return null;
  }

  const parts = channelId.split(':');
  if (parts.length < 4) {
    return null;
  }

  const siteId = parts[2]?.trim();
  const satelliteId = parts.slice(3).join(':').trim();
  if (!siteId || !satelliteId) {
    return null;
  }

  return { siteId, satelliteId };
}

function parseWyomingConnectionId(messageId: string): string | undefined {
  const match = /^wyoming-msg-(.+)-\d+$/.exec(messageId);
  const candidate = match?.[1]?.trim();
  return candidate ? candidate : undefined;
}
