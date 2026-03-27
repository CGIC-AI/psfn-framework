import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
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
import { v4 as uuidv4 } from 'uuid';
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
  ): Promise<ContactIdentityLinkResult>;
}

export interface IdentityVerificationContext {
  adapter: DatabaseAdapter;
  getById: (contactId: string) => Contact | undefined;
  getByChannelIdentity: (channel: string, channelUserId: string) => Contact | undefined;
  linkChannelIdentity: LinkIdentityFn;
}

export async function markIdentityLinkVerification(
  adapter: DatabaseAdapter,
  verificationId: string,
  status: ContactIdentityLinkVerificationState,
  failureReason?: string,
  verifiedAt?: string,
): Promise<ContactIdentityLinkVerification | undefined> {
  const now = new Date().toISOString();
  await adapter.run(`
    UPDATE contact_identity_link_verifications
    SET status = ?,
        updated_at = ?,
        verified_at = COALESCE(?, verified_at),
        failure_reason = ?
    WHERE id = ?
  `, [
    status,
    now,
    verifiedAt ?? null,
    failureReason ?? null,
    verificationId,
  ]);

  const row = await adapter.queryOne<ContactIdentityVerificationRow>(`
    SELECT *
    FROM contact_identity_link_verifications
    WHERE id = ?
    LIMIT 1
  `, [verificationId]);

  return row ? toIdentityLinkVerification(row) : undefined;
}

export async function createIdentityLinkChallenge(
  context: IdentityVerificationContext,
  input: ContactIdentityLinkChallengeInput,
): Promise<ContactIdentityLinkChallengeResult> {
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

  const existingPending = await context.adapter.queryOne<ContactIdentityVerificationRow>(`
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
  `, [
    contact.id,
    sourceIdentity.channel,
    sourceIdentity.userId,
    targetIdentity.channel,
    targetIdentity.userId,
  ]);

  if (existingPending) {
    const expiresAtMs = Date.parse(existingPending.expires_at);
    if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
      return {
        status: 'pending_exists',
        verification: toIdentityLinkVerification(existingPending),
      };
    }
    await markIdentityLinkVerification(context.adapter, existingPending.id, 'expired', 'expired');
  }

  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + normalizeVerificationTtlMs(input.ttlMs),
  ).toISOString();
  const verification: ContactIdentityLinkVerification = {
    id: uuidv4(),
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

  await context.adapter.run(`
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
  `, [
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
  ]);

  return { status: 'challenge_created', verification };
}

export async function verifyIdentityLinkChallenge(
  context: IdentityVerificationContext,
  input: ContactIdentityLinkVerificationInput,
): Promise<ContactIdentityLinkVerificationResult> {
  const contact = context.getById(input.contactId);
  if (!contact) return { status: 'contact_not_found' };

  const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
  const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);

  const row = await context.adapter.queryOne<ContactIdentityVerificationRow>(`
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
  `, [
    input.contactId,
    sourceIdentity.channel,
    sourceIdentity.userId,
    targetIdentity.channel,
    targetIdentity.userId,
    input.nonce.trim(),
  ]);

  if (!row) {
    return { status: 'verification_not_found' };
  }

  const mappedRow = toIdentityLinkVerification(row);
  if (mappedRow.status !== 'pending') {
    return { status: 'verification_replayed', verification: mappedRow };
  }

  if (row.expires_at !== input.expiresAt.trim()) {
    const failed = await markIdentityLinkVerification(context.adapter, row.id, 'failed', 'claim_mismatch')
      ?? mappedRow;
    return { status: 'claim_mismatch', verification: failed };
  }

  const now = Date.now();
  const expiresAtMs = Date.parse(row.expires_at);
  if (!Number.isFinite(expiresAtMs) || now > expiresAtMs) {
    const expired = await markIdentityLinkVerification(context.adapter, row.id, 'expired', 'expired')
      ?? mappedRow;
    return { status: 'verification_expired', verification: expired };
  }

  if (row.signature !== input.signature.trim()) {
    const failed = await markIdentityLinkVerification(context.adapter, row.id, 'failed', 'invalid_signature')
      ?? mappedRow;
    return { status: 'invalid_signature', verification: failed };
  }

  const sourceOwner = context.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
  if (!sourceOwner || sourceOwner.id !== input.contactId) {
    const failed = await markIdentityLinkVerification(context.adapter, row.id, 'failed', 'source_identity_not_linked')
      ?? mappedRow;
    return { status: 'source_identity_not_linked', verification: failed };
  }

  const linkResult = await context.linkChannelIdentity(
    input.contactId,
    targetIdentity.channel,
    targetIdentity.userId,
    { privacyLevel: input.privacyLevel },
  );

  if (linkResult === 'identity_conflict') {
    const failed = await markIdentityLinkVerification(context.adapter, row.id, 'failed', 'identity_conflict')
      ?? mappedRow;
    return { status: 'identity_conflict', verification: failed };
  }

  if (linkResult === 'contact_not_found') {
    return { status: 'contact_not_found' };
  }

  const verified = await markIdentityLinkVerification(
    context.adapter,
    row.id,
    'verified',
    undefined,
    new Date(now).toISOString(),
  ) ?? mappedRow;

  return { status: linkResult, verification: verified };
}