import {
  getLocalMinuteOfDay,
  isMinuteInWindow,
  parseLocalMinute,
  resolveConfiguredTimeZone,
} from '../../shared/time/daily-window.js';
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
  /**
   * IANA timezone of the outbound recipient (Contact.timezone). When present
   * and valid, quiet-hours are evaluated in the recipient's local time — "don't
   * message people who are sleeping" holds across timezones. Fail-closed: an
   * absent, empty, or unrecognized zone falls back to the global window's zone
   * and never throws mid-gate.
   */
  contactTimeZone?: string | null;
}

const MINUTE_MS = 60_000;

function isValidTimeZone(timeZone: string): boolean {
  try {
    // Constructing a formatter throws RangeError on an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Quiet-hours evaluation zone: the recipient's Contact.timezone when it is a
 * valid IANA zone, else the configured global window zone. Never throws — an
 * invalid contact zone degrades to the global window rather than blocking or
 * crashing the gate.
 */
function resolveQuietHoursTimeZone(
  configuredTimeZone: string,
  contactTimeZone: string | null | undefined,
): string {
  if (
    typeof contactTimeZone === 'string'
    && contactTimeZone.trim() !== ''
    && isValidTimeZone(contactTimeZone)
  ) {
    return contactTimeZone;
  }
  return resolveConfiguredTimeZone(configuredTimeZone);
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

  const timeZone = resolveQuietHoursTimeZone(quietHours.timeZone, input.contactTimeZone);
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
