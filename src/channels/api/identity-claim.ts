import type { IncomingHttpHeaders } from 'node:http';
import {
  clampHttpHeader as clampHeaderValue,
  singleHeader as firstHeaderValue,
} from './http-policy.js';

export const IDENTITY_CLAIM_HEADERS = {
  canonicalContactId: 'x-canonical-contact-id',
  sourceChannel: 'x-identity-claim-channel',
  sourceUserId: 'x-identity-claim-user-id',
  nonce: 'x-identity-claim-nonce',
  expires: 'x-identity-claim-expires',
  signature: 'x-identity-claim-signature',
} as const;

export interface IdentityClaimHeaders {
  canonicalContactId: string;
  sourceChannel: string;
  sourceUserId: string;
  nonce?: string;
  expiresAt?: string;
  signature?: string;
}

export function readIdentityClaimHeaders(headers: IncomingHttpHeaders): IdentityClaimHeaders | null {
  const canonicalContactId = clampHeaderValue(
    firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.canonicalContactId]),
    128,
  );
  if (!canonicalContactId) return null;

  return {
    canonicalContactId,
    sourceChannel: clampHeaderValue(
      firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.sourceChannel]),
      64,
    ) ?? '',
    sourceUserId: clampHeaderValue(
      firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.sourceUserId]),
      256,
    ) ?? '',
    nonce: clampHeaderValue(
      firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.nonce]),
      128,
    ),
    expiresAt: clampHeaderValue(
      firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.expires]),
      64,
    ),
    signature: clampHeaderValue(
      firstHeaderValue(headers[IDENTITY_CLAIM_HEADERS.signature]),
      256,
    ),
  };
}

export function buildIdentityChallengePayload(
  claim: IdentityClaimHeaders,
  authorId: string,
  challenge: {
    nonce: string;
    expiresAt: string;
    signature: string;
  },
): Record<string, unknown> {
  return {
    canonicalContactId: claim.canonicalContactId,
    sourceChannel: claim.sourceChannel,
    sourceUserId: claim.sourceUserId,
    targetChannel: 'api',
    targetUserId: authorId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    signature: challenge.signature,
    requiredHeaders: {
      canonicalContactId: 'X-Canonical-Contact-ID',
      sourceChannel: 'X-Identity-Claim-Channel',
      sourceUserId: 'X-Identity-Claim-User-ID',
      nonce: 'X-Identity-Claim-Nonce',
      expiresAt: 'X-Identity-Claim-Expires',
      signature: 'X-Identity-Claim-Signature',
    },
  };
}
