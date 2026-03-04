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

export interface PromptRuntimeMacroHint {
  token: string;
  description: string;
  example: string;
}

export const PROMPT_RUNTIME_MACRO_HINTS: PromptRuntimeMacroHint[] = [
  {
    token: '{{current_datetime}} / {{now()}}',
    description: 'Current UTC datetime in ISO-8601 format.',
    example: '2026-02-21T13:20:11.123Z',
  },
  {
    token: '{{current_date}}',
    description: 'Current UTC calendar date.',
    example: '2026-02-21',
  },
  {
    token: '{{current_time}}',
    description: 'Current UTC time.',
    example: '13:20:11Z',
  },
  {
    token: '{{unix_timestamp}}',
    description: 'Current Unix epoch timestamp in seconds.',
    example: '1769020811',
  },
  {
    token: '{{user}}',
    description: 'Current author/user display name from runtime context.',
    example: 'PrimaryUser',
  },
  {
    token: '{{char}}',
    description: 'Character/assistant name from runtime context.',
    example: 'PSFN',
  },
  {
    token: '{{description}}',
    description: 'Character card description field.',
    example: 'A new companion identity waiting to be customized.',
  },
  {
    token: '{{personality}}',
    description: 'Character card personality field.',
    example: 'A blank starter personality.',
  },
  {
    token: '{{scenario}}',
    description: 'Character card scenario field.',
    example: '{{user}} and {{char}} are chatting.',
  },
  {
    token: '{{system_prompt}}',
    description: 'Character card system_prompt field.',
    example: 'Use clear language and stay grounded.',
  },
  {
    token: '{{mes_example}}',
    description: 'Character card message example block.',
    example: 'Example dialogue style:\\n{{user}}: hi\\n{{char}}: hello',
  },
  {
    token: '{{post_history_instructions}}',
    description: 'Character card post-history instructions field.',
    example: 'Stay concise and ask clarifying questions when needed.',
  },
  {
    token: '{{channel_id}}',
    description: 'Resolved channel/session identifier.',
    example: 'discord:dm:123456789',
  },
  {
    token: '{{channel_type}}',
    description: 'Resolved channel type.',
    example: 'discord_text',
  },
  {
    token: '{{trust_level}}',
    description: 'Current trust tier for the author/context.',
    example: 'primary',
  },
  {
    token: '{{model}}',
    description: 'Current active model identifier.',
    example: 'moonshotai/kimi-k2.5',
  },
];

export const PROMPT_RUNTIME_TOKEN_HINT = `Runtime tokens: ${PROMPT_RUNTIME_MACRO_HINTS
  .map(entry => entry.token)
  .join(', ')}`;

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

  for (let pass = 0; pass < 3; pass += 1) {
    const before = output;

    for (const [pattern, resolver] of TOKEN_RESOLVERS) {
      output = output.replace(pattern, () => resolver(now));
    }

    output = output.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (fullToken, rawName: string) => {
      const cleaned = rawName.endsWith('()') ? rawName.slice(0, -2) : rawName;
      const normalized = normalizeLookupKey(cleaned);
      const resolved = variableLookup.get(normalized);
      return resolved ?? fullToken;
    });

    if (output === before) break;
  }

  return output;
}
