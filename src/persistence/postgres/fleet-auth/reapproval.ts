import type { Pool } from 'pg';
import { isCanonicalIsoTimestamp, isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { FLEET_AUTH_REAPPROVE_FUNCTION_NAME } from './reapproval-sql.js';

const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const CONTACT_ID_MAX_LENGTH = 256;

/**
 * Exact trusted-host account/binding/role reapproval request. Every identity is
 * bound: the ceremony, the principal, its Discord provider subject, the
 * per-companion contact binding, and the role grant. Nothing here can promote a
 * passkey — passkey authority is governed solely by the non-restored floor.
 */
export interface AccountReapprovalRequest {
  ceremonyId: string;
  principalId: string;
  provider: 'discord';
  providerSubjectId: string;
  companionId: string;
  contactId: string;
  bindingId: string;
  roleGrantId: string;
  auditEventId: string;
  at: string;
}

export interface AccountReapprovalResult {
  principalId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  roleVersion: number;
  auditEventId: string;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) {
    throw new Error(`Fleet auth reapproval ${field} must be an RFC-4122 UUID`);
  }
  return value;
}

function validateRequest(request: AccountReapprovalRequest): AccountReapprovalRequest {
  if (!isRecord(request)) {
    throw new Error('Fleet auth reapproval request must be an object');
  }
  const ceremonyId = assertUuid(request.ceremonyId, 'ceremonyId');
  const principalId = assertUuid(request.principalId, 'principalId');
  const companionId = assertUuid(request.companionId, 'companionId');
  const bindingId = assertUuid(request.bindingId, 'bindingId');
  const roleGrantId = assertUuid(request.roleGrantId, 'roleGrantId');
  const auditEventId = assertUuid(request.auditEventId, 'auditEventId');
  if (String(request.provider) !== 'discord') {
    throw new Error('Fleet auth reapproval provider must be discord');
  }
  if (typeof request.providerSubjectId !== 'string'
    || !DISCORD_SUBJECT_PATTERN.test(request.providerSubjectId)) {
    throw new Error('Fleet auth reapproval providerSubjectId is invalid');
  }
  if (typeof request.contactId !== 'string'
    || request.contactId.length < 1
    || request.contactId.length > CONTACT_ID_MAX_LENGTH) {
    throw new Error('Fleet auth reapproval contactId is invalid');
  }
  if (!isCanonicalIsoTimestamp(request.at)) {
    throw new Error('Fleet auth reapproval at must be an ISO timestamp');
  }
  return {
    ceremonyId,
    principalId,
    provider: 'discord',
    providerSubjectId: request.providerSubjectId,
    companionId,
    contactId: request.contactId,
    bindingId,
    roleGrantId,
    auditEventId,
    at: request.at,
  };
}

function parseResult(value: unknown): AccountReapprovalResult {
  if (!isRecord(value)) {
    throw new Error('Fleet auth reapproval returned no result payload');
  }
  const asNumber = (field: string): number => {
    const raw = value[field];
    const parsed = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Fleet auth reapproval result ${field} is invalid`);
    }
    return parsed;
  };
  const asString = (field: string): string => {
    const raw = value[field];
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new Error(`Fleet auth reapproval result ${field} is invalid`);
    }
    return raw;
  };
  return {
    principalId: asString('principalId'),
    authorityGeneration: asNumber('authorityGeneration'),
    globalAuthEpoch: asNumber('globalAuthEpoch'),
    authnVersion: asNumber('authnVersion'),
    authzVersion: asNumber('authzVersion'),
    bindingVersion: asNumber('bindingVersion'),
    roleVersion: asNumber('roleVersion'),
    auditEventId: asString('auditEventId'),
  };
}

/**
 * Bounded, transactional account reapproval. This is the only path through
 * which the gateway broker may reactivate a quarantined restore candidate. The
 * ceremony, all conflict/tombstone checks, version/epoch bumps, ephemeral
 * revocation, and the audit event are enforced inside a single SECURITY DEFINER
 * database transaction; any denial rolls back with zero mutation.
 */
export async function executeAccountReapproval(
  pool: Pool,
  request: AccountReapprovalRequest,
): Promise<AccountReapprovalResult> {
  const validated = validateRequest(request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ result: unknown }>(
      `SELECT ${FLEET_AUTH_REAPPROVE_FUNCTION_NAME}(
         $1::uuid, $2::uuid, $3::text, $4::text, $5::uuid, $6::text,
         $7::uuid, $8::uuid, $9::uuid, $10::timestamptz
       ) AS result`,
      [
        validated.ceremonyId,
        validated.principalId,
        validated.provider,
        validated.providerSubjectId,
        validated.companionId,
        validated.contactId,
        validated.bindingId,
        validated.roleGrantId,
        validated.auditEventId,
        validated.at,
      ],
    );
    const parsed = parseResult(result.rows.at(0)?.result);
    await client.query('COMMIT');
    return parsed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
