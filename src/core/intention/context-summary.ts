/**
 * The single bound for a pending follow-up's preserved situation summary
 * (`followUp.contextSummary` / `context_summary`). The appraisal prompt states
 * it, the decision parser and the schedule tool truncate to it, and every
 * store write enforces it by truncation: an over-long summary is shortened,
 * never rejected, so a paid appraisal is not discarded over its length.
 */
export const MAX_CONTEXT_SUMMARY_CHARS = 1000;

const TRUNCATION_MARKER = '…';

/**
 * Collapse whitespace and bound a context summary to
 * {@link MAX_CONTEXT_SUMMARY_CHARS}, cutting at the last word boundary that
 * fits (or hard-cutting a single over-long word) and marking the cut.
 * Returns undefined for absent or blank input.
 */
export function boundContextSummary(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_CONTEXT_SUMMARY_CHARS) return normalized;
  const budget = MAX_CONTEXT_SUMMARY_CHARS - TRUNCATION_MARKER.length;
  const hardCut = normalized.slice(0, budget);
  const lastSpace = hardCut.lastIndexOf(' ');
  const cut = lastSpace > 0 ? hardCut.slice(0, lastSpace) : hardCut;
  return `${cut.trimEnd()}${TRUNCATION_MARKER}`;
}
