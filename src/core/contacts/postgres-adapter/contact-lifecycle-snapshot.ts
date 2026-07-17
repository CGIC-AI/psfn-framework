import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ContactAuthorityLifecycleRequest } from '../../../shared/contracts/contact-authority-lifecycle.js';
import {
  parseContactLifecycleLockedSnapshot,
  type ContactLifecycleLockedSnapshot,
  type ContactLifecycleManualHoldReason,
} from '../../../shared/contracts/contact-lifecycle-ledger.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { withPostgresClient } from './connection.js';
import type { ContactIdentityVerificationRow } from './rows.js';

interface ContactAuthorityRow {
  id: string;
  contact_authority_version: string;
  contact_lifecycle_state: string;
  contact_restore_state: string;
}

interface OwnershipAuthorityRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  identity_version: string;
  ownership_state: string;
  verification_id: string | null;
  verification_digest: string | null;
  restore_state: string;
}

interface VerificationAuthorityRow {
  id: string;
  contact_id: string;
  source_channel: string;
  source_user_id: string;
  target_channel: string;
  target_user_id: string;
  status: string;
  verified_at: string | null;
}

export interface LockedContactLifecycleSnapshot {
  snapshot?: ContactLifecycleLockedSnapshot;
  holdReason?: ContactLifecycleManualHoldReason;
  targets: Array<{ kind: 'contact' | 'provider_subject'; id: string }>;
}

function authorityVersion(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Corrupt contact lifecycle authority ${field}`);
  }
  return parsed;
}

function verificationProvenance(value: VerificationAuthorityRow): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verificationId: value.id,
    contactId: value.contact_id,
    sourceChannel: value.source_channel,
    sourceUserId: value.source_user_id,
    targetChannel: value.target_channel,
    targetUserId: value.target_user_id,
    verifiedAt: value.verified_at,
  };
}

export function contactIdentityVerificationDigest(value: VerificationAuthorityRow): string {
  return createHash('sha256').update(JSON.stringify(verificationProvenance(value))).digest('hex');
}

function contactIdsForRequest(request: ContactAuthorityLifecycleRequest): string[] {
  return [...new Set([
    request.contactId,
    ...(request.canonicalContactId ? [request.canonicalContactId] : []),
  ])].sort();
}

async function preliminarySubjectIds(
  client: PoolClient,
  request: ContactAuthorityLifecycleRequest,
): Promise<string[]> {
  const subjects = new Set<string>();
  if (request.providerSubjectId) subjects.add(request.providerSubjectId);
  if (request.action === 'contact.merge' || request.action === 'contact.delete') {
    const rows = await client.query<{ channel_user_id: string }>(`
      SELECT channel_user_id
      FROM contact_channel_ids
      WHERE contact_id = ANY($1::text[]) AND channel = 'discord'
        AND ownership_state IN ('verified', 'quarantined')
      ORDER BY channel_user_id
    `, [contactIdsForRequest(request)]);
    for (const row of rows.rows) subjects.add(row.channel_user_id);
  }
  return [...subjects].sort();
}

async function lockTargetKeys(
  client: PoolClient,
  request: ContactAuthorityLifecycleRequest,
): Promise<Array<{ kind: 'contact' | 'provider_subject'; id: string }>> {
  const schemaResult = await client.query<{ schema_name: string }>(
    'SELECT current_schema() AS schema_name',
  );
  const schema = schemaResult.rows.at(0)?.schema_name;
  if (!schema || !/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error('Contact lifecycle store has no valid companion schema owner');
  }
  const targets: Array<{ kind: 'contact' | 'provider_subject'; id: string }> = [
    ...contactIdsForRequest(request).map(id => ({ kind: 'contact' as const, id })),
    ...(await preliminarySubjectIds(client, request)).map(id => ({
      kind: 'provider_subject' as const,
      id,
    })),
  ];
  targets.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  for (const target of targets) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `contact-lifecycle:${schema}:${target.kind}:${target.id}`,
    ]);
  }
  return targets;
}

async function loadLockedContacts(
  client: PoolClient,
  request: ContactAuthorityLifecycleRequest,
): Promise<{ rows?: ContactAuthorityRow[]; holdReason?: ContactLifecycleManualHoldReason }> {
  const ids = contactIdsForRequest(request);
  const result = await client.query<ContactAuthorityRow>(`
    SELECT id, contact_authority_version, contact_lifecycle_state, contact_restore_state
    FROM contacts
    WHERE id = ANY($1::text[])
    ORDER BY id
    FOR UPDATE
  `, [ids]);
  if (result.rows.length !== ids.length) {
    return {
      holdReason: request.canonicalContactId && !result.rows.some(row => row.id === request.canonicalContactId)
        ? 'canonical_contact_not_found'
        : 'contact_not_found',
    };
  }
  const valid = request.action === 'contact.reapprove'
    ? result.rows.every(row => row.contact_lifecycle_state === 'quarantined'
      && row.contact_restore_state === 'quarantined')
    : result.rows.every(row => row.contact_lifecycle_state === 'live'
      && row.contact_restore_state === 'live');
  if (!valid) {
    return { holdReason: 'contact_not_live' };
  }
  return { rows: result.rows };
}

async function validateOwnership(
  client: PoolClient,
  ownership: OwnershipAuthorityRow,
  contacts: Map<string, ContactAuthorityRow>,
  allowQuarantined = false,
): Promise<{
  snapshot?: ContactLifecycleLockedSnapshot['verifiedOwnerships'][number];
  holdReason?: ContactLifecycleManualHoldReason;
}> {
  const exactLive = ownership.restore_state === 'live'
    && ownership.ownership_state === 'verified';
  const exactQuarantine = ownership.restore_state === 'quarantined'
    && ownership.ownership_state === 'quarantined';
  if (!exactLive && !(allowQuarantined && exactQuarantine)) {
    return {
      holdReason: exactQuarantine ? 'ownership_quarantined' : 'ownership_unverified',
    };
  }
  if (!ownership.verification_id || !ownership.verification_digest) {
    return { holdReason: 'ownership_unverified' };
  }
  const verification = await client.query<VerificationAuthorityRow>(`
    SELECT id, contact_id, source_channel, source_user_id,
           target_channel, target_user_id, status, verified_at
    FROM contact_identity_link_verifications
    WHERE id = $1
    FOR SHARE
  `, [ownership.verification_id]);
  const row = verification.rows.at(0);
  if (!row
    || row.status !== 'verified'
    || row.contact_id !== ownership.contact_id
    || row.target_channel !== ownership.channel
    || row.target_user_id !== ownership.channel_user_id
    || !row.verified_at) {
    return { holdReason: 'stale_ownership' };
  }
  const digest = contactIdentityVerificationDigest(row);
  if (!timingSafeStringEqual(digest, ownership.verification_digest)) {
    throw new Error('Corrupt contact lifecycle verification provenance digest');
  }
  const contact = contacts.get(ownership.contact_id);
  if (!contact) return { holdReason: 'ownership_reassigned' };
  return {
    snapshot: {
      schemaVersion: 1,
      contactId: ownership.contact_id,
      channel: 'discord',
      providerSubjectId: ownership.channel_user_id,
      identityVersion: authorityVersion(ownership.identity_version, 'identity_version'),
      verificationId: ownership.verification_id,
      verificationDigest: ownership.verification_digest,
      contactAuthorityVersion: authorityVersion(
        contact.contact_authority_version,
        'contact_authority_version',
      ),
      ownershipState: exactQuarantine ? 'quarantined' : 'verified',
      restoreState: exactQuarantine ? 'quarantined' : 'live',
    },
  };
}

export async function lockExactContactLifecycleSnapshot(
  client: PoolClient,
  request: ContactAuthorityLifecycleRequest,
): Promise<LockedContactLifecycleSnapshot> {
  const targets = await lockTargetKeys(client, request);
  const lockedContacts = await loadLockedContacts(client, request);
  if (!lockedContacts.rows) return { holdReason: lockedContacts.holdReason, targets };
  const contacts = new Map(lockedContacts.rows.map(row => [row.id, row]));
  let ownershipRows: OwnershipAuthorityRow[] = [];
  if (request.providerSubjectId) {
    const result = await client.query<OwnershipAuthorityRow>(`
      SELECT contact_id, channel, channel_user_id, identity_version,
             ownership_state, verification_id, verification_digest, restore_state
      FROM contact_channel_ids
      WHERE channel = 'discord' AND channel_user_id = $1
      FOR UPDATE
    `, [request.providerSubjectId]);
    const ownership = result.rows.at(0);
    if (!ownership) return { holdReason: 'ownership_not_found', targets };
    if (ownership.contact_id !== request.contactId) {
      return { holdReason: 'ownership_reassigned', targets };
    }
    if (request.action === 'contact.verify' && ownership.ownership_state === 'unverified') {
      if (ownership.restore_state !== 'live') {
        return { holdReason: 'ownership_quarantined', targets };
      }
      const verification = await client.query<VerificationAuthorityRow>(`
        SELECT id, contact_id, source_channel, source_user_id,
               target_channel, target_user_id, status, verified_at
        FROM contact_identity_link_verifications
        WHERE id = $1
        FOR SHARE
      `, [request.intentId]);
      const proof = verification.rows.at(0);
      if (!proof
        || proof.contact_id !== request.contactId
        || proof.target_channel !== 'discord'
        || proof.target_user_id !== request.providerSubjectId
        || proof.status !== 'pending'
        || proof.verified_at !== null) {
        return { holdReason: 'stale_ownership', targets };
      }
      ownershipRows = [];
    } else {
      ownershipRows = [ownership];
    }
  } else {
    const result = await client.query<OwnershipAuthorityRow>(`
      SELECT contact_id, channel, channel_user_id, identity_version,
             ownership_state, verification_id, verification_digest, restore_state
      FROM contact_channel_ids
      WHERE contact_id = ANY($1::text[]) AND channel = 'discord'
        AND ownership_state IN ('verified', 'quarantined')
      ORDER BY channel_user_id
      FOR UPDATE
    `, [contactIdsForRequest(request)]);
    ownershipRows = result.rows;
  }
  const verifiedOwnerships: ContactLifecycleLockedSnapshot['verifiedOwnerships'] = [];
  for (const ownership of ownershipRows) {
    const validated = await validateOwnership(
      client,
      ownership,
      contacts,
      request.action === 'contact.reapprove',
    );
    if (!validated.snapshot) return { holdReason: validated.holdReason, targets };
    verifiedOwnerships.push(validated.snapshot);
  }
  const snapshot = parseContactLifecycleLockedSnapshot({
    schemaVersion: 1,
    contacts: lockedContacts.rows.map(row => ({
      schemaVersion: 1,
      contactId: row.id,
      contactAuthorityVersion: authorityVersion(
        row.contact_authority_version,
        'contact_authority_version',
      ),
      lifecycleState: row.contact_lifecycle_state,
      restoreState: row.contact_restore_state,
    })),
    verifiedOwnerships,
  });
  return { snapshot, targets };
}

export async function markVerifiedContactOwnership(
  pool: Pool,
  verificationId: string,
  status: string,
  failureReason?: string,
  verifiedAt?: string,
): Promise<ContactIdentityVerificationRow | undefined> {
  return await withPostgresClient(pool, async (client) => {
    const now = new Date().toISOString();
    await client.query(`
      UPDATE contact_identity_link_verifications
      SET status = $1, updated_at = $2,
          verified_at = COALESCE($3, verified_at), failure_reason = $4
      WHERE id = $5
    `, [status, now, verifiedAt ?? null, failureReason ?? null, verificationId]);
    const selected = await client.query<ContactIdentityVerificationRow>(`
      SELECT * FROM contact_identity_link_verifications WHERE id = $1 LIMIT 1
    `, [verificationId]);
    const row = selected.rows.at(0);
    if (!row || status !== 'verified' || row.target_channel !== 'discord') return row;
    if (!row.verified_at) {
      throw new Error('Verified Discord ownership requires exact verification provenance');
    }
    const digest = contactIdentityVerificationDigest(row);
    const ownership = await client.query(`
      UPDATE contact_channel_ids
      SET ownership_state = 'verified', verification_id = $1,
          verification_digest = $2, restore_state = 'live'
      WHERE contact_id = $3 AND channel = $4 AND channel_user_id = $5
        AND ownership_state IN ('unverified', 'verified')
      RETURNING contact_id
    `, [row.id, digest, row.contact_id, row.target_channel, row.target_user_id]);
    if (ownership.rowCount !== 1) {
      throw new Error('Verified Discord ownership target is missing, reassigned, or quarantined');
    }
    return row;
  });
}
