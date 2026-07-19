import type {
  ShardFoldReviewDecision,
  ShardFoldReviewRecord,
  ShardFoldReviewState,
} from '../../../../faculties/shards/fold-review.js';
import type {
  ShardConfigurationMutationResult,
  ShardConfigurationSnapshot,
} from '../../../../faculties/shards/types.js';
import type { GardenRequestContext } from '../../garden-request-context.js';

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
  shards: AdminShardSummary[];
}

export interface AdminShardSummary {
  shardId: string;
  name: string;
  task: string;
  startedAt: number;
  state: import('../../../../faculties/shards/types.js').ShardLifecycleState;
  health: import('../../../../faculties/shards/types.js').ShardHealthState;
  stateReason: string;
  parentCompanionId: string;
}

export interface AdminShardFoldReviewResolveResult {
  ok: boolean;
  review?: ShardFoldReviewRecord;
  message?: string;
}

export interface AdminShardFoldReviewService {
  listShardFoldReviews(context?: GardenRequestContext): Promise<AdminShardFoldReviewListData>;
  getShardFoldReview(
    shardId: string,
    context?: GardenRequestContext,
  ): Promise<ShardFoldReviewRecord | null>;
  resolveShardFoldReview(input: {
    shardId: string;
    decision: ShardFoldReviewDecision;
    actor?: string;
    note?: string;
  }, context?: GardenRequestContext): Promise<AdminShardFoldReviewResolveResult>;
  getShardConfiguration(
    shardId: string,
    context?: GardenRequestContext,
  ): Promise<ShardConfigurationSnapshot | null>;
  updateShardConfiguration(
    shardId: string,
    override: unknown,
    context?: GardenRequestContext,
  ): Promise<ShardConfigurationMutationResult>;
}
