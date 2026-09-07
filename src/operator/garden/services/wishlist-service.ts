import type {
  BeadsActionResult,
  BeadsIssueType,
} from '../../../boundary/gateway/protocol.js';
import type { DoingMirrorService } from '../../../core/doing-mirror/service.js';
import type { CompanionWish } from '../../../faculties/wiki/personal-wishlist.js';
import { PersonalWishlist } from '../../../faculties/wiki/personal-wishlist.js';
import { WikiStore } from '../../../faculties/wiki/store.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  AdminWishlistBeadCreatePort,
  AdminWishlistConvertInput,
  AdminWishlistDispositionLetter,
  AdminWishlistListData,
  AdminWishlistService,
} from './types/wishlist.js';

/**
 * psfn-framework-p4rmp: the legacy wishlist actions are one Garden surface over
 * the same companion-originated item the doing mirror owns, so they record the
 * Partner decision through the disposition lifecycle instead of mutating the
 * wiki wish behind its back. The lifecycle's own source hook writes the wish
 * state, which is why these methods never call acknowledgeWish/completeWish.
 */
export type AdminWishlistDispositionPort = Pick<DoingMirrorService, 'get' | 'transition'>;

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
    private readonly doingMirror?: AdminWishlistDispositionPort,
  ) {
    this.wishlist = new PersonalWishlist(new WikiStore(workspacePath));
  }

  async listWishes(): Promise<AdminWishlistListData> {
    return {
      wishes: this.wishlist.listWishes(),
      boundary: WISHLIST_BOUNDARY,
    };
  }

  async acknowledgeWish(wishRef: string, letter: AdminWishlistDispositionLetter) {
    this.assertNotConverting(wishRef);
    const wish = this.wishlist.getWish(wishRef);
    await this.recordDisposition(wish, 'considering', letter);
    return this.wishlist.getWish(wish.id);
  }

  async respondToWish(
    wishRef: string,
    response: string,
    letter: AdminWishlistDispositionLetter,
  ) {
    this.assertNotConverting(wishRef);
    const wish = this.wishlist.getWish(wishRef);
    // The response itself is companion-visible on the wish record. A Letter is
    // written only when this response is what first moves the disposition.
    await this.recordDisposition(wish, 'considering', letter);
    return this.wishlist.respondToWish(wish.id, response);
  }

  async convertWishToBead(wishRef: string, input: AdminWishlistConvertInput = {}) {
    if (!this.beadCreator) {
      throw new Error('wishlist bead conversion is unavailable');
    }
    const wish = this.wishlist.getWish(wishRef);
    if (wish.state === 'done') throw new Error(`${wish.ref} is already done`);
    if (wish.state === 'declined') throw new Error(`${wish.ref} is already declined`);
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

  async completeWish(wishRef: string, letter: AdminWishlistDispositionLetter) {
    this.assertNotConverting(wishRef);
    const wish = this.wishlist.getWish(wishRef);
    await this.recordDisposition(wish, 'done', letter);
    return this.wishlist.getWish(wish.id);
  }

  /**
   * Record the Partner decision once through the doing-mirror lifecycle, which
   * places exactly one Letter and writes the wish state through its source hook.
   * An action that would not change the disposition writes nothing, so a repeated
   * click never produces a second Letter.
   */
  private async recordDisposition(
    wish: CompanionWish,
    state: 'considering' | 'done',
    letter: AdminWishlistDispositionLetter,
  ): Promise<void> {
    if (!this.doingMirror) {
      throw new Error('wishlist dispositions are unavailable without the doing-mirror lifecycle');
    }
    const current = await this.doingMirror.get('wishlist', wish.id);
    const recorded = current.disposition.state;
    if (recorded === state) return;
    if (recorded === 'done' || recorded === 'declined') {
      throw new Error(`${wish.ref} already has a terminal ${recorded} disposition`);
    }
    const subject = letter.subject?.trim();
    const body = letter.body?.trim();
    if (!subject || !body) {
      throw new Error(
        `${wish.ref} moves to ${state}; supply the Letter subject and body in your own words`,
      );
    }
    await this.doingMirror.transition({
      itemType: 'wishlist',
      itemId: wish.id,
      state,
      subject,
      body,
    });
  }

  private assertNotConverting(wishRef: string): void {
    const wish = this.wishlist.getWish(wishRef);
    if (this.convertingWishIds.has(wish.id)) {
      throw new Error(`${wish.ref} conversion is already in progress`);
    }
  }
}
