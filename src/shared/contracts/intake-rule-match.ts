// Browser-safe vocabulary and safety bounds for deterministic L1 rule evidence.
// Keep this module free of Node-only imports: Garden validates persisted cache
// snapshots against the same contract used by the canonical intake envelope.

export const INTAKE_L1_RULE_MATCH_KINDS = ['phrase', 'near', 'regex'] as const;
export type IntakeL1RuleMatchKind = typeof INTAKE_L1_RULE_MATCH_KINDS[number];

export const INTAKE_L1_RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{1,63}$/u;
export const INTAKE_L1_SCAN_MAX_CHARS = 65_536;
export const INTAKE_RULE_MATCH_EXCERPT_MAX_CHARS = 160;
export const MAX_DECISION_RULE_MATCHES = 32;
/** Maximum rules in one canonical L1 owner-file snapshot. */
export const INTAKE_L1_RULE_MATCH_TOTAL_MAX = 512;

/** True when an excerpt contains a control, format, surrogate, or line-separator code point. */
export function hasUnsafeIntakeRuleMatchExcerptCharacters(value: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value);
}

/**
 * Truncate to a UTF-16 storage bound without manufacturing an unpaired
 * surrogate when the boundary falls inside an astral code point.
 */
export function truncateUtf16AtCodePointBoundary(
  value: string,
  maxCodeUnits: number,
): string {
  if (!Number.isSafeInteger(maxCodeUnits) || maxCodeUnits < 0) {
    throw new TypeError('maxCodeUnits must be a non-negative safe integer');
  }
  if (value.length <= maxCodeUnits) return value;
  let endOffset = maxCodeUnits;
  const preceding = value.charCodeAt(endOffset - 1);
  const following = value.charCodeAt(endOffset);
  if (preceding >= 0xD800 && preceding <= 0xDBFF
    && following >= 0xDC00 && following <= 0xDFFF) {
    endOffset -= 1;
  }
  return value.slice(0, endOffset);
}

/**
 * Bounded evidence for one deterministic L1 owner-file rule match.
 * Offsets are UTF-16 code-unit offsets into the capped, security-normalized
 * text inspected by the rule engine. The excerpt is a short, secret-redacted
 * projection of exactly that span; it is never the raw quarantined payload.
 */
export interface IntakeL1RuleMatchProvenance {
  ruleId: string;
  kind: IntakeL1RuleMatchKind;
  startOffset: number;
  endOffset: number;
  excerpt: string;
}

/** Owner-file rule ids are unique, so persisted evidence must preserve that invariant. */
export function hasUniqueIntakeRuleMatchRuleIds(
  matches: readonly Pick<IntakeL1RuleMatchProvenance, 'ruleId'>[],
): boolean {
  const seen = new Set<string>();
  for (const match of matches) {
    if (seen.has(match.ruleId)) return false;
    seen.add(match.ruleId);
  }
  return true;
}
