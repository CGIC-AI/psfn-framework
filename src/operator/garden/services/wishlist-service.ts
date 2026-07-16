import type {
  BeadsActionResult,
  BeadsIssueType,
} from '../../../boundary/gateway/protocol.js';
import { PersonalWishlist } from '../../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../../faculties/wiki/store.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  AdminWishlistBeadCreatePort,
  AdminWishlistConvertInput,
  AdminWishlistListData,
  AdminWishlistService,
} from './types/wishlist.js';

const WISHLIST_BOUNDARY =
  'Companion-authored wishes are personal wiki records reviewed asynchronously; creating a wish emits no push notification or operator interruption.';

function requireCreatedBeadId(result: BeadsActionResult): string {
  if (result.action !== 'create' || !isRecord(result.payload)) {
    throw new Error('beads.create returned an invalid conversion result');
  }
  const id = result.payload.id;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error('beads.create returned no issue id');
  }
  return id.trim();
}

function buildWishBeadDescription(wish: ReturnType<PersonalWishlist['getWish']>): string {
  return [
    `Converted from companion wishlist item ${wish.ref}.`,
    '',
    `Wish: ${wish.text}`,
    ...(wish.context ? ['', `Context: ${wish.context}`] : []),
    ...(wish.operatorResponse ? ['', `Operator response: ${wish.operatorResponse}`] : []),
    '',
    'Scope: carry out or concretely plan this wish. Preserve the companion-authored intent.',
    'Non-goal: do not alter unrelated companion preferences or runtime configuration.',
  ].join('\n');
}

function buildWishBeadAcceptance(wishRef: string): string {
  return [
    `The concrete outcome for ${wishRef} is delivered or scheduled with an explicit next step.`,
    'The wishlist item can be marked done after the companion-visible result is available.',
  ].join('\n');
}

export class AdminWishlistDataService implements AdminWishlistService {
  private readonly wishlist: PersonalWishlist;
  private readonly convertingWishIds = new Set<string>();

  constructor(
    workspacePath: string,
    private readonly beadCreator?: AdminWishlistBeadCreatePort,
  ) {
    this.wishlist = new PersonalWishlist(new WikiStore(workspacePath));
  }

  async listWishes(): Promise<AdminWishlistListData> {
    return {
      wishes: this.wishlist.listWishes(),
      boundary: WISHLIST_BOUNDARY,
    };
  }

  async acknowledgeWish(wishRef: string) {
    this.assertNotConverting(wishRef);
    return this.wishlist.acknowledgeWish(wishRef);
  }

  async respondToWish(wishRef: string, response: string) {
    this.assertNotConverting(wishRef);
    return this.wishlist.respondToWish(wishRef, response);
  }

  async convertWishToBead(wishRef: string, input: AdminWishlistConvertInput = {}) {
    if (!this.beadCreator) {
      throw new Error('wishlist bead conversion is unavailable');
    }
    const wish = this.wishlist.getWish(wishRef);
    if (wish.state === 'done') throw new Error(`${wish.ref} is already done`);
    if (wish.state === 'planned') return wish;
    if (this.convertingWishIds.has(wish.id)) {
      throw new Error(`${wish.ref} conversion is already in progress`);
    }
    this.convertingWishIds.add(wish.id);
    try {
      const issueType: BeadsIssueType = input.issueType ?? 'task';
      const priority = input.priority ?? 2;
      const result = await this.beadCreator.createWishBead({
        title: `Companion wish: ${wish.text.slice(0, 180)}`,
        description: buildWishBeadDescription(wish),
        acceptance: buildWishBeadAcceptance(wish.ref),
        issueType,
        priority,
        actor: 'garden-operator',
      });
      return this.wishlist.planWish(wish.ref, requireCreatedBeadId(result));
    } finally {
      this.convertingWishIds.delete(wish.id);
    }
  }

  async completeWish(wishRef: string) {
    this.assertNotConverting(wishRef);
    return this.wishlist.completeWish(wishRef);
  }

  private assertNotConverting(wishRef: string): void {
    const wish = this.wishlist.getWish(wishRef);
    if (this.convertingWishIds.has(wish.id)) {
      throw new Error(`${wish.ref} conversion is already in progress`);
    }
  }
}
