import { isRecord } from '../../shared/utils/types.js';

const EXACT_ARGUMENTS_CLAUSE = '\\s+exactly\\s+once\\s+with\\s+arguments\\s*';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function findJsonObjectEnd(text: string, start: number): number | undefined {
  if (text[start] !== '{') return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return undefined;
}

/** Extract the unambiguous JSON object from a single exact-arguments directive. */
export function resolveExactExplicitToolArguments(
  requestText: string,
  toolName: string,
): Record<string, unknown> | undefined {
  const pattern = new RegExp(
    `\\b(?:call|use|invoke|run|execute|trigger|attempt)\\s+(?:the\\s+)?(?:tool\\s+)?[\u0060]?${escapeRegExp(toolName)}[\u0060]?${EXACT_ARGUMENTS_CLAUSE}`,
    'giu',
  );
  const matches = [...requestText.matchAll(pattern)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const end = findJsonObjectEnd(requestText, start);
  if (end === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(requestText.slice(start, end));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function exactValueSchema(value: unknown): Record<string, unknown> {
  if (value === null) return { type: 'null' };
  if (Array.isArray(value)) {
    return { type: 'array', enum: [value] };
  }
  if (isRecord(value)) {
    return buildExactToolArgumentsModelSchema(value);
  }
  const type = typeof value;
  if (type === 'string' || type === 'boolean') {
    return { type, enum: [value] };
  }
  if (type === 'number' && Number.isFinite(value)) {
    return { type: Number.isInteger(value) ? 'integer' : 'number', enum: [value] };
  }
  throw new Error('Exact tool arguments must contain only JSON values');
}

/** Build a provider-facing exact schema; canonical execution validation remains separate. */
export function buildExactToolArgumentsModelSchema(
  expectedArguments: Record<string, unknown>,
): Record<string, unknown> {
  const entries = Object.entries(expectedArguments);
  return {
    type: 'object',
    properties: Object.fromEntries(entries.map(([key, value]) => [key, exactValueSchema(value)])),
    required: entries.map(([key]) => key),
    additionalProperties: false,
  };
}

function exactJsonValueMatch(actual: unknown, expected: unknown): boolean {
  if (isRecord(actual) && isRecord(expected)) {
    return exactToolArgumentsMatch(actual, expected);
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length
      && actual.every((value, index) => exactJsonValueMatch(value, expected[index]));
  }
  return Object.is(actual, expected);
}

export function exactToolArgumentsMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  return expectedKeys.every((key, index) => {
    if (actualKeys[index] !== key) return false;
    return exactJsonValueMatch(actual[key], expected[key]);
  });
}
