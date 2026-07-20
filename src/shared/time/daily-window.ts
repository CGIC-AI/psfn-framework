import { resolveActiveTimezone } from './active-timezone.js';

export function parseLocalMinute(value: string): number {
  const [hourRaw, minuteRaw] = value.split(':');
  return Number(hourRaw) * 60 + Number(minuteRaw);
}

export function resolveConfiguredTimeZone(timeZone: string): string {
  return timeZone === 'local' ? resolveActiveTimezone() : timeZone;
}

export function getLocalMinuteOfDay(nowMs: number, timeZone: string): number {
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

export function isMinuteInWindow(
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
