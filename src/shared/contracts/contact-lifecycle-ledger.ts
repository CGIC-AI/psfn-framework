import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../utils/types.js';
import type {
  ContactAuthorityLifecycleRequest,
  ContactAuthorityLifecycleResult,
} from './contact-authority-lifecycle.js';

export const CONTACT_LIFECYCLE_LEDGER_SCHEMA_VERSION = 1 as const;

export interface ContactLifecycleContactSnapshot {
  schemaVersion: 1;
  contactId: string;
  contactAuthorityVersion: number;
  lifecycleState: 'live';
  restoreState: 'live';
}

export interface ContactLifecycleVerifiedOwnershipSnapshot {
  schemaVersion: 1;
  contactId: string;
  channel: 'discord';
  providerSubjectId: string;
  identityVersion: number;
  verificationId: string;
  verificationDigest: string;
  contactAuthorityVersion: number;
  ownershipState: 'verified';
  restoreState: 'live';
}

export interface ContactLifecycleLockedSnapshot {
  schemaVersion: 1;
  contacts: ContactLifecycleContactSnapshot[];
  verifiedOwnerships: ContactLifecycleVerifiedOwnershipSnapshot[];
}

export type ContactLifecyclePendingPhase =
  | 'gateway_prepare_pending'
  | 'contact_commit_pending'
  | 'gateway_finalize_pending';

export type ContactLifecycleManualHoldReason =
  | 'contact_not_found'
  | 'canonical_contact_not_found'
  | 'contact_not_live'
  | 'ownership_not_found'
  | 'ownership_unverified'
  | 'ownership_reassigned'
  | 'ownership_quarantined'
  | 'stale_ownership'
  | 'target_locked'
  | 'retry_exhausted';

export type ContactLifecyclePrepareOutcome =
  | {
      schemaVersion: 1;
      status: 'pending';
      intentId: string;
      phase: ContactLifecyclePendingPhase;
      reason: string;
      snapshotDigest: string;
    }
  | {
      schemaVersion: 1;
      status: 'manual_hold';
      intentId: string;
      phase: 'manual_hold';
      reason: ContactLifecycleManualHoldReason;
    }
  | {
      schemaVersion: 1;
      status: 'completed';
      intentId: string;
      phase: 'finalized';
      reason: 'finalized';
    };

export interface ContactLifecycleRecoveryLease {
  schemaVersion: 1;
  intentId: string;
  phase: ContactLifecyclePendingPhase;
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>;
  snapshot: ContactLifecycleLockedSnapshot;
  snapshotDigest: string;
  retryCount: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface ContactLifecycleRecoveryClaimInput {
  leaseOwner: string;
  limit?: number;
  leaseMs?: number;
}

export interface ContactLifecycleRecoveryDeferralInput {
  intentId: string;
  leaseOwner: string;
  reason: string;
}

export interface ContactLifecycleGatewayResultInput {
  intentId: string;
  result: ContactAuthorityLifecycleResult;
}

const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const PENDING_PHASES = new Set<ContactLifecyclePendingPhase>([
  'gateway_prepare_pending',
  'contact_commit_pending',
  'gateway_finalize_pending',
]);
const MANUAL_HOLD_REASONS = new Set<ContactLifecycleManualHoldReason>([
  'contact_not_found',
  'canonical_contact_not_found',
  'contact_not_live',
  'ownership_not_found',
  'ownership_unverified',
  'ownership_reassigned',
  'ownership_quarantined',
  'stale_ownership',
  'target_locked',
  'retry_exhausted',
]);

function invalid(message: string): Error {
  return new Error(`Invalid companion contact lifecycle ledger v1: ${message}`);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  assertNoUnknownKeys(value, keys, path, {
    errorPrefix: 'Invalid companion contact lifecycle ledger v1',
  });
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw invalid(`${path} is missing a required field`);
  }
}

function assertContactId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalid(`${field} is invalid`);
  }
}

function positiveVersion(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalid(`${field} is invalid`);
  return Number(value);
}

function parseContactSnapshot(value: unknown, index: number): ContactLifecycleContactSnapshot {
  if (!isRecord(value)) throw invalid(`contacts[${index}] must be an object`);
  assertExactKeys(
    value,
    ['schemaVersion', 'contactId', 'contactAuthorityVersion', 'lifecycleState', 'restoreState'],
    `contacts[${index}]`,
  );
  if (value.schemaVersion !== 1 || value.lifecycleState !== 'live' || value.restoreState !== 'live') {
    throw invalid(`contacts[${index}] is not live authority`);
  }
  assertContactId(value.contactId, `contacts[${index}].contactId`);
  return {
    schemaVersion: 1,
    contactId: value.contactId,
    contactAuthorityVersion: positiveVersion(
      value.contactAuthorityVersion,
      `contacts[${index}].contactAuthorityVersion`,
    ),
    lifecycleState: 'live',
    restoreState: 'live',
  };
}

function parseOwnership(
  value: unknown,
  index: number,
): ContactLifecycleVerifiedOwnershipSnapshot {
  if (!isRecord(value)) throw invalid(`verifiedOwnerships[${index}] must be an object`);
  assertExactKeys(value, [
    'schemaVersion',
    'contactId',
    'channel',
    'providerSubjectId',
    'identityVersion',
    'verificationId',
    'verificationDigest',
    'contactAuthorityVersion',
    'ownershipState',
    'restoreState',
  ], `verifiedOwnerships[${index}]`);
  if (value.schemaVersion !== 1
    || value.channel !== 'discord'
    || value.ownershipState !== 'verified'
    || value.restoreState !== 'live') {
    throw invalid(`verifiedOwnerships[${index}] is not exact live verified Discord ownership`);
  }
  assertContactId(value.contactId, `verifiedOwnerships[${index}].contactId`);
  if (typeof value.providerSubjectId !== 'string'
    || !DISCORD_SUBJECT_PATTERN.test(value.providerSubjectId)) {
    throw invalid(`verifiedOwnerships[${index}].providerSubjectId is invalid`);
  }
  if (typeof value.verificationId !== 'string' || !UUID_PATTERN.test(value.verificationId)) {
    throw invalid(`verifiedOwnerships[${index}].verificationId is invalid`);
  }
  if (typeof value.verificationDigest !== 'string'
    || !DIGEST_PATTERN.test(value.verificationDigest)) {
    throw invalid(`verifiedOwnerships[${index}].verificationDigest is invalid`);
  }
  return {
    schemaVersion: 1,
    contactId: value.contactId,
    channel: 'discord',
    providerSubjectId: value.providerSubjectId,
    identityVersion: positiveVersion(
      value.identityVersion,
      `verifiedOwnerships[${index}].identityVersion`,
    ),
    verificationId: value.verificationId,
    verificationDigest: value.verificationDigest,
    contactAuthorityVersion: positiveVersion(
      value.contactAuthorityVersion,
      `verifiedOwnerships[${index}].contactAuthorityVersion`,
    ),
    ownershipState: 'verified',
    restoreState: 'live',
  };
}

export function parseContactLifecycleLockedSnapshot(
  input: unknown,
): ContactLifecycleLockedSnapshot {
  if (!isRecord(input)) throw invalid('snapshot must be an object');
  assertExactKeys(input, ['schemaVersion', 'contacts', 'verifiedOwnerships'], 'snapshot');
  if (input.schemaVersion !== 1 || !Array.isArray(input.contacts)
    || !Array.isArray(input.verifiedOwnerships) || input.contacts.length < 1) {
    throw invalid('snapshot shape is invalid');
  }
  const contacts = input.contacts.map(parseContactSnapshot).sort((a, b) => (
    a.contactId.localeCompare(b.contactId)
  ));
  const contactVersions = new Map<string, number>();
  for (const contact of contacts) {
    if (contactVersions.has(contact.contactId)) throw invalid('snapshot repeats a contact');
    contactVersions.set(contact.contactId, contact.contactAuthorityVersion);
  }
  const verifiedOwnerships = input.verifiedOwnerships.map(parseOwnership).sort((a, b) => (
    a.providerSubjectId.localeCompare(b.providerSubjectId)
  ));
  const subjects = new Set<string>();
  for (const ownership of verifiedOwnerships) {
    if (subjects.has(ownership.providerSubjectId)) throw invalid('snapshot repeats a provider subject');
    subjects.add(ownership.providerSubjectId);
    if (contactVersions.get(ownership.contactId) !== ownership.contactAuthorityVersion) {
      throw invalid('ownership contact authority version is stale');
    }
  }
  return { schemaVersion: 1, contacts, verifiedOwnerships };
}

export function canonicalContactLifecycleSnapshotJson(
  snapshot: ContactLifecycleLockedSnapshot,
): string {
  return JSON.stringify(parseContactLifecycleLockedSnapshot(snapshot));
}

export function parseContactLifecyclePrepareOutcome(input: unknown): ContactLifecyclePrepareOutcome {
  if (!isRecord(input)) throw invalid('outcome must be an object');
  assertExactKeys(
    input,
    ['schemaVersion', 'status', 'intentId', 'phase', 'reason',
      ...(input.status === 'pending' ? ['snapshotDigest'] : [])],
    'outcome',
  );
  if (input.schemaVersion !== 1 || !isRfc4122Uuid(input.intentId)) {
    throw invalid('outcome identity is invalid');
  }
  if (input.status === 'pending'
    && typeof input.phase === 'string'
    && PENDING_PHASES.has(input.phase as ContactLifecyclePendingPhase)
    && typeof input.reason === 'string'
    && input.reason.length >= 1
    && input.reason.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(input.reason)
    && typeof input.snapshotDigest === 'string'
    && DIGEST_PATTERN.test(input.snapshotDigest)) {
    return input as unknown as ContactLifecyclePrepareOutcome;
  }
  if (input.status === 'manual_hold'
    && input.phase === 'manual_hold'
    && typeof input.reason === 'string'
    && MANUAL_HOLD_REASONS.has(input.reason as ContactLifecycleManualHoldReason)) {
    return input as unknown as ContactLifecyclePrepareOutcome;
  }
  if (input.status === 'completed' && input.phase === 'finalized' && input.reason === 'finalized') {
    return input as unknown as ContactLifecyclePrepareOutcome;
  }
  throw invalid('outcome state is invalid');
}
