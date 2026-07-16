import type { Pool } from 'pg';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME } from './companion-reapproval-sql.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface CompanionReapprovalRequest {
  ceremonyId: string;
  companionId: string;
  lineageId: string;
  lineageGeneration: number;
  companionVersion: number;
  readdDecisionId: string;
  auditEventId: string;
  at: string;
}

export interface CompanionReapprovalResult {
  companionId: string;
  lineageId: string;
  lineageGeneration: number;
  companionVersion: number;
  authorityGeneration: number;
  globalAuthEpoch: number;
  auditEventId: string;
}

function validateRequest(request: CompanionReapprovalRequest): CompanionReapprovalRequest {
  if (!isRecord(request)) throw new Error('Fleet auth companion reapproval request must be an object');
  assertNoUnknownKeys(request, [
    'ceremonyId',
    'companionId',
    'lineageId',
    'lineageGeneration',
    'companionVersion',
    'readdDecisionId',
    'auditEventId',
    'at',
  ], 'companion reapproval request', { errorPrefix: 'Invalid fleet auth companion reapproval' });
  for (const field of ['ceremonyId', 'companionId', 'readdDecisionId', 'auditEventId'] as const) {
    if (!isRfc4122Uuid(request[field])) {
      throw new Error(`Fleet auth companion reapproval ${field} must be an RFC-4122 UUID`);
    }
  }
  if (!DIGEST_PATTERN.test(request.lineageId)) {
    throw new Error('Fleet auth companion reapproval lineageId must be a SHA-256 digest');
  }
  for (const field of ['lineageGeneration', 'companionVersion'] as const) {
    if (!Number.isSafeInteger(request[field]) || request[field] < 1) {
      throw new Error(`Fleet auth companion reapproval ${field} must be a positive integer`);
    }
  }
  if (!isCanonicalIsoTimestamp(request.at)) {
    throw new Error('Fleet auth companion reapproval at must be an ISO timestamp');
  }
  return request;
}

function parseResult(value: unknown): CompanionReapprovalResult {
  if (!isRecord(value)) throw new Error('Fleet auth companion reapproval returned no result');
  const stringValue = (field: string): string => {
    const result = value[field];
    if (typeof result !== 'string' || result.length === 0) {
      throw new Error(`Fleet auth companion reapproval result ${field} is invalid`);
    }
    return result;
  };
  const integerValue = (field: string): number => {
    const result = Number(value[field]);
    if (!Number.isSafeInteger(result) || result < 1) {
      throw new Error(`Fleet auth companion reapproval result ${field} is invalid`);
    }
    return result;
  };
  const companionId = stringValue('companionId');
  const lineageId = stringValue('lineageId');
  const auditEventId = stringValue('auditEventId');
  if (!isRfc4122Uuid(companionId) || !isRfc4122Uuid(auditEventId)
    || !DIGEST_PATTERN.test(lineageId)) {
    throw new Error('Fleet auth companion reapproval result identity is invalid');
  }
  return {
    companionId,
    lineageId,
    lineageGeneration: integerValue('lineageGeneration'),
    companionVersion: integerValue('companionVersion'),
    authorityGeneration: integerValue('authorityGeneration'),
    globalAuthEpoch: integerValue('globalAuthEpoch'),
    auditEventId,
  };
}

export async function executeCompanionReapproval(
  pool: Pool,
  request: CompanionReapprovalRequest,
): Promise<CompanionReapprovalResult> {
  const validated = validateRequest(request);
  const result = await pool.query<{ result: unknown }>(`
    SELECT ${FLEET_AUTH_REAPPROVE_COMPANION_FUNCTION_NAME}(
      $1::uuid, $2::uuid, $3::text, $4::bigint, $5::bigint,
      $6::uuid, $7::uuid, $8::timestamptz
    ) AS result
  `, [
    validated.ceremonyId,
    validated.companionId,
    validated.lineageId,
    validated.lineageGeneration,
    validated.companionVersion,
    validated.readdDecisionId,
    validated.auditEventId,
    validated.at,
  ]);
  const parsed = parseResult(result.rows.at(0)?.result);
  if (parsed.companionId !== validated.companionId
    || !timingSafeStringEqual(parsed.lineageId, validated.lineageId)
    || parsed.lineageGeneration !== validated.lineageGeneration
    || parsed.companionVersion !== validated.companionVersion + 1
    || parsed.authorityGeneration < parsed.lineageGeneration
    || parsed.auditEventId !== validated.auditEventId) {
    throw new Error('Fleet auth companion reapproval result does not match its exact request');
  }
  return parsed;
}
