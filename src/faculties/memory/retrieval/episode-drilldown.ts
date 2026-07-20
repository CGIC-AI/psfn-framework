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
import { resolveEpisodeSessionEntryTurnId } from '../episodic/turn-reference.js';
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

export interface ExpandedEpisodeSpan {
  spanRef: EpisodeSpanRef;
  turns: EpisodeDrilldownTurn[];
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
        + `${sibling.episode.title} (${sibling.episode.id}) — ${sibling.episode.landmark}`,
      );
    }
  }

  lines.push(`Thread siblings (${result.threadSiblings.length}):`);
  if (result.threadSiblings.length === 0) {
    lines.push('- None.');
  } else {
    for (const sibling of result.threadSiblings) {
      lines.push(`- ${sibling.title} (${sibling.id}) — ${sibling.landmark}`);
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
  const visibilityInput = {
    contextText: '',
    channelId: input.channelId,
    trustLevel: input.trustLevel,
    channelDisclosure: input.channelDisclosure,
    ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
  };
  if (!isEpisodeVisibleForTurn(episode, visibilityInput)) return null;

  const memberships = await listEpisodeArcMemberships(store, episode.id, {
    limit: input.siblingLimit,
  });
  const visibleMemberships = memberships.filter(membership => (
    membership.members.every(member => isEpisodeVisibleForTurn(member, visibilityInput))
  ));

  const threadSiblings = episode.threadId
    ? (await store.searchByThread(episode.threadId, {
      limit: input.siblingLimit + 1,
    }))
      .map(candidate => parseEpisode(candidate))
      .filter(candidate => (
        candidate.id !== episode.id
        && isEpisodeVisibleForTurn(candidate, visibilityInput)
      ))
      .slice(0, input.siblingLimit)
    : [];

  return {
    episode,
    spans: expandEpisodeSpans(sessionReader, episode.spanRefs),
    arcSiblings: toArcSiblings(episode.id, visibleMemberships),
    threadSiblings,
  };
}

function expandEpisodeSpans(
  sessionReader: EpisodeDrilldownSessionReader,
  spanRefs: readonly EpisodeSpanRef[],
): ExpandedEpisodeSpan[] {
  const entriesBySession = new Map<string, SessionEntry[]>();

  return spanRefs.map((spanRef) => {
    const sessionId = spanRef.sessionId?.trim() || spanRef.channelId?.trim();
    const startTurnId = spanRef.startTurnId?.trim();
    const endTurnId = spanRef.endTurnId?.trim();
    if (!sessionId || !startTurnId || !endTurnId) {
      throw new Error(
        `episode span "${spanRef.spanId}" is missing sessionId/channelId or turn boundaries`,
      );
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
    const endIndex = indexed.findLastIndex(candidate => candidate.turnId === endTurnId);
    if (startIndex < 0 || endIndex < 0) {
      throw new Error(
        `episode span "${spanRef.spanId}" turn boundaries are unavailable in session "${sessionId}"`,
      );
    }
    if (startIndex > endIndex) {
      throw new Error(
        `episode span "${spanRef.spanId}" turn boundaries are reversed in session "${sessionId}"`,
      );
    }

    const turns = indexed
      .slice(startIndex, endIndex + 1)
      .filter((candidate): candidate is typeof candidate & {
        entry: SessionEntry & { role: 'user' | 'assistant' };
      } => candidate.entry.role === 'user' || candidate.entry.role === 'assistant')
      .map(({ entry, turnId }) => ({
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
