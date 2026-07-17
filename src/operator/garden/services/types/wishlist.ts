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

export interface AdminWishlistConvertInput {
  issueType?: BeadsIssueType;
  priority?: number;
}

export interface AdminWishlistService {
  listWishes(): Promise<AdminWishlistListData>;
  acknowledgeWish(wishRef: string): Promise<CompanionWish>;
  respondToWish(wishRef: string, response: string): Promise<CompanionWish>;
  convertWishToBead(
    wishRef: string,
    input?: AdminWishlistConvertInput,
  ): Promise<CompanionWish>;
  completeWish(wishRef: string): Promise<CompanionWish>;
}
