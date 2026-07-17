import type { Pool, PoolClient } from 'pg';
import type { ContactAuthorityLifecycleAction } from '../../../shared/contracts/contact-authority-lifecycle.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { withPostgresClient } from './connection.js';
import {
  parseContactLifecycleIntentRow,
  type ContactLifecycleIntentRow,
  type ParsedContactLifecycleIntentRow,
} from './contact-lifecycle-ledger-state.js';
import { contactIdentityVerificationDigest } from './contact-lifecycle-snapshot.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';
import type { ContactIdentityVerificationRow } from './rows.js';

interface ContactCasRow {
  id: string;
  contact_authority_version: string;
  contact_lifecycle_state: string;
  contact_restore_state: string;
}

interface OwnershipCasRow {
  contact_id: string;
  channel_user_id: string;
  identity_version: string;
  ownership_state: string;
  verification_id: string | null;
  verification_digest: string | null;
  restore_state: string;
}

function exactVersion(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Corrupt contact lifecycle ${field}`);
  }
  return parsed;
}

export async function beginContactLifecycleMutationCommit(
  client: PoolClient,
  intentId: string,
  expectedAction: ContactAuthorityLifecycleAction,
  recoveryLeaseOwner?: string,
): Promise<ParsedContactLifecycleIntentRow> {
  const result = await client.query<ContactLifecycleIntentRow & { lease_is_live: boolean | null }>(`
    SELECT *, lease_expires_at > clock_timestamp() AS lease_is_live
    FROM contact_lifecycle_intents WHERE intent_id = $1 FOR UPDATE
  `, [intentId]);
  const row = result.rows.at(0);
  if (!row) throw new Error('Contact lifecycle mutation intent is missing');
  const parsed = parseContactLifecycleIntentRow(row);
  if (row.phase !== 'contact_commit_pending' || parsed.request.action !== expectedAction) {
    throw new Error('Contact lifecycle mutation is not ready for its exact local commit');
  }
  if (!parsed.snapshot) throw new Error('Contact lifecycle mutation snapshot is missing');
  if (recoveryLeaseOwner) {
    if (row.lease_owner !== recoveryLeaseOwner || row.lease_is_live !== true) {
      throw new Error('Contact lifecycle recovery lease was lost before local commit');
    }
  } else if (row.lease_owner !== null) {
    throw new Error('Contact lifecycle local commit is owned by a recovery worker');
  }

  const contacts = await client.query<ContactCasRow>(`
    SELECT id, contact_authority_version, contact_lifecycle_state, contact_restore_state
    FROM contacts
    WHERE id = ANY($1::text[])
    ORDER BY id
    FOR UPDATE
  `, [parsed.snapshot.contacts.map(contact => contact.contactId)]);
  const byId = new Map(contacts.rows.map(contact => [contact.id, contact]));
  for (const expected of parsed.snapshot.contacts) {
    const actual = byId.get(expected.contactId);
    if (!actual
      || exactVersion(actual.contact_authority_version, 'contact authority version')
        !== expected.contactAuthorityVersion
      || actual.contact_lifecycle_state !== expected.lifecycleState
      || actual.contact_restore_state !== expected.restoreState) {
      throw new Error('Contact lifecycle exact contact CAS failed');
    }
  }

  for (const expected of parsed.snapshot.verifiedOwnerships) {
    const ownership = await client.query<OwnershipCasRow>(`
      SELECT contact_id, channel_user_id, identity_version, ownership_state,
             verification_id, verification_digest, restore_state
      FROM contact_channel_ids
      WHERE channel = 'discord' AND channel_user_id = $1
      FOR UPDATE
    `, [expected.providerSubjectId]);
    const actual = ownership.rows.at(0);
    if (!actual
      || actual.contact_id !== expected.contactId
      || exactVersion(actual.identity_version, 'identity version') !== expected.identityVersion
      || actual.ownership_state !== expected.ownershipState
      || actual.restore_state !== expected.restoreState
      || actual.verification_id !== expected.verificationId
      || !actual.verification_digest
      || !timingSafeStringEqual(actual.verification_digest, expected.verificationDigest)) {
      throw new Error('Contact lifecycle exact verified ownership CAS failed');
    }
  }
  return parsed;
}

export async function completeContactLifecycleMutationCommit(
  client: PoolClient,
  intentId: string,
  contactVersion: number,
  recoveryLeaseOwner?: string,
): Promise<void> {
  if (!Number.isSafeInteger(contactVersion) || contactVersion < 1) {
    throw new Error('Contact lifecycle mutation produced an invalid contact version');
  }
  const updated = await client.query(`
    UPDATE contact_lifecycle_intents
    SET phase = 'gateway_finalize_pending', reason = 'gateway_finalize_pending',
        committed_contact_version = $2, updated_at = clock_timestamp()
    WHERE intent_id = $1 AND phase = 'contact_commit_pending'
      AND (($3::text IS NULL AND lease_owner IS NULL) OR lease_owner = $3)
  `, [intentId, contactVersion, recoveryLeaseOwner ?? null]);
  if (updated.rowCount !== 1) {
    throw new Error('Contact lifecycle local commit phase changed concurrently');
  }
}

export async function readContactLifecycleCommittedVersion(
  pool: Pool,
  intentId: string,
): Promise<number> {
  const result = await pool.query<{ committed_contact_version: string | null }>(`
    SELECT committed_contact_version FROM contact_lifecycle_intents WHERE intent_id = $1
  `, [intentId]);
  const value = result.rows.at(0)?.committed_contact_version;
  if (value === null || value === undefined) {
    throw new Error('Contact lifecycle committed contact version is missing');
  }
  return exactVersion(value, 'committed contact version');
}

const postgresContactLifecycleMutationCommitOperations: PostgresContactOperationMap = {
  async commitVerifiedDiscordIdentity(
    verificationId: string,
    lifecycleIntentId: string,
    recoveryLeaseOwner?: string,
  ): Promise<number> {
    return await withPostgresClient(this.pool, async (client) => {
      const parsed = await beginContactLifecycleMutationCommit(
        client,
        lifecycleIntentId,
        'contact.verify',
        recoveryLeaseOwner,
      );
      if (parsed.request.intentId !== verificationId || !parsed.request.providerSubjectId) {
        throw new Error('Contact verification lifecycle intent is not bound to its proof');
      }
      const verification = await client.query<ContactIdentityVerificationRow>(`
        SELECT * FROM contact_identity_link_verifications WHERE id = $1 FOR UPDATE
      `, [verificationId]);
      const row = verification.rows.at(0);
      if (!row
        || row.status !== 'pending'
        || row.contact_id !== parsed.request.contactId
        || row.target_channel !== 'discord'
        || row.target_user_id !== parsed.request.providerSubjectId) {
        throw new Error('Contact verification proof changed before exact local commit');
      }
      const verifiedAt = new Date().toISOString();
      const updatedVerification = await client.query<ContactIdentityVerificationRow>(`
        UPDATE contact_identity_link_verifications
        SET status = 'verified', verified_at = $2, failure_reason = NULL,
            updated_at = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING *
      `, [verificationId, verifiedAt]);
      const verified = updatedVerification.rows.at(0);
      if (!verified) throw new Error('Contact verification proof changed concurrently');
      const verificationDigest = contactIdentityVerificationDigest(verified);
      const ownership = await client.query(`
        UPDATE contact_channel_ids
        SET ownership_state = 'verified', verification_id = $1,
            verification_digest = $2, restore_state = 'live'
        WHERE contact_id = $3 AND channel = 'discord' AND channel_user_id = $4
          AND ownership_state IN ('unverified', 'verified') AND restore_state = 'live'
      `, [
        verificationId,
        verificationDigest,
        parsed.request.contactId,
        parsed.request.providerSubjectId,
      ]);
      if (ownership.rowCount !== 1) {
        throw new Error('Contact verification ownership changed before exact local commit');
      }
      const contact = await client.query<{ contact_authority_version: string }>(`
        UPDATE contacts
        SET discord_user_id = $2,
            trust_level = CASE
              WHEN $2 = $3 THEN 'primary'
              ELSE trust_level
            END,
            trust_version = CASE
              WHEN $2 = $3 AND trust_level <> 'primary' THEN trust_version + 1
              ELSE trust_version
            END
        WHERE id = $1 AND (discord_user_id IS NULL OR discord_user_id = $2)
        RETURNING contact_authority_version
      `, [parsed.request.contactId, parsed.request.providerSubjectId, this.primaryUserId ?? null]);
      const contactVersion = exactVersion(
        contact.rows.at(0)?.contact_authority_version ?? '',
        'verified contact authority version',
      );
      await completeContactLifecycleMutationCommit(
        client,
        lifecycleIntentId,
        contactVersion,
        recoveryLeaseOwner,
      );
      return contactVersion;
    });
  },

  async commitReapprovedDiscordIdentity(
    lifecycleIntentId: string,
    recoveryLeaseOwner?: string,
  ): Promise<number> {
    return await withPostgresClient(this.pool, async (client) => {
      const parsed = await beginContactLifecycleMutationCommit(
        client,
        lifecycleIntentId,
        'contact.reapprove',
        recoveryLeaseOwner,
      );
      const subjectId = parsed.request.providerSubjectId;
      if (!subjectId || parsed.snapshot?.contacts.length !== 1
        || parsed.snapshot.verifiedOwnerships.length !== 1) {
        throw new Error('Contact reapproval lifecycle snapshot is not exact');
      }
      const contact = await client.query<{ contact_authority_version: string }>(`
        UPDATE contacts
        SET contact_lifecycle_state = 'live', contact_restore_state = 'live',
            contact_authority_version = contact_authority_version + 1,
            discord_user_id = $2,
            trust_level = CASE WHEN $2 = $3 THEN 'primary' ELSE trust_level END,
            trust_version = CASE
              WHEN $2 = $3 AND trust_level <> 'primary' THEN trust_version + 1
              ELSE trust_version
            END
        WHERE id = $1 AND contact_lifecycle_state = 'quarantined'
          AND contact_restore_state = 'quarantined'
        RETURNING contact_authority_version
      `, [parsed.request.contactId, subjectId, this.primaryUserId ?? null]);
      if (contact.rowCount !== 1) {
        throw new Error('Contact reapproval contact changed before exact local commit');
      }
      const ownership = await client.query(`
        UPDATE contact_channel_ids
        SET ownership_state = 'verified', restore_state = 'live'
        WHERE contact_id = $1 AND channel = 'discord' AND channel_user_id = $2
          AND ownership_state = 'quarantined' AND restore_state = 'quarantined'
      `, [parsed.request.contactId, subjectId]);
      if (ownership.rowCount !== 1) {
        throw new Error('Contact reapproval ownership changed before exact local commit');
      }
      const version = await client.query<{ contact_authority_version: string }>(`
        SELECT contact_authority_version FROM contacts WHERE id = $1
      `, [parsed.request.contactId]);
      const contactVersion = exactVersion(
        version.rows.at(0)?.contact_authority_version ?? '',
        'reapproved contact authority version',
      );
      await completeContactLifecycleMutationCommit(
        client,
        lifecycleIntentId,
        contactVersion,
        recoveryLeaseOwner,
      );
      return contactVersion;
    });
  },
};

export function installPostgresContactLifecycleMutationCommitOperations(
  store: PostgresContactStoreClass,
): void {
  Object.assign(store.prototype, postgresContactLifecycleMutationCommitOperations);
}
