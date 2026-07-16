import type { Pool } from 'pg';
import type {
  RequestCapabilityConsumeResult,
  RequestCapabilityReplayOutcome,
  RequestCapabilityReplayPort,
} from '../../../boundary/fleet-auth/request-capability-replay.js';
import { isRecord, isRfc4122Uuid } from '../../../shared/utils/types.js';
import { FLEET_AUTH_CONSUME_REQUEST_CAPABILITY_FUNCTION_NAME } from './request-capability-replay-sql.js';

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
    || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt < 1) {
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
    expiresAt: value.expiresAt,
  });
}

export class PostgresRequestCapabilityReplayStore implements RequestCapabilityReplayPort {
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
}
