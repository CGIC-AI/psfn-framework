import { delimiter as pathDelimiter } from 'node:path';

export function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseOptionalPositiveIntEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const TRUE_ENV_BOOLEAN_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_ENV_BOOLEAN_VALUES = new Set(['false', '0', 'no', 'off']);

export interface ParseEnvListOptions {
  separators?: readonly string[];
  dedupe?: boolean;
}

function normalizeEnvString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function parseOptionalStringEnv(value: string | undefined): string | undefined {
  return normalizeEnvString(value);
}

function splitEnvList(
  value: string,
  separators: readonly string[],
): string[] {
  if (separators.length === 0) {
    return [value];
  }

  const escaped = separators
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (escaped.length === 0) return [value];
  const splitPattern = new RegExp(escaped.join('|'), 'g');
  return value.split(splitPattern);
}

export function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = normalizeEnvString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (TRUE_ENV_BOOLEAN_VALUES.has(normalized)) return true;
  if (FALSE_ENV_BOOLEAN_VALUES.has(normalized)) return false;
  return undefined;
}

export function parseEnvList(
  value: string | undefined,
  options: ParseEnvListOptions = {},
): string[] | undefined {
  const normalized = normalizeEnvString(value);
  if (!normalized) return undefined;

  const separators = options.separators ?? [','];
  const dedupe = options.dedupe ?? true;
  const entries = splitEnvList(normalized, separators)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) return undefined;

  if (!dedupe) return entries;

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
  }
  return unique;
}

export function parsePathListEnv(value: string | undefined): string[] | undefined {
  return parseEnvList(value, {
    separators: [pathDelimiter],
  });
}
