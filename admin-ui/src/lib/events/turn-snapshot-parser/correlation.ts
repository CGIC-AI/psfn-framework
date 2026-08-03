import {
  CHANNEL_TYPES,
  CORRELATION_METADATA_KEYS,
  REQUEST_AUDIENCE_VALUES,
  REQUESTER_PROVENANCE_VALUES,
  type CorrelationMetadata,
} from '../../../../../src/shared/contracts/runtime.js';
import { isObservabilityCallType } from '../../../../../src/shared/contracts/observability-call-types.js';
import { parseIcpConversationCorrelation } from '../../../../../src/shared/contracts/icp-autonomy.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
} from '../../../../../src/shared/contracts/charge-policy.js';
import { isChannelPrivacy } from '../../../../../src/system/trust/context-envelope.js';
import { TRUST_LEVELS } from '../../../../../src/system/trust/types.js';
import {
  optionalBoolean,
  optionalString,
  reject,
  requireBoolean,
  requireExactRecord,
  requireNonEmptyString,
  requireString,
} from './primitives';

export { CORRELATION_METADATA_KEYS };

const STRING_KEYS = [
  'companionId',
  'sessionId',
  'turnId',
  'requestId',
  'channelId',
  'toolName',
  'toolCallId',
  'originStage',
  'service',
  'process',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
  'shardId',
  'subagentId',
  'conversationId',
  'rootInitiationId',
  'workloadType',
  'workloadId',
  'purpose',
  'viewerMemorySubjectContactId',
  'viewerAuthorId',
] as const;

function requireOneOf<TValue extends string>(
  value: unknown,
  path: string,
  allowed: readonly TValue[],
): TValue {
  const result = requireString(value, path);
  if (!allowed.includes(result as TValue)) reject(path, 'contains an unsupported value');
  return result as TValue;
}

function parseEmbodimentContext(value: unknown, path: string) {
  const source = requireExactRecord(value, path, [
    'kind',
    'embodimentId',
    'companionId',
    'siteId',
    'channelId',
    'channelPrivacy',
    'label',
    'isPrimary',
    'isActive',
    'satelliteId',
    'emanationId',
  ]);
  if (source.kind !== 'embodiment') reject(`${path}.kind`, 'must equal embodiment');
  const siteId = optionalString(source, 'siteId', path);
  const channelId = optionalString(source, 'channelId', path);
  const label = optionalString(source, 'label', path);
  const satelliteId = optionalString(source, 'satelliteId', path);
  const emanationId = optionalString(source, 'emanationId', path);
  const isPrimary = optionalBoolean(source, 'isPrimary', path);
  const isActive = optionalBoolean(source, 'isActive', path);
  if (source.channelPrivacy !== undefined && !isChannelPrivacy(source.channelPrivacy)) {
    reject(`${path}.channelPrivacy`, 'contains an unsupported value');
  }
  return {
    kind: 'embodiment' as const,
    embodimentId: requireNonEmptyString(source.embodimentId, `${path}.embodimentId`),
    companionId: requireNonEmptyString(source.companionId, `${path}.companionId`),
    ...(siteId !== undefined ? { siteId } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(source.channelPrivacy !== undefined
      ? { channelPrivacy: source.channelPrivacy }
      : {}),
    ...(label !== undefined ? { label } : {}),
    ...(isPrimary !== undefined ? { isPrimary } : {}),
    ...(isActive !== undefined ? { isActive } : {}),
    ...(satelliteId !== undefined ? { satelliteId } : {}),
    ...(emanationId !== undefined ? { emanationId } : {}),
  };
}

const ICP_CORRELATION_KEYS = [
  'conversationId',
  'rootInitiationId',
  'initiatedByCompanionId',
  'localCompanionId',
  'peerCompanionId',
  'peerContactId',
  'channelId',
  'turnId',
  'messageId',
  'requestId',
  'chargeLane',
  'surface',
  'costPurpose',
  'costOriginStage',
  'fatigueDecision',
  'fatigueReasonCode',
] as const;

/** Parse and clone every optional field in the canonical CorrelationMetadata contract. */
export function parseCorrelationMetadataFields(
  source: Record<string, unknown>,
  path: string,
): Partial<CorrelationMetadata> {
  const parsed: Record<string, unknown> = {};
  for (const key of STRING_KEYS) {
    if (source[key] !== undefined) {
      parsed[key] = requireNonEmptyString(source[key], `${path}.${key}`);
    }
  }
  for (const key of ['callType', 'originType'] as const) {
    if (source[key] !== undefined) {
      if (!isObservabilityCallType(source[key])) reject(`${path}.${key}`, 'contains an unsupported value');
      parsed[key] = source[key];
    }
  }
  if (source.channelType !== undefined) {
    parsed.channelType = requireOneOf(source.channelType, `${path}.channelType`, CHANNEL_TYPES);
  }
  if (source.telemetryVisibility !== undefined) {
    parsed.telemetryVisibility = requireOneOf(
      source.telemetryVisibility,
      `${path}.telemetryVisibility`,
      ['operator_visible', 'companion_private'],
    );
  }
  if (source.chargeLane !== undefined) {
    parsed.chargeLane = requireOneOf(
      source.chargeLane,
      `${path}.chargeLane`,
      CHARGE_POLICY_RUNTIME_LANE_VALUES,
    );
  }
  if (source.chargeSurface !== undefined) {
    parsed.chargeSurface = requireOneOf(
      source.chargeSurface,
      `${path}.chargeSurface`,
      CHARGE_POLICY_SURFACE_VALUES,
    );
  }
  if (source.viewerTrustLevel !== undefined) {
    parsed.viewerTrustLevel = requireOneOf(
      source.viewerTrustLevel,
      `${path}.viewerTrustLevel`,
      TRUST_LEVELS,
    );
  }
  if (source.requesterProvenance !== undefined) {
    parsed.requesterProvenance = requireOneOf(
      source.requesterProvenance,
      `${path}.requesterProvenance`,
      REQUESTER_PROVENANCE_VALUES,
    );
  }
  if (source.requestAudience !== undefined) {
    parsed.requestAudience = requireOneOf(
      source.requestAudience,
      `${path}.requestAudience`,
      REQUEST_AUDIENCE_VALUES,
    );
  }
  if (source.viewerChannelPrivacy !== undefined) {
    if (!isChannelPrivacy(source.viewerChannelPrivacy)) {
      reject(`${path}.viewerChannelPrivacy`, 'contains an unsupported value');
    }
    parsed.viewerChannelPrivacy = source.viewerChannelPrivacy;
  }
  if (source.viewerIsDirectMessage !== undefined) {
    parsed.viewerIsDirectMessage = requireBoolean(
      source.viewerIsDirectMessage,
      `${path}.viewerIsDirectMessage`,
    );
  }
  if (source.embodimentContext !== undefined) {
    parsed.embodimentContext = parseEmbodimentContext(
      source.embodimentContext,
      `${path}.embodimentContext`,
    );
  }
  if (source.icpCorrelation !== undefined) {
    requireExactRecord(source.icpCorrelation, `${path}.icpCorrelation`, ICP_CORRELATION_KEYS);
    try {
      parsed.icpCorrelation = parseIcpConversationCorrelation(source.icpCorrelation);
    } catch {
      reject(`${path}.icpCorrelation`, 'does not satisfy the canonical ICP correlation contract');
    }
  }
  return parsed as Partial<CorrelationMetadata>;
}
