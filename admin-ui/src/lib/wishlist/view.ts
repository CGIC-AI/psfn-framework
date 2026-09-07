import type {
  CompanionWish,
  CompanionWishState,
} from '$lib/api/endpoints/wishlist';

export const WISHLIST_STATE_ORDER: readonly CompanionWishState[] = [
  'open',
  'acknowledged',
  'planned',
  'done',
  'declined',
];

export function wishlistStateLabel(state: CompanionWishState): string {
  switch (state) {
    case 'open': return 'Open';
    case 'acknowledged': return 'Acknowledged';
    case 'planned': return 'Planned';
    case 'done': return 'Done';
    case 'declined': return 'Declined';
  }
}

export function countWishesByState(
  wishes: readonly CompanionWish[],
): Record<CompanionWishState, number> {
  const counts: Record<CompanionWishState, number> = {
    open: 0,
    acknowledged: 0,
    planned: 0,
    done: 0,
    declined: 0,
  };
  for (const wish of wishes) counts[wish.state] += 1;
  return counts;
}

export function activeWishes(wishes: readonly CompanionWish[]): CompanionWish[] {
  return wishes.filter(wish => wish.state !== 'done' && wish.state !== 'declined');
}
