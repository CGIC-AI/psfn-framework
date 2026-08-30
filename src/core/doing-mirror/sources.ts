import type {
  ShardFoldReviewPort,
  ShardFoldReviewRecord,
} from '../../faculties/shards/fold-review.js';
import type { PersonalWishlist } from '../../faculties/wiki/personal-wishlist.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { DoingMirrorSourceItem, DoingMirrorSourcePort } from './contracts.js';

function wishSource(wish: ReturnType<PersonalWishlist['getWish']>): DoingMirrorSourceItem {
  const createdAt = Date.parse(wish.createdAt);
  if (!Number.isFinite(createdAt)) throw new Error(`wishlist item ${wish.ref} has an invalid createdAt`);
  return {
    itemType: 'wishlist',
    itemId: wish.id,
    ref: wish.ref,
    title: wish.text,
    ...(wish.context ? { summary: wish.context } : {}),
    createdAt,
    origin: {
      kind: 'companion',
      provenanceRefs: [`wiki:wishlist.wish.${wish.id}`],
    },
  };
}

export class WishlistDoingMirrorSource implements DoingMirrorSourcePort {
  readonly itemType = 'wishlist' as const;

  constructor(private readonly wishlist: PersonalWishlist) {}

  async list(): Promise<DoingMirrorSourceItem[]> {
    return this.wishlist.listWishes().map(wishSource);
  }

  async get(itemId: string): Promise<DoingMirrorSourceItem | null> {
    try {
      return wishSource(this.wishlist.getWish(itemId));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('wish not found:')) return null;
      throw error;
    }
  }
}

function assertFoldOrigin(record: ShardFoldReviewRecord, companionId: CompanionId): void {
  if (
    record.lineage.coreCompanionId !== companionId
    || record.lineage.companionProvenance.parentCompanionId !== companionId
    || record.lineage.shardId !== record.shardId
  ) {
    throw new Error(`fold package ${record.shardId} does not prove origin from this companion`);
  }
}

function foldSource(record: ShardFoldReviewRecord, companionId: CompanionId): DoingMirrorSourceItem {
  assertFoldOrigin(record, companionId);
  return {
    itemType: 'fold_package',
    itemId: record.shardId,
    ref: `fold:${record.shardId}`,
    title: record.task,
    summary: `Fold review state: ${record.reviewState}`,
    createdAt: record.createdAt,
    origin: {
      kind: 'companion',
      provenanceRefs: [
        `companion:${companionId}`,
        `shard:${record.shardId}`,
        `fold-review:${record.validationPath}`,
      ],
    },
  };
}

export class FoldPackageDoingMirrorSource implements DoingMirrorSourcePort {
  readonly itemType = 'fold_package' as const;

  constructor(
    private readonly folds: Pick<ShardFoldReviewPort, 'listFoldReviews' | 'getFoldReview'>,
    private readonly companionId: CompanionId,
  ) {}

  async list(): Promise<DoingMirrorSourceItem[]> {
    return (await this.folds.listFoldReviews()).map(record => foldSource(record, this.companionId));
  }

  async get(itemId: string): Promise<DoingMirrorSourceItem | null> {
    const record = await this.folds.getFoldReview(itemId);
    return record ? foldSource(record, this.companionId) : null;
  }
}
