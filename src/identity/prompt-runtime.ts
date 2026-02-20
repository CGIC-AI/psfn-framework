export interface PromptRuntimeContext {
  now?: Date;
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
  'Runtime tokens: {{current_datetime}} / {{now()}}, {{current_date}}, {{current_time}}, {{unix_timestamp}}';

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
  let output = text;

  for (const [pattern, resolver] of TOKEN_RESOLVERS) {
    output = output.replace(pattern, () => resolver(now));
  }

  return output;
}

