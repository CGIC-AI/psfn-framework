import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ShardFoldReviewRecord, ShardFoldReviewPort } from '../../faculties/shards/fold-review.js';
import { buildShardLineageEnvelope } from '../../faculties/shards/result-lineage.js';
import { PersonalWishlist } from '../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../faculties/wiki/store.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type {
  DoingMirrorDispositionRecord,
  DoingMirrorStorePort,
  DoingMirrorTransitionStoreInput,
} from './contracts.js';
import {
  FoldPackageDoingMirrorSource,
  reconcileClosedWishDispositions,
  WishlistDoingMirrorSource,
} from './sources.js';

function memoryDispositionStore(): DoingMirrorStorePort & {
  readonly records: Map<string, DoingMirrorDispositionRecord>;
} {
  const records = new Map<string, DoingMirrorDispositionRecord>();
  return {
    records,
    get: async (itemType, itemId) => records.get(`${itemType}:${itemId}`) ?? null,
    list: async () => [...records.values()],
    listPendingLetterDeliveries: async () => [...records.values()]
      .filter(record => record.notification.deliveredAt === undefined),
    recordLetterDeliveryFailure: async () => { throw new Error('unused'); },
    resetLetterDeliveryFailures: async () => { throw new Error('unused'); },
    transition: async (input: DoingMirrorTransitionStoreInput) => {
      const record: DoingMirrorDispositionRecord = {
        itemType: input.itemType,
        itemId: input.itemId,
        state: input.state,
        ...(input.reason ? { reason: input.reason } : {}),
        version: input.expectedVersion + 1,
        updatedAt: input.updatedAt,
        updatedBy: 'partner',
        notification: {
          letterId: input.letterId,
          subject: input.letterSubject,
          body: input.letterBody,
          failureCount: 0,
        },
      };
      records.set(`${input.itemType}:${input.itemId}`, record);
      return record;
    },
    markLetterDelivered: async (itemType, itemId, letterId, deliveredAt) => {
      const key = `${itemType}:${itemId}`;
      const current = records.get(key);
      if (!current || current.notification.letterId !== letterId) throw new Error('missing transition');
      const delivered: DoingMirrorDispositionRecord = {
        ...current,
        notification: { ...current.notification, deliveredAt },
      };
      records.set(key, delivered);
      return delivered;
    },
    close: async () => undefined,
  };
}

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function review(companionId: typeof COMPANION_ID, shardId: string): ShardFoldReviewRecord {
  return {
    schemaVersion: 1,
    shardId,
    channelId: `shard:${shardId}`,
    task: 'Sketch a seasonal planting plan',
    lineage: buildShardLineageEnvelope({
      kind: 'spawn',
      coreCompanionId: companionId,
      shardId,
      shardChannelId: `shard:${shardId}`,
      sourceMessage: {
        id: 'source-message',
        channelId: 'garden-room',
        channelType: 'api',
        authorId: companionId,
        authorName: 'Companion',
        timestamp: new Date(100),
      },
    }),
    validationPath: `/api/admin/shards/${shardId}`,
    reviewState: 'pending',
    createdAt: 100,
    updatedAt: 100,
    blockingReasons: [],
    visibilitySignals: {
      emotionalOrRelational: false,
      provenanceTags: [],
      emotionalOrRelationalOutputIds: [],
    },
    memoryItems: [],
    artifactItems: [],
  };
}

describe('doing-mirror source adapters', () => {
  it('projects only the canonical companion-authored wishlist record', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doing-mirror-wishlist-'));
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date(100),
      () => '9863edac-42bd-4b57-a693-fde2f85ffbd1',
    );
    const wish = wishlist.createWish({ text: 'Plant a moon garden', context: 'Next spring.' });
    const source = new WishlistDoingMirrorSource(wishlist);

    await expect(source.list()).resolves.toEqual([expect.objectContaining({
      itemType: 'wishlist',
      itemId: wish.id,
      ref: wish.ref,
      title: wish.text,
      origin: {
        kind: 'companion',
        provenanceRefs: [`wiki:wishlist.wish.${wish.id}`],
      },
    })]);
  });

  it('projects fold packages only when both canonical companion lineage fields agree', async () => {
    const fold = review(COMPANION_ID, 'fold-1');
    const port: Pick<ShardFoldReviewPort, 'listFoldReviews' | 'getFoldReview'> = {
      listFoldReviews: vi.fn(async () => [fold]),
      getFoldReview: vi.fn(async () => fold),
    };
    const source = new FoldPackageDoingMirrorSource(port, COMPANION_ID);

    await expect(source.get('fold-1')).resolves.toMatchObject({
      itemType: 'fold_package',
      itemId: 'fold-1',
      ref: 'fold:fold-1',
      origin: {
        kind: 'companion',
        provenanceRefs: expect.arrayContaining([
          'companion:11111111-1111-4111-8111-111111111111',
          'shard:fold-1',
        ]),
      },
    });

    fold.lineage.companionProvenance.parentCompanionId = createCompanionId(
      '22222222-2222-4222-8222-222222222222',
    );
    await expect(source.list()).rejects.toThrow('does not prove origin from this companion');
  });

  it('converges the wiki wish state with the recorded disposition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doing-mirror-apply-'));
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      undefined,
      () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const wish = wishlist.createWish({ text: 'Repair the garden gate' });
    const source = new WishlistDoingMirrorSource(wishlist);

    await source.applyDisposition({ itemId: wish.id, state: 'considering' });
    expect(wishlist.getWish(wish.id).state).toBe('acknowledged');

    await source.applyDisposition({
      itemId: wish.id, state: 'declined', reason: 'The gate is beyond repair.',
    });
    expect(wishlist.getWish(wish.id)).toMatchObject({
      state: 'declined', declineReason: 'The gate is beyond repair.',
    });

    // Idempotent: a redelivery pass repeats the write without moving anything.
    const declined = wishlist.getWish(wish.id);
    await source.applyDisposition({
      itemId: wish.id, state: 'declined', reason: 'The gate is beyond repair.',
    });
    expect(wishlist.getWish(wish.id)).toEqual(declined);

    await expect(source.applyDisposition({ itemId: wish.id, state: 'declined' }))
      .rejects.toThrow('must carry its companion-visible reason');
  });

  it('reconciles wishes closed before the doing mirror existed without writing a Letter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'doing-mirror-reconcile-'));
    let id = 0;
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      undefined,
      () => `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${id++}`,
    );
    const closed = wishlist.createWish({ text: 'Plant the tulips' });
    wishlist.completeWish(closed.id);
    const open = wishlist.createWish({ text: 'Prune the apple tree' });
    const store = memoryDispositionStore();

    let letterSeq = 0;
    await expect(reconcileClosedWishDispositions({
      wishlist,
      store,
      createId: () => `cccccccc-cccc-4ccc-8ccc-cccccccccc${String(letterSeq++).padStart(2, '0')}`,
    })).resolves.toEqual({ reconciled: 1 });

    const record = store.records.get(`wishlist:${closed.id}`);
    expect(record).toMatchObject({ state: 'done', version: 1 });
    // Stamped delivered on the spot: the drain must never compose a Letter for
    // a decision that predates the lifecycle.
    expect(record?.notification.deliveredAt).toBeDefined();
    expect(await store.listPendingLetterDeliveries(25)).toEqual([]);
    expect(store.records.has(`wishlist:${open.id}`)).toBe(false);

    // Idempotent across restarts.
    await expect(reconcileClosedWishDispositions({ wishlist, store }))
      .resolves.toEqual({ reconciled: 0 });
    expect(store.records.size).toBe(1);
  });
});