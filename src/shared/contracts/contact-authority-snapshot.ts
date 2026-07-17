import { isRecord } from '../utils/types.js';
import {
  parseContactLifecycleLockedSnapshot,
  type ContactLifecycleVerifiedOwnershipSnapshot,
} from './contact-lifecycle-ledger.js';

const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

export interface ContactAuthoritySnapshotRequest {
  contactId: string;
  providerSubjectId: string;
}

export type VerifiedDiscordContactAuthoritySnapshot = ContactLifecycleVerifiedOwnershipSnapshot;

function boundedContactId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function parseContactAuthoritySnapshotRequest(
  input: unknown,
): ContactAuthoritySnapshotRequest {
  if (!isRecord(input)
    || Object.keys(input).length !== 2
    || !boundedContactId(input.contactId)
    || typeof input.providerSubjectId !== 'string'
    || !DISCORD_SUBJECT_PATTERN.test(input.providerSubjectId)) {
    throw new Error('Invalid exact contact-authority snapshot request');
  }
  return {
    contactId: input.contactId,
    providerSubjectId: input.providerSubjectId,
  };
}

export function parseVerifiedDiscordContactAuthoritySnapshot(
  input: unknown,
): VerifiedDiscordContactAuthoritySnapshot {
  const snapshot = parseContactLifecycleLockedSnapshot({
    schemaVersion: 1,
    contacts: isRecord(input) ? [{
      schemaVersion: 1,
      contactId: input.contactId,
      contactAuthorityVersion: input.contactAuthorityVersion,
      lifecycleState: input.ownershipState === 'verified' ? 'live' : 'quarantined',
      restoreState: input.restoreState,
    }] : [],
    verifiedOwnerships: [input],
  });
  const ownership = snapshot.verifiedOwnerships.at(0);
  if (!ownership
    || ownership.ownershipState !== 'verified'
    || ownership.restoreState !== 'live') {
    throw new Error('Contact authority is not exact live verified Discord ownership');
  }
  return ownership;
}
