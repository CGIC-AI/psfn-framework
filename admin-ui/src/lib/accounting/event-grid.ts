import type {
  ModelUsageEvent,
  ModelUsageSortDirection,
} from '../../../../src/shared/telemetry/model-usage.js';

export type UsageEventSortKey =
  | 'when'
  | 'model'
  | 'purpose'
  | 'tool'
  | 'inputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'effectiveCost'
  | 'duration';

export interface UsageEventSort {
  key: UsageEventSortKey;
  direction: ModelUsageSortDirection;
}

type SortValue = number | string | undefined;

function searchableValues(event: ModelUsageEvent): string[] {
  return [
    `${event.provider}:${event.model}`,
    event.attribution.purpose,
    event.attribution.callType,
    event.attribution.toolName,
    event.attribution.sessionId,
    event.attribution.channelId,
    event.attribution.chargeRunId,
    event.errorCode ?? '',
    event.errorMessage ?? '',
  ];
}

export function filterUsageEvents(
  events: readonly ModelUsageEvent[],
  query: string,
): ModelUsageEvent[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return [...events];

  return events.filter(event => searchableValues(event).some(value => (
    value.toLocaleLowerCase().includes(normalizedQuery)
  )));
}

function sortValue(event: ModelUsageEvent, key: UsageEventSortKey): SortValue {
  switch (key) {
    case 'when': return event.recordedAtMs;
    case 'model': return `${event.provider}:${event.model}`;
    case 'purpose': return event.attribution.purpose;
    case 'tool': return event.attribution.toolName;
    case 'inputTokens': return event.inputTokens;
    case 'cacheReadTokens': return event.cacheReadTokens;
    case 'cacheWriteTokens': return event.cacheWriteTokens;
    case 'outputTokens': return event.outputTokens;
    case 'totalTokens': return event.totalTokens;
    case 'effectiveCost': return event.effectiveCost.total;
    case 'duration': return event.durationMs;
  }
}

function isUnknown(value: SortValue): value is undefined {
  return value === undefined || (typeof value === 'number' && !Number.isFinite(value));
}

function compareDefined(left: number | string, right: number | string): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base' });
}

export function sortUsageEvents(
  events: readonly ModelUsageEvent[],
  sort: UsageEventSort | null,
): ModelUsageEvent[] {
  if (!sort) return [...events];

  return events
    .map((event, baseIndex) => ({ event, baseIndex }))
    .sort((left, right) => {
      const leftValue = sortValue(left.event, sort.key);
      const rightValue = sortValue(right.event, sort.key);
      const leftUnknown = isUnknown(leftValue);
      const rightUnknown = isUnknown(rightValue);

      if (leftUnknown || rightUnknown) {
        if (leftUnknown !== rightUnknown) return leftUnknown ? 1 : -1;
        return left.baseIndex - right.baseIndex;
      }

      const comparison = compareDefined(leftValue, rightValue);
      return comparison === 0
        ? left.baseIndex - right.baseIndex
        : comparison * (sort.direction === 'asc' ? 1 : -1);
    })
    .map(({ event }) => event);
}

export function toggleUsageEventSort(
  current: UsageEventSort | null,
  key: UsageEventSortKey,
): UsageEventSort {
  return {
    key,
    direction: current?.key === key && current.direction === 'desc' ? 'asc' : 'desc',
  };
}
