/**
 * jp36.4.2 acceptance guard: "No scripted companion phrasing anywhere."
 *
 * Design bible §12.6 / §2 refinement (2): the overfatigue mechanism shapes
 * behavior toward wrapping up but the system must NEVER put a scripted
 * wind-down line in the companion's mouth. This guard scans the fatigue
 * subsystem (and the social-pot store) for string literals that read as
 * first-person, user-facing wind-down prose and fails closed if any appear, so
 * a future change cannot silently reintroduce scripted companion phrasing.
 *
 * The scan strips comments first (design/rationale prose is allowed in
 * comments) and only inspects quoted string literals.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const FATIGUE_DIR = dirname(fileURLToPath(import.meta.url));
const SOCIAL_POT_STORE = fileURLToPath(
  new URL('../../../persistence/postgres/social-pot-store.ts', import.meta.url),
);

/** First-person / scripted wind-down markers that must never be emitted verbatim. */
const SCRIPTED_PHRASE_PATTERN =
  /\b(i'm|i am|i need|i'm going|i'm gonna|gonna rest|need to rest|need a break|take a break|winding down|worn out|out of energy|running low on|feeling tired|getting tired|let me rest|call it a night)\b/i;

/** Remove line and block comments so only executable string literals are scanned. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Extract single-, double-, and backtick-quoted string literals. */
function extractStringLiterals(source: string): string[] {
  const literals: string[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    literals.push(match[0]);
  }
  return literals;
}

function fatigueSourceFiles(): string[] {
  const files = readdirSync(FATIGUE_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(FATIGUE_DIR, name));
  return [...files, SOCIAL_POT_STORE];
}

describe('fatigue subsystem contains no scripted companion phrasing (jp36.4.2)', () => {
  it('emits no first-person, user-facing wind-down prose in any string literal', () => {
    const offenders: Array<{ file: string; literal: string }> = [];
    for (const file of fatigueSourceFiles()) {
      const source = stripComments(readFileSync(file, 'utf-8'));
      for (const literal of extractStringLiterals(source)) {
        if (SCRIPTED_PHRASE_PATTERN.test(literal)) {
          offenders.push({ file, literal });
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans a non-empty set of fatigue source files (guard is actually wired)', () => {
    const files = fatigueSourceFiles();
    expect(files.length).toBeGreaterThan(1);
    // Sanity-check the extractor/pattern actually fire on a known scripted line.
    const sample = extractStringLiterals('const s = "I\'m winding down for the night";');
    expect(sample).toHaveLength(1);
    expect(SCRIPTED_PHRASE_PATTERN.test(sample[0] ?? '')).toBe(true);
  });
});
