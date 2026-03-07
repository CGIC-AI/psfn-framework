import type { CorrelationMetadata, ObservabilityCallType } from '../../types.js';
import type { EventMap, EventName } from '../../event-bus.js';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CALL_TYPES: ReadonlySet<ObservabilityCallType> = new Set([
  'chat',
  'tool',
  'memory',
  'summary',
  'background',
  'scheduled',
]);

function normalizeCallType(value: string | undefined): ObservabilityCallType | undefined {
  if (!value) return undefined;
  return CALL_TYPES.has(value as ObservabilityCallType)
    ? (value as ObservabilityCallType)
    : undefined;
}

function inferTelemetryCallType(eventName: EventName): ObservabilityCallType | undefined {
  if (eventName === 'agent.tool.start' || eventName === 'agent.tool.end') {
    return 'tool';
  }
  if (eventName.startsWith('agent.tools.adaptive.')) {
    return 'tool';
  }
  if (eventName === 'memory.extraction.end') {
    return 'memory';
  }
  if (
    eventName === 'agent.turn.usage'
    || eventName === 'message.sent'
    || eventName.startsWith('broadcast.')
  ) {
    return 'chat';
  }
  if (
    eventName.startsWith('wyoming.')
    || eventName === 'external.telemetry.ingested'
  ) {
    return 'background';
  }
  return undefined;
}

export function resolveTelemetryCorrelation<E extends EventName>(
  eventName: E,
  data: EventMap[E],
): Partial<CorrelationMetadata> {
  const payload = data as Record<string, unknown>;
  const nestedMessage = asRecord(payload.message);
  const nestedResponse = asRecord(payload.response);
  const nestedExternalEvent = asRecord(payload.event);
  const turnId = readString(payload.turnId) ?? readString(nestedMessage?.id);
  const requestId = readString(payload.requestId) ?? turnId;
  const channelId = readString(payload.channelId)
    ?? readString(nestedMessage?.channelId)
    ?? readString(nestedResponse?.channelId)
    ?? readString(nestedExternalEvent?.channelId);
  const callType = normalizeCallType(readString(payload.callType))
    ?? inferTelemetryCallType(eventName);
  const originType = normalizeCallType(readString(payload.originType))
    ?? callType;
  const toolName = readString(payload.toolName);
  const toolCallId = readString(payload.toolCallId);
  const purpose = readString(payload.purpose) ?? eventName;
  const originStage = readString(payload.originStage) ?? purpose;

  return {
    ...(turnId ? { turnId } : {}),
    ...(requestId ? { requestId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(callType ? { callType } : {}),
    ...(originType ? { originType } : {}),
    ...(originStage ? { originStage } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(purpose ? { purpose } : {}),
  };
}
