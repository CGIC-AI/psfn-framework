import { createHash } from 'node:crypto';
import {
  contactAuthorityLifecycleRequestDigest,
  parseContactAuthorityLifecycleRequest,
  parseContactAuthorityLifecycleResult,
  type ContactAuthorityLifecycleRequest,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import {
  canonicalContactLifecycleSnapshotJson,
  parseContactLifecycleLockedSnapshot,
  parseContactLifecyclePrepareOutcome,
  type ContactLifecycleLockedSnapshot,
  type ContactLifecyclePrepareOutcome,
} from '../../../shared/contracts/contact-lifecycle-ledger.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';

export type ContactLifecycleLedgerPhase =
  | 'gateway_prepare_pending'
  | 'contact_commit_pending'
  | 'gateway_finalize_pending'
  | 'finalized'
  | 'manual_hold'
  | 'quarantined';

export interface ContactLifecycleIntentRow {
  intent_id: string;
  schema_version: number;
  request_digest: string;
  canonical_request: unknown;
  action: string;
  contact_id: string;
  canonical_contact_id: string | null;
  provider_subject_id: string | null;
  locked_snapshot: unknown | null;
  snapshot_digest: string | null;
  committed_contact_version: string | null;
  phase: ContactLifecycleLedgerPhase;
  reason: string;
  retry_count: number;
  next_attempt_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  restore_state: 'live' | 'quarantined';
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ParsedContactLifecycleIntentRow {
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>;
  snapshot?: ContactLifecycleLockedSnapshot;
  outcome: ContactLifecyclePrepareOutcome;
}

export function digestContactLifecycleSnapshot(snapshot: ContactLifecycleLockedSnapshot): string {
  return createHash('sha256')
    .update(canonicalContactLifecycleSnapshotJson(snapshot))
    .digest('hex');
}

export function digestContactLifecycleResult(result: unknown): string {
  const parsed = parseContactAuthorityLifecycleResult(result);
  const canonical = {
    schemaVersion: parsed.schemaVersion,
    intentId: parsed.intentId,
    phase: parsed.phase,
    action: parsed.action,
    status: parsed.status,
    authorityGeneration: parsed.authorityGeneration,
    globalAuthEpoch: parsed.globalAuthEpoch,
    auditEventId: parsed.auditEventId,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function outcomeForIntentRow(row: ContactLifecycleIntentRow): ContactLifecyclePrepareOutcome {
  if (row.restore_state !== 'live' || row.phase === 'quarantined') {
    return parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'manual_hold',
      intentId: row.intent_id,
      phase: 'manual_hold',
      reason: 'ownership_quarantined',
    });
  }
  if (row.phase === 'manual_hold') {
    return parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'manual_hold',
      intentId: row.intent_id,
      phase: 'manual_hold',
      reason: row.reason,
    });
  }
  if (row.phase === 'finalized') {
    return parseContactLifecyclePrepareOutcome({
      schemaVersion: 1,
      status: 'completed',
      intentId: row.intent_id,
      phase: 'finalized',
      reason: 'finalized',
    });
  }
  return parseContactLifecyclePrepareOutcome({
    schemaVersion: 1,
    status: 'pending',
    intentId: row.intent_id,
    phase: row.phase,
    reason: row.reason,
    snapshotDigest: row.snapshot_digest,
  });
}

export function parseContactLifecycleIntentRow(
  row: ContactLifecycleIntentRow,
): ParsedContactLifecycleIntentRow {
  if (row.schema_version !== 1) throw new Error('Corrupt contact lifecycle intent schema version');
  const request = parseContactAuthorityLifecycleRequest(row.canonical_request);
  if (request.phase !== 'prepare') {
    throw new Error('Corrupt contact lifecycle intent contains a non-prepare request');
  }
  const requestDigest = contactAuthorityLifecycleRequestDigest(request);
  if (!timingSafeStringEqual(requestDigest, row.request_digest)
    || request.intentId !== row.intent_id
    || request.action !== row.action
    || request.contactId !== row.contact_id
    || (request.canonicalContactId ?? null) !== row.canonical_contact_id
    || (request.providerSubjectId ?? null) !== row.provider_subject_id) {
    throw new Error('Corrupt contact lifecycle intent canonical request tuple');
  }
  let snapshot: ContactLifecycleLockedSnapshot | undefined;
  if (row.locked_snapshot !== null || row.snapshot_digest !== null) {
    if (row.locked_snapshot === null || row.snapshot_digest === null) {
      throw new Error('Corrupt contact lifecycle intent snapshot tuple');
    }
    snapshot = parseContactLifecycleLockedSnapshot(row.locked_snapshot);
    if (!timingSafeStringEqual(digestContactLifecycleSnapshot(snapshot), row.snapshot_digest)) {
      throw new Error('Corrupt contact lifecycle intent snapshot digest');
    }
    const reapproval = request.action === 'contact.reapprove';
    const snapshotIsQuarantined = snapshot.contacts.every(contact => (
      contact.lifecycleState === 'quarantined' && contact.restoreState === 'quarantined'
    )) && snapshot.verifiedOwnerships.every(ownership => (
      ownership.ownershipState === 'quarantined' && ownership.restoreState === 'quarantined'
    ));
    const snapshotIsLive = snapshot.contacts.every(contact => (
      contact.lifecycleState === 'live' && contact.restoreState === 'live'
    )) && snapshot.verifiedOwnerships.every(ownership => (
      ownership.ownershipState === 'verified' && ownership.restoreState === 'live'
    ));
    if ((reapproval && (!snapshotIsQuarantined
        || snapshot.contacts.length !== 1
        || snapshot.verifiedOwnerships.length !== 1))
      || (!reapproval && !snapshotIsLive)) {
      throw new Error('Corrupt contact lifecycle snapshot action state');
    }
  }
  if (row.phase !== 'manual_hold' && row.phase !== 'quarantined' && !snapshot) {
    throw new Error('Corrupt live contact lifecycle intent is missing its locked snapshot');
  }
  const committedContactVersion = row.committed_contact_version === null
    ? null
    : Number(row.committed_contact_version);
  if ((committedContactVersion !== null
      && (!Number.isSafeInteger(committedContactVersion) || committedContactVersion < 1))
    || ((row.phase === 'gateway_finalize_pending' || row.phase === 'finalized')
      && committedContactVersion === null)
    || ((row.phase === 'gateway_prepare_pending' || row.phase === 'contact_commit_pending')
      && committedContactVersion !== null)) {
    throw new Error('Corrupt contact lifecycle committed contact version');
  }
  return { request, ...(snapshot ? { snapshot } : {}), outcome: outcomeForIntentRow(row) };
}
