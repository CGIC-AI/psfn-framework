import type {
  PostgresContactOperationContext,
  PostgresContactStoreClass,
} from './operation-map.js';
import {
  parseVerifiedDiscordContactAuthoritySnapshot,
  type VerifiedDiscordContactAuthoritySnapshot,
} from '../../../shared/contracts/contact-authority-snapshot.js';
import { contactIdentityVerificationDigest } from './contact-lifecycle-snapshot.js';

interface ExactContactAuthorityRow {
  contact_id: string;
  contact_authority_version: string;
  contact_lifecycle_state: string;
  contact_restore_state: string;
  identity_version: string;
  ownership_state: string;
  ownership_restore_state: string;
  verification_id: string;
  source_channel: string;
  source_user_id: string;
  target_channel: string;
  target_user_id: string;
  verification_status: string;
  verified_at: string | null;
}

function positiveVersion(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Corrupt contact authority ${field}`);
  }
  return parsed;
}

async function readVerifiedDiscordContactAuthority(
  this: PostgresContactOperationContext,
  contactId: string,
  providerSubjectId: string,
): Promise<VerifiedDiscordContactAuthoritySnapshot | undefined> {
  const result = await this.pool.query<ExactContactAuthorityRow>(`
    SELECT contact.id AS contact_id,
           contact.contact_authority_version,
           contact.contact_lifecycle_state,
           contact.contact_restore_state,
           ownership.identity_version,
           ownership.ownership_state,
           ownership.restore_state AS ownership_restore_state,
           verification.id AS verification_id,
           verification.source_channel,
           verification.source_user_id,
           verification.target_channel,
           verification.target_user_id,
           verification.status AS verification_status,
           verification.verified_at
    FROM contacts AS contact
    JOIN contact_channel_ids AS ownership
      ON ownership.contact_id = contact.id
     AND ownership.channel = 'discord'
     AND ownership.channel_user_id = $2
    JOIN contact_identity_link_verifications AS verification
      ON verification.id = ownership.verification_id
     AND verification.contact_id = contact.id
     AND verification.target_channel = 'discord'
     AND verification.target_user_id = $2
    WHERE contact.id = $1
  `, [contactId, providerSubjectId]);
  if (result.rowCount !== 1) return undefined;
  const row = result.rows[0]!;
  if (row.contact_lifecycle_state !== 'live'
    || row.contact_restore_state !== 'live'
    || row.ownership_state !== 'verified'
    || row.ownership_restore_state !== 'live'
    || row.verification_status !== 'verified'
    || row.verified_at === null) {
    return undefined;
  }
  const verificationDigest = contactIdentityVerificationDigest({
    id: row.verification_id,
    contact_id: row.contact_id,
    source_channel: row.source_channel,
    source_user_id: row.source_user_id,
    target_channel: row.target_channel,
    target_user_id: row.target_user_id,
    status: row.verification_status,
    verified_at: row.verified_at,
  });
  return parseVerifiedDiscordContactAuthoritySnapshot({
    schemaVersion: 1,
    contactId: row.contact_id,
    channel: 'discord',
    providerSubjectId,
    identityVersion: positiveVersion(row.identity_version, 'identity_version'),
    verificationId: row.verification_id,
    verificationDigest,
    contactAuthorityVersion: positiveVersion(
      row.contact_authority_version,
      'contact_authority_version',
    ),
    ownershipState: 'verified',
    restoreState: 'live',
  });
}

export function installPostgresContactAuthoritySnapshotOperations(
  Store: PostgresContactStoreClass,
): void {
  Store.prototype.readVerifiedDiscordContactAuthority = readVerifiedDiscordContactAuthority;
}
