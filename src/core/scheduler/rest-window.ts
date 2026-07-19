import {
  getLocalMinuteOfDay,
  isMinuteInWindow,
  parseLocalMinute,
  resolveConfiguredTimeZone,
} from '../../shared/time/daily-window.js';
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
