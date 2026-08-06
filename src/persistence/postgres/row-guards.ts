export { requireUuid } from '../../shared/utils/uuid.js';

type PostgresInteger = string | number;

function coerceSafeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseSafeInteger(value: PostgresInteger): number | null {
  return coerceSafeInteger(value);
}

export function requireSafeInteger(value: PostgresInteger, field: string): number {
  const parsed = coerceSafeInteger(value);
  if (parsed === null) throw new Error(`${field} must be a safe integer`);
  return parsed;
}

export function requireBackgroundWorkSafeInteger(value: unknown, field: string): number {
  const parsed = coerceSafeInteger(value);
  if (parsed === null || parsed < 0) {
    throw new Error(`Background work ${field} must be a non-negative safe integer`);
  }
  return parsed;
}

export function requirePartnerAffectSafeInteger(value: PostgresInteger, field: string): number {
  const parsed = coerceSafeInteger(value);
  if (parsed === null) {
    throw new Error(`Persisted partner-affect shadow row has non-integer ${field}: ${String(value)}`);
  }
  return parsed;
}

export function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

export function requireFleetAuthInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid fleet_auth ${field}`);
  }
  return parsed;
}
