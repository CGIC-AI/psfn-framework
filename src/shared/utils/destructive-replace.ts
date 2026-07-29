/**
 * Shared destructive-text-replace heuristic (charter 9.5 category-2).
 *
 * A replacement of a long-lived prose field counts as "destructive" when it
 * removes a large absolute amount of existing text AND leaves only a small
 * fraction behind. Both the character-card versioning surface
 * (src/core/identity/card-versioning.ts) and the managed skill store
 * (src/faculties/skills/store.ts) use this single predicate so the two
 * self-modification surfaces cannot drift apart on what "destructive" means.
 */

const MIN_DESTRUCTIVE_REPLACE_SOURCE_LENGTH = 400;
const MIN_DESTRUCTIVE_REPLACE_REMOVED_CHARS = 200;
const MAX_SAFE_REMAINING_RATIO = 0.6;

export interface DestructiveTextReplaceRisk {
  previousLength: number;
  nextLength: number;
}

/**
 * Evaluate trimmed previous/next lengths against the destructive-replace
 * thresholds. Returns the risk record when the replacement is destructive,
 * otherwise null.
 */
export function detectDestructiveTextReplace(
  previousLength: number,
  nextLength: number,
): DestructiveTextReplaceRisk | null {
  const removedChars = previousLength - nextLength;
  const remainingRatio = previousLength > 0 ? nextLength / previousLength : 1;

  if (
    previousLength >= MIN_DESTRUCTIVE_REPLACE_SOURCE_LENGTH
    && removedChars >= MIN_DESTRUCTIVE_REPLACE_REMOVED_CHARS
    && remainingRatio <= MAX_SAFE_REMAINING_RATIO
  ) {
    return { previousLength, nextLength };
  }

  return null;
}
