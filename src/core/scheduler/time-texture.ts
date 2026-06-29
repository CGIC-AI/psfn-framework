import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';

export type IdleGapTextureKind =
  | 'short_gap'
  | 'long_workday'
  | 'overnight'
  | 'multiple_days';

export type ReconnectionWarmthSignal = 'low' | 'medium' | 'high';

export interface IdleGapTexture {
  kind: IdleGapTextureKind;
  label: string;
  elapsedMs: number;
  dayBoundaryCount: number;
  reconnectionWarmth: ReconnectionWarmthSignal;
  guidance: string;
}

export interface ClassifyIdleGapTextureInput {
  lastActivityAtMs: number;
  observedAtMs?: number;
  timeZone?: string;
}

const HOUR_MS = 60 * 60_000;
const LONG_WORKDAY_MIN_MS = 6 * HOUR_MS;
const MULTIPLE_DAYS_MIN_MS = 36 * HOUR_MS;
const RECONNECTION_GUIDANCE = 'Use this as continuity pacing only; do not treat it as a requirement to perform affection or claim a feeling.';

function normalizeTimestamp(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.floor(value);
}

function localDateKey(timestampMs: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestampMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localDateBoundaryCount(lastActivityAtMs: number, observedAtMs: number, timeZone: string): number {
  if (observedAtMs <= lastActivityAtMs) return 0;
  const startKey = localDateKey(lastActivityAtMs, timeZone);
  const endKey = localDateKey(observedAtMs, timeZone);
  if (startKey === endKey) return 0;

  let cursor = lastActivityAtMs;
  let count = 0;
  let previousKey = startKey;
  while (cursor < observedAtMs) {
    cursor = Math.min(observedAtMs, cursor + HOUR_MS);
    const nextKey = localDateKey(cursor, timeZone);
    if (nextKey !== previousKey) {
      count += 1;
      previousKey = nextKey;
    }
  }
  return count;
}

export function classifyIdleGapTexture(input: ClassifyIdleGapTextureInput): IdleGapTexture {
  const observedAtMs = normalizeTimestamp(input.observedAtMs, Date.now());
  const lastActivityAtMs = normalizeTimestamp(input.lastActivityAtMs, observedAtMs);
  const elapsedMs = Math.max(0, observedAtMs - lastActivityAtMs);
  const timeZone = input.timeZone?.trim() || resolveActiveTimezone();
  const dayBoundaryCount = localDateBoundaryCount(lastActivityAtMs, observedAtMs, timeZone);

  if (elapsedMs >= MULTIPLE_DAYS_MIN_MS || dayBoundaryCount >= 2) {
    return {
      kind: 'multiple_days',
      label: 'multiple days away',
      elapsedMs,
      dayBoundaryCount,
      reconnectionWarmth: 'high',
      guidance: RECONNECTION_GUIDANCE,
    };
  }

  if (dayBoundaryCount >= 1 && elapsedMs >= LONG_WORKDAY_MIN_MS) {
    return {
      kind: 'overnight',
      label: 'overnight gap',
      elapsedMs,
      dayBoundaryCount,
      reconnectionWarmth: 'medium',
      guidance: RECONNECTION_GUIDANCE,
    };
  }

  if (elapsedMs >= LONG_WORKDAY_MIN_MS) {
    return {
      kind: 'long_workday',
      label: 'long workday gap',
      elapsedMs,
      dayBoundaryCount,
      reconnectionWarmth: 'medium',
      guidance: RECONNECTION_GUIDANCE,
    };
  }

  return {
    kind: 'short_gap',
    label: 'short gap',
    elapsedMs,
    dayBoundaryCount,
    reconnectionWarmth: 'low',
    guidance: RECONNECTION_GUIDANCE,
  };
}
