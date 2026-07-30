import type {
  Episode,
  EpisodeArc,
  EpisodeArtifactRef,
  EpisodeProvenanceRef,
  EpisodeSpanRef,
} from '../../../../shared/contracts/episodic-memory.js';
import type { GardenRequestContext } from '../../garden-request-context.js';

export interface AdminEpisodicEpisodeListData {
  episodes: Episode[];
  /** Owner-only count; omitted for non-owner principals to avoid existence leakage. */
  withheldBySubjectAuthorizationCount?: number;
  pagination: {
    limit: number;
    offset: number;
    total: number;
    hasPrevious: boolean;
    hasNext: boolean;
  };
  filters: {
    threadId?: string;
    from?: string;
    to?: string;
  };
}

export interface AdminEpisodicRelatedArcView {
  arc: EpisodeArc;
  direction: 'incoming' | 'outgoing';
  relatedEpisode: Episode | null;
}

export interface AdminEpisodicEpisodeProvenanceData {
  episodeId: string;
  spanRefs: EpisodeSpanRef[];
  artifactRefs: EpisodeArtifactRef[];
  provenanceRefs: EpisodeProvenanceRef[];
}

export interface AdminEpisodicEpisodeDetailData extends AdminEpisodicEpisodeProvenanceData {
  episode: Episode;
  relatedArcs: AdminEpisodicRelatedArcView[];
  threadEpisodes: Episode[];
}

export interface AdminEpisodicThreadSummary {
  threadId: string;
  episodeCount: number;
  arcCount: number;
  startedAt: string;
  endedAt: string;
  topThemes: string[];
  salienceScore: number;
  latestEpisodeId: string;
  latestEpisodeTitle: string;
}

export interface AdminEpisodicThreadListData {
  threads: AdminEpisodicThreadSummary[];
}

export interface AdminEpisodicThreadDetailData {
  thread: AdminEpisodicThreadSummary;
  episodes: Episode[];
  arcs: EpisodeArc[];
  relatedArcs: AdminEpisodicRelatedArcView[];
}

export interface AdminEpisodicMemoryService {
  listEpisodes(params?: URLSearchParams, context?: GardenRequestContext): Promise<AdminEpisodicEpisodeListData>;
  getEpisodeDetail(id: string, context?: GardenRequestContext): Promise<AdminEpisodicEpisodeDetailData | null>;
  getEpisodeProvenance(id: string, context?: GardenRequestContext): Promise<AdminEpisodicEpisodeProvenanceData | null>;
  listEpisodeArcs(
    id: string,
    params?: URLSearchParams,
    context?: GardenRequestContext,
  ): Promise<{ episodeId: string; relatedArcs: AdminEpisodicRelatedArcView[] } | null>;
  listThreads(params?: URLSearchParams, context?: GardenRequestContext): Promise<AdminEpisodicThreadListData>;
  getThreadDetail(threadId: string, context?: GardenRequestContext): Promise<AdminEpisodicThreadDetailData | null>;
}
