import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { getAllowedSensitivities } from '../../../system/trust/policy.js';
import {
  canViewerReadSessionChannel,
  resolveViewerContextFromRequest,
} from '../../../core/session/session-viewer-access.js';
import {
  resolveSessionSearchViewerTrustLevel,
  resolveSessionSearchViewerVisibility,
  type SessionSearchViewerContext,
} from '../../../core/session/search-runtime.js';

/**
 * Visibility provenance for Personal Workspace journal notes
 * (psfn-framework-75oi4).
 *
 * Journal notes are written by the companion from many turns, including
 * self-directed synthesis (the dream pass, reflections) that sees episodes
 * from gated conversations. Reads surface note text into whatever
 * conversation asks, so every note carries where it came from and reads
 * apply the same trust/room gate as transcript and memory reads:
 * - `conversation`: written in one conversation; readable wherever that
 *   conversation's content is readable (canViewerReadSessionChannel).
 * - `restricted`: written by self-directed or internal synthesis, merged from
 *   several sources, or legacy (no header); readable only where confidential
 *   material is (primary trust in a private room).
 *
 * The provenance lives in a first-line header the journal writer stamps. The
 * header is never taken from model-supplied content (forged headers are
 * stripped).
 */
export type JournalProvenance =
  | { scope: 'conversation'; channelId: string }
  | { scope: 'restricted' };

const HEADER_PREFIX = '<!-- journal-provenance: ';
const HEADER_SUFFIX = ' -->';
const HEADER_LINE = /^<!-- journal-provenance: (\{.*\}) -->[ \t]*$/u;

export const RESTRICTED_JOURNAL_PROVENANCE: JournalProvenance = Object.freeze({ scope: 'restricted' });

export function renderJournalProvenanceHeader(provenance: JournalProvenance): string {
  return `${HEADER_PREFIX}${JSON.stringify(provenance)}${HEADER_SUFFIX}`;
}

function parseHeaderJson(json: string): JournalProvenance | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { scope?: unknown; channelId?: unknown };
  if (record.scope === 'restricted') return RESTRICTED_JOURNAL_PROVENANCE;
  if (record.scope === 'conversation' && typeof record.channelId === 'string' && record.channelId.length > 0) {
    return { scope: 'conversation', channelId: record.channelId };
  }
  return null;
}

/**
 * Split a note into its provenance and body. A missing or malformed header is
 * treated as restricted (legacy notes predate provenance; fail closed).
 */
export function parseJournalNote(content: string): { provenance: JournalProvenance; body: string; stamped: boolean } {
  const newline = content.indexOf('\n');
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  const match = HEADER_LINE.exec(firstLine);
  const provenance = match?.[1] ? parseHeaderJson(match[1]) : null;
  if (!provenance) return { provenance: RESTRICTED_JOURNAL_PROVENANCE, body: content, stamped: false };
  return { provenance, body: newline === -1 ? '' : content.slice(newline + 1), stamped: true };
}

/** Remove any provenance header lines from model-supplied content. */
export function stripJournalProvenanceHeaders(content: string): string {
  return content
    .split('\n')
    .filter(line => !HEADER_LINE.test(line))
    .join('\n');
}

/** Two sources: the same conversation stays; anything else is restricted. */
export function mergeJournalProvenance(existing: JournalProvenance, incoming: JournalProvenance): JournalProvenance {
  if (
    existing.scope === 'conversation'
    && incoming.scope === 'conversation'
    && existing.channelId === incoming.channelId
  ) {
    return existing;
  }
  return RESTRICTED_JOURNAL_PROVENANCE;
}

const INTERNAL_CHANNEL_PREFIX = 'internal:';

/**
 * Provenance for a note written by the current turn. Internal and
 * self-directed turns (dream pass, reflections, free time) synthesize across
 * conversations, so they write restricted notes; a turn with no conversation
 * does too.
 */
export function resolveWriterJournalProvenance(): JournalProvenance {
  const context = getRequestContext();
  const channelId = typeof context?.channelId === 'string' ? context.channelId.trim() : '';
  if (
    !channelId
    || channelId.startsWith(INTERNAL_CHANNEL_PREFIX)
    || context?.requesterProvenance === 'self_directed'
  ) {
    return RESTRICTED_JOURNAL_PROVENANCE;
  }
  return { scope: 'conversation', channelId };
}

function viewerAdmitsConfidential(viewer: SessionSearchViewerContext): boolean {
  const allowed = getAllowedSensitivities(
    resolveSessionSearchViewerTrustLevel(viewer.trustLevel),
    { channelPrivacy: resolveSessionSearchViewerVisibility(viewer), broadcast: false },
  );
  return allowed.includes('confidential');
}

export function canViewerReadJournalNote(
  provenance: JournalProvenance,
  viewer: SessionSearchViewerContext = resolveViewerContextFromRequest(),
): boolean {
  if (provenance.scope === 'conversation') return canViewerReadSessionChannel(viewer, provenance.channelId);
  return viewerAdmitsConfidential(viewer);
}
