const DEFAULT_ACTIVE_TIMEZONE = 'America/New_York';

function normalizeOffset(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'Z') return '+00:00';
  const normalized = trimmed.replace(/^GMT/i, '');
  const match = normalized.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) {
    throw new Error(`Unsupported timezone offset format "${raw}"`);
  }
  const [, sign, hoursRaw, minutesRaw] = match;
  const hours = hoursRaw.padStart(2, '0');
  const minutes = (minutesRaw ?? '00').padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

function resolveFormatterParts(now: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return parts;
}

function resolveOffset(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const zonePart = formatter
    .formatToParts(now)
    .find((part) => part.type === 'timeZoneName')
    ?.value;

  return normalizeOffset(zonePart?.replace('UTC', 'GMT') ?? 'GMT');
}

export function resolveActiveTimezone(): string {
  return process.env.TZ?.trim() || DEFAULT_ACTIVE_TIMEZONE;
}

export function validateActiveTimezone(timeZone: string): void {
  // Intl throws RangeError on invalid IANA names.
  // This call is also cheap enough to reuse in startup paths.
  void new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
}

export function ensureActiveTimezone(): string {
  const timeZone = resolveActiveTimezone();
  validateActiveTimezone(timeZone);
  process.env.TZ = timeZone;
  return timeZone;
}

export function formatActiveDateTimeIso(now: Date): string {
  const timeZone = resolveActiveTimezone();
  const parts = resolveFormatterParts(now, timeZone);
  const offset = resolveOffset(now, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${String(now.getUTCMilliseconds()).padStart(3, '0')}${offset}`;
}

export function formatActiveDate(now: Date): string {
  const parts = resolveFormatterParts(now, resolveActiveTimezone());
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatActiveTime(now: Date): string {
  const parts = resolveFormatterParts(now, resolveActiveTimezone());
  const offset = resolveOffset(now, resolveActiveTimezone());
  return `${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

export function formatActiveDateTimeCompact(now: Date): string {
  const parts = resolveFormatterParts(now, resolveActiveTimezone());
  const shortYear = parts.year.slice(-2);
  return `${parts.month}-${parts.day}-${shortYear} ${parts.hour}:${parts.minute}`;
}

export function formatActiveDateTimeLabel(now: Date): string {
  return `${formatActiveDateTimeCompact(now)} ${resolveActiveTimezone()}`;
}
