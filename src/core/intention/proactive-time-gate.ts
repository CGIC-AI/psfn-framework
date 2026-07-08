import { resolveActiveTimezone } from '../../shared/time/active-timezone.js';
import type { EpisodicProcessingRestWindowConfig } from '../../system/config/scheduler-config.js';

export type ProactiveQuietHoursConfig = Pick<
  EpisodicProcessingRestWindowConfig,
  'enabled' | 'startLocalTime' | 'endLocalTime' | 'timeZone'
>;

export type ProactiveOutboundTimeGateBlockReason =
  | 'before_time_gate'
  | 'quiet_hours';

export type ProactiveOutboundTimeGateDecision =
  | {
    allowed: true;
    sendAtMs: number;
    timeZone?: string;
  }
  | {
    allowed: false;
    reason: ProactiveOutboundTimeGateBlockReason;
    nextEligibleAtMs: number;
    timeZone?: string;
  };

export interface ProactiveOutboundTimeGateInput {
  nowMs?: number;
  earliestSendAtMs?: number;
  quietHours?: ProactiveQuietHoursConfig | null;
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

function isInQuietHours(
  nowMs: number,
  timeZone: string,
  startMinute: number,
  endMinute: number,
): boolean {
  return isMinuteInWindow(getLocalMinuteOfDay(nowMs, timeZone), startMinute, endMinute);
}

function resolveFirstAllowedOutsideQuietHours(
  candidateMs: number,
  timeZone: string,
  startMinute: number,
  endMinute: number,
): number {
  if (!isInQuietHours(candidateMs, timeZone, startMinute, endMinute)) {
    return candidateMs;
  }

  let cursor = Math.ceil(candidateMs / MINUTE_MS) * MINUTE_MS;
  for (let i = 0; i <= 24 * 60 + 1; i += 1) {
    if (!isInQuietHours(cursor, timeZone, startMinute, endMinute)) {
      return cursor;
    }
    cursor += MINUTE_MS;
  }

  throw new Error('Unable to resolve next proactive outbound quiet-hours boundary within 24 hours');
}

function normalizeFutureTime(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function evaluateProactiveOutboundTimeGate(
  input: ProactiveOutboundTimeGateInput,
): ProactiveOutboundTimeGateDecision {
  const nowMs = normalizeFutureTime(input.nowMs, Date.now());
  const earliestSendAtMs = normalizeFutureTime(input.earliestSendAtMs, nowMs);
  const quietHours = input.quietHours;
  const candidateMs = Math.max(nowMs, earliestSendAtMs);

  if (!quietHours?.enabled) {
    if (candidateMs > nowMs) {
      return {
        allowed: false,
        reason: 'before_time_gate',
        nextEligibleAtMs: candidateMs,
      };
    }
    return { allowed: true, sendAtMs: nowMs };
  }

  const timeZone = resolveConfiguredTimeZone(quietHours.timeZone);
  const startMinute = parseLocalMinute(quietHours.startLocalTime);
  const endMinute = parseLocalMinute(quietHours.endLocalTime);
  const nextAllowedMs = resolveFirstAllowedOutsideQuietHours(
    candidateMs,
    timeZone,
    startMinute,
    endMinute,
  );

  if (nextAllowedMs > nowMs) {
    return {
      allowed: false,
      reason: candidateMs > nowMs ? 'before_time_gate' : 'quiet_hours',
      nextEligibleAtMs: nextAllowedMs,
      timeZone,
    };
  }

  return {
    allowed: true,
    sendAtMs: nowMs,
    timeZone,
  };
}
