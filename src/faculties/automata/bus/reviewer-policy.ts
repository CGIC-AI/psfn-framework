import { isRecord } from '../../../shared/utils/types.js';
import type { AutomataBusReviewerCandidatePolicy } from './reviewer-candidates.js';

/**
 * Canonical owner-controlled reviewer policy. Runtime composition parses this
 * from its owner file and passes the normalized value to the core service.
 */
export interface AutomataBusReviewerPolicy extends AutomataBusReviewerCandidatePolicy {
  enabled: boolean;
  cadenceMs: number;
  /** Owner-selected models.json slot; the reviewer adapter routes it as background work. */
  model: string;
  maxReviewsPerRun: number;
  maxEvidenceRefsPerReview: number;
  maxReviewInputChars: number;
  maxDecisionReasonChars: number;
  maxOutputTokens: number;
  deadlineMs: number;
  tokenCeiling: number;
  costCeilingUsd: number;
}

const POLICY_KEYS = new Set<keyof AutomataBusReviewerPolicy>([
  'enabled',
  'cadenceMs',
  'model',
  'similarityThreshold',
  'maxFindingsPerRun',
  'maxNominationsPerRun',
  'maxCandidatesPerCluster',
  'maxClustersPerRun',
  'maxReviewsPerRun',
  'maxEvidenceRefsPerReview',
  'maxReviewInputChars',
  'maxDecisionReasonChars',
  'maxOutputTokens',
  'deadlineMs',
  'tokenCeiling',
  'costCeilingUsd',
]);

function positiveInteger(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid Automata Bus reviewer policy at ${sourcePath}: ${field} must be a positive safe integer`);
  }
  return value;
}

function positiveNumber(value: unknown, field: string, sourcePath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid Automata Bus reviewer policy at ${sourcePath}: ${field} must be a positive finite number`);
  }
  return value;
}

export function parseAutomataBusReviewerPolicy(
  value: unknown,
  sourcePath: string,
): AutomataBusReviewerPolicy {
  if (!isRecord(value)) {
    throw new Error(`Invalid Automata Bus reviewer policy at ${sourcePath}: expected an object`);
  }
  const unknown = Object.keys(value).filter(key => !POLICY_KEYS.has(
    key as keyof AutomataBusReviewerPolicy,
  )).sort();
  if (unknown.length > 0) {
    throw new Error(
      `Invalid Automata Bus reviewer policy at ${sourcePath}: unknown fields: ${unknown.join(', ')}`,
    );
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(`Invalid Automata Bus reviewer policy at ${sourcePath}: enabled must be boolean`);
  }
  if (typeof value.model !== 'string' || value.model.trim().length === 0) {
    throw new Error(`Invalid Automata Bus reviewer policy at ${sourcePath}: model must be a non-empty string`);
  }
  if (
    typeof value.similarityThreshold !== 'number'
    || !Number.isFinite(value.similarityThreshold)
    || value.similarityThreshold < 0
    || value.similarityThreshold > 1
  ) {
    throw new Error(
      `Invalid Automata Bus reviewer policy at ${sourcePath}: similarityThreshold must be in [0,1]`,
    );
  }
  const maxCandidatesPerCluster = positiveInteger(
    value.maxCandidatesPerCluster,
    'maxCandidatesPerCluster',
    sourcePath,
  );
  if (maxCandidatesPerCluster < 2) {
    throw new Error(
      `Invalid Automata Bus reviewer policy at ${sourcePath}: maxCandidatesPerCluster must be at least 2`,
    );
  }
  const maxClustersPerRun = positiveInteger(
    value.maxClustersPerRun,
    'maxClustersPerRun',
    sourcePath,
  );
  const maxReviewsPerRun = positiveInteger(
    value.maxReviewsPerRun,
    'maxReviewsPerRun',
    sourcePath,
  );
  if (maxReviewsPerRun > maxClustersPerRun) {
    throw new Error(
      `Invalid Automata Bus reviewer policy at ${sourcePath}: maxReviewsPerRun cannot exceed maxClustersPerRun`,
    );
  }
  return Object.freeze({
    enabled: value.enabled,
    cadenceMs: positiveInteger(value.cadenceMs, 'cadenceMs', sourcePath),
    model: value.model.trim(),
    similarityThreshold: value.similarityThreshold,
    maxFindingsPerRun: positiveInteger(
      value.maxFindingsPerRun,
      'maxFindingsPerRun',
      sourcePath,
    ),
    maxNominationsPerRun: positiveInteger(
      value.maxNominationsPerRun,
      'maxNominationsPerRun',
      sourcePath,
    ),
    maxCandidatesPerCluster,
    maxClustersPerRun,
    maxReviewsPerRun,
    maxEvidenceRefsPerReview: positiveInteger(
      value.maxEvidenceRefsPerReview,
      'maxEvidenceRefsPerReview',
      sourcePath,
    ),
    maxReviewInputChars: positiveInteger(
      value.maxReviewInputChars,
      'maxReviewInputChars',
      sourcePath,
    ),
    maxDecisionReasonChars: positiveInteger(
      value.maxDecisionReasonChars,
      'maxDecisionReasonChars',
      sourcePath,
    ),
    maxOutputTokens: positiveInteger(value.maxOutputTokens, 'maxOutputTokens', sourcePath),
    deadlineMs: positiveInteger(value.deadlineMs, 'deadlineMs', sourcePath),
    tokenCeiling: positiveInteger(value.tokenCeiling, 'tokenCeiling', sourcePath),
    costCeilingUsd: positiveNumber(value.costCeilingUsd, 'costCeilingUsd', sourcePath),
  });
}
