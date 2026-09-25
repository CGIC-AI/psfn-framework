import {
  formatMemoryWithheldReasonLabel,
  listMemoryWithheldReasonEntries,
  type MemoryWithheldSummary,
} from '../withheld-summary.js';

/**
 * Content-free notes for memory tool results when the trust/room gate hides
 * matches from this conversation. Without them an empty result reads as "no
 * memory exists", and companions concluded their own extraction had failed
 * (psfn-framework-jequ8). The notes carry counts and gate categories only,
 * never memory text, ids, or source channels.
 */

const GATED_NOT_ABSENT =
  'They exist but are not visible from this conversation; do not report them as missing or as an extraction failure.';

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}

export function formatMemoryWithheldNote(summary: MemoryWithheldSummary | undefined): string | null {
  if (!summary || summary.totalCount <= 0) return null;
  const reasons = listMemoryWithheldReasonEntries(summary.reasonCounts)
    .map(({ reason, count }) => `${formatMemoryWithheldReasonLabel(reason)}: ${count}`);
  const reasonSuffix = reasons.length > 0 ? ` (${reasons.join(', ')})` : '';
  return `Withheld by visibility gating: ${summary.totalCount} matching `
    + `${plural(summary.totalCount, 'memory', 'memories')}${reasonSuffix}. ${GATED_NOT_ABSENT}`;
}

export function formatEpisodesWithheldNote(withheldCount: number): string | null {
  if (withheldCount <= 0) return null;
  return `Withheld by visibility gating: ${withheldCount} ${plural(withheldCount, 'episode', 'episodes')} `
    + `from other conversations. ${GATED_NOT_ABSENT}`;
}

export function appendWithheldNote(text: string, note: string | null): string {
  return note ? `${text}\n${note}` : text;
}
