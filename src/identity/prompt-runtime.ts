import {
  formatActiveDate,
  formatActiveDateTimeIso,
  formatActiveTime,
  resolveActiveTimezone,
} from '../time/active-timezone.js';

export interface PromptRuntimeContext {
  now?: Date;
  variables?: Record<string, unknown>;
  onUnresolvedToken?: (token: string) => void;
}

function activeIso(now: Date): string {
  return formatActiveDateTimeIso(now);
}

function activeDate(now: Date): string {
  return formatActiveDate(now);
}

function activeTime(now: Date): string {
  return formatActiveTime(now);
}

function unixTimestamp(now: Date): string {
  return String(Math.floor(now.getTime() / 1000));
}

type TokenResolver = (now: Date) => string;
const EMPTY_WRAPPED_SECTION_PATTERN = /<([a-z0-9_]+)>\s*<\/\1>/g;

const TOKEN_RESOLVERS: Array<[RegExp, TokenResolver]> = [
  [/\{\{\s*(?:current_datetime|current_datetime_iso|now|now\(\))\s*\}\}/gi, activeIso],
  [/\{\{\s*(?:current_date|date|date\(\))\s*\}\}/gi, activeDate],
  [/\{\{\s*(?:current_time|time|time\(\))\s*\}\}/gi, activeTime],
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
    description: `Current active timezone datetime in ISO-8601 format (${resolveActiveTimezone()}).`,
    example: '2026-02-21T08:20:11.123-05:00',
  },
  {
    token: '{{current_date}}',
    description: `Current calendar date in the active timezone (${resolveActiveTimezone()}).`,
    example: '2026-02-21',
  },
  {
    token: '{{current_time}}',
    description: `Current time in the active timezone (${resolveActiveTimezone()}).`,
    example: '08:20:11-05:00',
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
    example: 'Companion',
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
  {
    token: '{{active_timezone}}',
    description: 'Active runtime timezone identifier.',
    example: 'America/New_York',
  },
  {
    token: '{{runtime_current_datetime_human}}',
    description: 'Current local datetime formatted for prompt-facing companion context.',
    example: 'Friday, March 27, 2026 at 10:27 PM',
  },
  {
    token: '{{runtime_current_weekday}}',
    description: 'Current weekday in the active timezone.',
    example: 'Friday',
  },
  {
    token: '{{runtime_current_date_human}}',
    description: 'Current local calendar date in companion-facing format.',
    example: 'March 27, 2026',
  },
  {
    token: '{{runtime_current_time_human}}',
    description: 'Current local clock time in companion-facing format.',
    example: '10:27 PM',
  },
  {
    token: '{{runtime_last_message_received_human}}',
    description: 'Last pre-turn message timestamp plus relative elapsed wording.',
    example: 'Friday, March 27, 2026 at 10:11 PM America/New_York (16 minutes ago)',
  },
  {
    token: '{{runtime_last_message_received_at_iso}}',
    description: 'ISO-8601 timestamp for the most recent pre-turn message.',
    example: '2026-03-27T22:11:04.112-04:00',
  },
  {
    token: '{{runtime_last_message_received_ago}}',
    description: 'Relative time since the most recent pre-turn message.',
    example: '16 minutes ago',
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

function normalizeTokenName(rawToken: string): string {
  const trimmed = rawToken.trim();
  if (trimmed.endsWith('()')) {
    return trimmed.slice(0, -2);
  }
  return trimmed;
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

function collectUnresolvedTokens(text: string): string[] {
  const unresolved = new Set<string>();
  text.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (_full, rawToken: string) => {
    unresolved.add(normalizeTokenName(rawToken));
    return '';
  });
  return [...unresolved];
}

function pruneEmptyWrappedSections(text: string): string {
  return text
    .replace(EMPTY_WRAPPED_SECTION_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PromptRuntimeRenderResult {
  text: string;
  unresolvedTokens: string[];
}

/**
 * Replace runtime date/time tokens in prompt text.
 * All values are UTC to keep behavior deterministic across environments.
 */
export function renderPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): PromptRuntimeRenderResult {
  if (!text) return { text, unresolvedTokens: [] };

  const now = context.now ?? new Date();
  const variableLookup = buildVariableLookup(context.variables ?? {});
  let output = text;

  for (let pass = 0; pass < 3; pass += 1) {
    const before = output;

    for (const [pattern, resolver] of TOKEN_RESOLVERS) {
      output = output.replace(pattern, () => resolver(now));
    }

    output = output.replace(/\{\{\s*([a-zA-Z0-9_.-]+(?:\(\))?)\s*\}\}/g, (fullToken, rawName: string) => {
      const cleaned = normalizeTokenName(rawName);
      const normalized = normalizeLookupKey(cleaned);
      const resolved = variableLookup.get(normalized);
      return resolved ?? fullToken;
    });

    output = pruneEmptyWrappedSections(output);

    if (output === before) break;
  }

  const unresolvedTokens = collectUnresolvedTokens(output);
  if (context.onUnresolvedToken) {
    for (const token of unresolvedTokens) {
      context.onUnresolvedToken(token);
    }
  }

  return {
    text: output,
    unresolvedTokens,
  };
}

/**
 * Backward-compatible helper that returns only rendered text.
 */
export function injectPromptRuntimeTokens(
  text: string,
  context: PromptRuntimeContext = {},
): string {
  return renderPromptRuntimeTokens(text, context).text;
}
