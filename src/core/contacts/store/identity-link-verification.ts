import type Database from 'better-sqlite3';
import type {
  Contact,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactIdentityLinkVerificationState,
} from '../types.js';
import { v7 as uuidv7 } from 'uuid';
import type { ContactIdentityVerificationRow } from './domain-types.js';
import {
  createVerificationToken,
  normalizeIdentity,
  normalizeVerificationTtlMs,
  toIdentityLinkVerification,
} from './identity-utils.js';

interface LinkIdentityFn {
  (
    contactId: string,
    channel: string,
    channelUserId: string,
    options?: { privacyLevel?: ContactIdentityLinkVerificationInput['privacyLevel'] },
  ): ContactIdentityLinkResult;
}

export interface IdentityVerificationContext {
  db: Database.Database;
  getById: (contactId: string) => Contact | undefined;
  getByChannelIdentity: (channel: string, channelUserId: string) => Contact | undefined;
  linkChannelIdentity: LinkIdentityFn;
}

export function markIdentityLinkVerification(
  db: Database.Database,
  verificationId: string,
  status: ContactIdentityLinkVerificationState,
  failureReason?: string,
  verifiedAt?: string,
): ContactIdentityLinkVerification | undefined {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE contact_identity_link_verifications
    SET status = ?,
        updated_at = ?,
        verified_at = COALESCE(?, verified_at),
        failure_reason = ?
    WHERE id = ?
  `).run(
    status,
    now,
    verifiedAt ?? null,
    failureReason ?? null,
    verificationId,
  );

  const row = db.prepare(`
    SELECT *
    FROM contact_identity_link_verifications
    WHERE id = ?
    LIMIT 1
  `).get(verificationId) as ContactIdentityVerificationRow | undefined;

  return row ? toIdentityLinkVerification(row) : undefined;
}

export function createIdentityLinkChallenge(
  context: IdentityVerificationContext,
  input: ContactIdentityLinkChallengeInput,
): ContactIdentityLinkChallengeResult {
  const contact = context.getById(input.contactId);
  if (!contact) return { status: 'contact_not_found' };

  const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
  const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);
  const sourceOwner = context.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
  if (!sourceOwner || sourceOwner.id !== contact.id) {
    return { status: 'source_identity_not_linked' };
  }

  const targetOwner = context.getByChannelIdentity(targetIdentity.channel, targetIdentity.userId);
  if (targetOwner && targetOwner.id !== contact.id) {
    return { status: 'identity_conflict' };
  }
  if (targetOwner && targetOwner.id === contact.id) {
    return { status: 'already_linked' };
  }

  const existingPending = context.db.prepare(`
    SELECT *
    FROM contact_identity_link_verifications
    WHERE contact_id = ?
      AND source_channel = ?
      AND source_user_id = ?
      AND target_channel = ?
      AND target_user_id = ?
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    contact.id,
    sourceIdentity.channel,
    sourceIdentity.userId,
    targetIdentity.channel,
    targetIdentity.userId,
  ) as ContactIdentityVerificationRow | undefined;

  if (existingPending) {
    const expiresAtMs = Date.parse(existingPending.expires_at);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
      return {
        status: 'pending_exists',
        verification: toIdentityLinkVerification(existingPending),
      };
    }
    markIdentityLinkVerification(context.db, existingPending.id, 'expired', 'expired');
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + normalizeVerificationTtlMs(input.ttlMs),
  ).toISOString();
  const verification: ContactIdentityLinkVerification = {
    id: uuidv7(),
    contactId: contact.id,
    sourceChannel: sourceIdentity.channel,
    sourceUserId: sourceIdentity.userId,
    targetChannel: targetIdentity.channel,
    targetUserId: targetIdentity.userId,
    nonce: createVerificationToken(),
    expiresAt,
    signature: createVerificationToken(),
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  };

  context.db.prepare(`
    INSERT INTO contact_identity_link_verifications (
      id,
      contact_id,
      source_channel,
      source_user_id,
      target_channel,
      target_user_id,
      nonce,
      expires_at,
      signature,
      status,
      created_at,
      updated_at,
      verified_at,
      failure_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    verification.id,
    verification.contactId,
    verification.sourceChannel,
    verification.sourceUserId,
    verification.targetChannel,
    verification.targetUserId,
    verification.nonce,
    verification.expiresAt,
    verification.signature,
    verification.status,
    verification.createdAt,
    verification.updatedAt,
    null,
    null,
  );

  return { status: 'challenge_created', verification };
}

export function verifyIdentityLinkChallenge(
  context: IdentityVerificationContext,
  input: ContactIdentityLinkVerificationInput,
): ContactIdentityLinkVerificationResult {
  const contact = context.getById(input.contactId);
  if (!contact) return { status: 'contact_not_found' };

  const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
  const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);

  const row = context.db.prepare(`
    SELECT *
    FROM contact_identity_link_verifications
    WHERE contact_id = ?
      AND source_channel = ?
      AND source_user_id = ?
      AND target_channel = ?
      AND target_user_id = ?
      AND nonce = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(
    input.contactId,
    sourceIdentity.channel,
    sourceIdentity.userId,
    targetIdentity.channel,
    targetIdentity.userId,
    input.nonce.trim(),
  ) as ContactIdentityVerificationRow | undefined;

  if (!row) {
    return { status: 'verification_not_found' };
  }

  const mappedRow = toIdentityLinkVerification(row);
  if (mappedRow.status !== 'pending') {
    return { status: 'verification_replayed', verification: mappedRow };
  }

  if (row.expires_at !== input.expiresAt.trim()) {
    const failed = markIdentityLinkVerification(context.db, row.id, 'failed', 'claim_mismatch')
      ?? mappedRow;
    return { status: 'claim_mismatch', verification: failed };
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAtMs) || now > expiresAtMs) {
    const expired = markIdentityLinkVerification(context.db, row.id, 'expired', 'expired')
      ?? mappedRow;
    return { status: 'verification_expired', verification: expired };
  }

  if (row.signature !== input.signature.trim()) {
    const failed = markIdentityLinkVerification(context.db, row.id, 'failed', 'invalid_signature')
      ?? mappedRow;
    return { status: 'invalid_signature', verification: failed };
  }

  const sourceOwner = context.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
  if (!sourceOwner || sourceOwner.id !== input.contactId) {
    const failed = markIdentityLinkVerification(context.db, row.id, 'failed', 'source_identity_not_linked')
      ?? mappedRow;
    return { status: 'source_identity_not_linked', verification: failed };
  }

  const linkResult = context.linkChannelIdentity(
    input.contactId,
    targetIdentity.channel,
    targetIdentity.userId,
    { privacyLevel: input.privacyLevel },
  );

  if (linkResult === 'identity_conflict') {
    const failed = markIdentityLinkVerification(context.db, row.id, 'failed', 'identity_conflict')
      ?? mappedRow;
    return { status: 'identity_conflict', verification: failed };
  }

  if (linkResult === 'contact_not_found') {
    return { status: 'contact_not_found' };
  }

  const verified = markIdentityLinkVerification(
    context.db,
    row.id,
    'verified',
    undefined,
    new Date(now).toISOString(),
  ) ?? mappedRow;

  return { status: linkResult, verification: verified };
}
