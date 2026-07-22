import {
  assertNoUnknownKeys,
  isRecord,
  normalizeStringArray,
} from '../utils/types.js';

export const MEMORY_SUBJECT_CLASSIFIER_VERSION = 1;

/**
 * A memory subject mutation was refused because the caller's authorization does
 * not cover every requested memory. Callers performing a *mutation* must keep
 * treating this as fatal. Callers doing bookkeeping on rows retrieval already
 * selected and rendered (access counters) must degrade instead of discarding
 * the caller's work — see the retrieval access-stat loop.
 */
export class MemorySubjectAuthorizationDeniedError extends Error {
  constructor(message = 'Memory subject authorization denied') {
    super(message);
    this.name = 'MemorySubjectAuthorizationDeniedError';
  }
}

export const MEMORY_SUBJECT_CLASSES = [
  'single_contact',
  'multiple_contacts',
  'shared_room',
  'companion_private',
  'unbound_person',
  'unattributed',
  'ambiguous',
] as const;
export type MemorySubjectClass = typeof MEMORY_SUBJECT_CLASSES[number];

export const MEMORY_SUBJECT_CLASSIFICATION_STATUSES = ['current', 'invalidated'] as const;
export type MemorySubjectClassificationStatus = typeof MEMORY_SUBJECT_CLASSIFICATION_STATUSES[number];

export const MEMORY_SUBJECT_EVIDENCE_KINDS = [
  'explicit_subject_contact',
  'explicit_subject_contacts',
  'mention_routed_contact',
  'structured_room',
  'companion_internal',
  'unbound_subject',
  'no_subject_evidence',
  'contradictory_evidence',
] as const;
export type MemorySubjectEvidenceKind = typeof MEMORY_SUBJECT_EVIDENCE_KINDS[number];

export const MEMORY_VIEWER_RELATIONS = ['self', 'co_subject', 'other', 'none'] as const;
export type MemoryViewerRelation = typeof MEMORY_VIEWER_RELATIONS[number];

export const MEMORY_SUBJECT_ACCESS_ACTIONS = [
  'list',
  'detail',
  'search',
  'count',
  'snippet',
  'embedding',
  'export',
  'prompt_preview',
  'bulk_mutation',
  'update',
] as const;
export type MemorySubjectAccessAction = typeof MEMORY_SUBJECT_ACCESS_ACTIONS[number];

export interface MemorySubjectClassification {
  memoryId: string;
  subjectClass: MemorySubjectClass;
  status: MemorySubjectClassificationStatus;
  classifierVersion: number;
  memoryRevision: number;
  evidenceDigest: string;
  evidence: MemorySubjectEvidenceKind[];
  subjectContactIds: string[];
  roomId?: string;
  unboundPersonLabelHash?: string;
  reasonClass: string;
  classifiedAt: number;
  updatedAt: number;
}

export interface MemorySubjectGrantBinding {
  memoryId: string;
  memoryRevision: number;
  classifierVersion: number;
  evidenceDigest: string;
}

export interface MemorySubjectQueryAuthorization {
  action: MemorySubjectAccessAction;
  viewerContactIds: string[];
  allowedSubjectClasses: MemorySubjectClass[];
  allowedViewerRelations: MemoryViewerRelation[];
  classifierVersion: number;
  grantBindings: MemorySubjectGrantBinding[];
}

const CLASSIFICATION_KEYS = [
  'memoryId',
  'subjectClass',
  'status',
  'classifierVersion',
  'memoryRevision',
  'evidenceDigest',
  'evidence',
  'subjectContactIds',
  'roomId',
  'unboundPersonLabelHash',
  'reasonClass',
  'classifiedAt',
  'updatedAt',
] as const;
const AUTHORIZATION_KEYS = [
  'action',
  'viewerContactIds',
  'allowedSubjectClasses',
  'allowedViewerRelations',
  'classifierVersion',
  'grantBindings',
] as const;
const GRANT_KEYS = ['memoryId', 'memoryRevision', 'classifierVersion', 'evidenceDigest'] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Memory subject ${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Memory subject ${field} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeTimestamp(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`Memory subject ${field} must be a non-negative safe integer`);
  }
  return Number(value);
}

function sha256Digest(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`Memory subject ${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function strictEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`Memory subject ${field} is unknown`);
  }
  return value as T;
}

function strictEnumArray<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T[] {
  const normalized = normalizeStringArray(value, field, { errorPrefix: 'Memory subject' });
  return normalized.map(entry => strictEnum(entry, values, field));
}

export function parseMemorySubjectClassification(value: unknown): MemorySubjectClassification {
  if (!isRecord(value)) throw new Error('Memory subject classification must be an object');
  assertNoUnknownKeys(value, CLASSIFICATION_KEYS, 'classification', { errorPrefix: 'Memory subject' });
  const subjectClass = strictEnum(value.subjectClass, MEMORY_SUBJECT_CLASSES, 'subjectClass');
  const status = strictEnum(value.status, MEMORY_SUBJECT_CLASSIFICATION_STATUSES, 'status');
  const evidence = strictEnumArray(value.evidence, MEMORY_SUBJECT_EVIDENCE_KINDS, 'evidence');
  const subjectContactIds = normalizeStringArray(value.subjectContactIds, 'subjectContactIds', {
    errorPrefix: 'Memory subject',
  }).sort();
  const roomId = optionalString(value.roomId, 'roomId');
  const unboundPersonLabelHash = value.unboundPersonLabelHash === undefined
    ? undefined
    : sha256Digest(value.unboundPersonLabelHash, 'unboundPersonLabelHash');

  if (subjectClass === 'single_contact' && subjectContactIds.length !== 1) {
    throw new Error('Memory subject single_contact requires exactly one subjectContactId');
  }
  if (subjectClass === 'multiple_contacts' && subjectContactIds.length < 2) {
    throw new Error('Memory subject multiple_contacts requires at least two subjectContactIds');
  }
  if (subjectClass === 'shared_room' && !roomId) {
    throw new Error('Memory subject shared_room requires roomId');
  }
  if (subjectClass === 'unbound_person' && !unboundPersonLabelHash) {
    throw new Error('Memory subject unbound_person requires unboundPersonLabelHash');
  }

  return {
    memoryId: requiredString(value.memoryId, 'memoryId'),
    subjectClass,
    status,
    classifierVersion: positiveInteger(value.classifierVersion, 'classifierVersion'),
    memoryRevision: positiveInteger(value.memoryRevision, 'memoryRevision'),
    evidenceDigest: sha256Digest(value.evidenceDigest, 'evidenceDigest'),
    evidence,
    subjectContactIds,
    ...(roomId ? { roomId } : {}),
    ...(unboundPersonLabelHash ? { unboundPersonLabelHash } : {}),
    reasonClass: requiredString(value.reasonClass, 'reasonClass'),
    classifiedAt: nonNegativeTimestamp(value.classifiedAt, 'classifiedAt'),
    updatedAt: nonNegativeTimestamp(value.updatedAt, 'updatedAt'),
  };
}

function parseGrantBinding(value: unknown): MemorySubjectGrantBinding {
  if (!isRecord(value)) throw new Error('Memory subject grant binding must be an object');
  assertNoUnknownKeys(value, GRANT_KEYS, 'grantBinding', { errorPrefix: 'Memory subject' });
  return {
    memoryId: requiredString(value.memoryId, 'grantBinding.memoryId'),
    memoryRevision: positiveInteger(value.memoryRevision, 'grantBinding.memoryRevision'),
    classifierVersion: positiveInteger(value.classifierVersion, 'grantBinding.classifierVersion'),
    evidenceDigest: sha256Digest(value.evidenceDigest, 'grantBinding.evidenceDigest'),
  };
}

export function parseMemorySubjectQueryAuthorization(value: unknown): MemorySubjectQueryAuthorization {
  if (!isRecord(value)) throw new Error('Memory subject authorization must be an object');
  assertNoUnknownKeys(value, AUTHORIZATION_KEYS, 'authorization', { errorPrefix: 'Memory subject' });
  const viewerContactIds = normalizeStringArray(value.viewerContactIds, 'viewerContactIds', {
    errorPrefix: 'Memory subject',
  }).sort();
  const allowedSubjectClasses = strictEnumArray(
    value.allowedSubjectClasses,
    MEMORY_SUBJECT_CLASSES,
    'allowedSubjectClasses',
  );
  const allowedViewerRelations = strictEnumArray(
    value.allowedViewerRelations,
    MEMORY_VIEWER_RELATIONS,
    'allowedViewerRelations',
  );
  if (viewerContactIds.length === 0) {
    throw new Error('Memory subject viewerContactIds must contain at least one contact');
  }
  if (allowedSubjectClasses.length === 0 || allowedViewerRelations.length === 0) {
    throw new Error('Memory subject authorization policy must not be empty');
  }
  if (!Array.isArray(value.grantBindings) && value.grantBindings !== undefined) {
    throw new Error('Memory subject grantBindings must be an array');
  }
  return {
    action: strictEnum(value.action, MEMORY_SUBJECT_ACCESS_ACTIONS, 'action'),
    viewerContactIds,
    allowedSubjectClasses,
    allowedViewerRelations,
    classifierVersion: positiveInteger(value.classifierVersion, 'classifierVersion'),
    grantBindings: (value.grantBindings ?? []).map(parseGrantBinding),
  };
}
