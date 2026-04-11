const REFUSAL_SUBJECT_FRAGMENT = String.raw`(i|we)`;
const REFUSAL_NEGATION_FRAGMENT = String.raw`(can(?:not|'t)|won't|will not|must not)`;
const REFUSAL_PREFIX_FRAGMENT = String.raw`\b${REFUSAL_SUBJECT_FRAGMENT}\s+${REFUSAL_NEGATION_FRAGMENT}\s+`;

const COMPACTION_REFUSAL_ACTIONS = ['help', 'assist', 'provide', 'share', 'comply', 'do'] as const;
const BOUNDARY_LOG_REFUSAL_ACTIONS = ['help', 'assist', 'provide', 'share', 'guide', 'support', 'do'] as const;

function buildPrimaryRefusalPattern(actions: readonly string[]): RegExp {
  return new RegExp(`${REFUSAL_PREFIX_FRAGMENT}(${actions.join('|')})\\b`, 'i');
}

const REFUSAL_DECLINE_PATTERN = /\b(i|we)\s+(refuse|decline)\b/i;
const REFUSAL_UNABLE_PATTERN = /\b(i|we)\s+(am|are|'m)\s+unable\s+to\b/i;
const REFUSAL_HELP_WITH_PATTERN = /\b(can(?:not|'t)|won't)\s+help\s+with\b/i;
const REFUSAL_POLICY_PATTERN = /\bagainst\s+(policy|safety|my boundaries|our boundaries)\b/i;

export const COMPACTION_REFUSAL_PATTERNS = [
  buildPrimaryRefusalPattern(COMPACTION_REFUSAL_ACTIONS),
  REFUSAL_DECLINE_PATTERN,
  REFUSAL_UNABLE_PATTERN,
] as const;

export const BOUNDARY_LOG_REFUSAL_PATTERNS = [
  buildPrimaryRefusalPattern(BOUNDARY_LOG_REFUSAL_ACTIONS),
  REFUSAL_DECLINE_PATTERN,
  REFUSAL_UNABLE_PATTERN,
  REFUSAL_HELP_WITH_PATTERN,
  REFUSAL_POLICY_PATTERN,
] as const;

export function matchesRefusalPatterns(content: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(content));
}
