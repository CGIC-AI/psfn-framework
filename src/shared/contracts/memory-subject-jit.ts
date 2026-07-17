import { createHash } from 'node:crypto';
import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  type MemorySubjectClassification,
  type MemoryViewerRelation,
} from './memory-subject.js';
import { assertNoUnknownKeys, isRecord } from '../utils/types.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const JIT_REQUEST_KEYS = [
  'subjectScopeDigest',
  'purpose',
  'memoryRevision',
  'classifierVersion',
  'classifierEvidenceDigest',
] as const;

export interface MemorySubjectJitRequest {
  subjectScopeDigest: string;
  purpose: string;
  memoryRevision: number;
  classifierVersion: number;
  classifierEvidenceDigest: string;
}

export interface MemorySubjectScopeDigestInput {
  companionId: string;
  memoryId: string;
  viewerContactId: string;
  viewerRelation: Extract<MemoryViewerRelation, 'self' | 'co_subject'>;
  classification: Pick<MemorySubjectClassification,
    | 'subjectClass'
    | 'status'
    | 'classifierVersion'
    | 'memoryRevision'
    | 'evidenceDigest'
    | 'subjectContactIds'>;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`Memory subject JIT ${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Memory subject JIT ${field} must be a positive safe integer`);
  }
  return Number(value);
}

function purpose(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Memory subject JIT purpose must be a string');
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error('Memory subject JIT purpose is invalid');
  }
  return normalized;
}

export function parseMemorySubjectJitRequest(value: unknown): MemorySubjectJitRequest {
  if (!isRecord(value)) throw new Error('Memory subject JIT request must be an object');
  assertNoUnknownKeys(value, JIT_REQUEST_KEYS, 'memorySubjectJit');
  return {
    subjectScopeDigest: digest(value.subjectScopeDigest, 'subjectScopeDigest'),
    purpose: purpose(value.purpose),
    memoryRevision: positiveInteger(value.memoryRevision, 'memoryRevision'),
    classifierVersion: positiveInteger(value.classifierVersion, 'classifierVersion'),
    classifierEvidenceDigest: digest(
      value.classifierEvidenceDigest,
      'classifierEvidenceDigest',
    ),
  };
}

/**
 * Bind the classifier version separately from its evidence hash. The fleet JIT
 * schema predates the explicit classifier-version field, so this digest is the
 * durable, exact binding stored in its classifier_evidence_digest column.
 */
export function memorySubjectClassifierEvidenceDigest(
  classification: Pick<MemorySubjectClassification, 'classifierVersion' | 'evidenceDigest'>,
): string {
  return sha256(JSON.stringify({
    schemaVersion: 1,
    classifierVersion: classification.classifierVersion,
    evidenceDigest: classification.evidenceDigest,
  }));
}

/** Canonical authorization-layer projection bound into every subject JIT grant. */
export function memorySubjectScopeDigest(input: MemorySubjectScopeDigestInput): string {
  const subjectContactIds = [...new Set(input.classification.subjectContactIds.map(id => id.trim()))]
    .filter(Boolean)
    .sort();
  if (!input.companionId.trim() || !input.memoryId.trim() || !input.viewerContactId.trim()
    || input.classification.status !== 'current'
    || input.classification.classifierVersion !== MEMORY_SUBJECT_CLASSIFIER_VERSION
    || !subjectContactIds.includes(input.viewerContactId.trim())) {
    throw new Error('Memory subject JIT scope is not a current proven subject projection');
  }
  return sha256(JSON.stringify({
    schemaVersion: 1,
    companionId: input.companionId.trim(),
    memoryId: input.memoryId.trim(),
    viewerContactId: input.viewerContactId.trim(),
    viewerRelation: input.viewerRelation,
    subjectClass: input.classification.subjectClass,
    subjectContactIds,
    classifierVersion: input.classification.classifierVersion,
    memoryRevision: input.classification.memoryRevision,
    evidenceDigest: input.classification.evidenceDigest,
  }));
}

export function memorySubjectJitRequestFor(input: {
  companionId: string;
  memoryId: string;
  viewerContactId: string;
  viewerRelation: Extract<MemoryViewerRelation, 'self' | 'co_subject'>;
  classification: MemorySubjectClassification;
  purpose: string;
}): MemorySubjectJitRequest {
  return {
    subjectScopeDigest: memorySubjectScopeDigest(input),
    purpose: purpose(input.purpose),
    memoryRevision: input.classification.memoryRevision,
    classifierVersion: input.classification.classifierVersion,
    classifierEvidenceDigest: memorySubjectClassifierEvidenceDigest(input.classification),
  };
}
