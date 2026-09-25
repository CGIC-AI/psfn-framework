import type { Pool } from 'pg';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import type { OperatorAccountAction } from './admin-token-lifecycle-approval.js';
import {
  FLEET_AUTH_OPERATOR_REINSTATE_COMPANION_FUNCTION_NAME,
  FLEET_AUTH_OPERATOR_REINSTATE_PRINCIPAL_FUNCTION_NAME,
  FLEET_AUTH_OPERATOR_SET_PRINCIPAL_STATUS_FUNCTION_NAME,
} from './operator-account-authority-sql.js';

/**
 * Audited ADMIN_TOKEN operator account actions (psfn-framework-aol3m,
 * key-or-SSO ruling): reinstate a quarantined account or companion, and
 * disable or re-enable an account, with no Discord session, OAuth proof or SSO
 * principal. Each call runs one bounded SECURITY DEFINER procedure that proves
 * the gateway's exact approval row inside the same transaction.
 */
export type OperatorAccountRequest =
  | {
    action: 'principal.reinstate';
    companionId: string;
    principalId: string;
    bindingId: string;
    roleGrantId: string;
  }
  | { action: 'companion.reinstate'; companionId: string; companionVersion: number }
  | { action: 'principal.suspend' | 'principal.reactivate'; companionId: string; principalId: string };

export interface OperatorAccountResult {
  action: OperatorAccountAction;
  companionId: string;
  authorityGeneration: number;
  globalAuthEpoch: number;
  auditEventId: string;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Operator account result ${field} is invalid`);
  }
  return parsed;
}

function parseResult(value: unknown, request: OperatorAccountRequest): OperatorAccountResult {
  if (!isRecord(value) || value.action !== request.action || value.companionId !== request.companionId
    || typeof value.auditEventId !== 'string' || !isRfc4122Uuid(value.auditEventId)) {
    throw new Error('Operator account procedure returned an invalid result');
  }
  return {
    action: request.action,
    companionId: request.companionId,
    authorityGeneration: positiveInteger(value.authorityGeneration, 'authorityGeneration'),
    globalAuthEpoch: positiveInteger(value.globalAuthEpoch, 'globalAuthEpoch'),
    auditEventId: value.auditEventId,
  };
}

function procedureCall(request: OperatorAccountRequest): { sql: string; args: unknown[] } {
  switch (request.action) {
    case 'principal.reinstate':
      return {
        sql: `SELECT ${FLEET_AUTH_OPERATOR_REINSTATE_PRINCIPAL_FUNCTION_NAME}(`
          + '$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid) AS result',
        args: [request.companionId, request.principalId, request.bindingId, request.roleGrantId],
      };
    case 'companion.reinstate':
      return {
        sql: `SELECT ${FLEET_AUTH_OPERATOR_REINSTATE_COMPANION_FUNCTION_NAME}(`
          + '$1::uuid, $2::uuid, $3::uuid, $4::bigint) AS result',
        args: [request.companionId, request.companionVersion],
      };
    case 'principal.suspend':
    case 'principal.reactivate':
      return {
        sql: `SELECT ${FLEET_AUTH_OPERATOR_SET_PRINCIPAL_STATUS_FUNCTION_NAME}(`
          + '$1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::boolean) AS result',
        args: [request.companionId, request.principalId, request.action === 'principal.reactivate'],
      };
  }
}

export async function executeOperatorAccountAction(
  pool: Pool,
  input: { request: OperatorAccountRequest; approvalEventId: string; auditEventId: string },
): Promise<OperatorAccountResult> {
  if (!isRfc4122Uuid(input.approvalEventId) || !isRfc4122Uuid(input.auditEventId)
    || input.approvalEventId === input.auditEventId) {
    throw new Error('Operator account action requires distinct approval and audit identities');
  }
  const call = procedureCall(input.request);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ result: unknown }>(
      call.sql,
      [input.approvalEventId, input.auditEventId, ...call.args],
    );
    const parsed = parseResult(result.rows.at(0)?.result, input.request);
    await client.query('COMMIT');
    return parsed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
