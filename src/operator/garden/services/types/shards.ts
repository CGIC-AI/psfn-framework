import type {
  ShardFoldReviewDecision,
  ShardFoldReviewRecord,
  ShardFoldReviewState,
} from '../../../../faculties/shards/fold-review.js';

export interface AdminShardFoldReviewSummary {
  shardId: string;
  channelId: string;
  task: string;
  validationPath: string;
  reviewState: ShardFoldReviewState;
  createdAt: number;
  updatedAt: number;
  lastReviewedAt?: number;
  pendingMemoryCount: number;
  pendingArtifactCount: number;
  blockingReasons: string[];
  emotionalOrRelational: boolean;
}

export interface AdminShardFoldReviewListData {
  reviews: AdminShardFoldReviewSummary[];
}

export interface AdminShardFoldReviewResolveResult {
  ok: boolean;
  review?: ShardFoldReviewRecord;
  message?: string;
}

export interface AdminShardFoldReviewService {
  listShardFoldReviews(): Promise<AdminShardFoldReviewListData>;
  getShardFoldReview(shardId: string): Promise<ShardFoldReviewRecord | null>;
  resolveShardFoldReview(input: {
    shardId: string;
    decision: ShardFoldReviewDecision;
    actor?: string;
    note?: string;
  }): Promise<AdminShardFoldReviewResolveResult>;
}
