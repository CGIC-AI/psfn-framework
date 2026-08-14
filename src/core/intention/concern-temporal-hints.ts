import {
  resolveActiveTimezone,
  zonedWallClockParts,
  zonedWallClockToEpoch,
  type ZonedWallClockParts,
} from '../../shared/time/active-timezone.js';

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};
const HOUR_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const EXPLICIT_TEMPORAL_DIRECTIVE_PATTERN = /\b(?:remind(?:\s+me)?|tell\s+me|make\s+sure|do\s+not\s+let\s+me\s+forget|don['’]?t\s+let\s+me\s+forget|follow\s+up|check\s+in|appointment|deadline|due)\b/i;
const NEGATED_TEMPORAL_DIRECTIVE_PATTERN = /\b(?:do\s+not|don['’]?t|never)\s+(?:remind|tell|follow\s+up|check\s+in|schedule)\b/i;
const TEMPORAL_REFERENCE_PATTERN = /(?:\b(?:today|tomorrow|next\s+week|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b|\b\d{4}-\d{2}-\d{2}\b|\bat\s+(?:\d{1,2}(?::\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)/i;

export type ConcernTemporalResolution =
  | {
    status: 'resolved';
    dueAt: string;
    timeZone: string;
  }
  | {
    status: 'needs_clarification';
    reason: 'unresolved_or_past';
    timeZone: string;
  };

export function isExplicitTemporalConcernRequest(text: string): boolean {
  return !NEGATED_TEMPORAL_DIRECTIVE_PATTERN.test(text)
    && EXPLICIT_TEMPORAL_DIRECTIVE_PATTERN.test(text)
    && TEMPORAL_REFERENCE_PATTERN.test(text);
}

export function resolveConcernTemporalHint(
  text: string,
  createdAt: string,
  timeZone = resolveActiveTimezone(),
): ConcernTemporalResolution | undefined {
  if (!isExplicitTemporalConcernRequest(text)) return undefined;
  const dueAt = deriveConcernDueAtHint(text, createdAt, timeZone);
  return dueAt
    ? { status: 'resolved', dueAt, timeZone }
    : { status: 'needs_clarification', reason: 'unresolved_or_past', timeZone };
}

export function deriveConcernDueAtHint(
  text: string,
  createdAt: string,
  timeZone = resolveActiveTimezone(),
): string | undefined {
  const createdAtMs = Date.parse(createdAt);
  if (!Number.isFinite(createdAtMs)) return undefined;
  const normalized = text.toLowerCase().replace(/[’]/g, "'");
  if (NEGATED_TEMPORAL_DIRECTIVE_PATTERN.test(normalized)) return undefined;
  const nowParts = zonedWallClockParts(createdAtMs, timeZone);
  const date = resolveTargetDate(normalized, nowParts);
  const clockCandidates = resolveClockCandidates(normalized, nowParts);
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(normalized) && !date) return undefined;
  if (/\bat\s+(?:\d{1,2}(?::\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/.test(normalized)
    && clockCandidates.length === 0) {
    return undefined;
  }

  if (!date && clockCandidates.length === 0) {
    return undefined;
  }

  const targetDate = date ?? calendarDateShift(nowParts, 0);
  const clocks = clockCandidates.length > 0
    ? clockCandidates
    : [{ hour: nowParts.hour, minute: nowParts.minute }];
  const candidates = clocks
    .map(clock => zonedWallClockToEpoch(
      timeZone,
      targetDate.year,
      targetDate.month,
      targetDate.day,
      clock.hour,
      clock.minute,
    ))
    .filter(epoch => epoch > createdAtMs)
    .sort((left, right) => left - right);
  if (candidates[0] !== undefined) {
    return new Date(candidates[0]).toISOString();
  }

  if (date && !hasExplicitCalendarDate(normalized) && resolveWeekdayIndex(normalized) !== null) {
    const nextWeek = calendarDateShift(nowParts, 7);
    const nextWeekCandidates = clocks
      .map(clock => zonedWallClockToEpoch(
        timeZone,
        nextWeek.year,
        nextWeek.month,
        nextWeek.day,
        clock.hour,
        clock.minute,
      ))
      .sort((left, right) => left - right);
    return nextWeekCandidates[0] === undefined
      ? undefined
      : new Date(nextWeekCandidates[0]).toISOString();
  }

  if (!date && clockCandidates.length > 0) {
    const tomorrow = calendarDateShift(nowParts, 1);
    const tomorrowCandidates = clocks
      .map(clock => zonedWallClockToEpoch(
        timeZone,
        tomorrow.year,
        tomorrow.month,
        tomorrow.day,
        clock.hour,
        clock.minute,
      ))
      .sort((left, right) => left - right);
    return tomorrowCandidates[0] === undefined
      ? undefined
      : new Date(tomorrowCandidates[0]).toISOString();
  }
  return undefined;
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ClockTime {
  hour: number;
  minute: number;
}

function resolveTargetDate(text: string, now: ZonedWallClockParts): CalendarDate | null {
  const isoMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCFullYear() === year
      && check.getUTCMonth() === month - 1
      && check.getUTCDate() === day) {
      return { year, month, day };
    }
    return null;
  }
  if (/\btomorrow\b/.test(text)) return calendarDateShift(now, 1);
  if (/\bnext\s+week\b/.test(text)) return calendarDateShift(now, 7);
  if (/\btoday\b/.test(text)) return calendarDateShift(now, 0);

  const targetWeekday = resolveWeekdayIndex(text);
  if (targetWeekday === null) return null;
  const daysAhead = (targetWeekday - now.weekday + 7) % 7;
  return calendarDateShift(now, daysAhead);
}

function resolveClockCandidates(text: string, now: ZonedWallClockParts): ClockTime[] {
  const match = /\bat\s+(?:(\d{1,2})(?::(\d{2}))?|(?:\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b)(?:\s+o['’]?clock)?)\s*(a\.?m\.?|p\.?m\.?)?/i.exec(text);
  if (!match) return [];
  const rawHour = match[1] ? Number(match[1]) : HOUR_WORDS[match[3]?.toLowerCase() ?? ''];
  const minute = match[2] ? Number(match[2]) : 0;
  if (rawHour === undefined || minute < 0 || minute > 59) return [];
  const meridiem = match[4]?.toLowerCase().replaceAll('.', '');
  if (meridiem) {
    if (rawHour < 1 || rawHour > 12) return [];
    const hour = meridiem === 'pm' ? (rawHour % 12) + 12 : rawHour % 12;
    return [{ hour, minute }];
  }
  if (rawHour > 23) return [];
  if (rawHour === 0 || rawHour > 12) return [{ hour: rawHour, minute }];

  const first = { hour: rawHour, minute };
  const second = { hour: rawHour + 12, minute };
  const nowMinute = now.hour * 60 + now.minute;
  return [first, second].sort((left, right) => {
    const leftFuture = left.hour * 60 + left.minute > nowMinute ? 0 : 1;
    const rightFuture = right.hour * 60 + right.minute > nowMinute ? 0 : 1;
    return leftFuture - rightFuture || left.hour - right.hour || left.minute - right.minute;
  });
}

function calendarDateShift(now: ZonedWallClockParts, days: number): CalendarDate {
  const shifted = new Date(Date.UTC(now.year, now.month - 1, now.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function resolveWeekdayIndex(text: string): number | null {
  const weekdayMatch = /\b(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/.exec(text);
  if (!weekdayMatch) return null;
  return WEEKDAY_INDEX[weekdayMatch[1] ?? ''] ?? null;
}

function hasExplicitCalendarDate(text: string): boolean {
  return /\b\d{4}-\d{2}-\d{2}\b|\btoday\b|\btomorrow\b|\bnext\s+week\b/.test(text);
}
