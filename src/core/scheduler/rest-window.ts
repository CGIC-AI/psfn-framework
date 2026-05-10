import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';

export type RestWindowDenialReason =
  | 'outside_rest_window'
  | 'insufficient_inactivity';

export interface RestWindowEligibilityInput {
  config: EpisodicProcessingRestWindowConfig;
  nowMs?: number;
  lastUserActivityAtMs?: number | null;
}

export interface RestWindowEligibilityDecision {
  allowed: boolean;
  enabled: boolean;
  timeZone: string;
  nowMs: number;
  inactiveForMs?: number;
  requiredInactiveMs: number;
  nextEligibleAtMs?: number;
  reasonCode?: RestWindowDenialReason;
}

const MINUTE_MS = 60_000;

function parseLocalMinute(value: string): number {
  const [hourRaw, minuteRaw] = value.split(':');
  return Number(hourRaw) * 60 + Number(minuteRaw);
}

function resolveConfiguredTimeZone(timeZone: string): string {
  return timeZone === 'local' ? resolveActiveTimezone() : timeZone;
}

function getLocalMinuteOfDay(nowMs: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(nowMs))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return (Number(parts.hour) % 24) * 60 + Number(parts.minute);
}

function isMinuteInWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) {
    return true;
  }
  if (startMinute < endMinute) {
    return minuteOfDay >= startMinute && minuteOfDay < endMinute;
  }
  return minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

function isInRestWindow(
  nowMs: number,
  timeZone: string,
  startMinute: number,
  endMinute: number,
): boolean {
  return isMinuteInWindow(getLocalMinuteOfDay(nowMs, timeZone), startMinute, endMinute);
}

function findNextWindowTime(
  candidateMs: number,
  timeZone: string,
  startMinute: number,
  endMinute: number,
): number {
  if (isInRestWindow(candidateMs, timeZone, startMinute, endMinute)) {
    return candidateMs;
  }

  let cursor = Math.ceil(candidateMs / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i <= 24 * 60 + 1; i += 1) {
    if (isInRestWindow(cursor, timeZone, startMinute, endMinute)) {
      return cursor;
    }
    cursor += MINUTE_MS;
  }

  throw new Error('Unable to resolve next rest window within 24 hours');
}

export function evaluateRestWindowEligibility(
  input: RestWindowEligibilityInput,
): RestWindowEligibilityDecision {
  const nowMs = input.nowMs ?? Date.now();
  const timeZone = resolveConfiguredTimeZone(input.config.timeZone);
  const requiredInactiveMs = input.config.inactivityThresholdMinutes * MINUTE_MS;

  if (!input.config.enabled) {
    return {
      allowed: true,
      enabled: false,
      timeZone,
      nowMs,
      requiredInactiveMs,
    };
  }

  const startMinute = parseLocalMinute(input.config.startLocalTime);
  const endMinute = parseLocalMinute(input.config.endLocalTime);
  const inactiveForMs = typeof input.lastUserActivityAtMs === 'number'
    && Number.isFinite(input.lastUserActivityAtMs)
    ? Math.max(0, nowMs - input.lastUserActivityAtMs)
    : undefined;
  const inactivityReadyAtMs = inactiveForMs === undefined
    ? nowMs
    : Math.max(nowMs, input.lastUserActivityAtMs as number + requiredInactiveMs);
  const nextEligibleAtMs = findNextWindowTime(
    inactivityReadyAtMs,
    timeZone,
    startMinute,
    endMinute,
  );
  const insideWindow = isInRestWindow(nowMs, timeZone, startMinute, endMinute);
  const hasSufficientInactivity = inactiveForMs === undefined || inactiveForMs >= requiredInactiveMs;

  if (insideWindow && hasSufficientInactivity) {
    return {
      allowed: true,
      enabled: true,
      timeZone,
      nowMs,
      inactiveForMs,
      requiredInactiveMs,
    };
  }

  return {
    allowed: false,
    enabled: true,
    timeZone,
    nowMs,
    inactiveForMs,
    requiredInactiveMs,
    nextEligibleAtMs,
    reasonCode: insideWindow ? 'insufficient_inactivity' : 'outside_rest_window',
  };
}
