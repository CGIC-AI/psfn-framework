import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalWishlist } from '../../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../../faculties/wiki/store.js';
import { AdminWishlistDataService } from './wishlist-service.js';

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
    const service = new AdminWishlistDataService(root);

    const listed = await service.listWishes();
    expect(listed.wishes).toHaveLength(1);
    expect(listed.boundary).toContain('no push notification');

    await service.acknowledgeWish('33333333-3333-4333-8333-333333333333');
    await service.respondToWish(
      '33333333-3333-4333-8333-333333333333',
      'I will look for a small local studio.',
    );
    const companionView = companionWishlist.getWish('33333333-3333-4333-8333-333333333333');
    expect(companionView).toMatchObject({
      state: 'acknowledged',
      operatorResponse: 'I will look for a small local studio.',
    });
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
