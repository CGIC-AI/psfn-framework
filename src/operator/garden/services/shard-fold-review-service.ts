import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import type { ShardConfigurationPort } from '../../../faculties/shards/port.js';
import type { ShardFoldReviewRecord } from '../../../faculties/shards/fold-review.js';
import type {
  ShardConfigurationMutationResult,
  ShardConfigurationSnapshot,
} from '../../../faculties/shards/types.js';
import type {
  AdminShardFoldReviewListData,
  AdminShardFoldReviewResolveResult,
  AdminShardFoldReviewService,
  AdminShardFoldReviewSummary,
} from './types.js';
import type { AdminShardSummary } from './types/shards.js';
import type { GardenRequestContext } from '../garden-request-context.js';

const SHARD_FOLD_REVIEW_UNAVAILABLE = 'Shard fold review controller unavailable';
const SHARD_CONFIGURATION_UNAVAILABLE = 'Shard configuration controller unavailable';

type ParentScope =
  | { kind: 'scoped'; parentCompanionId: string }
  | { kind: 'unscoped' }
  | { kind: 'denied' };

/**
 * Resolve how a request should be scoped against the shared shard fold-review
 * store.
 *
 * - A context that names a parent companion (every fleet principal, and any
 *   companion-bound standalone transport whose config.companionId is set) is
 *   `scoped`: reviews, active shards, and configuration are filtered to that
 *   parent's lineage so one parent can never see or mutate another's shards.
 * - A standalone single-companion Garden whose transport did not carry a companion
 *   id is `unscoped`: that transport binds to exactly one companion's fold-review
 *   store, so there is no cross-parent surface to filter and fold review plus
 *   lineage stay visible exactly as the pre-fleet routes exposed them.
 * - Any other absence of an authenticated context (undefined, public) is
 *   `denied` and fails closed.
 */
function resolveParentScope(context: GardenRequestContext | undefined): ParentScope {
  if (!context) return { kind: 'denied' };
  const companionId = context.resource.companionId;
  if (typeof companionId === 'string' && companionId.length > 0) {
    return { kind: 'scoped', parentCompanionId: companionId };
  }
  if (context.kind === 'standalone_token') return { kind: 'unscoped' };
  return { kind: 'denied' };
}

function resolveActor(context: GardenRequestContext | undefined, requestedActor?: string): string {
  if (context?.kind === 'fleet_principal') {
    return `fleet-principal:${context.actor.principalId}`;
  }
  return requestedActor?.trim() || context?.actor.actorId || 'garden:unknown';
}

function belongsToParent(record: ShardFoldReviewRecord, parentCompanionId: string): boolean {
  return record.lineage.coreCompanionId === parentCompanionId
    && record.lineage.companionProvenance.parentCompanionId === parentCompanionId
    && record.lineage.shardId === record.shardId;
}

function activeShardBelongsToParent(
  shard: ReturnType<ShardExecutionPort['getActiveShards']>[number],
  parentCompanionId: string,
): boolean {
  return shard.lineage.coreCompanionId === parentCompanionId
    && shard.lineage.companionProvenance.parentCompanionId === parentCompanionId
    && shard.lineage.shardId === shard.id;
}

function toActiveShardSummary(
  shard: ReturnType<ShardExecutionPort['getActiveShards']>[number],
): AdminShardSummary {
  return {
    shardId: shard.id,
    name: shard.name,
    task: shard.task,
    startedAt: shard.startedAt,
    state: shard.state,
    health: shard.health,
    stateReason: shard.stateReason,
    parentCompanionId: shard.lineage.companionProvenance.parentCompanionId,
  };
}

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

function hasShardConfigurationPort(
  port: ShardExecutionPort,
): port is ShardExecutionPort & ShardConfigurationPort {
  return typeof port.getShardConfigurationSnapshot === 'function'
    && typeof port.updateShardConfigurationOverrides === 'function';
}

export class AdminShardFoldReviewDataService implements AdminShardFoldReviewService {
  constructor(private readonly shardManager: ShardExecutionPort) {}

  async listShardFoldReviews(
    context?: GardenRequestContext,
  ): Promise<AdminShardFoldReviewListData> {
    const scope = resolveParentScope(context);
    if (scope.kind === 'denied') return { reviews: [], shards: [] };
    const port = this.requirePort();
    const reviews = await port.listFoldReviews();
    const activeShards = this.shardManager.getActiveShards();
    if (scope.kind === 'unscoped') {
      return {
        reviews: reviews.map(toSummary),
        shards: activeShards.map(toActiveShardSummary),
      };
    }
    return {
      reviews: reviews
        .filter(review => belongsToParent(review, scope.parentCompanionId))
        .map(toSummary),
      shards: activeShards
        .filter(shard => activeShardBelongsToParent(shard, scope.parentCompanionId))
        .map(toActiveShardSummary),
    };
  }

  async getShardFoldReview(
    shardId: string,
    context?: GardenRequestContext,
  ): Promise<ShardFoldReviewRecord | null> {
    const scope = resolveParentScope(context);
    if (scope.kind === 'denied') return null;
    const port = this.requirePort();
    const review = await port.getFoldReview(shardId);
    if (!review) return null;
    if (scope.kind === 'unscoped') return review;
    return belongsToParent(review, scope.parentCompanionId) ? review : null;
  }

  async resolveShardFoldReview(input: {
    shardId: string;
    decision: 'approve' | 'deny';
    actor?: string;
    note?: string;
  }, context?: GardenRequestContext): Promise<AdminShardFoldReviewResolveResult> {
    const scope = resolveParentScope(context);
    if (scope.kind === 'denied') {
      return { ok: false, message: 'Shard fold review not found' };
    }
    const port = this.requirePort();
    if (scope.kind === 'scoped') {
      const existing = await port.getFoldReview(input.shardId);
      if (!existing || !belongsToParent(existing, scope.parentCompanionId)) {
        return { ok: false, message: 'Shard fold review not found' };
      }
    }
    const review = await port.resolveFoldReview({
      ...input,
      actor: resolveActor(context, input.actor),
    });
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

  async getShardConfiguration(
    shardId: string,
    context?: GardenRequestContext,
  ): Promise<ShardConfigurationSnapshot | null> {
    const scope = resolveParentScope(context);
    if (scope.kind !== 'scoped') return null;
    return this.requireConfigurationPort()
      .getShardConfigurationSnapshot(scope.parentCompanionId, shardId);
  }

  async updateShardConfiguration(
    shardId: string,
    override: unknown,
    context?: GardenRequestContext,
  ): Promise<ShardConfigurationMutationResult> {
    const scope = resolveParentScope(context);
    if (scope.kind !== 'scoped') {
      return { ok: false, code: 'not_found', message: 'Shard not found' };
    }
    return this.requireConfigurationPort().updateShardConfigurationOverrides({
      parentCompanionId: scope.parentCompanionId,
      shardId,
      actor: resolveActor(context),
      override,
    });
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

  private requireConfigurationPort(): ShardConfigurationPort {
    if (!hasShardConfigurationPort(this.shardManager)) {
      throw new Error(SHARD_CONFIGURATION_UNAVAILABLE);
    }
    return this.shardManager;
  }
}

export function isShardFoldReviewUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(SHARD_FOLD_REVIEW_UNAVAILABLE)
    || message.includes(SHARD_CONFIGURATION_UNAVAILABLE);
}
