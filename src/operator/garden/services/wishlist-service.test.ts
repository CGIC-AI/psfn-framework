import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DoingMirrorDispositionRecord,
  DoingMirrorStorePort,
  DoingMirrorTransitionStoreInput,
} from '../../../core/doing-mirror/contracts.js';
import { DoingMirrorService } from '../../../core/doing-mirror/service.js';
import { WishlistDoingMirrorSource } from '../../../core/doing-mirror/sources.js';
import type { LetterService } from '../../../core/letters/service.js';
import { PersonalWishlist } from '../../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../../faculties/wiki/store.js';
import { AdminWishlistDataService } from './wishlist-service.js';

/**
 * psfn-framework-p4rmp: the legacy wishlist routes now record their Partner
 * decision through the doing-mirror lifecycle, so the service under test needs
 * a real lifecycle over an in-memory disposition store.
 */
function makeDoingMirror(wishlist: PersonalWishlist) {
  const records = new Map<string, DoingMirrorDispositionRecord>();
  let nextLetter = 0;
  const store: DoingMirrorStorePort = {
    get: async (itemType, itemId) => records.get(`${itemType}:${itemId}`) ?? null,
    list: async () => [...records.values()],
    listPendingLetterDeliveries: async () => [],
    recordLetterDeliveryFailure: async () => { throw new Error('unused'); },
    resetLetterDeliveryFailures: async () => { throw new Error('unused'); },
    transition: async (input: DoingMirrorTransitionStoreInput) => {
      const key = `${input.itemType}:${input.itemId}`;
      const current = records.get(key);
      if ((current?.state ?? 'open') !== input.expectedState) {
        throw new Error('doing-mirror transition lost its expected-state race');
      }
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
      records.set(key, record);
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
  const compose = vi.fn(async (input: { id?: string; subject: string; body: string }) => ({
    id: input.id ?? `letter-${++nextLetter}`,
    subject: input.subject,
    body: input.body,
  }));
  const service = new DoingMirrorService({
    store,
    letters: { compose } as unknown as Pick<LetterService, 'compose'>,
  });
  service.registerSource(new WishlistDoingMirrorSource(wishlist));
  return { doingMirror: service, compose, records };
}

describe('AdminWishlistDataService', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('lists and mutates the same canonical wish records used by the companion tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garden-wishlist-'));
    roots.push(root);
    const companionWishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date('2020-07-16T12:00:00.000Z'),
      () => '33333333-3333-4333-8333-333333333333',
    );
    companionWishlist.createWish({ text: 'Try a pottery class', context: 'A quiet beginners session.' });
    const { doingMirror, compose, records } = makeDoingMirror(
      new PersonalWishlist(new WikiStore(root)),
    );
    const service = new AdminWishlistDataService(root, undefined, doingMirror);

    const listed = await service.listWishes();
    expect(listed.wishes).toHaveLength(1);
    expect(listed.boundary).toContain('no push notification');

    await service.acknowledgeWish('33333333-3333-4333-8333-333333333333', {
      subject: 'About the pottery class',
      body: 'I read this and I am looking.',
    });
    await service.respondToWish(
      '33333333-3333-4333-8333-333333333333',
      'I will look for a small local studio.',
      { subject: 'Still about the pottery class', body: 'A second note.' },
    );
    const companionView = companionWishlist.getWish('33333333-3333-4333-8333-333333333333');
    expect(companionView).toMatchObject({
      state: 'acknowledged',
      operatorResponse: 'I will look for a small local studio.',
    });
    // p4rmp: one disposition and one Letter for the acknowledgement; the second
    // action does not move the disposition, so it writes no second Letter.
    expect(compose).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      author: 'partner',
      recipient: 'companion',
      subject: 'About the pottery class',
      body: 'I read this and I am looking.',
    }));
    expect(records.get('wishlist:33333333-3333-4333-8333-333333333333'))
      .toMatchObject({ state: 'considering', version: 1 });
  });

  it('completes a wish as one disposition, one Letter, and one terminal state in both stores', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garden-wishlist-done-'));
    roots.push(root);
    const companionWishlist = new PersonalWishlist(
      new WikiStore(root),
      undefined,
      () => '77777777-7777-4777-8777-777777777777',
    );
    companionWishlist.createWish({ text: 'Repot the fern' });
    const { doingMirror, compose, records } = makeDoingMirror(
      new PersonalWishlist(new WikiStore(root)),
    );
    const service = new AdminWishlistDataService(root, undefined, doingMirror);
    const letter = { subject: 'The fern is repotted', body: 'I did it this morning.' };

    const done = await service.completeWish('77777777-7777-4777-8777-777777777777', letter);

    expect(done).toMatchObject({ state: 'done' });
    expect(companionWishlist.getWish('77777777-7777-4777-8777-777777777777').state).toBe('done');
    expect(records.get('wishlist:77777777-7777-4777-8777-777777777777')).toMatchObject({
      state: 'done',
      version: 1,
      notification: { subject: letter.subject, body: letter.body },
    });
    expect(compose).toHaveBeenCalledTimes(1);

    // Repeating the action neither advances the lifecycle nor writes a Letter.
    await service.completeWish('77777777-7777-4777-8777-777777777777', letter);
    expect(compose).toHaveBeenCalledTimes(1);
    expect(records.get('wishlist:77777777-7777-4777-8777-777777777777')?.version).toBe(1);

    // The doing-mirror surface agrees with the wiki instead of showing it open.
    await expect(doingMirror.get('wishlist', '77777777-7777-4777-8777-777777777777'))
      .resolves.toMatchObject({ disposition: { state: 'done' } });
  });

  it('fails closed when a legacy action would change the disposition without Letter text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garden-wishlist-letterless-'));
    roots.push(root);
    const companionWishlist = new PersonalWishlist(
      new WikiStore(root),
      undefined,
      () => '88888888-8888-4888-8888-888888888888',
    );
    companionWishlist.createWish({ text: 'Find the old photographs' });
    const { doingMirror, compose } = makeDoingMirror(new PersonalWishlist(new WikiStore(root)));
    const service = new AdminWishlistDataService(root, undefined, doingMirror);

    await expect(service.completeWish('88888888-8888-4888-8888-888888888888', {}))
      .rejects.toThrow('supply the Letter subject and body in your own words');
    expect(compose).not.toHaveBeenCalled();
    expect(companionWishlist.getWish('88888888-8888-4888-8888-888888888888').state).toBe('open');

    // Without the lifecycle at all the legacy action refuses rather than
    // mutating the wish behind the doing mirror's back.
    await expect(new AdminWishlistDataService(root).acknowledgeWish(
      '88888888-8888-4888-8888-888888888888',
      { subject: 'A', body: 'B' },
    )).rejects.toThrow('unavailable without the doing-mirror lifecycle');
  });

  it('converts a wish through the injected Beads create primitive and persists the returned id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garden-wishlist-bead-'));
    roots.push(root);
    const companionWishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date('2020-07-16T12:00:00.000Z'),
      () => '44444444-4444-4444-8444-444444444444',
    );
    companionWishlist.createWish({ text: 'Make a tiny moss garden' });
    const createWishBead = vi.fn().mockResolvedValue({
      actor: 'garden-operator',
      action: 'create',
      target: 'new',
      result: 'success',
      payload: { id: 'wishlist-moss-garden' },
    });
    const service = new AdminWishlistDataService(root, { createWishBead });

    const planned = await service.convertWishToBead(
      'wish:44444444-4444-4444-8444-444444444444',
      { issueType: 'feature', priority: 1 },
    );

    expect(createWishBead).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Companion wish: Make a tiny moss garden',
      description: expect.stringContaining('wish:44444444-4444-4444-8444-444444444444'),
      acceptance: expect.stringContaining('companion-visible result'),
      issueType: 'feature',
      priority: 1,
      actor: 'garden-operator',
    }));
    expect(planned).toMatchObject({
      state: 'planned',
      beadId: 'wishlist-moss-garden',
    });
    expect(companionWishlist.getWish(planned.ref)).toMatchObject({
      state: 'planned',
      beadId: 'wishlist-moss-garden',
    });
  });

  it('fails closed when conversion is unwired or Beads returns malformed data', async () => {
    const root = mkdtempSync(join(tmpdir(), 'garden-wishlist-fail-'));
    roots.push(root);
    const companionWishlist = new PersonalWishlist(
      new WikiStore(root),
      undefined,
      () => '55555555-5555-4555-8555-555555555555',
    );
    companionWishlist.createWish({ text: 'Learn bookbinding' });

    await expect(new AdminWishlistDataService(root).convertWishToBead(
      '55555555-5555-4555-8555-555555555555',
    )).rejects.toThrow('conversion is unavailable');

    const malformed = new AdminWishlistDataService(root, {
      createWishBead: vi.fn().mockResolvedValue({
        actor: 'garden-operator',
        action: 'create',
        target: 'new',
        result: 'success',
        payload: {},
      }),
    });
    await expect(malformed.convertWishToBead(
      '55555555-5555-4555-8555-555555555555',
    )).rejects.toThrow('no issue id');
    expect(companionWishlist.getWish('55555555-5555-4555-8555-555555555555').state).toBe('open');
  });
});
