// ── Bounded-proximity primitives + rule-pattern safety lint (htm9.4) ──
//
// The Hermes deterministic scanner's core mechanism, generalized: two
// explicit proximity primitives, BOTH hard-bounded.
//
//   (a) char-window co-occurrence — `verb <=N chars on the same line> token`
//       (e.g. curl … $API_KEY), built by buildCharWindowPattern().
//   (b) word-count-bounded filler between phrase anchors —
//       `anchor \s+ (?:\w+\s+){0,K} anchor` (defeats insert-a-few-words
//       bypasses), built by buildBoundedFillerPattern().
//
// CRITICAL LESSON (Hermes skills_guard.py ReDoS, fixed in their 4ea29978):
// NEVER put an unbounded `*`/`+` quantifier between two attacker-visible
// anchors — ambiguous unbounded repetition backtracks catastrophically on
// adversarial near-misses. Every rule-file pattern fragment is therefore
// linted by assertBoundedRulePattern(): unescaped `*`, `+`, and open-ended
// `{n,}` are rejected outright; only `?`, `{m}`, and `{m,n}` (n ≤ cap) pass.
// The engine-internal filler joiner `(?:\w+\s+){0,K}` is the one vetted
// exception: `\w` and `\s` are disjoint classes, the repetition is bounded,
// and the whole input is capped at MAX_SCAN_CHARS before matching.

export const MAX_RULE_PATTERN_CHARS = 600;
export const MAX_BOUNDED_QUANTIFIER = 4_096;
export const MAX_FILLER_WORDS = 16;
export const DEFAULT_FILLER_WORDS = 8;
export const MAX_PROXIMITY_GAP_CHARS = 4_096;
export const DEFAULT_PROXIMITY_GAP_CHARS = 2_048;

export class IntakeRulePatternError extends Error {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`Invalid intake rule pattern (${field}): ${detail}`);
    this.name = 'IntakeRulePatternError';
    this.field = field;
  }
}

/**
 * Fail-closed syntactic lint for rule-file regex fragments.
 *
 * Rejects every form of unbounded repetition:
 * - unescaped `*` or `+` (anywhere outside a character class),
 * - open-ended `{n,}` bounds,
 * - bounded `{m,n}` with n > MAX_BOUNDED_QUANTIFIER,
 * - malformed `{...}` specs (would be a syntax error under the `u` flag).
 *
 * `?`, `{m}`, and `{m,n}` are allowed. Escaped literals (`\*`, `\+`, `\{`)
 * and characters inside `[...]` classes are not treated as quantifiers.
 */
export function assertBoundedRulePattern(pattern: string, field: string): void {
  if (pattern.length === 0) {
    throw new IntakeRulePatternError(field, 'must be non-empty');
  }
  if (pattern.length > MAX_RULE_PATTERN_CHARS) {
    throw new IntakeRulePatternError(field, `exceeds ${String(MAX_RULE_PATTERN_CHARS)} characters`);
  }
  let inClass = false;
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      index += 1;
      continue;
    }
    if (char === '[') {
      inClass = true;
      index += 1;
      continue;
    }
    if (char === '*' || char === '+') {
      throw new IntakeRulePatternError(
        field,
        `unbounded quantifier '${char}' at index ${String(index)} — use a bounded {m,n} repetition instead`,
      );
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index + 1);
      if (close === -1) {
        throw new IntakeRulePatternError(field, `unterminated '{' at index ${String(index)}`);
      }
      const spec = pattern.slice(index + 1, close);
      const match = /^(\d{1,5})(?:,(\d{0,5}))?$/.exec(spec);
      if (!match) {
        throw new IntakeRulePatternError(field, `malformed repetition '{${spec}}' at index ${String(index)}`);
      }
      const lower = Number(match[1]);
      // Optional group: undefined when '{m}' form, '' when '{m,}' form.
      const upperText = match.at(2);
      if (upperText === '') {
        throw new IntakeRulePatternError(
          field,
          `open-ended repetition '{${spec}}' at index ${String(index)} — an upper bound is required`,
        );
      }
      const upper = upperText === undefined ? lower : Number(upperText);
      if (upper > MAX_BOUNDED_QUANTIFIER) {
        throw new IntakeRulePatternError(
          field,
          `repetition upper bound ${String(upper)} exceeds ${String(MAX_BOUNDED_QUANTIFIER)}`,
        );
      }
      if (lower > upper) {
        throw new IntakeRulePatternError(field, `repetition '{${spec}}' has lower bound above upper bound`);
      }
      index = close + 1;
      continue;
    }
    index += 1;
  }
  if (inClass) {
    throw new IntakeRulePatternError(field, "unterminated '[' character class");
  }
}

/**
 * Compiles an ALREADY-VETTED pattern with the 'iu' flags. Used for patterns
 * assembled by the primitive builders below, whose attacker-authorable
 * fragments were linted individually — the engine-internal filler joiner
 * `(?:\w+\s+){0,K}` intentionally contains `+` (disjoint classes, bounded
 * outer repetition; the vetted safe exception).
 */
export function compileBuiltPattern(pattern: string, field: string): RegExp {
  try {
    return new RegExp(pattern, 'iu');
  } catch (error) {
    throw new IntakeRulePatternError(
      field,
      `does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Lints then compiles a rule-file regex pattern with the 'iu' flags. */
export function compileRulePattern(pattern: string, field: string): RegExp {
  assertBoundedRulePattern(pattern, field);
  return compileBuiltPattern(pattern, field);
}

/**
 * Primitive (b): word-count-bounded filler between phrase anchors.
 *
 * Joins linted anchor fragments with `\s+(?:\w+\s+){0,K}`, mirroring the
 * post-ReDoS-fix Hermes `_FILLER` shape: an attacker can insert up to K
 * filler words between anchors ("ignore all of the previous instructions")
 * but the repetition is bounded, so adversarial near-miss inputs cannot
 * trigger runaway backtracking.
 */
export function buildBoundedFillerPattern(
  anchors: readonly string[],
  maxFillerWords: number,
  field: string,
): string {
  if (anchors.length < 2) {
    throw new IntakeRulePatternError(field, 'phrase rules require at least 2 anchors');
  }
  if (anchors.length > 8) {
    throw new IntakeRulePatternError(field, 'phrase rules allow at most 8 anchors');
  }
  if (!Number.isInteger(maxFillerWords) || maxFillerWords < 0 || maxFillerWords > MAX_FILLER_WORDS) {
    throw new IntakeRulePatternError(
      field,
      `maxFillerWords must be an integer in [0, ${String(MAX_FILLER_WORDS)}]`,
    );
  }
  anchors.forEach((anchor, index) => {
    assertBoundedRulePattern(anchor, `${field}.anchors[${String(index)}]`);
  });
  const filler = `\\s+(?:\\w+\\s+){0,${String(maxFillerWords)}}`;
  return anchors.map((anchor) => `(?:${anchor})`).join(filler);
}

/**
 * Primitive (a): char-window co-occurrence — `left <= N chars> right`.
 *
 * `sameLine: true` (default) uses `[^\n]{0,N}` so the verb and the secret
 * token must co-occur on one line (Hermes exfil_curl shape); `false` allows
 * the window to span lines via `[\s\S]{0,N}`. The window is always bounded.
 */
export function buildCharWindowPattern(input: {
  left: string;
  right: string;
  maxGapChars: number;
  sameLine: boolean;
  field: string;
}): string {
  const { left, right, maxGapChars, sameLine, field } = input;
  if (!Number.isInteger(maxGapChars) || maxGapChars < 0 || maxGapChars > MAX_PROXIMITY_GAP_CHARS) {
    throw new IntakeRulePatternError(
      field,
      `maxGapChars must be an integer in [0, ${String(MAX_PROXIMITY_GAP_CHARS)}]`,
    );
  }
  assertBoundedRulePattern(left, `${field}.left`);
  assertBoundedRulePattern(right, `${field}.right`);
  const window = sameLine ? '[^\\n]' : '[\\s\\S]';
  return `(?:${left})${window}{0,${String(maxGapChars)}}(?:${right})`;
}
