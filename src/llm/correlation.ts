import type {
  CompletionPurpose,
  CorrelationMetadata,
  ObservabilityCallType,
} from '../types.js';

const OBSERVABILITY_CALL_TYPES: ReadonlySet<ObservabilityCallType> = new Set([
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
]);

export interface ResolvedCorrelationMetadata extends CorrelationMetadata {
  requestId: string;
  originType: ObservabilityCallType;
  originStage: string;
}

export function isObservabilityCallType(value: unknown): value is ObservabilityCallType {
  return typeof value === 'string' && OBSERVABILITY_CALL_TYPES.has(value as ObservabilityCallType);
}

export function normalizeCorrelationValue(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function inferCallType(
  purpose: CompletionPurpose | 'chat',
  channelId?: string,
): ObservabilityCallType {
  const normalizedChannelId = normalizeCorrelationValue(channelId)?.toLowerCase();
  if (normalizedChannelId?.startsWith('internal:')) {
    return 'scheduled';
  }

  switch (purpose) {
    case 'chat':
      return 'chat';
    case 'reasoning':
      return 'tool';
    case 'memory':
    case 'extraction':
      return 'memory';
    case 'summary':
      return 'summary';
    case 'context':
    case 'background':
    case 'import_processing':
    default:
      return 'background';
  }
}

export function resolveCorrelationMetadata(
  contextCorrelation: CorrelationMetadata | undefined,
  optionCorrelation: Partial<CorrelationMetadata> | undefined,
  purpose: CompletionPurpose | 'chat',
): ResolvedCorrelationMetadata {
  const merged: Partial<CorrelationMetadata> = {
    ...(contextCorrelation ?? {}),
    ...(optionCorrelation ?? {}),
  };

  const turnId = normalizeCorrelationValue(merged.turnId);
  const channelId = normalizeCorrelationValue(merged.channelId);
  const requestId = normalizeCorrelationValue(merged.requestId) ?? turnId ?? 'unknown';
  const toolName = normalizeCorrelationValue(merged.toolName);
  const toolCallId = normalizeCorrelationValue(merged.toolCallId);

  const inferredCallType = inferCallType(purpose, channelId);
  const originType = isObservabilityCallType(merged.originType)
    ? merged.originType
    : (isObservabilityCallType(merged.callType) ? merged.callType : inferredCallType);
  const originStage = normalizeCorrelationValue(merged.originStage)
    ?? normalizeCorrelationValue(merged.purpose)
    ?? String(purpose);

  const callType = isObservabilityCallType(merged.callType)
    ? merged.callType
    : originType;
  const resolvedPurpose = normalizeCorrelationValue(merged.purpose) ?? originStage;

  return {
    ...(turnId ? { turnId } : {}),
    requestId,
    ...(channelId ? { channelId } : {}),
    callType,
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    purpose: resolvedPurpose,
    originType,
    originStage,
  };
}

export function toCorrelationLogFields(
  correlation: Partial<CorrelationMetadata> | undefined,
): {
  requestId: string;
  originType: ObservabilityCallType;
  originStage: string;
  turnId?: string;
  channelId?: string;
  toolName?: string;
  toolCallId?: string;
} {
  const turnId = normalizeCorrelationValue(correlation?.turnId);
  const requestId = normalizeCorrelationValue(correlation?.requestId) ?? turnId ?? 'unknown';
  const channelId = normalizeCorrelationValue(correlation?.channelId);
  const toolName = normalizeCorrelationValue(correlation?.toolName);
  const toolCallId = normalizeCorrelationValue(correlation?.toolCallId);
  const originType = isObservabilityCallType(correlation?.originType)
    ? correlation.originType
    : (isObservabilityCallType(correlation?.callType) ? correlation.callType : 'background');
  const originStage = normalizeCorrelationValue(correlation?.originStage)
    ?? normalizeCorrelationValue(correlation?.purpose)
    ?? 'unknown';

  return {
    ...(turnId ? { turnId } : {}),
    requestId,
    ...(channelId ? { channelId } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    originType,
    originStage,
  };
}
