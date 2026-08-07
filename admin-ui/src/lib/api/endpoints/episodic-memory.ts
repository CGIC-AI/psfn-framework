import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import type {
  AdminEpisodicEpisodeDetailData,
  AdminEpisodicEpisodeListData,
  AdminEpisodicThreadDetailData,
  AdminEpisodicThreadListData,
} from '$lib/types';

export interface EpisodicEpisodeListParams {
  threadId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

function toQueryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params as Record<string, string | number | undefined>)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return withQuery('', search);
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
