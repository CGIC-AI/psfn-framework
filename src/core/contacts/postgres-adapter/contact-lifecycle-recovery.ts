import type {
  ContactLifecyclePrepareOutcome,
  ContactLifecycleRecoveryClaimInput,
  ContactLifecycleRecoveryDeferralInput,
  ContactLifecycleRecoveryLease,
} from '../../../shared/contracts/contact-lifecycle-ledger.js';
import type {
  ContactLifecycleDiagnosticEntry,
  ContactLifecycleDiagnostics,
} from '../contact-store-port.js';
import { parseContactAuthorityLifecycleResult } from '../../../shared/contracts/contact-authority-lifecycle.js';
import { isRfc4122Uuid } from '../../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { withPostgresClient } from './connection.js';
import {
  contactIdentityVerificationDigest,
} from './contact-lifecycle-snapshot.js';
import {
  digestContactLifecycleResult,
  outcomeForIntentRow,
  parseContactLifecycleIntentRow,
  type ContactLifecycleIntentRow,
} from './contact-lifecycle-ledger-state.js';
import { ContactLifecycleLedgerDeniedError } from './contact-lifecycle-ledger-operations.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';

interface ResultHealthRow {
  intent_id: string;
  gateway_phase: 'prepare' | 'finalize';
  result_digest: string;
  result: unknown;
  action: string;
}

interface OwnershipHealthRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  identity_version: string;
  ownership_state: string;
  verification_id: string | null;
  verification_digest: string | null;
  restore_state: string;
  contact_authority_version: string;
  contact_lifecycle_state: string;
  contact_restore_state: string;
  verification_contact_id: string | null;
  source_channel: string | null;
  source_user_id: string | null;
  target_channel: string | null;
  target_user_id: string | null;
  verification_status: string | null;
  verified_at: string | null;
}

interface LockHealthRow {
  intent_id: string;
  target_kind: 'contact' | 'provider_subject';
  target_id: string;
  lock_state: 'active' | 'released' | 'quarantined';
  phase: ContactLifecycleIntentRow['phase'];
  restore_state: ContactLifecycleIntentRow['restore_state'];
}

const RECOVERY_POLICY = {
  defaultLimit: 25,
  maximumLimit: 100,
  defaultLeaseMs: 30_000,
  minimumLeaseMs: 1_000,
  maximumLeaseMs: 300_000,
  manualHoldAfterAttempts: 8,
} as const;

const DIAGNOSTIC_PHASES = [
  'gateway_prepare_pending',
  'contact_commit_pending',
  'gateway_finalize_pending',
  'manual_hold',
  'quarantined',
] as const;

function diagnosticLimit(value: number | undefined): number {
  const resolved = value ?? 20;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 100) {
    throw new ContactLifecycleLedgerDeniedError('invalid_diagnostic_limit');
  }
  return resolved;
}

function diagnosticEntry(row: ContactLifecycleIntentRow): ContactLifecycleDiagnosticEntry {
  const parsed = parseContactLifecycleIntentRow(row);
  if (!DIAGNOSTIC_PHASES.includes(row.phase as (typeof DIAGNOSTIC_PHASES)[number])) {
    throw new Error('Contact lifecycle diagnostic query returned a terminal row');
  }
  let state: ContactLifecycleDiagnosticEntry['state'] = 'over_fenced';
  if (row.phase === 'gateway_prepare_pending') state = 'prepared';
  else if (row.phase === 'manual_hold' || row.phase === 'quarantined') state = 'manual_hold';
  let reason: string = row.phase;
  if (row.phase === 'manual_hold') reason = parsed.outcome.reason;
  else if (row.phase === 'quarantined') reason = 'ownership_quarantined';
  return {
    action: parsed.request.action,
    state,
    phase: row.phase as (typeof DIAGNOSTIC_PHASES)[number],
    reason,
    retryCount: row.retry_count,
    updatedAt: canonicalTimestamp(row.updated_at, 'diagnostic update'),
  };
}

function leaseOwner(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ContactLifecycleLedgerDeniedError('invalid_lease_owner');
  }
  return trimmed;
}

function recoveryLimit(value: number | undefined): number {
  const resolved = value ?? RECOVERY_POLICY.defaultLimit;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > RECOVERY_POLICY.maximumLimit) {
    throw new ContactLifecycleLedgerDeniedError('invalid_recovery_limit');
  }
  return resolved;
}

function recoveryLeaseMs(value: number | undefined): number {
  const resolved = value ?? RECOVERY_POLICY.defaultLeaseMs;
  if (!Number.isSafeInteger(resolved)
    || resolved < RECOVERY_POLICY.minimumLeaseMs
    || resolved > RECOVERY_POLICY.maximumLeaseMs) {
    throw new ContactLifecycleLedgerDeniedError('invalid_recovery_lease');
  }
  return resolved;
}

function canonicalTimestamp(value: Date | string, field: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Corrupt contact lifecycle ${field}`);
  return date.toISOString();
}

function assertHealthyVerifiedOwnership(row: OwnershipHealthRow): void {
  if (row.channel !== 'discord'
    || row.ownership_state !== 'verified'
    || row.restore_state !== 'live'
    || row.contact_lifecycle_state !== 'live'
    || row.contact_restore_state !== 'live'
    || !row.verification_id
    || !row.verification_digest
    || row.verification_contact_id !== row.contact_id
    || row.target_channel !== row.channel
    || row.target_user_id !== row.channel_user_id
    || row.verification_status !== 'verified'
    || !row.verified_at
    || !row.source_channel
    || !row.source_user_id) {
    throw new Error('Corrupt exact verified contact ownership row');
  }
  const digest = contactIdentityVerificationDigest({
    id: row.verification_id,
    contact_id: row.verification_contact_id,
    source_channel: row.source_channel,
    source_user_id: row.source_user_id,
    target_channel: row.target_channel,
    target_user_id: row.target_user_id,
    status: row.verification_status,
    verified_at: row.verified_at,
  });
  if (!timingSafeStringEqual(digest, row.verification_digest)) {
    throw new Error('Corrupt exact verified contact ownership provenance digest');
  }
  const identityVersion = Number(row.identity_version);
  const contactAuthorityVersion = Number(row.contact_authority_version);
  if (!Number.isSafeInteger(identityVersion) || identityVersion < 1
    || !Number.isSafeInteger(contactAuthorityVersion) || contactAuthorityVersion < 1) {
    throw new Error('Corrupt exact verified contact ownership version');
  }
}

const postgresContactLifecycleRecoveryOperations: PostgresContactOperationMap = {
  async getContactLifecycleDiagnostics(limitInput?: number): Promise<ContactLifecycleDiagnostics> {
    const limit = diagnosticLimit(limitInput);
    return await withPostgresClient(this.pool, async (client) => {
      const countsResult = await client.query<{ phase: ContactLifecycleIntentRow['phase']; count: string }>(`
        SELECT phase, COUNT(*)::text AS count
        FROM contact_lifecycle_intents
        WHERE phase = ANY($1::text[])
        GROUP BY phase
      `, [[...DIAGNOSTIC_PHASES]]);
      const rows = await client.query<ContactLifecycleIntentRow>(`
        SELECT * FROM contact_lifecycle_intents
        WHERE phase = ANY($1::text[])
        ORDER BY updated_at DESC, intent_id DESC
        LIMIT $2
      `, [[...DIAGNOSTIC_PHASES], limit]);
      const counts: ContactLifecycleDiagnostics['counts'] = {
        prepared: 0,
        over_fenced: 0,
        manual_hold: 0,
      };
      let total = 0;
      for (const row of countsResult.rows) {
        const count = Number(row.count);
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error('Corrupt contact lifecycle diagnostic count');
        }
        total += count;
        if (row.phase === 'gateway_prepare_pending') counts.prepared += count;
        else if (row.phase === 'manual_hold' || row.phase === 'quarantined') {
          counts.manual_hold += count;
        } else if (row.phase === 'contact_commit_pending'
          || row.phase === 'gateway_finalize_pending') {
          counts.over_fenced += count;
        } else {
          throw new Error('Corrupt contact lifecycle diagnostic phase');
        }
      }
      return {
        schemaVersion: 1,
        total,
        truncated: total > rows.rows.length,
        counts,
        entries: rows.rows.map(diagnosticEntry),
      };
    });
  },

  async claimContactLifecycleRecovery(
    input: ContactLifecycleRecoveryClaimInput,
  ): Promise<ContactLifecycleRecoveryLease[]> {
    const owner = leaseOwner(input.leaseOwner);
    const limit = recoveryLimit(input.limit);
    const leaseMs = recoveryLeaseMs(input.leaseMs);
    return await withPostgresClient(this.pool, async (client) => {
      const claimed = await client.query<ContactLifecycleIntentRow>(`
        WITH candidates AS (
          SELECT intent_id
          FROM contact_lifecycle_intents
          WHERE restore_state = 'live'
            AND phase IN ('gateway_prepare_pending', 'contact_commit_pending', 'gateway_finalize_pending')
            AND next_attempt_at <= clock_timestamp()
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
          ORDER BY next_attempt_at, created_at, intent_id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
        )
        UPDATE contact_lifecycle_intents AS intent
        SET lease_owner = $2,
            lease_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
            updated_at = clock_timestamp()
        FROM candidates
        WHERE intent.intent_id = candidates.intent_id
        RETURNING intent.*
      `, [limit, owner, leaseMs]);
      return claimed.rows.map((row): ContactLifecycleRecoveryLease => {
        const parsed = parseContactLifecycleIntentRow(row);
        if (!parsed.snapshot
          || row.phase === 'manual_hold'
          || row.phase === 'finalized'
          || row.phase === 'quarantined'
          || !row.lease_owner
          || !row.lease_expires_at) {
          throw new Error('Corrupt claimed contact lifecycle recovery row');
        }
        return {
          schemaVersion: 1,
          intentId: row.intent_id,
          phase: row.phase,
          request: parsed.request,
          snapshot: parsed.snapshot,
          snapshotDigest: row.snapshot_digest ?? '',
          retryCount: row.retry_count,
          leaseOwner: row.lease_owner,
          leaseExpiresAt: canonicalTimestamp(row.lease_expires_at, 'lease expiry'),
        };
      });
    });
  },

  async deferContactLifecycleRecovery(
    input: ContactLifecycleRecoveryDeferralInput,
  ): Promise<ContactLifecyclePrepareOutcome> {
    if (!isRfc4122Uuid(input.intentId)) {
      throw new ContactLifecycleLedgerDeniedError('invalid_intent_id');
    }
    const owner = leaseOwner(input.leaseOwner);
    const reason = input.reason.trim();
    if (!reason || reason.length > 128 || /[\u0000-\u001f\u007f]/u.test(reason)) {
      throw new ContactLifecycleLedgerDeniedError('invalid_deferral_reason');
    }
    return await withPostgresClient(this.pool, async (client) => {
      const current = await client.query<ContactLifecycleIntentRow & { lease_is_live: boolean }>(`
        SELECT *, lease_expires_at > clock_timestamp() AS lease_is_live
        FROM contact_lifecycle_intents WHERE intent_id = $1 FOR UPDATE
      `, [input.intentId]);
      const row = current.rows.at(0);
      if (!row) throw new ContactLifecycleLedgerDeniedError('intent_not_found');
      parseContactLifecycleIntentRow(row);
      if (row.lease_owner !== owner || !row.lease_expires_at || row.lease_is_live !== true) {
        throw new ContactLifecycleLedgerDeniedError('recovery_lease_lost');
      }
      const nextRetryCount = row.retry_count + 1;
      const manualHold = nextRetryCount >= RECOVERY_POLICY.manualHoldAfterAttempts;
      const updated = await client.query<ContactLifecycleIntentRow>(`
        UPDATE contact_lifecycle_intents
        SET retry_count = $2::integer,
            phase = CASE WHEN $3 THEN 'manual_hold' ELSE phase END,
            reason = CASE WHEN $3 THEN 'retry_exhausted' ELSE $4 END,
            next_attempt_at = clock_timestamp()
              + (LEAST(3600, POWER(2::numeric, $2::integer)) * interval '1 second'),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE intent_id = $1
        RETURNING *
      `, [input.intentId, nextRetryCount, manualHold, reason]);
      return outcomeForIntentRow(updated.rows[0]);
    });
  },

  async assertContactLifecycleLedgerHealthy(): Promise<void> {
    await withPostgresClient(this.pool, async (client) => {
      const intents = await client.query<ContactLifecycleIntentRow>(`
        SELECT * FROM contact_lifecycle_intents ORDER BY created_at, intent_id
      `);
      for (const row of intents.rows) {
        parseContactLifecycleIntentRow(row);
      }
      const results = await client.query<ResultHealthRow>(`
        SELECT result.intent_id, result.gateway_phase, result.result_digest,
               result.result, intent.action
        FROM contact_lifecycle_results AS result
        JOIN contact_lifecycle_intents AS intent USING (intent_id)
        ORDER BY result.intent_id, result.gateway_phase
      `);
      const resultPhases = new Map<string, Set<'prepare' | 'finalize'>>();
      for (const row of results.rows) {
        const parsed = parseContactAuthorityLifecycleResult(row.result);
        if (parsed.intentId !== row.intent_id
          || parsed.phase !== row.gateway_phase
          || parsed.action !== row.action
          || !timingSafeStringEqual(digestContactLifecycleResult(parsed), row.result_digest)) {
          throw new Error('Corrupt contact lifecycle gateway result tuple');
        }
        const phases = resultPhases.get(row.intent_id) ?? new Set<'prepare' | 'finalize'>();
        phases.add(row.gateway_phase);
        resultPhases.set(row.intent_id, phases);
      }
      const locks = await client.query<LockHealthRow>(`
        SELECT lock.intent_id, lock.target_kind, lock.target_id,
               lock.lock_state, intent.phase, intent.restore_state
        FROM contact_lifecycle_target_locks AS lock
        JOIN contact_lifecycle_intents AS intent USING (intent_id)
      `);
      const locksByIntent = new Map<string, LockHealthRow[]>();
      for (const row of locks.rows) {
        if ((row.lock_state === 'quarantined'
          && !(row.phase === 'quarantined' && row.restore_state === 'quarantined'))
          || (row.lock_state === 'released'
            && row.phase !== 'finalized' && row.phase !== 'quarantined')
          || (row.lock_state === 'active'
            && (row.phase === 'finalized' || row.phase === 'quarantined'))) {
          throw new Error('Corrupt contact lifecycle target lock state');
        }
        const intentLocks = locksByIntent.get(row.intent_id) ?? [];
        intentLocks.push(row);
        locksByIntent.set(row.intent_id, intentLocks);
      }
      for (const row of intents.rows) {
        const parsed = parseContactLifecycleIntentRow(row);
        const phases = resultPhases.get(row.intent_id) ?? new Set<'prepare' | 'finalize'>();
        if ((row.phase === 'contact_commit_pending'
          || row.phase === 'gateway_finalize_pending'
          || row.phase === 'finalized') && !phases.has('prepare')) {
          throw new Error('Corrupt contact lifecycle phase is missing its prepare result');
        }
        if (row.phase === 'finalized' && !phases.has('finalize')) {
          throw new Error('Corrupt finalized contact lifecycle intent is missing its finalize result');
        }
        if (row.phase === 'gateway_prepare_pending' && phases.size > 0) {
          throw new Error('Corrupt contact lifecycle prepare phase has an early gateway result');
        }
        if (!parsed.snapshot) continue;
        const expectedTargets = new Set<string>([
          `contact:${parsed.request.contactId}`,
          ...(parsed.request.canonicalContactId
            ? [`contact:${parsed.request.canonicalContactId}`]
            : []),
          ...(parsed.request.providerSubjectId
            ? [`provider_subject:${parsed.request.providerSubjectId}`]
            : []),
          ...parsed.snapshot.verifiedOwnerships.map(ownership => (
            `provider_subject:${ownership.providerSubjectId}`
          )),
        ]);
        const actualLocks = locksByIntent.get(row.intent_id) ?? [];
        if (row.phase === 'manual_hold' && actualLocks.length === 0) continue;
        const actualTargets = new Set(actualLocks.map(lock => `${lock.target_kind}:${lock.target_id}`));
        if (actualTargets.size !== expectedTargets.size
          || [...expectedTargets].some(target => !actualTargets.has(target))) {
          throw new Error('Corrupt contact lifecycle intent target lock set');
        }
      }
      const ownerships = await client.query<OwnershipHealthRow>(`
        SELECT ownership.contact_id, ownership.channel, ownership.channel_user_id,
               ownership.identity_version, ownership.ownership_state,
               ownership.verification_id, ownership.verification_digest,
               ownership.restore_state, contact.contact_authority_version,
               contact.contact_lifecycle_state, contact.contact_restore_state,
               verification.contact_id AS verification_contact_id,
               verification.source_channel, verification.source_user_id,
               verification.target_channel, verification.target_user_id,
               verification.status AS verification_status, verification.verified_at
        FROM contact_channel_ids AS ownership
        JOIN contacts AS contact ON contact.id = ownership.contact_id
        LEFT JOIN contact_identity_link_verifications AS verification
          ON verification.id = ownership.verification_id
        WHERE ownership.ownership_state = 'verified'
        ORDER BY ownership.channel, ownership.channel_user_id
      `);
      for (const row of ownerships.rows) assertHealthyVerifiedOwnership(row);
    });
  },
};

export function installPostgresContactLifecycleRecoveryOperations(
  store: PostgresContactStoreClass,
): void {
  Object.assign(store.prototype, postgresContactLifecycleRecoveryOperations);
}
