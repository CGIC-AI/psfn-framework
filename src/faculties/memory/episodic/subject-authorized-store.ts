import type { Episode, EpisodeArc } from '../../../shared/contracts/episodic-memory.js';
import type { EpisodicStorePort } from './store-port.js';

/**
 * The read surface the Garden episodic admin service consumes. Kept as a
 * Pick of the full store port so the subject-authorized projection can never
 * accidentally expose a write or maintenance method.
 */
export type SubjectScopedEpisodicReadStore = Pick<
  EpisodicStorePort,
  | 'getEpisode'
  | 'getEpisodesByIds'
  | 'listEpisodeArcsForEpisode'
  | 'listEpisodeArcsForEpisodes'
  | 'listEpisodes'
  | 'searchByThread'
  | 'searchByTime'
>;

export interface EpisodicSubjectAccessContext {
  /**
   * Must come from the authenticated fleet request context (the signed
   * capability's contact binding), never from tool or request parameters.
   */
  viewerContactId: string;
}

export function isEpisodeVisibleToSubject(
  episode: Episode,
  viewerContactId: string,
): boolean {
  const normalized = viewerContactId.trim();
  return normalized.length > 0 && episode.participantContactIds.includes(normalized);
}

/**
 * Project the broad episodic store into a subject-scoped read store (88u3):
 * an episode is visible only when the viewer contact is one of its explicitly
 * attributed participants (`participantContactIds`; room participation alone
 * never populates that field). Fail closed: episodes with no participant
 * attribution are invisible, and an arc is visible only when BOTH of its
 * endpoint episodes are visible. Named reads never fall back to the raw
 * store.
 */
export function createSubjectAuthorizedEpisodicStore(
  store: SubjectScopedEpisodicReadStore,
  context: EpisodicSubjectAccessContext,
): SubjectScopedEpisodicReadStore {
  const viewerContactId = context.viewerContactId.trim();
  if (!viewerContactId) {
    throw new Error('Episodic memory access requires a trusted viewer contact');
  }

  const isVisible = (episode: Episode): boolean => (
    isEpisodeVisibleToSubject(episode, viewerContactId)
  );
  const filterEpisodes = (episodes: readonly Episode[]): Episode[] => episodes.filter(isVisible);
  const filterArcsToVisibleEndpoints = async (
    arcs: readonly EpisodeArc[],
  ): Promise<EpisodeArc[]> => {
    if (arcs.length === 0) return [];
    const endpointIds = [...new Set(
      arcs.flatMap(arc => [arc.sourceEpisodeId, arc.targetEpisodeId]),
    )];
    const endpointEpisodes = await store.getEpisodesByIds(endpointIds);
    const visibleIds = new Set(filterEpisodes(endpointEpisodes).map(episode => episode.id));
    return arcs.filter(arc => (
      visibleIds.has(arc.sourceEpisodeId) && visibleIds.has(arc.targetEpisodeId)
    ));
  };

  return {
    getEpisode: async (id) => {
      const episode = await store.getEpisode(id);
      return episode && isVisible(episode) ? episode : undefined;
    },
    getEpisodesByIds: async ids => filterEpisodes(await store.getEpisodesByIds(ids)),
    listEpisodes: async options => filterEpisodes(await store.listEpisodes(options)),
    searchByTime: async options => filterEpisodes(await store.searchByTime(options)),
    searchByThread: async (threadId, options) => (
      filterEpisodes(await store.searchByThread(threadId, options))
    ),
    listEpisodeArcsForEpisode: async (episodeId, options) => {
      const anchor = await store.getEpisode(episodeId);
      if (!anchor || !isVisible(anchor)) return [];
      return await filterArcsToVisibleEndpoints(
        await store.listEpisodeArcsForEpisode(episodeId, options),
      );
    },
    listEpisodeArcsForEpisodes: async (episodeIds, options) => {
      const anchors = filterEpisodes(await store.getEpisodesByIds(episodeIds));
      if (anchors.length === 0) return [];
      return await filterArcsToVisibleEndpoints(
        await store.listEpisodeArcsForEpisodes(anchors.map(episode => episode.id), options),
      );
    },
  };
}
