export type LaneStatusView = {
  runtimeClass: string;
  chargeLane: string;
  saturated: boolean;
  queueDepth: number;
  maxQueuedActions: number;
  readyCount: number;
  retryScheduledCount: number;
  droppedCount: number;
  nextRunAt?: number;
};

const DURATION_UNITS = [
  { max: 1_000, divisor: 1, suffix: 'ms' },
  { max: 60_000, divisor: 1_000, suffix: 's' },
  { max: 3_600_000, divisor: 60_000, suffix: 'm' },
  { max: Number.POSITIVE_INFINITY, divisor: 3_600_000, suffix: 'h' },
] as const;

export function formatTime(timestamp: number | undefined): string {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '-';
  const boundedMs = Math.max(0, ms);
  const unit = DURATION_UNITS.find((candidate) => boundedMs < candidate.max) ?? DURATION_UNITS.at(-1)!;
  return `${Math.round(boundedMs / unit.divisor)}${unit.suffix}`;
}

export function shortRef(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

const DEFAULT_STATE_CLASS = 'border-leaf-300 bg-leaf-50 text-leaf-800';
const STATE_CLASS_BY_STATE: Record<string, string> = {
  ready: 'border-gold-300 bg-gold-50 text-gold-800',
  running: 'border-gold-300 bg-gold-50 text-gold-800',
  scheduled: 'border-petal-300 bg-petal-50 text-petal-800',
  retry_scheduled: 'border-petal-300 bg-petal-50 text-petal-800',
  queued: 'border-gold-300 bg-gold-50 text-gold-800',
  sent: 'border-leaf-300 bg-leaf-50 text-leaf-700',
  blocked: 'border-wilt-300 bg-wilt-50 text-wilt-700',
  failed: 'border-wilt-300 bg-wilt-50 text-wilt-700',
  skipped: 'border-bark-300 bg-bark-100 text-shadow-700',
  cancelled: 'border-bark-300 bg-bark-100 text-shadow-700',
  acknowledged: 'border-bark-300 bg-bark-100 text-shadow-700',
};

export function stateClass(state: string): string {
  return STATE_CLASS_BY_STATE[state] ?? DEFAULT_STATE_CLASS;
}

/** Loose history record read: returns the trimmed string at `key` when present. */
export function stringRecordProperty(record: unknown, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function recordSummary(record: unknown): string {
  return stringRecordProperty(record, 'error')
    ?? stringRecordProperty(record, 'detail')
    ?? stringRecordProperty(record, 'reason')
    ?? 'No detail recorded.';
}
