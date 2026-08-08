import type { Pool } from 'pg';
import type {
  RequestCapabilityConsumeResult,
  RequestCapabilityReplayOutcome,
  RequestCapabilityReplayPort,
  TrustedHostRecoveryConsumeResult,
  TrustedHostRecoveryReplayOutcome,
  TrustedHostRecoveryReplayPort,
} from '../../../boundary/fleet-auth/request-capability-replay.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME } from './request-capability-replay-sql.js';
import {
  FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME,
  FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME,
} from './recovery-request-capability-sql.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

function parseConsumeResult(value: unknown): RequestCapabilityConsumeResult {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.decision !== 'allow'
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)
    || typeof value.targetDigest !== 'string'
    || !DIGEST_PATTERN.test(value.targetDigest)
    || typeof value.audience !== 'string'
    || value.audience.length < 1
    || value.audience.length > 256
    || typeof value.companionId !== 'string'
    || !isRfc4122Uuid(value.companionId)
    || typeof value.parentDigest !== 'string'
    || !DIGEST_PATTERN.test(value.parentDigest)
    || typeof value.authorityVersionsDigest !== 'string'
    || !DIGEST_PATTERN.test(value.authorityVersionsDigest)
    || !Number.isSafeInteger(value.expiresAt as number)
    || (value.expiresAt as number) < 1) {
    throw new Error('Request capability replay procedure returned an invalid result');
  }
  return Object.freeze({
    schemaVersion: 1,
    decision: 'allow',
    requestId: value.requestId,
    decisionId: value.decisionId,
    targetDigest: value.targetDigest,
    audience: value.audience,
    companionId: value.companionId,
    parentDigest: value.parentDigest,
    authorityVersionsDigest: value.authorityVersionsDigest,
    expiresAt: value.expiresAt as number,
  });
}

function parseRecoveryConsumeResult(value: unknown): TrustedHostRecoveryConsumeResult {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.kind !== 'trusted_host_garden_recovery_receipt'
    || value.decision !== 'allow'
    || value.outcome !== 'recovery_ready'
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)
    || typeof value.targetDigest !== 'string'
    || !DIGEST_PATTERN.test(value.targetDigest)
    || typeof value.audience !== 'string'
    || value.audience !== `recovery:${String(value.companionId)}`
    || !isRfc4122Uuid(value.companionId)
    || value.action !== 'recovery.begin'
    || typeof value.resourceDigest !== 'string'
    || !DIGEST_PATTERN.test(value.resourceDigest)
    || typeof value.reasonDigest !== 'string'
    || !DIGEST_PATTERN.test(value.reasonDigest)
    || typeof value.credentialId !== 'string'
    || !DIGEST_PATTERN.test(value.credentialId)
    || typeof value.authorityFloorDigest !== 'string'
    || !DIGEST_PATTERN.test(value.authorityFloorDigest)
    || !Number.isSafeInteger(value.expiresAt as number)
    || (value.expiresAt as number) < 1) {
    throw new Error('Trusted-host recovery replay procedure returned an invalid result');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'trusted_host_garden_recovery_receipt',
    decision: 'allow',
    outcome: 'recovery_ready',
    requestId: value.requestId,
    decisionId: value.decisionId,
    targetDigest: value.targetDigest,
    audience: value.audience as `recovery:${string}`,
    companionId: value.companionId,
    action: 'recovery.begin',
    resourceDigest: value.resourceDigest,
    reasonDigest: value.reasonDigest,
    credentialId: value.credentialId,
    authorityFloorDigest: value.authorityFloorDigest,
    expiresAt: value.expiresAt as number,
  });
}

export class PostgresRequestCapabilityReplayStore
implements RequestCapabilityReplayPort, TrustedHostRecoveryReplayPort {
  constructor(private readonly pool: Pool) {}

  async consume(input: Parameters<RequestCapabilityReplayPort['consume']>[0]):
  Promise<RequestCapabilityReplayOutcome> {
    const queryResult = await this.pool.query<{ result: unknown }>(`
      SELECT ${FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME}(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) AS result
    `, [
      input.issuer,
      input.jti,
      input.capabilityDigest,
      input.targetDigest,
      input.bodyDigest,
      input.audienceDigest,
      input.companionDigest,
      input.actionDigest,
      input.resourceDigest,
      input.parentDigest,
      input.decisionDigest,
      input.authorityVersionsDigest,
      input.expiresAt,
      input.consumeResult,
    ]);
    const record = queryResult.rows.at(0)?.result;
    if (!isRecord(record)) {
      throw new Error('Request capability replay procedure returned an invalid outcome');
    }
    if (record.outcome === 'mismatch' && !('result' in record)) {
      return { outcome: 'mismatch' };
    }
    if ((record.outcome === 'consumed' || record.outcome === 'replayed')
      && 'result' in record) {
      return { outcome: record.outcome, result: parseConsumeResult(record.result) };
    }
    throw new Error('Request capability replay procedure returned an invalid outcome');
  }

  async consumeRecovery(
    input: Parameters<TrustedHostRecoveryReplayPort['consumeRecovery']>[0],
  ): Promise<TrustedHostRecoveryReplayOutcome> {
    const queryResult = await this.pool.query<{ result: unknown }>(`
      SELECT ${FLEET_AUTH_CONSUME_RECOVERY_CAPABILITY_FUNCTION_NAME}(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17
      ) AS result
    `, [
      input.issuer,
      input.jti,
      input.capabilityDigest,
      input.targetDigest,
      input.bodyDigest,
      input.audienceDigest,
      input.companionDigest,
      input.actionDigest,
      input.resourceDigest,
      input.parentDigest,
      input.decisionDigest,
      input.authorityVersionsDigest,
      input.expiresAt,
      input.consumeResult,
      input.authorityFloor.authorityGeneration,
      input.authorityFloor.activationGeneration,
      input.authorityFloor.restoreCheckpoint,
    ]);
    const record = queryResult.rows.at(0)?.result;
    if (!isRecord(record)) {
      throw new Error('Trusted-host recovery replay procedure returned an invalid outcome');
    }
    if ((record.outcome === 'mismatch' || record.outcome === 'authority_changed')
      && !('result' in record)) {
      return { outcome: record.outcome };
    }
    if ((record.outcome === 'consumed' || record.outcome === 'replayed')
      && 'result' in record) {
      return { outcome: record.outcome, result: parseRecoveryConsumeResult(record.result) };
    }
    throw new Error('Trusted-host recovery replay procedure returned an invalid outcome');
  }

  async auditRecovery(
    input: Parameters<TrustedHostRecoveryReplayPort['auditRecovery']>[0],
  ): Promise<void> {
    await this.pool.query(`
      SELECT ${FLEET_AUTH_AUDIT_RECOVERY_CAPABILITY_FUNCTION_NAME}(
        $1, $2, $3, $4, $5, $6, $7, $8
      )
    `, [
      input.outcome,
      input.companionId,
      input.targetDigest,
      input.resourceDigest,
      input.reasonDigest,
      input.credentialId,
      input.authorityFloorDigest,
      input.correlationId,
    ]);
  }
}
