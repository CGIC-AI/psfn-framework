import { apiGet, apiPatch, apiPost } from '$lib/api/client';
import type {
  AdminShardFoldReviewListData,
  AdminShardFoldReviewResolveResult,
} from '../../../../../src/operator/garden/services/types/shards.js';
import type { ShardFoldReviewRecord } from '../../../../../src/faculties/shards/fold-review.js';
import type {
  ShardConfigurationOverridePatch,
  ShardConfigurationSnapshot,
} from '../../../../../src/faculties/shards/types.js';

function shardPath(shardId: string): string {
  return `/api/admin/shards/${encodeURIComponent(shardId)}`;
}

export function listParentShards(): Promise<AdminShardFoldReviewListData> {
  return apiGet<AdminShardFoldReviewListData>('/api/admin/shards');
}

export function getShardFoldReview(shardId: string): Promise<ShardFoldReviewRecord> {
  return apiGet<ShardFoldReviewRecord>(shardPath(shardId));
}

export function resolveShardFoldReview(
  shardId: string,
  decision: 'approve' | 'deny',
  note?: string,
): Promise<AdminShardFoldReviewResolveResult> {
  return apiPost<AdminShardFoldReviewResolveResult>(
    `${shardPath(shardId)}/review`,
    {
      decision,
      ...(note?.trim() ? { note: note.trim() } : {}),
    },
  );
}

export function getShardConfiguration(shardId: string): Promise<ShardConfigurationSnapshot> {
  return apiGet<ShardConfigurationSnapshot>(`${shardPath(shardId)}/configuration`);
}

export function updateShardConfiguration(
  shardId: string,
  patch: ShardConfigurationOverridePatch,
): Promise<ShardConfigurationSnapshot> {
  return apiPatch<ShardConfigurationSnapshot>(
    `${shardPath(shardId)}/configuration`,
    patch,
  );
}
