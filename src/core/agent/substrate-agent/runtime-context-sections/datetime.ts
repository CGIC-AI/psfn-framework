// ── Datetime section producers (E2.6) ──
// Clock-derived prompt variables: the runtime_current_* group and the
// last-message-received group. Both producers take the turn clock as a
// declared input; the active timezone is process-level configuration read
// through the shared active-timezone helpers (same as every other formatter
// in the runtime).

import {
  formatActiveDate,
  formatActiveDateTimeIso,
  resolveActiveTimezone,
} from '../../../../shared/time/active-timezone.js';

function formatPromptRuntimeDateTime(now: Date): string {
  const timeZone = resolveActiveTimezone();
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

function formatPromptRuntimeDate(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(now);
}

function formatPromptRuntimeTime(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

export function formatPromptRuntimeTimeForTimezone(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(now);
}

export function normalizeRuntimeTimezone(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return undefined;
  }
}

function formatPromptRuntimeRelativeDate(now: Date, dayOffset: number): string {
  const [yearText, monthText, dayText] = formatActiveDate(now).split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return formatActiveDate(now);
  }
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return shifted.toISOString().slice(0, 10);
}

function formatPromptRuntimePartOfDay(now: Date): string {
  const hourPart = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    hour: 'numeric',
    hour12: false,
  }).formatToParts(now).find(part => part.type === 'hour')?.value;
  const parsedHour = Number(hourPart);
  if (!Number.isFinite(parsedHour)) return '';
  const hour = parsedHour % 24;
  if (hour < 5) return 'overnight';
  if (hour < 9) return 'morning';
  if (hour < 12) return 'late morning';
  if (hour < 15) return 'early afternoon';
  if (hour < 18) return 'late afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function formatPromptRuntimeWeekday(now: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: resolveActiveTimezone(),
    weekday: 'long',
  }).format(now);
}

function formatRelativeElapsed(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const deltaMinutes = Math.floor(deltaMs / 60_000);
  if (deltaMinutes < 1) return 'just now';
  if (deltaMinutes < 60) return `${deltaMinutes} minute${deltaMinutes === 1 ? '' : 's'} ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours} hour${deltaHours === 1 ? '' : 's'} ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays} day${deltaDays === 1 ? '' : 's'} ago`;
}

function formatElapsedDaysHours(now: Date, then: Date): string {
  const deltaMs = Math.max(0, now.getTime() - then.getTime());
  const totalHours = Math.floor(deltaMs / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0 && hours > 0) {
    return `${days} day${days === 1 ? '' : 's'} ${hours} hour${hours === 1 ? '' : 's'}`;
  }
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}`;
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.max(1, Math.floor(deltaMs / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

/**
 * The runtime_current_* clock group for one turn.
 *
 * NOTE: active_timezone is intentionally NOT produced here. It is owned by
 * buildPromptTemplateVariables (session phase); writing it again here would be
 * a duplicate write in the turn prompt variable namespace (fail closed).
 */
export function buildCurrentDatetimePromptVariables(now: Date): Record<string, string> {
  return {
    runtime_current_datetime_human: formatPromptRuntimeDateTime(now),
    runtime_current_datetime_iso: formatActiveDateTimeIso(now),
    runtime_current_weekday: formatPromptRuntimeWeekday(now),
    runtime_current_date_human: formatPromptRuntimeDate(now),
    runtime_current_time_human: formatPromptRuntimeTime(now),
    runtime_current_today: formatPromptRuntimeRelativeDate(now, 0),
    runtime_current_yesterday: formatPromptRuntimeRelativeDate(now, -1),
    runtime_current_tomorrow: formatPromptRuntimeRelativeDate(now, 1),
    runtime_current_part_of_day: formatPromptRuntimePartOfDay(now),
  };
}

export function buildLastMessagePromptVariables(input: {
  now: Date;
  lastMessageReceivedAtMs?: number | null;
}): Record<string, string> {
  const { now } = input;
  const lastMessageReceivedAt = (
    typeof input.lastMessageReceivedAtMs === 'number' && Number.isFinite(input.lastMessageReceivedAtMs)
  )
    ? new Date(input.lastMessageReceivedAtMs)
    : null;
  // A finite but out-of-range millisecond value (|ms| > 8.64e15) constructs an
  // Invalid Date, whose toISOString() throws in formatActiveDateTimeIso — treat
  // it as missing instead of crashing prompt assembly.
  if (!lastMessageReceivedAt || !Number.isFinite(lastMessageReceivedAt.getTime())) {
    return {
      runtime_last_message_received_present: 'false',
      runtime_last_message_received_missing: 'true',
      runtime_last_message_received_at_iso: '',
      runtime_last_message_received_weekday: '',
      runtime_last_message_received_date_human: '',
      runtime_last_message_received_time_human: '',
      runtime_last_message_received_timezone: '',
      runtime_last_message_received_ago: '',
      runtime_last_message_received_days_hours: '',
    };
  }

  const activeTimezone = resolveActiveTimezone();
  const relativeElapsed = formatRelativeElapsed(now, lastMessageReceivedAt);
  return {
    runtime_last_message_received_present: 'true',
    runtime_last_message_received_missing: 'false',
    runtime_last_message_received_at_iso: formatActiveDateTimeIso(lastMessageReceivedAt),
    runtime_last_message_received_weekday: formatPromptRuntimeWeekday(lastMessageReceivedAt),
    runtime_last_message_received_date_human: formatPromptRuntimeDate(lastMessageReceivedAt),
    runtime_last_message_received_time_human: formatPromptRuntimeTime(lastMessageReceivedAt),
    runtime_last_message_received_timezone: activeTimezone,
    runtime_last_message_received_ago: relativeElapsed,
    runtime_last_message_received_days_hours: formatElapsedDaysHours(now, lastMessageReceivedAt),
  };
}
