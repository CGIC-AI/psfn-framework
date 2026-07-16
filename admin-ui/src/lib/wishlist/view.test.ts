import { describe, expect, it } from 'vitest';
import type { CompanionWish } from '$lib/api/endpoints/wishlist';
import { activeWishes, countWishesByState, wishlistStateLabel } from './view';

function wish(id: string, state: CompanionWish['state']): CompanionWish {
  return {
    schemaVersion: 1,
    kind: 'companion_wish',
    id,
    ref: `wish:${id}`,
    text: `Wish ${id}`,
    state,
    visibility: 'primary_contact',
    createdAt: '2026-07-16T12:00:00.000Z',
    updatedAt: '2026-07-16T12:00:00.000Z',
  };
}

describe('wishlist view helpers', () => {
  it('summarizes state and keeps completed wishes out of the active view', () => {
    const wishes = [
      wish('11111111-1111-4111-8111-111111111111', 'open'),
      wish('22222222-2222-4222-8222-222222222222', 'planned'),
      wish('33333333-3333-4333-8333-333333333333', 'done'),
    ];

    expect(countWishesByState(wishes)).toEqual({
      open: 1,
      acknowledged: 0,
      planned: 1,
      done: 1,
    });
    expect(activeWishes(wishes).map(item => item.state)).toEqual(['open', 'planned']);
    expect(wishlistStateLabel('acknowledged')).toBe('Acknowledged');
  });
});
