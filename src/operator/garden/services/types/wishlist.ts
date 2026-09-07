import type {
  BeadsActionResult,
  BeadsIssueType,
} from '../../../../boundary/gateway/protocol.js';
import type { CompanionWish } from '../../../../faculties/wiki/personal-wishlist.js';

export interface AdminWishlistListData {
  wishes: CompanionWish[];
  boundary: string;
}

export interface AdminWishlistBeadCreatePort {
  createWishBead(input: {
    title: string;
    description: string;
    acceptance: string;
    issueType: BeadsIssueType;
    priority: number;
    actor: string;
  }): Promise<BeadsActionResult>;
}

/**
 * psfn-framework-p4rmp: exact Partner-authored Letter text for the disposition a
 * legacy wishlist action records. Optional because an action that does not
 * change the disposition (a second response while already considering) writes no
 * Letter; an action that does change it fails closed without both fields.
 */
export interface AdminWishlistDispositionLetter {
  subject?: string;
  body?: string;
}

export interface AdminWishlistConvertInput {
  issueType?: BeadsIssueType;
  priority?: number;
}

export interface AdminWishlistService {
  listWishes(): Promise<AdminWishlistListData>;
  acknowledgeWish(
    wishRef: string,
    letter: AdminWishlistDispositionLetter,
  ): Promise<CompanionWish>;
  respondToWish(
    wishRef: string,
    response: string,
    letter: AdminWishlistDispositionLetter,
  ): Promise<CompanionWish>;
  convertWishToBead(
    wishRef: string,
    input?: AdminWishlistConvertInput,
  ): Promise<CompanionWish>;
  completeWish(
    wishRef: string,
    letter: AdminWishlistDispositionLetter,
  ): Promise<CompanionWish>;
}
