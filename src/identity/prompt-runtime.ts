export interface PromptRuntimeContext {
  now?: Date;
  variables?: Record<string, unknown>;
}

function utcIso(now: Date): string {
  return now.toISOString();
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function utcTime(now: Date): string {
  return `${now.toISOString().slice(11, 19)}Z`;
}

function unixTimestamp(now: Date): string {
  return String(Math.floor(now.getTime() / 1000));
}

type TokenResolver = (now: Date) => string;

const TOKEN_RESOLVERS: Array<[RegExp, TokenResolver]> = [
  [/\{\{\s*(?:current_datetime|current_datetime_iso|now|now\(\))\s*\}\}/gi, utcIso],
  [/\{\{\s*(?:current_date|date|date\(\))\s*\}\}/gi, utcDate],
  [/\{\{\s*(?:current_time|time|time\(\))\s*\}\}/gi, utcTime],
  [/\{\{\s*(?:current_timestamp|unix_timestamp|timestamp|timestamp\(\))\s*\}\}/gi, unixTimestamp],
];

export const PROMPT_RUNTIME_TOKEN_HINT =
  'Runtime tokens: {{current_datetime}} / {{now()}}, {{current_date}}, {{current_time}}, {{unix_timestamp}}, '
  + '{{user}}, {{char}}, {{channel_id}}, {{channel_type}}, {{trust_level}}, {{model}}';

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function stringifyVariableValue(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function setVariableLookup(lookup: Map<string, string>, key: string, value: string): void {
  if (!key) return;
  const normalized = normalizeLookupKey(key);
  if (!lookup.has(normalized)) {
    lookup.set(normalized, value);
  }
}

function addVariable(
  lookup: Map<string, string>,
  key: string,
  value: string,
): void {
  setVariableLookup(lookup, key, value);
  setVariableLookup(lookup, toSnakeCase(key), value);
}

function buildVariableLookup(variables: Record<string, unknown>): Map<string, string> {
  const lookup = new Map<string, string>();

  const walk = (obj: Record<string, unknown>, prefix?: string): void => {
    for (const [rawKey, rawValue] of Object.entries(obj)) {
      if (!rawKey.trim()) continue;

      const dottedKey = prefix ? `${prefix}.${rawKey}` : rawKey;
      const primitive = stringifyVariableValue(rawValue);
      if (primitive != null) {
        addVariable(lookup, dottedKey, primitive);
      }

      if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue) && !(rawValue instanceof Date)) {
        walk(rawValue as Record<string, unknown>, dottedKey);
      }
    }
  };

  walk(variables);
  return lookup;
}

/**
 * Replace runtime date/time tokens in prompt text.
 * All values are UTC to keep behavior deterministic across environments.
 */
export function injectPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): string {
  if (!text) return text;

  const now = context.now ?? new Date();
  const variableLookup = buildVariableLookup(context.variables ?? {});
  let output = text;

  for (const [pattern, resolver] of TOKEN_RESOLVERS) {
    output = output.replace(pattern, () => resolver(now));
  }

  output = output.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (fullToken, rawName: string) => {
    const cleaned = rawName.endsWith('()') ? rawName.slice(0, -2) : rawName;
    const normalized = normalizeLookupKey(cleaned);
    const resolved = variableLookup.get(normalized);
    return resolved ?? fullToken;
  });

  return output;
}
