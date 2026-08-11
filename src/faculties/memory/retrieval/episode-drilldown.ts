import type { SessionEntry } from '../../../core/session/types.js';
import {
  parseEpisode,
  type Episode,
  type EpisodeArc,
  type EpisodeSpanRef,
} from '../../../shared/contracts/episodic-memory.js';
import type { ChannelDisclosureContext } from '../../../system/trust/policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { EpisodicStorePort } from '../episodic/store-port.js';
import type { RetrievalAccessScope } from '../types.js';
import { resolveEpisodeSessionEntryTurnId } from '../episodic/turn-reference.js';
import {
  isEpisodeQuarantined,
  type MemorySessionQuarantineFilter,
} from './session-quarantine.js';
import {
  isEpisodeVisibleForTurn,
  listEpisodeArcMemberships,
  type EpisodeArcMembership,
} from './episodic.js';

export type EpisodeDrilldownStore = Pick<
  EpisodicStorePort,
  'getEpisode' | 'getEpisodesByIds' | 'listEpisodeArcsForEpisode' | 'searchByThread'
>;

export interface EpisodeDrilldownSessionReader {
  getRecent(channelId: string, limit: number): SessionEntry[];
}

export interface EpisodeDrilldownInput {
  episodeId: string;
  channelId: string;
  trustLevel: TrustLevel;
  channelDisclosure: ChannelDisclosureContext;
  canonicalContactId?: string;
  accessScope?: RetrievalAccessScope;
  sessionQuarantineFilter?: MemorySessionQuarantineFilter | null;
  siblingLimit: number;
}

export interface EpisodeDrilldownTurn {
  turnId: string;
  channelId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  authorName?: string;
}

/**
 * Why a span's verbatim turns are not present:
 *   - 'compacted'     the source session was rolled out / compacted, so the turn
 *                     boundaries are no longer materialized (old episodes — the
 *                     primary drill-down target — routinely hit this).
 *   - 'cross_channel' the span belongs to a channel the viewer is not authorized
 *                     to read verbatim; the episode can be visible cross-channel
 *                     (contact-match) yet carry sessions the viewer never saw.
 *   - 'malformed'     the span is missing its session or turn boundaries.
 *   - 'reversed'      the persisted turn boundaries are inverted.
 */
export type EpisodeSpanUnavailableReason =
  | 'compacted'
  | 'cross_channel'
  | 'malformed'
  | 'reversed';

export interface ExpandedEpisodeSpan {
  spanRef: EpisodeSpanRef;
  turns: EpisodeDrilldownTurn[];
  /**
   * Present when this span could not be — or must not be — expanded into
   * verbatim turns. The episode's metadata (title/landmark/meaning) still
   * renders; the raw user/assistant turns do not. Absent for a normally
   * expanded span.
   */
  unavailable?: EpisodeSpanUnavailableReason;
}

export interface EpisodeArcSibling {
  arc: EpisodeArc;
  episode: Episode;
}

export interface EpisodeDrilldownResult {
  episode: Episode;
  spans: ExpandedEpisodeSpan[];
  arcSiblings: EpisodeArcSibling[];
  threadSiblings: Episode[];
}

const SPAN_UNAVAILABLE_NOTES: Record<EpisodeSpanUnavailableReason, string> = {
  compacted: 'source session was compacted or rolled out',
  cross_channel: 'span belongs to another channel; withheld to metadata only',
  malformed: 'span is missing its session or turn boundaries',
  reversed: 'span turn boundaries are inverted in the source session',
};

export function formatEpisodeDrilldown(result: EpisodeDrilldownResult): string {
  const episode = result.episode;
  const turnCount = result.spans.reduce((sum, span) => sum + span.turns.length, 0);
  const lines = [
    `Episode: ${episode.title} (${episode.id})`,
    `Time: ${episode.startedAt} to ${episode.endedAt}`,
    `Landmark: ${episode.landmark}`,
  ];
  if (episode.themes.length > 0) {
    lines.push(`Themes: ${episode.themes.join(', ')}`);
  }
  if (episode.meaning?.text) {
    lines.push(`Meaning: ${episode.meaning.text}`);
  } else {
    // Candidates, not verdicts (h4fp.6): without her authored meaning the
    // title/landmark are machine-drafted summaries, marked so they never
    // masquerade as her settled lived past.
    lines.push('(unreviewed: machine-drafted summary — you have not yet given this episode its meaning)');
  }

  lines.push(`Source turns (${turnCount} message${turnCount === 1 ? '' : 's'}):`);
  if (result.spans.length === 0) {
    lines.push('- No source spans are recorded for this episode.');
  }
  for (const span of result.spans) {
    lines.push(
      `- Span ${span.spanRef.spanId} (${span.spanRef.sessionId ?? span.spanRef.channelId}, `
      + `${span.spanRef.startTurnId} to ${span.spanRef.endTurnId})`,
    );
    if (span.unavailable) {
      lines.push(`  - (verbatim turns unavailable: ${SPAN_UNAVAILABLE_NOTES[span.unavailable]})`);
      continue;
    }
    for (const turn of span.turns) {
      const speaker = turn.authorName?.trim() || turn.role;
      lines.push(
        `  - ${new Date(turn.timestamp).toISOString()} ${speaker} [${turn.turnId}]: ${turn.content}`,
      );
    }
  }

  lines.push(`Arc siblings (${result.arcSiblings.length}):`);
  if (result.arcSiblings.length === 0) {
    lines.push('- None.');
  } else {
    for (const sibling of result.arcSiblings) {
      lines.push(
        `- ${sibling.arc.arcKind} via ${sibling.arc.id}: `
        + `${sibling.episode.title} (${sibling.episode.id}) — ${sibling.episode.landmark}`
        + (sibling.episode.meaning ? '' : ' [unreviewed]'),
      );
    }
  }

  lines.push(`Thread siblings (${result.threadSiblings.length}):`);
  if (result.threadSiblings.length === 0) {
    lines.push('- None.');
  } else {
    for (const sibling of result.threadSiblings) {
      lines.push(
        `- ${sibling.title} (${sibling.id}) — ${sibling.landmark}`
        + (sibling.meaning ? '' : ' [unreviewed]'),
      );
    }
  }

  return lines.join('\n');
}

/**
 * Resolve one visible episode into its journal-current source turns and its
 * visible arc/thread neighborhood. Missing and inaccessible episodes share the
 * same null outcome so exact-id probing cannot disclose protected memories.
 */
export async function retrieveEpisodeDrilldown(
  store: EpisodeDrilldownStore,
  sessionReader: EpisodeDrilldownSessionReader,
  input: EpisodeDrilldownInput,
): Promise<EpisodeDrilldownResult | null> {
  const storedEpisode = await store.getEpisode(input.episodeId);
  if (!storedEpisode) return null;

  const episode = parseEpisode(storedEpisode);
  if (isEpisodeQuarantined(input.sessionQuarantineFilter ?? null, episode)) return null;
  const visibilityInput = {
    contextText: '',
    channelId: input.channelId,
    trustLevel: input.trustLevel,
    channelDisclosure: input.channelDisclosure,
    ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
    ...(input.accessScope ? { accessScope: input.accessScope } : {}),
  };
  if (!isEpisodeVisibleForTurn(episode, visibilityInput)) return null;

  const memberships = await listEpisodeArcMemberships(store, episode.id, {
    limit: input.siblingLimit,
  });
  const visibleMemberships = memberships.filter(membership => (
    membership.members.every(member => (
      isEpisodeVisibleForTurn(member, visibilityInput)
      && !isEpisodeQuarantined(input.sessionQuarantineFilter ?? null, member)
    ))
  ));

  const threadSiblings = episode.threadId
    ? (await store.searchByThread(episode.threadId, {
      limit: input.siblingLimit + 1,
    }))
      .map(candidate => parseEpisode(candidate))
      .filter(candidate => (
        candidate.id !== episode.id
        && isEpisodeVisibleForTurn(candidate, visibilityInput)
        && !isEpisodeQuarantined(input.sessionQuarantineFilter ?? null, candidate)
      ))
      .slice(0, input.siblingLimit)
    : [];

  return {
    episode,
    spans: expandEpisodeSpans(
      sessionReader,
      episode.spanRefs,
      input.channelId,
      input.accessScope === 'companion_self_reflection',
    ),
    arcSiblings: toArcSiblings(episode.id, visibleMemberships),
    threadSiblings,
  };
}

function unavailableSpan(
  spanRef: EpisodeSpanRef,
  reason: EpisodeSpanUnavailableReason,
): ExpandedEpisodeSpan {
  return { spanRef: { ...spanRef }, turns: [], unavailable: reason };
}

/**
 * Expand each span into its journal-current verbatim turns, fail-closed on both
 * availability and authorization:
 *   - a span whose source session was rolled out/compacted, or that is
 *     structurally incomplete/inverted, degrades to metadata-only (no throw) so
 *     one unavailable span never errors the whole drill-down (old episodes are
 *     the primary target and routinely have compacted sources);
 *   - verbatim turns are only expanded for spans that belong to the viewer's
 *     authorized channel. An episode can be visible cross-channel via a trusted
 *     contact-match yet carry spans/sessions the viewer was never present in —
 *     including consolidated, multi-participant episodes that union foreign
 *     turns. Those restore the prior cross-channel disclosure ceiling
 *     (title/landmark/meaning only). When a span's channel cannot be pinned to
 *     the authorized channel, it is NOT expanded.
 */
function expandEpisodeSpans(
  sessionReader: EpisodeDrilldownSessionReader,
  spanRefs: readonly EpisodeSpanRef[],
  authorizedChannelId: string,
  allowCrossChannel: boolean,
): ExpandedEpisodeSpan[] {
  const entriesBySession = new Map<string, SessionEntry[]>();

  return spanRefs.map((spanRef) => {
    const sessionId = spanRef.sessionId?.trim() || spanRef.channelId?.trim();
    const startTurnId = spanRef.startTurnId?.trim();
    const endTurnId = spanRef.endTurnId?.trim();
    if (!sessionId || !startTurnId || !endTurnId) {
      return unavailableSpan(spanRef, 'malformed');
    }

    let entries = entriesBySession.get(sessionId);
    if (!entries) {
      entries = sessionReader.getRecent(sessionId, Number.MAX_SAFE_INTEGER);
      entriesBySession.set(sessionId, entries);
    }

    const indexed = entries.map(entry => ({
      entry,
      turnId: resolveEpisodeSessionEntryTurnId(entry),
    }));
    const startIndex = indexed.findIndex(candidate => candidate.turnId === startTurnId);
    const reverseEndIndex = indexed.slice().reverse().findIndex(candidate => candidate.turnId === endTurnId);
    const endIndex = reverseEndIndex < 0 ? -1 : indexed.length - 1 - reverseEndIndex;
    if (startIndex < 0 || endIndex < 0) {
      return unavailableSpan(spanRef, 'compacted');
    }
    if (startIndex > endIndex) {
      return unavailableSpan(spanRef, 'reversed');
    }

    const roleEntries = indexed
      .slice(startIndex, endIndex + 1)
      .filter((candidate): candidate is typeof candidate & {
        entry: SessionEntry & { role: 'user' | 'assistant' };
      } => candidate.entry.role === 'user' || candidate.entry.role === 'assistant');

    // Per-span re-authorization: only the viewer's own authorized channel may
    // disclose raw turns. Any turn sourced from a different channel (or a span
    // whose channel cannot be determined) means the viewer was not a participant
    // of this specific span/session — withhold verbatim, keep metadata only.
    const spanChannels = new Set(roleEntries.map(({ entry }) => entry.channelId));
    const belongsToAuthorizedChannel = [...spanChannels]
      .every(channel => channel === authorizedChannelId);
    if (!allowCrossChannel && !belongsToAuthorizedChannel) {
      return unavailableSpan(spanRef, 'cross_channel');
    }

    const turns = roleEntries.map(({ entry, turnId }) => ({
      turnId,
      channelId: entry.channelId,
      role: entry.role,
      content: entry.content,
      timestamp: entry.timestamp,
      ...(entry.authorName ? { authorName: entry.authorName } : {}),
    }));

    return {
      spanRef: { ...spanRef },
      turns,
    };
  });
}

function toArcSiblings(
  rootEpisodeId: string,
  memberships: readonly EpisodeArcMembership[],
): EpisodeArcSibling[] {
  return memberships.map((membership) => {
    const sibling = membership.members.find(member => member.id !== rootEpisodeId);
    if (!sibling) {
      throw new Error(
        `episode arc "${membership.arc.id}" does not contain a sibling for "${rootEpisodeId}"`,
      );
    }
    return {
      arc: membership.arc,
      episode: sibling,
    };
  });
}
