import { MAX_ICP_CANDIDATE_TTL_MS } from '../../core/icp/initiation-candidate.js';
import {
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  MAX_ICP_PERMIT_TTL_MS,
} from '../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../shared/utils/types.js';
import { assertNoUnknownKeys, assertPositiveInteger } from './validators.js';

export interface IcpAutonomySchedulerConfig {
  enabled: boolean;
  candidate: {
    defaultTtlMs: number;
    retryCadenceMs: number;
    maxRetryAttempts: number;
  };
  permit: {
    ttlMs: number;
  };
  policyHolds: {
    ttlMs: number;
    maxOutstanding: number;
  };
  availability: {
    operatorLeaseTtlMs: number;
  };
}

/** Structural safety ceilings: policy holds retain live tenant-row locks. */
export const MAX_ICP_POLICY_HOLD_TTL_MS = 30_000;
export const MAX_ICP_POLICY_OUTSTANDING_HOLDS = 8;

export const DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG: IcpAutonomySchedulerConfig = {
  // Operator ruling D4 (2026-07-30, psfn-framework-hrmrq.34): autonomous
  // initiation is DEFAULT-ON. The one-way runtime fence
  // (createIcpAutonomyRuntimeEnablement) remains only as the live-process
  // emergency disable; scheduler.json can still set enabled:false explicitly.
  enabled: true,
  candidate: {
    defaultTtlMs: 24 * 60 * 60_000,
    retryCadenceMs: 5 * 60_000,
    maxRetryAttempts: 3,
  },
  permit: {
    ttlMs: 5 * 60_000,
  },
  policyHolds: {
    ttlMs: 10_000,
    maxOutstanding: MAX_ICP_POLICY_OUTSTANDING_HOLDS,
  },
  availability: {
    operatorLeaseTtlMs: MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  },
};

const ERROR_PREFIX = 'Invalid ICP autonomy scheduler config';

function requireRecord(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${ERROR_PREFIX}: ${fieldPath} must be an object`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fieldPath: string,
  max?: number,
): number {
  return assertPositiveInteger(value, fieldPath, {
    min: 1,
    ...(max === undefined ? {} : { max }),
    message: ({ fieldLabel }) => `${ERROR_PREFIX}: ${fieldLabel} must be a positive integer`,
    messages: {
      aboveMax: ({ fieldLabel, max: maximum }) => (
        `${ERROR_PREFIX}: ${fieldLabel} must be <= ${maximum}`
      ),
    },
  });
}

export function parseIcpAutonomySchedulerConfig(
  value: unknown,
  fieldPath = 'icpAutonomy',
): IcpAutonomySchedulerConfig {
  const root = requireRecord(value, fieldPath);
  assertNoUnknownKeys(root, [
    'enabled', 'candidate', 'permit', 'policyHolds', 'availability',
  ], fieldPath, {
    errorPrefix: ERROR_PREFIX,
  });
  if (typeof root.enabled !== 'boolean') {
    throw new Error(`${ERROR_PREFIX}: ${fieldPath}.enabled must be a boolean`);
  }

  const candidate = requireRecord(root.candidate, `${fieldPath}.candidate`);
  assertNoUnknownKeys(
    candidate,
    ['defaultTtlMs', 'retryCadenceMs', 'maxRetryAttempts'],
    `${fieldPath}.candidate`,
    { errorPrefix: ERROR_PREFIX },
  );
  const permit = requireRecord(root.permit, `${fieldPath}.permit`);
  assertNoUnknownKeys(permit, ['ttlMs'], `${fieldPath}.permit`, { errorPrefix: ERROR_PREFIX });
  const policyHolds = requireRecord(root.policyHolds, `${fieldPath}.policyHolds`);
  assertNoUnknownKeys(
    policyHolds,
    ['ttlMs', 'maxOutstanding'],
    `${fieldPath}.policyHolds`,
    { errorPrefix: ERROR_PREFIX },
  );
  const availability = requireRecord(root.availability, `${fieldPath}.availability`);
  assertNoUnknownKeys(
    availability,
    ['operatorLeaseTtlMs'],
    `${fieldPath}.availability`,
    { errorPrefix: ERROR_PREFIX },
  );

  return {
    enabled: root.enabled,
    candidate: {
      defaultTtlMs: positiveInteger(
        candidate.defaultTtlMs,
        `${fieldPath}.candidate.defaultTtlMs`,
        MAX_ICP_CANDIDATE_TTL_MS,
      ),
      retryCadenceMs: positiveInteger(
        candidate.retryCadenceMs,
        `${fieldPath}.candidate.retryCadenceMs`,
        MAX_ICP_CANDIDATE_TTL_MS,
      ),
      maxRetryAttempts: positiveInteger(
        candidate.maxRetryAttempts,
        `${fieldPath}.candidate.maxRetryAttempts`,
      ),
    },
    permit: {
      ttlMs: positiveInteger(
        permit.ttlMs,
        `${fieldPath}.permit.ttlMs`,
        MAX_ICP_PERMIT_TTL_MS,
      ),
    },
    policyHolds: {
      ttlMs: positiveInteger(
        policyHolds.ttlMs,
        `${fieldPath}.policyHolds.ttlMs`,
        MAX_ICP_POLICY_HOLD_TTL_MS,
      ),
      maxOutstanding: positiveInteger(
        policyHolds.maxOutstanding,
        `${fieldPath}.policyHolds.maxOutstanding`,
        MAX_ICP_POLICY_OUTSTANDING_HOLDS,
      ),
    },
    availability: {
      operatorLeaseTtlMs: positiveInteger(
        availability.operatorLeaseTtlMs,
        `${fieldPath}.availability.operatorLeaseTtlMs`,
        MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
      ),
    },
  };
}
