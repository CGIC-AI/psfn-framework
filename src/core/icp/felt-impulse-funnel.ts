import { isRfc4122Uuid } from '../../shared/utils/types.js';

const FELT_IMPULSE_CORRELATION_PREFIX = 'felt-impulse:would_message:';

interface IcpFeltImpulseFunnelRecordBase {
  correlationId: string;
  firstCrossingMs: number;
  firedAtMs: number;
  recordedAtMs: number;
}

export type IcpFeltImpulseFunnelRecord = IcpFeltImpulseFunnelRecordBase & (
  | { outcome: 'no_eligible_peer' }
  | { outcome: 'not_authorized' }
  | { outcome: 'throttled'; nextEligibleAtMs: number }
  | {
    outcome: 'candidate_linked';
    candidateId: string;
    candidateOutcome: 'submitted' | 'deduped';
  }
);

export type IcpFeltImpulseLifecycleOutcome =
  | 'pending'
  | 'permitted'
  | 'deferred'
  | 'declined'
  | 'rejected'
  | 'delivered'
  | 'suppressed'
  | 'expired'
  | 'cancelled';

export type IcpFeltImpulseFunnelRecentOutcome = IcpFeltImpulseFunnelRecord & {
  lifecycleOutcome?: IcpFeltImpulseLifecycleOutcome;
};

export interface IcpFeltImpulseFunnelProjection {
  totalQualified: number;
  preCandidate: {
    noEligiblePeer: number;
    notAuthorized: number;
    throttled: number;
  };
  candidateLinks: {
    total: number;
    submitted: number;
    deduped: number;
  };
  candidateLifecycle: Record<IcpFeltImpulseLifecycleOutcome, number>;
  recent: IcpFeltImpulseFunnelRecentOutcome[];
}

export interface IcpFeltImpulseFunnelStorePort {
  getOutcome(correlationId: string): Promise<IcpFeltImpulseFunnelRecord | null>;
  recordOutcome(record: IcpFeltImpulseFunnelRecord): Promise<IcpFeltImpulseFunnelRecord>;
  readProjection(limit: number): Promise<IcpFeltImpulseFunnelProjection>;
  close(): Promise<void>;
}

function requireTimestamp(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

export function requireFeltImpulseCorrelationId(value: string): string {
  parseFeltImpulseCorrelationFirstCrossingMs(value);
  return value;
}

export function parseFeltImpulseCorrelationFirstCrossingMs(value: string): number {
  const suffix = value.startsWith(FELT_IMPULSE_CORRELATION_PREFIX)
    ? value.slice(FELT_IMPULSE_CORRELATION_PREFIX.length)
    : '';
  const timestamp = Number(suffix);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || String(timestamp) !== suffix) {
    throw new Error('Felt-impulse correlationId must be a content-free would_message identity');
  }
  return timestamp;
}

export function parseIcpFeltImpulseFunnelRecord(
  input: IcpFeltImpulseFunnelRecord,
): IcpFeltImpulseFunnelRecord {
  const correlationId = requireFeltImpulseCorrelationId(input.correlationId);
  const firstCrossingMs = requireTimestamp(input.firstCrossingMs, 'firstCrossingMs');
  const firedAtMs = requireTimestamp(input.firedAtMs, 'firedAtMs');
  if (parseFeltImpulseCorrelationFirstCrossingMs(correlationId) !== firstCrossingMs) {
    throw new Error('Felt-impulse correlationId must encode firstCrossingMs');
  }
  if (firedAtMs < firstCrossingMs) {
    throw new Error('Felt-impulse firedAtMs must not precede firstCrossingMs');
  }
  const base = {
    correlationId,
    firstCrossingMs,
    firedAtMs,
    recordedAtMs: requireTimestamp(input.recordedAtMs, 'recordedAtMs'),
  };
  switch (input.outcome) {
    case 'no_eligible_peer':
    case 'not_authorized':
      return { ...base, outcome: input.outcome };
    case 'throttled': {
      const nextEligibleAtMs = requireTimestamp(input.nextEligibleAtMs, 'nextEligibleAtMs');
      if (nextEligibleAtMs <= input.recordedAtMs) {
        throw new Error('Felt-impulse nextEligibleAtMs must be after recordedAtMs');
      }
      return { ...base, outcome: input.outcome, nextEligibleAtMs };
    }
    case 'candidate_linked':
      if (!isRfc4122Uuid(input.candidateId)) {
        throw new Error('Felt-impulse candidateId must be a lowercase RFC-4122 UUID');
      }
      return {
        ...base,
        outcome: input.outcome,
        candidateId: input.candidateId,
        candidateOutcome: input.candidateOutcome,
      };
  }
}
