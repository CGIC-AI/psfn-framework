// ── CogSec receipt ports (psfn-framework-1fjvm.3) ──
//
// The Core-side ports over the content-addressed screening receipt contract in
// src/shared/contracts/cogsec-receipt.ts. Screening holds only the narrow
// writer port (it issues, it never reads back); admission consumers hold the
// full store port and always go through `resolveAdmittedCogSecReceipt`
// (verification.ts) so a lookup can never be mistaken for a verification.

import type { CogSecReceipt } from '../../../shared/contracts/cogsec-receipt.js';

/** Durable issuance sink. Recording the same receipt id twice is idempotent. */
export interface CogSecReceiptWriterPort {
  record(receipt: CogSecReceipt): Promise<void>;
}

export interface CogSecReceiptLookupQuery {
  /** sha256 of the exact bytes the caller wants admitted. */
  contentSha256: string;
  /** The caller's CURRENT effective screening contract digest. */
  screeningContractDigest: string;
}

export interface CogSecReceiptStorePort extends CogSecReceiptWriterPort {
  /**
   * Most recently issued receipt for these exact bytes under this exact
   * screening contract, or null. Expired receipts are RETURNED, not filtered:
   * expiry is a verification outcome with a typed reason, and hiding it here
   * would report a stale receipt as a missing one.
   */
  findLatestForContent(query: CogSecReceiptLookupQuery): Promise<CogSecReceipt | null>;
  getById(receiptId: string): Promise<CogSecReceipt | null>;
  close(): Promise<void>;
}
