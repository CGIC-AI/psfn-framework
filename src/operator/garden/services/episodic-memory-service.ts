import {
  EPISODE_ARC_KINDS,
  type Episode,
  type EpisodeArc,
  type EpisodeArcKind,
} from '../../../shared/contracts/episodic-memory.js';
import type { EpisodicStorePort } from '../../../faculties/memory/episodic/store.js';
import type {
  AdminEpisodicEpisodeDetailData,
  AdminEpisodicEpisodeListData,
  AdminEpisodicEpisodeProvenanceData,
  AdminEpisodicMemoryService,
  AdminEpisodicRelatedArcView,
  AdminEpisodicThreadDetailData,
  AdminEpisodicThreadListData,
  AdminEpisodicThreadSummary,
} from './types.js';

export type AdminEpisodicStore = Pick<
  EpisodicStorePort,
  | 'getEpisode'
  | 'getEpisodesByIds'
  | 'listEpisodeArcsForEpisode'
  | 'listEpisodeArcsForEpisodes'
  | 'listEpisodes'
  | 'searchByThread'
  | 'searchByTime'
>;

const DEFAULT_EPISODE_LIST_LIMIT = 50;
const DEFAULT_ARC_LIST_LIMIT = 100;
const MAX_EPISODIC_SCAN_LIMIT = 1000;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
  max: number,
  field: string,
): number {
  if (value === null || value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${field} must be an integer between 1 and ${max}`);
  }
  return parsed;
}

function parseOffset(value: string | null | undefined): number {
  if (value === null || value === undefined || value.trim() === '') return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return parsed;
}

function parseIsoInstant(value: string | null | undefined, field: string): string | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const trimmed = value.trim();
  if (!ISO_INSTANT_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC instant`);
  }
  return trimmed;
}

function parseThreadId(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseArcKind(value: string | null | undefined): EpisodeArcKind | undefined {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim();
  if (!(EPISODE_ARC_KINDS as readonly string[]).includes(normalized)) {
    throw new Error(`arcKind must be one of: ${EPISODE_ARC_KINDS.join(', ')}`);
  }
  return normalized as EpisodeArcKind;
}

function parseArcDirection(value: string | null | undefined): 'incoming' | 'outgoing' | 'both' {
  if (value === null || value === undefined || value.trim() === '') return 'both';
  const normalized = value.trim();
  if (normalized !== 'incoming' && normalized !== 'outgoing' && normalized !== 'both') {
    throw new Error('direction must be incoming, outgoing, or both');
  }
  return normalized;
}

function compareEpisodeRecency(left: Episode, right: Episode): number {
  if (right.startedAt !== left.startedAt) return right.startedAt.localeCompare(left.startedAt);
  return right.id.localeCompare(left.id);
}

function compareEpisodeChronology(left: Episode, right: Episode): number {
  if (left.startedAt !== right.startedAt) return left.startedAt.localeCompare(right.startedAt);
  return left.id.localeCompare(right.id);
}

function compareThreadRecency(left: AdminEpisodicThreadSummary, right: AdminEpisodicThreadSummary): number {
  if (right.endedAt !== left.endedAt) return right.endedAt.localeCompare(left.endedAt);
  return left.threadId.localeCompare(right.threadId);
}

function topThemes(episodes: readonly Episode[]): string[] {
  const counts = new Map<string, number>();
  for (const episode of episodes) {
    for (const theme of episode.themes) {
      counts.set(theme, (counts.get(theme) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => {
      if (right[1] !== left[1]) return right[1] - left[1];
      return left[0].localeCompare(right[0]);
    })
    .slice(0, 6)
    .map(([theme]) => theme);
}

function averageSalience(episodes: readonly Episode[]): number {
  if (episodes.length === 0) return 0;
  const total = episodes.reduce((sum, episode) => sum + episode.salience.score, 0);
  return Number((total / episodes.length).toFixed(3));
}

export class AdminEpisodicMemoryDataService implements AdminEpisodicMemoryService {
  constructor(private readonly store: AdminEpisodicStore) {}

  async listEpisodes(params?: URLSearchParams): Promise<AdminEpisodicEpisodeListData> {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_EPISODE_LIST_LIMIT,
      MAX_EPISODIC_SCAN_LIMIT,
      'limit',
    );
    const offset = parseOffset(params?.get('offset'));
    const threadId = parseThreadId(params?.get('threadId'));
    const from = parseIsoInstant(params?.get('from'), 'from');
    const to = parseIsoInstant(params?.get('to'), 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must be before or equal to to');
    }

    const episodes = (await this.loadEpisodeCandidates({ threadId, from, to }))
      .sort(compareEpisodeRecency);
    const page = episodes.slice(offset, offset + limit);

    return {
      episodes: page,
      pagination: {
        limit,
        offset,
        total: episodes.length,
        hasPrevious: offset > 0,
        hasNext: offset + page.length < episodes.length,
      },
      filters: {
        ...(threadId ? { threadId } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      },
    };
  }

  async getEpisodeDetail(id: string): Promise<AdminEpisodicEpisodeDetailData | null> {
    const episode = await this.store.getEpisode(id);
    if (!episode) return null;
    const provenance = this.toProvenanceData(episode);
    return {
      episode,
      ...provenance,
      relatedArcs: await this.buildRelatedArcViews(episode.id),
      threadEpisodes: episode.threadId
        ? (await this.store.searchByThread(episode.threadId, { limit: MAX_EPISODIC_SCAN_LIMIT }))
          .sort(compareEpisodeChronology)
        : [],
    };
  }

  async getEpisodeProvenance(id: string): Promise<AdminEpisodicEpisodeProvenanceData | null> {
    const episode = await this.store.getEpisode(id);
    return episode ? this.toProvenanceData(episode) : null;
  }

  async listEpisodeArcs(
    id: string,
    params?: URLSearchParams,
  ): Promise<{ episodeId: string; relatedArcs: AdminEpisodicRelatedArcView[] } | null> {
    if (!(await this.store.getEpisode(id))) return null;
    const direction = parseArcDirection(params?.get('direction'));
    const arcKind = parseArcKind(params?.get('arcKind'));
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_ARC_LIST_LIMIT,
      MAX_EPISODIC_SCAN_LIMIT,
      'limit',
    );
    return {
      episodeId: id,
      relatedArcs: await this.buildRelatedArcViews(id, { direction, arcKind, limit }),
    };
  }

  async listThreads(params?: URLSearchParams): Promise<AdminEpisodicThreadListData> {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      MAX_EPISODIC_SCAN_LIMIT,
      MAX_EPISODIC_SCAN_LIMIT,
      'limit',
    );
    const threads = (await this.buildThreadSummaries(await this.store.listEpisodes({ limit })))
      .sort(compareThreadRecency);
    return { threads };
  }

  async getThreadDetail(threadId: string): Promise<AdminEpisodicThreadDetailData | null> {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) return null;

    const episodes = (await this.store.searchByThread(normalizedThreadId, { limit: MAX_EPISODIC_SCAN_LIMIT }))
      .sort(compareEpisodeChronology);
    if (episodes.length === 0) return null;

    const arcs = await this.collectArcsForEpisodes(episodes);
    const thread = this.summarizeThread(normalizedThreadId, episodes, arcs);
    return {
      thread,
      episodes,
      arcs,
      relatedArcs: await this.buildThreadRelatedArcViews(new Set(episodes.map(episode => episode.id)), arcs),
    };
  }

  private async loadEpisodeCandidates(options: {
    threadId?: string;
    from?: string;
    to?: string;
  }): Promise<Episode[]> {
    const hasTimeFilter = options.from !== undefined || options.to !== undefined;
    if (options.threadId && !hasTimeFilter) {
      return await this.store.searchByThread(options.threadId, { limit: MAX_EPISODIC_SCAN_LIMIT });
    }

    const timeMatches = hasTimeFilter
      ? await this.store.searchByTime({
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
        limit: MAX_EPISODIC_SCAN_LIMIT,
      })
      : await this.store.listEpisodes({ limit: MAX_EPISODIC_SCAN_LIMIT });

    return options.threadId
      ? timeMatches.filter(episode => episode.threadId === options.threadId)
      : timeMatches;
  }

  private toProvenanceData(episode: Episode): AdminEpisodicEpisodeProvenanceData {
    return {
      episodeId: episode.id,
      spanRefs: episode.spanRefs,
      artifactRefs: episode.artifactRefs,
      provenanceRefs: episode.provenanceRefs,
    };
  }

  private async buildRelatedArcViews(
    episodeId: string,
    options: {
      direction?: 'incoming' | 'outgoing' | 'both';
      arcKind?: EpisodeArcKind;
      limit?: number;
    } = {},
  ): Promise<AdminEpisodicRelatedArcView[]> {
    const arcs = await this.store.listEpisodeArcsForEpisode(episodeId, {
      direction: options.direction ?? 'both',
      ...(options.arcKind ? { arcKind: options.arcKind } : {}),
      limit: options.limit ?? DEFAULT_ARC_LIST_LIMIT,
    });
    return await this.toRelatedArcViews(episodeId, arcs);
  }

  private async toRelatedArcViews(
    episodeId: string,
    arcs: readonly EpisodeArc[],
  ): Promise<AdminEpisodicRelatedArcView[]> {
    const relatedEpisodeIds = arcs.map(arc => this.getRelatedEpisodeIdForEpisode(episodeId, arc));
    const relatedEpisodes = await this.getEpisodeMap(relatedEpisodeIds);
    return arcs.map((arc) => {
      const direction = arc.sourceEpisodeId === episodeId ? 'outgoing' : 'incoming';
      const relatedEpisodeId = this.getRelatedEpisodeIdForEpisode(episodeId, arc);
      return {
        arc,
        direction,
        relatedEpisode: relatedEpisodes.get(relatedEpisodeId) ?? null,
      };
    });
  }

  private getRelatedEpisodeIdForEpisode(episodeId: string, arc: EpisodeArc): string {
    const direction = arc.sourceEpisodeId === episodeId ? 'outgoing' : 'incoming';
    return direction === 'outgoing' ? arc.targetEpisodeId : arc.sourceEpisodeId;
  }

  private async buildThreadSummaries(episodes: readonly Episode[]): Promise<AdminEpisodicThreadSummary[]> {
    const byThread = new Map<string, Episode[]>();
    for (const episode of episodes) {
      if (!episode.threadId) continue;
      const group = byThread.get(episode.threadId) ?? [];
      group.push(episode);
      byThread.set(episode.threadId, group);
    }

    const arcsByThread = await this.collectArcsByThread(byThread);
    return [...byThread.entries()].map(([threadId, threadEpisodes]) => {
      const sorted = [...threadEpisodes].sort(compareEpisodeChronology);
      const arcs = arcsByThread.get(threadId) ?? [];
      return this.summarizeThread(threadId, sorted, arcs);
    });
  }

  private summarizeThread(
    threadId: string,
    episodes: readonly Episode[],
    arcs: readonly EpisodeArc[],
  ): AdminEpisodicThreadSummary {
    const sorted = [...episodes].sort(compareEpisodeChronology);
    const latest = [...episodes].sort(compareEpisodeRecency)[0]!;
    return {
      threadId,
      episodeCount: episodes.length,
      arcCount: arcs.length,
      startedAt: sorted[0]!.startedAt,
      endedAt: sorted.at(-1)!.endedAt,
      topThemes: topThemes(episodes),
      salienceScore: averageSalience(episodes),
      latestEpisodeId: latest.id,
      latestEpisodeTitle: latest.title,
    };
  }

  private async collectArcsForEpisodes(episodes: readonly Episode[]): Promise<EpisodeArc[]> {
    if (episodes.length === 0) return [];
    const episodeIds = episodes.map(episode => episode.id);
    const arcs = await this.store.listEpisodeArcsForEpisodes(episodeIds, {
      direction: 'both',
      limit: MAX_EPISODIC_SCAN_LIMIT,
    });
    return this.sortAndDeduplicateArcs(arcs);
  }

  private async collectArcsByThread(
    byThread: ReadonlyMap<string, readonly Episode[]>,
  ): Promise<Map<string, EpisodeArc[]>> {
    const allThreadEpisodes = [...byThread.values()].flat();
    const allArcs = await this.collectArcsForEpisodes(allThreadEpisodes);
    const result = new Map<string, EpisodeArc[]>();
    for (const [threadId, episodes] of byThread.entries()) {
      const episodeIds = new Set(episodes.map(episode => episode.id));
      result.set(
        threadId,
        allArcs.filter(arc => (
          episodeIds.has(arc.sourceEpisodeId) || episodeIds.has(arc.targetEpisodeId)
        )),
      );
    }
    return result;
  }

  private sortAndDeduplicateArcs(arcs: readonly EpisodeArc[]): EpisodeArc[] {
    const byId = new Map<string, EpisodeArc>();
    for (const arc of arcs) {
      byId.set(arc.id, arc);
    }
    return [...byId.values()].sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
      return left.id.localeCompare(right.id);
    });
  }

  private async buildThreadRelatedArcViews(
    threadEpisodeIds: ReadonlySet<string>,
    arcs: readonly EpisodeArc[],
  ): Promise<AdminEpisodicRelatedArcView[]> {
    const relatedEpisodeIds = arcs.map((arc) => {
      const sourceInThread = threadEpisodeIds.has(arc.sourceEpisodeId);
      const direction = sourceInThread ? 'outgoing' : 'incoming';
      return direction === 'outgoing' ? arc.targetEpisodeId : arc.sourceEpisodeId;
    });
    const relatedEpisodes = await this.getEpisodeMap(relatedEpisodeIds);
    return arcs.map((arc) => {
      const sourceInThread = threadEpisodeIds.has(arc.sourceEpisodeId);
      const direction = sourceInThread ? 'outgoing' : 'incoming';
      const relatedEpisodeId = direction === 'outgoing' ? arc.targetEpisodeId : arc.sourceEpisodeId;
      return {
        arc,
        direction,
        relatedEpisode: relatedEpisodes.get(relatedEpisodeId) ?? null,
      };
    });
  }

  private async getEpisodeMap(ids: readonly string[]): Promise<Map<string, Episode>> {
    if (ids.length === 0) return new Map();
    const episodes = await this.store.getEpisodesByIds(ids);
    return new Map(episodes.map(episode => [episode.id, episode]));
  }
}
