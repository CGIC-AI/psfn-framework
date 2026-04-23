import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { ShardFoldReviewRecord } from '../../../faculties/shards/fold-review.js';
import type {
  AdminShardFoldReviewListData,
  AdminShardFoldReviewResolveResult,
  AdminShardFoldReviewService,
  AdminShardFoldReviewSummary,
} from './types.js';

const SHARD_FOLD_REVIEW_UNAVAILABLE = 'Shard fold review controller unavailable';

function toSummary(record: ShardFoldReviewRecord): AdminShardFoldReviewSummary {
  return {
    shardId: record.shardId,
    channelId: record.channelId,
    task: record.task,
    validationPath: record.validationPath,
    reviewState: record.reviewState,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastReviewedAt ? { lastReviewedAt: record.lastReviewedAt } : {}),
    pendingMemoryCount: record.memoryItems.filter(item => item.reviewState === 'pending').length,
    pendingArtifactCount: record.artifactItems.filter(item => item.reviewState === 'pending').length,
    blockingReasons: [...record.blockingReasons],
    emotionalOrRelational: record.visibilitySignals.emotionalOrRelational,
  };
}

function hasShardFoldReviewPort(port: ShardExecutionPort): port is ShardExecutionPort & Required<Pick<
  ShardExecutionPort,
  'listFoldReviews' | 'getFoldReview' | 'resolveFoldReview'
>> {
  return (
    typeof port.listFoldReviews === 'function'
    && typeof port.getFoldReview === 'function'
    && typeof port.resolveFoldReview === 'function'
  );
}

export class AdminShardFoldReviewDataService implements AdminShardFoldReviewService {
  constructor(private readonly shardManager: ShardExecutionPort) {}

  async listShardFoldReviews(): Promise<AdminShardFoldReviewListData> {
    const port = this.requirePort();
    const reviews = await port.listFoldReviews();
    return {
      reviews: reviews.map(toSummary),
    };
  }

  async getShardFoldReview(shardId: string): Promise<ShardFoldReviewRecord | null> {
    const port = this.requirePort();
    return await port.getFoldReview(shardId);
  }

  async resolveShardFoldReview(input: {
    shardId: string;
    decision: 'approve' | 'deny';
    actor?: string;
    note?: string;
  }): Promise<AdminShardFoldReviewResolveResult> {
    const port = this.requirePort();
    const review = await port.resolveFoldReview(input);
    if (!review) {
      return {
        ok: false,
        message: 'Shard fold review not found',
      };
    }
    return {
      ok: true,
      review,
    };
  }

  private requirePort(): Required<Pick<
    ShardExecutionPort,
    'listFoldReviews' | 'getFoldReview' | 'resolveFoldReview'
  >> {
    if (!hasShardFoldReviewPort(this.shardManager)) {
      throw new Error(SHARD_FOLD_REVIEW_UNAVAILABLE);
    }
    return this.shardManager;
  }
}

export function isShardFoldReviewUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SHARD_FOLD_REVIEW_UNAVAILABLE);
}
