// ── CogSec receipt verification (psfn-framework-1fjvm.3) ──
//
// The one primitive an admission consumer uses to decide whether it may skip
// re-screening. It FAILS CLOSED: every outcome that is not an exact,
// unexpired, known-issuer, contract-matching receipt over the exact bytes is a
// typed refusal, and the caller's only correct response to a refusal is to
// screen the content again.
//
// Verification is a value, never an exception: a missing, stale, forged, or
// mismatched receipt is normal operation. Exceptions are reserved for store
// failures, which must never be swallowed into a silent rescreen-forever.

import {
  cogSecContentSha256,
  validateCogSecReceipt,
  type CogSecReceipt,
} from '../../../shared/contracts/cogsec-receipt.js';
import type { CogSecReceiptStorePort } from './contracts.js';

export const COGSEC_RECEIPT_REFUSAL_REASONS = [
  /** No receipt exists for these bytes under this screening contract. */
  'not_found',
  /** The receipt is structurally invalid or its self-binding digest is broken. */
  'malformed',
  /** The issuing authority is not in the caller's trusted issuer set. */
  'unknown_issuer',
  /** The receipt covers different bytes than the ones presented. */
  'content_hash_mismatch',
  /** The effective screening contract has drifted since issuance. */
  'screening_contract_mismatch',
  /** The receipt is at or past its expiry. */
  'expired',
] as const;

export type CogSecReceiptRefusalReason = typeof COGSEC_RECEIPT_REFUSAL_REASONS[number];

export type CogSecReceiptVerification =
  | { admitted: true; receipt: CogSecReceipt }
  | { admitted: false; reason: CogSecReceiptRefusalReason; detail: string };

export interface VerifyCogSecReceiptInput {
  /** The receipt as received; untrusted and re-validated here. */
  receipt: unknown;
  /** The exact bytes the caller wants to admit. */
  content: string | Uint8Array;
  /** The caller's CURRENT effective screening contract digest. */
  expectedScreeningContractDigest: string;
  /** Issuer ids this caller accepts. An empty set admits nothing. */
  trustedIssuerIds: readonly string[];
  nowMs: number;
}

/**
 * Verify one receipt against the exact bytes, the caller's current screening
 * contract, its trusted issuers, and the clock. Checks run structure → issuer
 * → content → contract → expiry, so the reported reason is the earliest
 * violated precondition rather than an arbitrary one.
 */
export function verifyCogSecReceipt(input: VerifyCogSecReceiptInput): CogSecReceiptVerification {
  let receipt: CogSecReceipt;
  try {
    receipt = validateCogSecReceipt(input.receipt);
  } catch (error) {
    return refuse('malformed', error instanceof Error ? error.message : String(error));
  }
  if (!input.trustedIssuerIds.includes(receipt.issuer.id)) {
    return refuse('unknown_issuer', `issuer '${receipt.issuer.id}' is not trusted here`);
  }
  const contentSha256 = cogSecContentSha256(input.content);
  if (receipt.contentSha256 !== contentSha256) {
    return refuse(
      'content_hash_mismatch',
      `receipt covers ${receipt.contentSha256}, presented bytes hash to ${contentSha256}`,
    );
  }
  if (receipt.screeningContractDigest !== input.expectedScreeningContractDigest) {
    return refuse(
      'screening_contract_mismatch',
      `receipt contract ${receipt.screeningContractDigest} `
      + `is not the current ${input.expectedScreeningContractDigest}`,
    );
  }
  if (!Number.isSafeInteger(input.nowMs)) {
    throw new Error('CogSec receipt verification requires an integer nowMs');
  }
  if (input.nowMs >= receipt.expiresAtMs) {
    return refuse('expired', `receipt expired at ${String(receipt.expiresAtMs)}`);
  }
  return { admitted: true, receipt };
}

export interface ResolveAdmittedCogSecReceiptInput {
  content: string | Uint8Array;
  expectedScreeningContractDigest: string;
  trustedIssuerIds: readonly string[];
  nowMs: number;
}

/**
 * Look up and verify in one step. Consumers must use this rather than pairing
 * `findLatestForContent` with their own checks: a lookup hit is not admission,
 * and separating the two invites a caller that forgets to verify.
 */
export async function resolveAdmittedCogSecReceipt(
  store: CogSecReceiptStorePort,
  input: ResolveAdmittedCogSecReceiptInput,
): Promise<CogSecReceiptVerification> {
  const contentSha256 = cogSecContentSha256(input.content);
  const found = await store.findLatestForContent({
    contentSha256,
    screeningContractDigest: input.expectedScreeningContractDigest,
  });
  if (!found) {
    return refuse('not_found', `no receipt for ${contentSha256} under the current contract`);
  }
  return verifyCogSecReceipt({
    receipt: found,
    content: input.content,
    expectedScreeningContractDigest: input.expectedScreeningContractDigest,
    trustedIssuerIds: input.trustedIssuerIds,
    nowMs: input.nowMs,
  });
}

function refuse(reason: CogSecReceiptRefusalReason, detail: string): CogSecReceiptVerification {
  return { admitted: false, reason, detail };
}
