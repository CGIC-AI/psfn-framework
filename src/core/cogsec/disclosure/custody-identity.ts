// ── Custody identity primitives (psfn-framework-ccgdz.1 / .4) ──
//
// The content-free binding rule every custody record shares: a free-form
// runtime reference is ALWAYS stored as its sha256, and its literal text
// survives only when it is a bounded token that structurally cannot carry
// prose, a path, or a message body. That is what makes "content-free" a
// testable property of the record rather than a claim about its producers.
//
// Extracted here so the custody snapshot and the context source manifest bind
// their references identically — one rule, one implementation, no cycle
// between the two record modules.

import { createHash } from 'node:crypto';

import { isRecord } from '../../../shared/utils/types.js';

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

/**
 * A literal reference is retained only when it matches this shape: a bounded
 * run of identifier/id-punctuation characters. No whitespace, no slash, no
 * quote, no newline — so a path, a sentence, or a message body can never be
 * mistaken for an id and stored verbatim.
 */
export const CUSTODY_SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

/** Bounded identity for one runtime reference: always a hash, sometimes an id. */
export interface CustodyIdentity {
  /** sha256 of the exact original reference string; the durable join key. */
  readonly digest: string;
  /** The literal reference, retained only when structurally safe to store. */
  readonly id?: string;
}

export function custodySha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Bind one free-form runtime reference. The digest is unconditional; the
 * literal survives only when it is a bounded safe token.
 */
export function custodyIdentity(reference: string): CustodyIdentity {
  const digest = custodySha256(reference);
  return CUSTODY_SAFE_IDENTIFIER_PATTERN.test(reference)
    ? { digest, id: reference }
    : { digest };
}

export function validateCustodyIdentity(value: unknown, field: string): CustodyIdentity {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (typeof value.digest !== 'string' || !SHA256_HEX_PATTERN.test(value.digest)) {
    throw new Error(`${field}.digest must be 64 lowercase hex characters`);
  }
  if (value.id === undefined) return { digest: value.digest };
  if (typeof value.id !== 'string' || !CUSTODY_SAFE_IDENTIFIER_PATTERN.test(value.id)) {
    throw new Error(`${field}.id must be a bounded safe identifier`);
  }
  if (custodySha256(value.id) !== value.digest) {
    throw new Error(`${field}.id does not match its digest`);
  }
  return { digest: value.digest, id: value.id };
}

/** The custody key for a turn. No new identifier is minted. */
export function custodyRefForTurn(turnId: string): string {
  const trimmed = turnId.trim();
  if (trimmed.length === 0) {
    throw new Error('Custody ref requires a non-empty turn id');
  }
  return `turn:${trimmed}`;
}
