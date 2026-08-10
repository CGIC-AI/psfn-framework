import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasExactKeys, isRecord } from '../../shared/utils/types.js';

interface BiographicalDepthModePolicy {
  readonly candidateLimitPerRefresh: number;
  readonly refreshIntervalMs: number;
  readonly retentionClaimLimit: number | null;
  readonly compactionBatchLimit: number;
  readonly backfillBatchLimit: number;
  readonly operationClaimLimit: number;
  readonly turnClaimLimit: number;
}

export interface BiographicalDepthPolicy {
  readonly schemaVersion: 1;
  readonly developingIndependentContextMinimum: number;
  readonly recognition: BiographicalDepthModePolicy & { readonly retentionClaimLimit: number };
  readonly developing: BiographicalDepthModePolicy & { readonly retentionClaimLimit: number };
  readonly full: BiographicalDepthModePolicy & { readonly retentionClaimLimit: null };
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`Invalid settings at ${path}: expected integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function normalizeMode(
  value: unknown,
  path: string,
  retention: 'bounded' | 'unbounded',
): BiographicalDepthModePolicy {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'candidateLimitPerRefresh',
      'refreshIntervalMs',
      'retentionClaimLimit',
      'compactionBatchLimit',
      'backfillBatchLimit',
      'operationClaimLimit',
      'turnClaimLimit',
    ])
  ) {
    throw new Error(`Invalid settings at ${path}: expected exact depth-mode policy`);
  }
  const candidateLimitPerRefresh = integer(
    value.candidateLimitPerRefresh,
    `${path}.candidateLimitPerRefresh`,
    1,
    10_000,
  );
  const operationClaimLimit = integer(
    value.operationClaimLimit,
    `${path}.operationClaimLimit`,
    1,
    10_000,
  );
  const turnClaimLimit = integer(value.turnClaimLimit, `${path}.turnClaimLimit`, 1, 10_000);
  if (candidateLimitPerRefresh > operationClaimLimit || turnClaimLimit > operationClaimLimit) {
    throw new Error(`Invalid settings at ${path}: refresh and turn limits must not exceed operationClaimLimit`);
  }
  const retentionClaimLimit = retention === 'unbounded'
    ? value.retentionClaimLimit
    : integer(value.retentionClaimLimit, `${path}.retentionClaimLimit`, 1, 1_000_000);
  if (retention === 'unbounded' && retentionClaimLimit !== null) {
    throw new Error(`Invalid settings at ${path}.retentionClaimLimit: full depth must be null`);
  }
  return {
    candidateLimitPerRefresh,
    refreshIntervalMs: integer(value.refreshIntervalMs, `${path}.refreshIntervalMs`, 1_000, 31_536_000_000),
    retentionClaimLimit: retentionClaimLimit as number | null,
    compactionBatchLimit: integer(value.compactionBatchLimit, `${path}.compactionBatchLimit`, 1, 10_000),
    backfillBatchLimit: integer(value.backfillBatchLimit, `${path}.backfillBatchLimit`, 0, 10_000),
    operationClaimLimit,
    turnClaimLimit,
  };
}

export function normalizeBiographicalDepthPolicy(
  value: unknown,
  fieldPath = 'biographicalDepthPolicy',
): BiographicalDepthPolicy {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      'schemaVersion',
      'developingIndependentContextMinimum',
      'recognition',
      'developing',
      'full',
    ])
  ) {
    throw new Error(`Invalid settings at ${fieldPath}: expected exact versioned depth policy`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`Invalid settings at ${fieldPath}.schemaVersion: expected 1`);
  }
  const recognition = normalizeMode(value.recognition, `${fieldPath}.recognition`, 'bounded');
  const developing = normalizeMode(value.developing, `${fieldPath}.developing`, 'bounded');
  const full = normalizeMode(value.full, `${fieldPath}.full`, 'unbounded');
  return {
    schemaVersion: 1,
    developingIndependentContextMinimum: integer(
      value.developingIndependentContextMinimum,
      `${fieldPath}.developingIndependentContextMinimum`,
      2,
      100,
    ),
    recognition: {
      ...recognition,
      retentionClaimLimit: recognition.retentionClaimLimit as number,
    },
    developing: {
      ...developing,
      retentionClaimLimit: developing.retentionClaimLimit as number,
    },
    full: { ...full, retentionClaimLimit: null },
  };
}

export function createDefaultBiographicalDepthPolicy(
  seedDir = process.env.CONFIG_DIR ?? './config',
): BiographicalDepthPolicy {
  const seedPath = join(seedDir, 'settings.seed.json');
  const root: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (!isRecord(root)) {
    throw new Error(`${seedPath} must be an object`);
  }
  return normalizeBiographicalDepthPolicy(
    root.biographicalDepthPolicy,
    `${seedPath}.biographicalDepthPolicy`,
  );
}

export function cloneBiographicalDepthPolicy(
  policy: BiographicalDepthPolicy,
): BiographicalDepthPolicy {
  return structuredClone(policy);
}
