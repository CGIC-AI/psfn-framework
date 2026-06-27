import { isRecord } from '../../../../src/shared/utils/types.js';
export interface GardenEventCorrelation {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: string;
  originType?: string;
  originStage?: string;
  toolName?: string;
  toolCallId?: string;
  purpose?: string;
}

export interface GardenEventEnvelope<TData = unknown> {
  type: string;
  timestamp: number;
  correlation: GardenEventCorrelation;
  data: TData;
}

export interface GardenEventFilter {
  types?: readonly string[];
  channelId?: string;
  turnId?: string;
  predicate?: (event: GardenEventEnvelope) => boolean;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}


export function normalizeGardenEventCorrelation(value: unknown): GardenEventCorrelation {
  if (!isRecord(value)) {
    return {};
  }

  return {
    ...(normalizeString(value.turnId) ? { turnId: normalizeString(value.turnId) } : {}),
    ...(normalizeString(value.requestId) ? { requestId: normalizeString(value.requestId) } : {}),
    ...(normalizeString(value.channelId) ? { channelId: normalizeString(value.channelId) } : {}),
    ...(normalizeString(value.callType) ? { callType: normalizeString(value.callType) } : {}),
    ...(normalizeString(value.originType) ? { originType: normalizeString(value.originType) } : {}),
    ...(normalizeString(value.originStage) ? { originStage: normalizeString(value.originStage) } : {}),
    ...(normalizeString(value.toolName) ? { toolName: normalizeString(value.toolName) } : {}),
    ...(normalizeString(value.toolCallId) ? { toolCallId: normalizeString(value.toolCallId) } : {}),
    ...(normalizeString(value.purpose) ? { purpose: normalizeString(value.purpose) } : {}),
  };
}

export function normalizeGardenEventEnvelope(value: unknown): GardenEventEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }

  const type = normalizeString(value.type);
  if (!type) {
    return null;
  }

  const timestamp = typeof value.timestamp === 'number' && Number.isFinite(value.timestamp)
    ? value.timestamp
    : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return null;
  }

  return {
    type,
    timestamp,
    correlation: normalizeGardenEventCorrelation(value.correlation),
    data: value.data,
  };
}

export function matchesGardenEventFilter(
  event: GardenEventEnvelope,
  filter?: GardenEventFilter,
): boolean {
  if (!filter) return true;
  if (filter.types && filter.types.length > 0 && !filter.types.includes(event.type)) {
    return false;
  }
  if (filter.channelId && event.correlation.channelId !== filter.channelId) {
    return false;
  }
  if (filter.turnId && event.correlation.turnId !== filter.turnId) {
    return false;
  }
  if (filter.predicate && !filter.predicate(event)) {
    return false;
  }
  return true;
}
