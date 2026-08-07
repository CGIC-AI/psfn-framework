import { assertPositiveInteger } from '../validators.js';

export function toInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1_000) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 1000`);
  }
  return value;
}

export function toPositiveInteger(value: unknown, field: string, minimum: number): number {
  return assertPositiveInteger(value, field, {
    min: minimum,
    message: ({ fieldLabel, min }) => `Invalid scheduler config: ${fieldLabel} must be an integer >= ${min}`,
  });
}

export function toBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid scheduler config: ${field} must be true or false`);
  }
  return value;
}

export function toNumberAtLeast(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new Error(`Invalid scheduler config: ${field} must be a finite number >= ${minimum}`);
  }
  return value;
}

export function toUnitFactor(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a number in [0, 1]`);
  }
  return value;
}

/**
 * A dampening factor multiplied against a decayed weight. The valid range is the
 * half-open interval (0, 1]: a factor of 0 would hard-zero the weight on the
 * first application, silently disabling the mechanism and contradicting the
 * charter invariant that dampening "reduces weight rather than zeroing it out"
 * (Law 27 / 6.24). Fail closed — reject 0 and out-of-range rather than clamp.
 */
export function toPositiveUnitFactor(value: unknown, field: string): number {
  const factor = toUnitFactor(value, field);
  if (!(factor > 0)) {
    throw new Error(
      `Invalid scheduler config: ${field} must be in (0, 1] — a factor of 0 hard-zeroes the weighted thought, disabling the dampening mechanism against Charter Law 27; use a small positive value to dampen without zeroing`,
    );
  }
  return factor;
}

export function toLocalTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid scheduler config: ${field} must be HH:mm local time`);
  }
  const trimmed = value.trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    throw new Error(`Invalid scheduler config: ${field} must be HH:mm local time`);
  }
  return trimmed;
}

export function toTimeZone(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  if (trimmed === 'local') {
    return trimmed;
  }
  try {
    void new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date());
  } catch {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or a valid IANA time zone`);
  }
  return trimmed;
}

export function toUnitInterval(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Invalid scheduler config: ${field} must be a number between 0 and 1`);
  }
  return value;
}

export function toCadenceTimezone(value: unknown, field: string): 'local' | 'utc' {
  if (value !== 'local' && value !== 'utc') {
    throw new Error(`Invalid scheduler config: ${field} must be "local" or "utc"`);
  }
  return value;
}

export function toWakeTimingMode(value: unknown, field: string): 'fixed' | 'habit' {
  if (value !== 'fixed' && value !== 'habit') {
    throw new Error(`Invalid scheduler config: ${field} must be "fixed" or "habit"`);
  }
  return value;
}

export function toHourOfDay(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer between 0 and 23`);
  }
  return value;
}

export function toPositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a number greater than 0`);
  }
  return value;
}

export function toNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid scheduler config: ${field} must be a non-empty string`);
  }
  return value;
}

export function toNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid scheduler config: ${field} must be an integer >= 0`);
  }
  return value;
}
