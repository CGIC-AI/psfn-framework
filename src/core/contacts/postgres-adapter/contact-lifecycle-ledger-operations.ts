import type { PoolClient } from 'pg';
import {
  contactAuthorityLifecycleRequestDigest,
  parseContactAuthorityLifecycleRequest,
  parseContactAuthorityLifecycleResult,
  type ContactAuthorityLifecycleRequest,
} from '../../../shared/contracts/contact-authority-lifecycle.js';
import type {
  ContactLifecycleGatewayResultInput,
  ContactLifecycleLockedSnapshot,
  ContactLifecycleManualHoldReason,
  ContactLifecyclePrepareOutcome,
} from '../../../shared/contracts/contact-lifecycle-ledger.js';
import { isRfc4122Uuid } from '../../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { withPostgresClient } from './connection.js';
import {
  digestContactLifecycleResult,
  digestContactLifecycleSnapshot,
  outcomeForIntentRow,
  parseContactLifecycleIntentRow,
  type ContactLifecycleIntentRow,
} from './contact-lifecycle-ledger-state.js';
import { lockExactContactLifecycleSnapshot } from './contact-lifecycle-snapshot.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';

interface ResultRow {
  result_digest: string;
  result: unknown;
}

export class ContactLifecycleLedgerDeniedError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(`Contact lifecycle ledger denied: ${code}`, options);
    this.name = 'ContactLifecycleLedgerDeniedError';
    this.code = code;
  }
}

async function readIntent(
  client: PoolClient,
  intentId: string,
): Promise<ContactLifecycleIntentRow | undefined> {
  const result = await client.query<ContactLifecycleIntentRow>(`
    SELECT * FROM contact_lifecycle_intents WHERE intent_id = $1 FOR UPDATE
  `, [intentId]);
  return result.rows.at(0);
}

async function intentLockKey(client: PoolClient, intentId: string): Promise<string> {
  const result = await client.query<{ schema_name: string }>(
    'SELECT current_schema() AS schema_name',
  );
  const schema = result.rows.at(0)?.schema_name;
  if (!schema || !/^[a-z_][a-z0-9_]{0,62}$/u.test(schema)) {
    throw new Error('Contact lifecycle store has no valid companion schema owner');
  }
  return `contact-lifecycle-intent:${schema}:${intentId}`;
}

function requestJson(request: ContactAuthorityLifecycleRequest): string {
  return JSON.stringify(request);
}

async function insertManualHold(
  client: PoolClient,
  request: Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }>,
  requestDigest: string,
  reason: ContactLifecycleManualHoldReason,
  snapshot?: ContactLifecycleLockedSnapshot,
): Promise<ContactLifecyclePrepareOutcome> {
  const snapshotDigest = snapshot ? digestContactLifecycleSnapshot(snapshot) : null;
  const inserted = await client.query<ContactLifecycleIntentRow>(`
    INSERT INTO contact_lifecycle_intents
      (intent_id, schema_version, request_digest, canonical_request, action,
       contact_id, canonical_contact_id, provider_subject_id,
       locked_snapshot, snapshot_digest, phase, reason)
    VALUES ($1, 1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9, 'manual_hold', $10)
    RETURNING *
  `, [
    request.intentId,
    requestDigest,
    requestJson(request),
    request.action,
    request.contactId,
    request.canonicalContactId ?? null,
    request.providerSubjectId ?? null,
    snapshot ? JSON.stringify(snapshot) : null,
    snapshotDigest,
    reason,
  ]);
  const row = inserted.rows[0];
  if (!row) throw new Error('Contact lifecycle manual-hold insert returned no row');
  return outcomeForIntentRow(row);
}

function exactRequest(
  input: unknown,
): Extract<ContactAuthorityLifecycleRequest, { phase: 'prepare' }> {
  let request: ContactAuthorityLifecycleRequest;
  try {
    request = parseContactAuthorityLifecycleRequest(input);
  } catch (error) {
    throw new ContactLifecycleLedgerDeniedError('invalid_v1_request', { cause: error });
  }
  if (request.phase !== 'prepare') {
    throw new ContactLifecycleLedgerDeniedError('prepare_request_required');
  }
  return request;
}

async function assertNoTargetConflict(
  client: PoolClient,
  targets: Array<{ kind: 'contact' | 'provider_subject'; id: string }>,
): Promise<boolean> {
  for (const target of targets) {
    const conflict = await client.query(`
      SELECT 1 FROM contact_lifecycle_target_locks
      WHERE target_kind = $1 AND target_id = $2
        AND lock_state IN ('active', 'quarantined')
      LIMIT 1
    `, [target.kind, target.id]);
    if ((conflict.rowCount ?? 0) > 0) return false;
  }
  return true;
}

const postgresContactLifecycleLedgerOperations: PostgresContactOperationMap = {
  async prepareContactLifecycleIntent(input: unknown): Promise<ContactLifecyclePrepareOutcome> {
    const request = exactRequest(input);
    const digest = contactAuthorityLifecycleRequestDigest(request);
    return await withPostgresClient(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        await intentLockKey(client, request.intentId),
      ]);
      const existing = await readIntent(client, request.intentId);
      if (existing) {
        if (!timingSafeStringEqual(existing.request_digest, digest)) {
          throw new ContactLifecycleLedgerDeniedError('changed_intent_reuse');
        }
        if (existing.restore_state !== 'live' || existing.phase === 'quarantined') {
          throw new ContactLifecycleLedgerDeniedError('restored_intent_quarantined');
        }
        return parseContactLifecycleIntentRow(existing).outcome;
      }
      const locked = await lockExactContactLifecycleSnapshot(client, request);
      if (!locked.snapshot) {
        return await insertManualHold(
          client,
          request,
          digest,
          locked.holdReason ?? 'stale_ownership',
        );
      }
      if (!await assertNoTargetConflict(client, locked.targets)) {
        return await insertManualHold(
          client,
          request,
          digest,
          'target_locked',
          locked.snapshot,
        );
      }
      const snapshotDigest = digestContactLifecycleSnapshot(locked.snapshot);
      const inserted = await client.query<ContactLifecycleIntentRow>(`
        INSERT INTO contact_lifecycle_intents
          (intent_id, schema_version, request_digest, canonical_request, action,
           contact_id, canonical_contact_id, provider_subject_id,
           locked_snapshot, snapshot_digest, phase, reason)
        VALUES ($1, 1, $2, $3::jsonb, $4, $5, $6, $7, $8::jsonb, $9,
                'gateway_prepare_pending', 'gateway_prepare_pending')
        RETURNING *
      `, [
        request.intentId,
        digest,
        requestJson(request),
        request.action,
        request.contactId,
        request.canonicalContactId ?? null,
        request.providerSubjectId ?? null,
        JSON.stringify(locked.snapshot),
        snapshotDigest,
      ]);
      for (const target of locked.targets) {
        await client.query(`
          INSERT INTO contact_lifecycle_target_locks
            (intent_id, target_kind, target_id, lock_state)
          VALUES ($1, $2, $3, 'active')
        `, [request.intentId, target.kind, target.id]);
      }
      const row = inserted.rows[0];
      if (!row) throw new Error('Contact lifecycle gateway-prepare insert returned no row');
      return outcomeForIntentRow(row);
    });
  },

  async recordContactLifecycleGatewayResult(
    input: ContactLifecycleGatewayResultInput,
  ): Promise<ContactLifecyclePrepareOutcome> {
    if (!isRfc4122Uuid(input.intentId)) {
      throw new ContactLifecycleLedgerDeniedError('invalid_intent_id');
    }
    let result;
    try {
      result = parseContactAuthorityLifecycleResult(input.result);
    } catch (error) {
      throw new ContactLifecycleLedgerDeniedError('invalid_gateway_result', { cause: error });
    }
    if (result.intentId !== input.intentId) {
      throw new ContactLifecycleLedgerDeniedError('gateway_result_intent_mismatch');
    }
    const resultDigest = digestContactLifecycleResult(result);
    return await withPostgresClient(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        await intentLockKey(client, input.intentId),
      ]);
      const intent = await readIntent(client, input.intentId);
      if (!intent) throw new ContactLifecycleLedgerDeniedError('intent_not_found');
      if (intent.restore_state !== 'live' || intent.phase === 'quarantined') {
        throw new ContactLifecycleLedgerDeniedError('restored_intent_quarantined');
      }
      const parsed = parseContactLifecycleIntentRow(intent);
      if (input.leaseOwner) {
        const owner = input.leaseOwner.trim();
        const lease = await client.query<{ lease_is_live: boolean }>(`
          SELECT lease_owner = $2 AND lease_expires_at > clock_timestamp() AS lease_is_live
          FROM contact_lifecycle_intents WHERE intent_id = $1
        `, [input.intentId, owner]);
        if (!owner || owner !== input.leaseOwner || lease.rows.at(0)?.lease_is_live !== true) {
          throw new ContactLifecycleLedgerDeniedError('recovery_lease_lost');
        }
      } else if (intent.lease_owner !== null) {
        throw new ContactLifecycleLedgerDeniedError('recovery_lease_required');
      }
      if (parsed.request.action !== result.action) {
        throw new ContactLifecycleLedgerDeniedError('gateway_result_action_mismatch');
      }
      const replay = await client.query<ResultRow>(`
        SELECT result_digest, result FROM contact_lifecycle_results
        WHERE intent_id = $1 AND gateway_phase = $2
      `, [input.intentId, result.phase]);
      const existing = replay.rows.at(0);
      if (existing) {
        if (!timingSafeStringEqual(existing.result_digest, resultDigest)) {
          throw new ContactLifecycleLedgerDeniedError('changed_gateway_result_reuse');
        }
        parseContactAuthorityLifecycleResult(existing.result);
        return parsed.outcome;
      }
      const expectedPhase = result.phase === 'prepare'
        ? 'gateway_prepare_pending'
        : 'gateway_finalize_pending';
      if (intent.phase !== expectedPhase) {
        throw new ContactLifecycleLedgerDeniedError('gateway_result_phase_mismatch');
      }
      await client.query(`
        INSERT INTO contact_lifecycle_results
          (intent_id, gateway_phase, result_digest, result)
        VALUES ($1, $2, $3, $4::jsonb)
      `, [input.intentId, result.phase, resultDigest, JSON.stringify(result)]);
      const nextPhase = result.phase === 'prepare' ? 'contact_commit_pending' : 'finalized';
      const updated = await client.query<ContactLifecycleIntentRow>(`
        UPDATE contact_lifecycle_intents
        SET phase = $2, reason = $2,
            lease_owner = CASE WHEN $2 = 'finalized' THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN $2 = 'finalized' THEN NULL ELSE lease_expires_at END,
            updated_at = clock_timestamp()
        WHERE intent_id = $1
        RETURNING *
      `, [input.intentId, nextPhase]);
      if (result.phase === 'finalize') {
        await client.query(`
          UPDATE contact_lifecycle_target_locks
          SET lock_state = 'released', updated_at = clock_timestamp()
          WHERE intent_id = $1 AND lock_state = 'active'
        `, [input.intentId]);
      }
      const row = updated.rows[0];
      if (!row) throw new Error('Contact lifecycle gateway-result update returned no row');
      return outcomeForIntentRow(row);
    });
  },

};

export function installPostgresContactLifecycleLedgerOperations(
  store: PostgresContactStoreClass,
): void {
  Object.assign(store.prototype, postgresContactLifecycleLedgerOperations);
}
