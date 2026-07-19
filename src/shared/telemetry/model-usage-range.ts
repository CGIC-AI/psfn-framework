import type {
  ModelUsageBucket,
  ModelUsagePeriodComparison,
  ModelUsageQuery,
  ModelUsageRange,
  ModelUsageResolvedRange,
  ResolvedModelUsageBucket,
} from './model-usage.js';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MAX_CUSTOM_RANGE_MS = 367 * DAY_MS;
const MAX_BUCKET_COUNT = 2_000;
const DEFAULT_TIMEZONE = 'UTC';
const DATE_SEARCH_RADIUS_MS = 36 * HOUR_MS;

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

export interface ResolveModelUsageRangeOptions {
  nowMs: number;
  allSinceMs?: number;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dateFormatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  dateFormatterCache.set(timezone, formatter);
  return formatter;
}

function normalizeTimezone(value: unknown): string {
  if (value === undefined) return DEFAULT_TIMEZONE;
  if (typeof value !== 'string') throw new Error('timezone must be an IANA timezone string');
  const timezone = value.trim();
  if (!timezone || timezone.length > 128 || /[\u0000-\u001F\u007F-\u009F]/u.test(timezone)) {
    throw new Error('timezone must be a valid IANA timezone');
  }
  try {
    dateFormatter(timezone).format(0);
  } catch {
    throw new Error(`timezone ${JSON.stringify(timezone)} is not a valid IANA timezone`);
  }
  return timezone;
}

function calendarDate(timestampMs: number, timezone: string): CalendarDate {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of dateFormatter(timezone).formatToParts(timestampMs)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = Number(part.value);
    }
  }
  if (!values.year || !values.month || !values.day) {
    throw new Error(`Unable to resolve calendar date in timezone ${JSON.stringify(timezone)}`);
  }
  return { year: values.year, month: values.month, day: values.day };
}

function dateKey(date: CalendarDate): number {
  return (date.year * 10_000) + (date.month * 100) + date.day;
}

/** Finds the first real instant belonging to a local calendar day, including DST transition days. */
function startOfCalendarDate(date: CalendarDate, timezone: string): number {
  const approximate = Date.UTC(date.year, date.month - 1, date.day);
  let low = approximate - DATE_SEARCH_RADIUS_MS;
  let high = approximate + DATE_SEARCH_RADIUS_MS;
  const target = dateKey(date);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateKey(calendarDate(middle, timezone)) < target) low = middle + 1;
    else high = middle;
  }
  if (dateKey(calendarDate(low, timezone)) !== target) {
    throw new Error(`Calendar date ${target} does not exist in timezone ${JSON.stringify(timezone)}`);
  }
  return low;
}

function shiftCalendarDate(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function startOfWeek(date: CalendarDate): CalendarDate {
  const dayOfWeek = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return shiftCalendarDate(date, -(dayOfWeek === 0 ? 6 : dayOfWeek - 1));
}

function calendarRangeStart(range: Exclude<ModelUsageRange, 'all' | 'custom'>, now: CalendarDate): CalendarDate {
  switch (range) {
    case 'today': return now;
    case 'week': return startOfWeek(now);
    case 'month': return { ...now, day: 1 };
    case 'quarter': return { year: now.year, month: Math.floor((now.month - 1) / 3) * 3 + 1, day: 1 };
    case 'year': return { year: now.year, month: 1, day: 1 };
  }
}

function resolveAutoBucket(durationMs: number): ResolvedModelUsageBucket {
  if (durationMs <= 3 * DAY_MS) return 'hour';
  if (durationMs <= 180 * DAY_MS) return 'day';
  if (durationMs <= 3 * 366 * DAY_MS) return 'week';
  return 'month';
}

function normalizeTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function resolveRangeName(query: ModelUsageQuery): ModelUsageRange {
  if (query.range !== undefined) return query.range;
  return query.sinceMs !== undefined || query.untilMs !== undefined ? 'custom' : 'all';
}

export function resolveModelUsageRange(
  query: ModelUsageQuery,
  options: ResolveModelUsageRangeOptions,
): ModelUsageResolvedRange {
  const nowMs = normalizeTimestamp(options.nowMs, 'nowMs');
  const timezone = normalizeTimezone(query.timezone);
  const range = resolveRangeName(query);
  let sinceMs: number;
  let untilMs: number;

  if (range === 'custom') {
    if (query.sinceMs === undefined || query.untilMs === undefined) {
      throw new Error('custom range requires sinceMs and untilMs');
    }
    sinceMs = normalizeTimestamp(query.sinceMs, 'sinceMs');
    untilMs = normalizeTimestamp(query.untilMs, 'untilMs');
    if (sinceMs >= untilMs) throw new Error('sinceMs must be less than untilMs');
    if (untilMs - sinceMs > MAX_CUSTOM_RANGE_MS) {
      throw new Error('custom range must span at most 367 days');
    }
  } else {
    if (query.sinceMs !== undefined || query.untilMs !== undefined) {
      throw new Error(`${range} range cannot include sinceMs or untilMs`);
    }
    untilMs = nowMs + 1;
    if (!Number.isSafeInteger(untilMs)) throw new Error('nowMs is too large to resolve a query range');
    if (range === 'all') {
      sinceMs = options.allSinceMs === undefined
        ? nowMs
        : normalizeTimestamp(options.allSinceMs, 'allSinceMs');
      sinceMs = Math.min(sinceMs, nowMs);
    } else {
      sinceMs = startOfCalendarDate(calendarRangeStart(range, calendarDate(nowMs, timezone)), timezone);
    }
  }

  const requestedBucket: ModelUsageBucket = query.bucket ?? 'auto';
  const bucket = requestedBucket === 'auto'
    ? resolveAutoBucket(untilMs - sinceMs)
    : requestedBucket;
  const resolved: ModelUsageResolvedRange = {
    range,
    timezone,
    sinceMs,
    untilMs,
    bucket,
    boundary: '[sinceMs, untilMs)',
    calendarWeekStartsOn: 'monday',
  };
  createModelUsageBucketBoundaries(resolved);
  return resolved;
}

export function resolvePreviousModelUsagePeriod(
  range: ModelUsageResolvedRange,
): Pick<ModelUsagePeriodComparison, 'sinceMs' | 'untilMs'> | undefined {
  if (range.range === 'all') return undefined;
  const durationMs = range.untilMs - range.sinceMs;
  return {
    sinceMs: range.sinceMs - durationMs,
    untilMs: range.sinceMs,
  };
}

function bucketStart(timestampMs: number, bucket: ResolvedModelUsageBucket, timezone: string): number {
  if (bucket === 'hour') return Math.floor(timestampMs / HOUR_MS) * HOUR_MS;
  const date = calendarDate(timestampMs, timezone);
  if (bucket === 'day') return startOfCalendarDate(date, timezone);
  if (bucket === 'week') return startOfCalendarDate(startOfWeek(date), timezone);
  return startOfCalendarDate({ year: date.year, month: date.month, day: 1 }, timezone);
}

function nextBucket(startMs: number, bucket: ResolvedModelUsageBucket, timezone: string): number {
  if (bucket === 'hour') return startMs + HOUR_MS;
  const date = calendarDate(startMs, timezone);
  if (bucket === 'day') return startOfCalendarDate(shiftCalendarDate(date, 1), timezone);
  if (bucket === 'week') return startOfCalendarDate(shiftCalendarDate(date, 7), timezone);
  const nextMonth = new Date(Date.UTC(date.year, date.month, 1));
  return startOfCalendarDate({
    year: nextMonth.getUTCFullYear(),
    month: nextMonth.getUTCMonth() + 1,
    day: 1,
  }, timezone);
}

export function createModelUsageBucketBoundaries(
  range: ModelUsageResolvedRange,
): Array<{ startMs: number; endMs: number }> {
  const boundaries: Array<{ startMs: number; endMs: number }> = [];
  let startMs = bucketStart(range.sinceMs, range.bucket, range.timezone);
  while (startMs < range.untilMs) {
    if (boundaries.length >= MAX_BUCKET_COUNT) {
      throw new Error(`Requested ${range.bucket} bucket produces too many time buckets`);
    }
    const nextMs = nextBucket(startMs, range.bucket, range.timezone);
    if (nextMs <= startMs) throw new Error('Unable to advance model usage time bucket');
    boundaries.push({ startMs, endMs: Math.min(nextMs, range.untilMs) });
    startMs = nextMs;
  }
  return boundaries;
}
