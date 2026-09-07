import type {
  ShardFoldReviewPort,
  ShardFoldReviewRecord,
} from '../../faculties/shards/fold-review.js';
import type { PersonalWishlist } from '../../faculties/wiki/personal-wishlist.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { randomUUID } from 'node:crypto';

import type {
  DoingMirrorSourceDispositionInput,
  DoingMirrorSourceItem,
  DoingMirrorSourcePort,
  DoingMirrorStorePort,
} from './contracts.js';

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

const CLOSED_BEFORE_MIRROR_SUBJECT = 'Closed before the doing mirror recorded dispositions';
const CLOSED_BEFORE_MIRROR_BODY = [
  'This wish was already closed in the Garden before dispositions carried Letters.',
  'No Letter was written for it, and none is sent now.',
].join(' ');

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

  /**
   * psfn-framework-p4rmp: keep the wiki wish state and the doing-mirror
   * disposition from disagreeing. `considering` acknowledges without disturbing
   * a wish already planned against a bead; the terminal states close the wish.
   * Every branch is idempotent, so a redelivery pass is a no-op.
   */
  async applyDisposition(input: DoingMirrorSourceDispositionInput): Promise<void> {
    switch (input.state) {
      case 'considering':
        this.wishlist.acknowledgeWish(input.itemId);
        return;
      case 'done':
        this.wishlist.completeWish(input.itemId);
        return;
      case 'declined':
        if (!input.reason) {
          throw new Error('a declined wishlist disposition must carry its companion-visible reason');
        }
        this.wishlist.declineWish(input.itemId, input.reason);
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

/**
 * psfn-framework-p4rmp: wishes closed in the Garden before the doing-mirror
 * lifecycle existed have no disposition row, so the mirror would project them
 * as `open` while the wiki calls them terminal. Record the terminal disposition
 * they already have.
 *
 * The stored notification text is a system notice, not Partner-authored words:
 * these rows are stamped delivered at the moment they are written and their
 * Letter is deliberately never composed, because no Letter was ever sent for a
 * wish closed before the lifecycle existed. Backfilling one would put words the
 * Partner never wrote into the companion's bin.
 *
 * Idempotent: a wish that already has a disposition row is left untouched.
 */
export async function reconcileClosedWishDispositions(input: {
  wishlist: Pick<PersonalWishlist, 'listWishes'>;
  store: DoingMirrorStorePort;
  createId?: () => string;
}): Promise<{ reconciled: number }> {
  const createId = input.createId ?? randomUUID;
  const closed = input.wishlist.listWishes(['done', 'declined']);
  let reconciled = 0;
  for (const wish of closed) {
    if (await input.store.get('wishlist', wish.id)) continue;
    const state = wish.state === 'declined' ? 'declined' as const : 'done' as const;
    const closedAt = Date.parse(
      (state === 'declined' ? wish.declinedAt : wish.completedAt) ?? wish.updatedAt,
    );
    if (!Number.isSafeInteger(closedAt) || closedAt < 0) {
      throw new Error(`wishlist item ${wish.ref} has an invalid closure timestamp`);
    }
    const reason = state === 'declined'
      ? wish.declineReason ?? 'Declined before the doing mirror recorded reasons.'
      : undefined;
    const letterId = createId();
    const record = await input.store.transition({
      itemType: 'wishlist',
      itemId: wish.id,
      expectedState: 'open',
      expectedVersion: 0,
      state,
      ...(reason ? { reason } : {}),
      updatedAt: closedAt,
      letterId,
      letterSubject: CLOSED_BEFORE_MIRROR_SUBJECT,
      letterBody: CLOSED_BEFORE_MIRROR_BODY,
    });
    await input.store.markLetterDelivered('wishlist', wish.id, record.notification.letterId, closedAt);
    reconciled += 1;
  }
  return { reconciled };
}
