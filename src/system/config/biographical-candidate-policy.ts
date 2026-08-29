import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BiographicalClaimBasis,
  BiographicalClaimKind,
} from '../../faculties/memory/biographical/types.js';
import { hasExactKeys, isRecord } from '../../shared/utils/types.js';
import {
  MEMORY_POLICY_TYPES,
  type MemoryPolicyType,
} from './memory-retrieval-policy.js';
import {
  VALID_SENSITIVITY_LEVELS,
  type SensitivityLevel,
} from '../trust/types.js';

export const BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES = [
  'active',
  'quarantined',
  'tombstoned',
  'cogsec_blocked',
  'revoked',
  'superseded',
] as const;
export type BiographicalSourceLifecycleState =
  (typeof BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES)[number];

const REQUIRED_BIOGRAPHICAL_SOURCE_EXCLUSIONS = [
  'quarantined',
  'tombstoned',
  'cogsec_blocked',
  'revoked',
  'superseded',
] as const;

const BIOGRAPHICAL_REVIEW_TRIGGERS = [
  'human_subject',
  'inferred_basis',
  'imported_basis',
  'relational_claim',
  'sensitivity_lowering',
] as const;
type BiographicalReviewTrigger = (typeof BIOGRAPHICAL_REVIEW_TRIGGERS)[number];

const BIOGRAPHICAL_PROJECTION_SCOPES = [
  'companion_self',
  'current_author',
  'explicitly_relevant_subject',
] as const;
type BiographicalProjectionScope = (typeof BIOGRAPHICAL_PROJECTION_SCOPES)[number];

interface BiographicalCandidateBudgets {
  readonly maxPendingCandidates: number;
  readonly maxCandidatesPerAutomataRun: number;
  readonly maxSourcesPerCandidate: number;
  readonly maxReviewReceiptsPerCandidate: number;
}

interface BiographicalCompanionAutoactivationPolicy {
  readonly enabled: boolean;
  readonly scopes: readonly ['companion_self'];
  readonly admittedClaimKinds: readonly BiographicalClaimKind[];
  readonly admittedBases: readonly BiographicalClaimBasis[];
  readonly maximumSensitivity: SensitivityLevel;
}

export interface BiographicalCandidatePolicy {
  readonly schemaVersion: 1;
  readonly admittedSourceTypes: readonly MemoryPolicyType[];
  readonly maximumSourceSensitivity: SensitivityLevel;
  readonly excludedLifecycleStates: readonly BiographicalSourceLifecycleState[];
  readonly budgets: BiographicalCandidateBudgets;
  readonly reviewTriggers: readonly BiographicalReviewTrigger[];
  readonly companionOnlyAutoactivation: BiographicalCompanionAutoactivationPolicy;
  readonly projectionScopes: readonly BiographicalProjectionScope[];
}

const CLAIM_KINDS: readonly BiographicalClaimKind[] = [
  'name',
  'nickname',
  'relationship',
  'role',
  'stable-preference',
  'shared-language',
];
const CLAIM_BASES: readonly BiographicalClaimBasis[] = [
  'explicit',
  'observed',
  'inferred',
  'imported',
];

function invalid(path: string, expectation: string): never {
  throw new Error(`Invalid settings at ${path}: ${expectation}`);
}

function exactKnownList<T extends string>(
  value: unknown,
  known: readonly T[],
  path: string,
  options: { readonly nonEmpty?: boolean; readonly required?: readonly T[] } = {},
): T[] {
  if (!Array.isArray(value) || (options.nonEmpty === true && value.length === 0)) {
    return invalid(path, 'expected a non-empty array');
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !known.includes(entry as T) || seen.has(entry)) {
      return invalid(path, 'contains an unknown or duplicate value');
    }
    seen.add(entry);
  }
  if (options.required?.some(required => !seen.has(required))) {
    return invalid(path, 'omits a mandatory privacy exclusion');
  }
  return [...value] as T[];
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    return invalid(path, 'expected a positive safe integer');
  }
  return value;
}

function sensitivity(value: unknown, path: string): SensitivityLevel {
  if (
    typeof value !== 'string'
    || !(VALID_SENSITIVITY_LEVELS as readonly string[]).includes(value)
  ) {
    return invalid(path, 'expected a supported sensitivity');
  }
  return value as SensitivityLevel;
}

export function normalizeBiographicalCandidatePolicy(
  value: unknown,
  fieldPath = 'biographicalCandidatePolicy',
): BiographicalCandidatePolicy {
  if (!isRecord(value) || !hasExactKeys(value, [
    'schemaVersion',
    'admittedSourceTypes',
    'maximumSourceSensitivity',
    'excludedLifecycleStates',
    'budgets',
    'reviewTriggers',
    'companionOnlyAutoactivation',
    'projectionScopes',
  ])) {
    return invalid(fieldPath, 'expected an exact versioned candidate policy');
  }
  if (value.schemaVersion !== 1) invalid(`${fieldPath}.schemaVersion`, 'expected 1');
  if (!isRecord(value.budgets) || !hasExactKeys(value.budgets, [
    'maxPendingCandidates',
    'maxCandidatesPerAutomataRun',
    'maxSourcesPerCandidate',
    'maxReviewReceiptsPerCandidate',
  ])) {
    return invalid(`${fieldPath}.budgets`, 'expected exact candidate budgets');
  }
  if (
    !isRecord(value.companionOnlyAutoactivation)
    || !hasExactKeys(value.companionOnlyAutoactivation, [
      'enabled',
      'scopes',
      'admittedClaimKinds',
      'admittedBases',
      'maximumSensitivity',
    ])
  ) {
    return invalid(
      `${fieldPath}.companionOnlyAutoactivation`,
      'expected exact companion-only autoactivation policy',
    );
  }
  const auto = value.companionOnlyAutoactivation;
  if (typeof auto.enabled !== 'boolean') {
    invalid(`${fieldPath}.companionOnlyAutoactivation.enabled`, 'expected boolean');
  }
  const autoScopes = exactKnownList(
    auto.scopes,
    ['companion_self'] as const,
    `${fieldPath}.companionOnlyAutoactivation.scopes`,
    { nonEmpty: true },
  );
  return {
    schemaVersion: 1,
    admittedSourceTypes: exactKnownList(
      value.admittedSourceTypes,
      MEMORY_POLICY_TYPES,
      `${fieldPath}.admittedSourceTypes`,
      { nonEmpty: true },
    ),
    maximumSourceSensitivity: sensitivity(
      value.maximumSourceSensitivity,
      `${fieldPath}.maximumSourceSensitivity`,
    ),
    excludedLifecycleStates: exactKnownList(
      value.excludedLifecycleStates,
      BIOGRAPHICAL_SOURCE_LIFECYCLE_STATES,
      `${fieldPath}.excludedLifecycleStates`,
      { nonEmpty: true, required: REQUIRED_BIOGRAPHICAL_SOURCE_EXCLUSIONS },
    ),
    budgets: {
      maxPendingCandidates: positiveInteger(
        value.budgets.maxPendingCandidates,
        `${fieldPath}.budgets.maxPendingCandidates`,
      ),
      maxCandidatesPerAutomataRun: positiveInteger(
        value.budgets.maxCandidatesPerAutomataRun,
        `${fieldPath}.budgets.maxCandidatesPerAutomataRun`,
      ),
      maxSourcesPerCandidate: positiveInteger(
        value.budgets.maxSourcesPerCandidate,
        `${fieldPath}.budgets.maxSourcesPerCandidate`,
      ),
      maxReviewReceiptsPerCandidate: positiveInteger(
        value.budgets.maxReviewReceiptsPerCandidate,
        `${fieldPath}.budgets.maxReviewReceiptsPerCandidate`,
      ),
    },
    reviewTriggers: exactKnownList(
      value.reviewTriggers,
      BIOGRAPHICAL_REVIEW_TRIGGERS,
      `${fieldPath}.reviewTriggers`,
    ),
    companionOnlyAutoactivation: {
      enabled: auto.enabled,
      scopes: autoScopes as unknown as readonly ['companion_self'],
      admittedClaimKinds: exactKnownList(
        auto.admittedClaimKinds,
        CLAIM_KINDS,
        `${fieldPath}.companionOnlyAutoactivation.admittedClaimKinds`,
      ),
      admittedBases: exactKnownList(
        auto.admittedBases,
        CLAIM_BASES,
        `${fieldPath}.companionOnlyAutoactivation.admittedBases`,
      ),
      maximumSensitivity: sensitivity(
        auto.maximumSensitivity,
        `${fieldPath}.companionOnlyAutoactivation.maximumSensitivity`,
      ),
    },
    projectionScopes: exactKnownList(
      value.projectionScopes,
      BIOGRAPHICAL_PROJECTION_SCOPES,
      `${fieldPath}.projectionScopes`,
      { nonEmpty: true },
    ),
  };
}

export function createDefaultBiographicalCandidatePolicy(
  seedDir = process.env.CONFIG_DIR ?? './config',
): BiographicalCandidatePolicy {
  const seedPath = join(seedDir, 'settings.seed.json');
  const root: unknown = JSON.parse(readFileSync(seedPath, 'utf8'));
  if (!isRecord(root)) throw new Error(`${seedPath} must be an object`);
  return normalizeBiographicalCandidatePolicy(
    root.biographicalCandidatePolicy,
    `${seedPath}.biographicalCandidatePolicy`,
  );
}

export function cloneBiographicalCandidatePolicy(
  policy: BiographicalCandidatePolicy,
): BiographicalCandidatePolicy {
  return structuredClone(policy);
}
