import { apiGet } from '$lib/api/client';
import type {
  AdminEpisodicEpisodeDetailData,
  AdminEpisodicEpisodeListData,
  AdminEpisodicEpisodeProvenanceData,
  AdminEpisodicRelatedArcView,
  AdminEpisodicThreadDetailData,
  AdminEpisodicThreadListData,
  EpisodeArcKind,
} from '$lib/types';

export interface EpisodicEpisodeListParams {
  threadId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface EpisodicArcListParams {
  direction?: 'incoming' | 'outgoing' | 'both';
  arcKind?: EpisodeArcKind;
  limit?: number;
}

function toQueryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, string | number | undefined>)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export function listEpisodicEpisodes(
  params: EpisodicEpisodeListParams = {}
): Promise<AdminEpisodicEpisodeListData> {
  return apiGet<AdminEpisodicEpisodeListData>(
    `/api/admin/episodic-memory/episodes${toQueryString(params)}`
  );
}

export function getEpisodicEpisodeDetail(
  id: string
): Promise<AdminEpisodicEpisodeDetailData> {
  return apiGet<AdminEpisodicEpisodeDetailData>(
    `/api/admin/episodic-memory/episodes/${encodeURIComponent(id)}`
  );
}

export function getEpisodicEpisodeProvenance(
  id: string
): Promise<AdminEpisodicEpisodeProvenanceData> {
  return apiGet<AdminEpisodicEpisodeProvenanceData>(
    `/api/admin/episodic-memory/episodes/${encodeURIComponent(id)}/provenance`
  );
}

export function listEpisodicEpisodeArcs(
  id: string,
  params: EpisodicArcListParams = {}
): Promise<{ episodeId: string; relatedArcs: AdminEpisodicRelatedArcView[] }> {
  return apiGet<{ episodeId: string; relatedArcs: AdminEpisodicRelatedArcView[] }>(
    `/api/admin/episodic-memory/episodes/${encodeURIComponent(id)}/arcs${toQueryString(params)}`
  );
}

export function listEpisodicThreads(): Promise<AdminEpisodicThreadListData> {
  return apiGet<AdminEpisodicThreadListData>('/api/admin/episodic-memory/threads');
}

export function getEpisodicThreadDetail(
  threadId: string
): Promise<AdminEpisodicThreadDetailData> {
  return apiGet<AdminEpisodicThreadDetailData>(
    `/api/admin/episodic-memory/threads/${encodeURIComponent(threadId)}`
  );
}
