import { parseEpisode, type Episode } from '../../../shared/contracts/episodic-memory.js';
import {
  cloneRolledOutSessionBoundary,
  type RolledOutSessionBoundary,
} from '../../../core/session/rolled-out-session-boundary.js';
import type {
  EpisodicRetrievalChain,
  EpisodicRetrievalStore,
} from './episodic-types.js';

export async function retrieveRolledOutBreadcrumbs(input: {
  store: EpisodicRetrievalStore;
  boundary?: RolledOutSessionBoundary;
  maxChains: number;
  scanLimit: number;
  isVisible(episode: Episode): boolean;
}): Promise<EpisodicRetrievalChain[]> {
  if (!input.boundary) return [];
  const boundary = cloneRolledOutSessionBoundary(input.boundary);
  const episodes = await input.store.searchByTime({
    to: new Date(boundary.beforeMs).toISOString(),
    sessionId: boundary.sessionId,
    order: 'desc',
    limit: input.scanLimit,
  });

  return episodes
    .map(episode => parseEpisode(structuredClone(episode)))
    .filter(input.isVisible)
    .slice(0, input.maxChains)
    .map(episode => ({
      rootEpisodeId: episode.id,
      episodes: [episode],
      arcs: [],
      score: 0,
      matchedTerms: [],
    }));
}

/**
 * Breadcrumbs have first claim on the bounded block, but an explicit semantic
 * match always retains one slot unless it already enriches a breadcrumb root.
 */
export function mergePreferredBreadcrumbs(
  breadcrumbs: readonly EpisodicRetrievalChain[],
  rankedChains: readonly EpisodicRetrievalChain[],
  maxChains: number,
): EpisodicRetrievalChain[] {
  let merged = breadcrumbs.map(chain => structuredClone(chain));
  const indexByRootId = new Map(merged.map((chain, index) => [chain.rootEpisodeId, index]));
  let usedEpisodeIds = new Set(merged.flatMap(chain => chain.episodes.map(episode => episode.id)));

  for (const chain of rankedChains) {
    const breadcrumbIndex = indexByRootId.get(chain.rootEpisodeId);
    if (breadcrumbIndex === undefined) continue;
    const overlapsAnotherBreadcrumb = chain.episodes.some(episode => (
      episode.id !== chain.rootEpisodeId && usedEpisodeIds.has(episode.id)
    ));
    if (!overlapsAnotherBreadcrumb) {
      merged[breadcrumbIndex] = structuredClone(chain);
      usedEpisodeIds = new Set(merged.flatMap(item => item.episodes.map(episode => episode.id)));
    }
  }

  for (const chain of rankedChains) {
    if (usedEpisodeIds.has(chain.rootEpisodeId)) continue;
    const chainEpisodeIds = new Set(chain.episodes.map(episode => episode.id));
    merged = merged.filter(item => !chainEpisodeIds.has(item.rootEpisodeId));
    if (merged.length >= maxChains) {
      merged.splice(Math.max(0, maxChains - 1));
    }
    merged.push(structuredClone(chain));
    break;
  }

  return merged.slice(0, maxChains);
}
