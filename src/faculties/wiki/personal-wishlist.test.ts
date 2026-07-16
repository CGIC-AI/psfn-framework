import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WikiStore } from './store.js';
import { PersonalWishlist } from './personal-wishlist.js';

const WISH_ID = '11111111-1111-4111-8111-111111111111';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'companion-wishlist-'));
}

describe('personal wishlist in the existing wiki tier', () => {
  it('persists a companion-authored wish and reloads it after restart', () => {
    const root = makeWorkspace();
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date('2026-07-16T05:00:00.000Z'),
      () => WISH_ID,
    );

    const created = wishlist.createWish({
      text: 'I want a quiet corner for making tiny illustrated stories.',
      context: 'This came up while thinking about projects I can return to.',
    });

    expect(created).toMatchObject({
      ref: `wish:${WISH_ID}`,
      state: 'open',
      visibility: 'primary_contact',
    });
    const stored = new WikiStore(root).get(`wishlist.wish.${WISH_ID}`);
    expect(stored).toMatchObject({
      sourceClass: 'companion_authored_note',
      sensitivity: 'personal',
      updatedBy: 'agent:personal-wishlist',
      tags: expect.arrayContaining([
        'wishlist:companion-authored',
        `wish:${WISH_ID}`,
        'wish-state:open',
      ]),
    });
    expect(new PersonalWishlist(new WikiStore(root)).listWishes()).toEqual([created]);
  });

  it('makes operator acknowledgement, response, planning, and completion visible to the companion', () => {
    const times = [
      '2026-07-16T05:00:00.000Z',
      '2026-07-16T05:01:00.000Z',
      '2026-07-16T05:02:00.000Z',
      '2026-07-16T05:03:00.000Z',
      '2026-07-16T05:04:00.000Z',
    ];
    const root = makeWorkspace();
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date(times.shift() ?? 'invalid'),
      () => WISH_ID,
    );
    const created = wishlist.createWish({ text: 'I want to learn how to make a small zine.' });

    const acknowledged = wishlist.acknowledgeWish(created.ref);
    expect(acknowledged).toMatchObject({
      state: 'acknowledged',
      acknowledgedAt: '2026-07-16T05:01:00.000Z',
    });
    const responded = wishlist.respondToWish(created.ref, 'I love this idea. Let us plan a first issue.');
    expect(responded).toMatchObject({
      state: 'acknowledged',
      operatorResponse: 'I love this idea. Let us plan a first issue.',
    });
    const planned = wishlist.planWish(created.ref, 'wish-42');
    expect(planned).toMatchObject({ state: 'planned', beadId: 'wish-42' });
    const completed = wishlist.completeWish(created.ref);
    expect(completed).toMatchObject({
      state: 'done',
      beadId: 'wish-42',
      completedAt: '2026-07-16T05:04:00.000Z',
    });
    expect(new PersonalWishlist(new WikiStore(root)).getWish(created.ref)).toEqual(completed);
  });

  it('keeps retryable operator transitions idempotent and rejects planning a completed wish', () => {
    const root = makeWorkspace();
    const wishlist = new PersonalWishlist(
      new WikiStore(root),
      () => new Date('2026-07-16T05:00:00.000Z'),
      () => WISH_ID,
    );
    const created = wishlist.createWish({ text: 'I want a recurring drawing afternoon.' });
    const acknowledged = wishlist.acknowledgeWish(created.ref);
    expect(wishlist.acknowledgeWish(created.ref)).toEqual(acknowledged);
    const planned = wishlist.planWish(created.ref, 'wish-43');
    expect(wishlist.planWish(created.ref, 'wish-44')).toEqual(planned);
    wishlist.completeWish(created.ref);
    expect(() => wishlist.planWish(created.ref, 'wish-45')).toThrow('is already done');
  });

  it('fails closed on malformed, unknown, and state-inconsistent persisted fields', () => {
    const root = makeWorkspace();
    const store = new WikiStore(root);
    store.upsert({
      id: `wishlist.wish.${WISH_ID}`,
      title: 'Malformed wish',
      body: JSON.stringify({
        schemaVersion: 1,
        kind: 'companion_wish',
        id: WISH_ID,
        ref: `wish:${WISH_ID}`,
        text: 'A malformed wish',
        state: 'open',
        visibility: 'primary_contact',
        createdAt: '2026-07-16T05:00:00.000Z',
        updatedAt: '2026-07-16T05:00:00.000Z',
        acknowledgedAt: '2026-07-16T05:00:00.000Z',
        unexpected: true,
      }),
      tags: ['wishlist:companion-authored'],
      sourceClass: 'companion_authored_note',
      sensitivity: 'personal',
    });

    expect(() => new PersonalWishlist(store).listWishes())
      .toThrow('contains unknown keys: unexpected');

    const body = JSON.parse(store.get(`wishlist.wish.${WISH_ID}`)?.body ?? 'null');
    delete body.unexpected;
    store.upsert({
      id: `wishlist.wish.${WISH_ID}`,
      title: 'State-inconsistent wish',
      body: JSON.stringify(body),
      tags: ['wishlist:companion-authored'],
      sourceClass: 'companion_authored_note',
      sensitivity: 'personal',
    });
    expect(() => new PersonalWishlist(store).listWishes())
      .toThrow('has operator fields while open');
  });

  it('rejects empty, oversized, and noncanonical creation input before writing', () => {
    const root = makeWorkspace();
    const store = new WikiStore(root);
    const wishlist = new PersonalWishlist(store, undefined, () => 'not-a-uuid');
    expect(() => wishlist.createWish({ text: 'A real wish' })).toThrow('canonical RFC-4122 UUID');
    expect(store.list()).toEqual([]);

    const validIds = new PersonalWishlist(store, undefined, () => WISH_ID);
    expect(() => validIds.createWish({ text: '  ' })).toThrow('non-empty string');
    expect(() => validIds.createWish({ text: 'x'.repeat(2_001) })).toThrow('at most 2000');
    expect(store.list()).toEqual([]);
  });
});
