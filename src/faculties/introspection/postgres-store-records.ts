import type { QueryResultRow } from 'pg';
import { isRecord } from '../../shared/utils/types.js';
import { requirePositiveInteger } from '../../shared/utils/numeric.js';
import type {
  IntrospectionAuditDecisionAppendInput,
  IntrospectionDivergenceType,
  IntrospectionLandmarkAppendInput,
} from './contracts.js';

export const INTROSPECTION_LANDMARK_SCHEMA_VERSION = 1 as const;
export const MAX_INTROSPECTION_LANDMARK_LIST_LIMIT = 1_000;

const MAX_ID_LENGTH = 256;
const MAX_SOURCE_REF_LENGTH = 1_024;
const MAX_CHANNEL_ID_LENGTH = 512;
const MAX_TURN_ID_LENGTH = 512;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_NARRATIVE_LENGTH = 32_768;
const MAX_PROVENANCE_BYTES = 65_536;
const CONSENT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const LINE_CONTROL_PATTERN = /[\r\n\0]/;

export type IntrospectionAuditOutcome =
  | 'no_divergence'
  | 'below_confidence'
  | 'landmark_created';

export interface IntrospectionLandmarkRecord extends IntrospectionLandmarkAppendInput {
  schemaVersion: typeof INTROSPECTION_LANDMARK_SCHEMA_VERSION;
}

export interface IntrospectionAuditDecisionRecord extends Omit<
  IntrospectionAuditDecisionAppendInput,
  'outcome'
> {
  schemaVersion: typeof INTROSPECTION_LANDMARK_SCHEMA_VERSION;
  outcome: IntrospectionAuditOutcome;
  landmarkId: string | null;
}

export interface IntrospectionLandmarkRow extends QueryResultRow {
  id: unknown;
  schema_version: unknown;
  source_ref: unknown;
  channel_id: unknown;
  turn_id: unknown;
  occurred_at: unknown;
  divergence_type: unknown;
  observation: unknown;
  confidence: unknown;
  companion_reflection: unknown;
  consent_revision: unknown;
  consent_hash: unknown;
  stable_estimator_model: unknown;
  divergence_auditor_model: unknown;
  companion_reflector_model: unknown;
  provenance_json: unknown;
  created_at: unknown;
}

export interface IntrospectionAuditDecisionRow extends QueryResultRow {
  source_ref: unknown;
  schema_version: unknown;
  outcome: unknown;
  confidence: unknown;
  landmark_id: unknown;
  consent_revision: unknown;
  consent_hash: unknown;
  provenance_json: unknown;
  created_at: unknown;
}

function normalizeBoundedText(
  value: unknown,
  field: string,
  maxLength: number,
  options: { allowLineBreaks?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new Error(`Introspection ${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Introspection ${field} must not be empty`);
  }
  if (normalized.length > maxLength) {
    throw new Error(`Introspection ${field} must be ${maxLength} characters or fewer`);
  }
  if (options.allowLineBreaks !== true && LINE_CONTROL_PATTERN.test(normalized)) {
    throw new Error(`Introspection ${field} must not contain line-control characters`);
  }
  if (normalized.includes('\0')) {
    throw new Error(`Introspection ${field} must not contain NUL characters`);
  }
  return normalized;
}

function normalizeConfidence(value: unknown, field = 'confidence'): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`Introspection ${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function normalizeTimestamp(value: unknown, field: string): string {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === 'string'
      ? Date.parse(value)
      : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Introspection ${field} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeSchemaVersion(value: unknown): typeof INTROSPECTION_LANDMARK_SCHEMA_VERSION {
  if (value !== INTROSPECTION_LANDMARK_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported introspection landmark schema version ${JSON.stringify(value)}`,
    );
  }
  return INTROSPECTION_LANDMARK_SCHEMA_VERSION;
}

function normalizeDivergenceType(value: unknown): IntrospectionDivergenceType {
  if (value !== 'affective' && value !== 'substantive') {
    throw new Error(`Unsupported introspection divergence type ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeConsentHash(value: unknown): string {
  const normalized = normalizeBoundedText(value, 'consentHash', 64);
  if (!CONSENT_HASH_PATTERN.test(normalized)) {
    throw new Error('Introspection consentHash must be a lowercase SHA-256 hex digest');
  }
  return normalized;
}

function assertJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`Introspection provenance ${path} must be a finite JSON number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error(`Introspection provenance ${path} must not contain cycles`);
    }
    seen.add(value);
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], `${path}[${index}]`, seen);
    }
    seen.delete(value);
    return;
  }
  if (!isRecord(value)) {
    throw new Error(`Introspection provenance ${path} must contain only JSON values`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`Introspection provenance ${path} must contain only plain objects`);
  }
  if (seen.has(value)) {
    throw new Error(`Introspection provenance ${path} must not contain cycles`);
  }
  seen.add(value);
  for (const [key, entry] of Object.entries(value)) {
    assertJsonValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function normalizeProvenance(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Introspection provenance must be a JSON object');
  }
  if (Object.keys(value).length === 0) {
    throw new Error('Introspection provenance must contain at least one reference');
  }
  assertJsonValue(value, '$');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_PROVENANCE_BYTES) {
    throw new Error(`Introspection provenance must be ${MAX_PROVENANCE_BYTES} bytes or fewer`);
  }
  const decoded: unknown = JSON.parse(encoded);
  if (!isRecord(decoded)) {
    throw new Error('Introspection provenance must encode as a JSON object');
  }
  return decoded;
}

export function normalizeIntrospectionSourceRef(value: unknown): string {
  return normalizeBoundedText(value, 'sourceRef', MAX_SOURCE_REF_LENGTH);
}

export function normalizeLandmarkInput(
  input: IntrospectionLandmarkAppendInput,
): IntrospectionLandmarkRecord {
  return {
    schemaVersion: INTROSPECTION_LANDMARK_SCHEMA_VERSION,
    id: normalizeBoundedText(input.id, 'landmark id', MAX_ID_LENGTH),
    sourceRef: normalizeIntrospectionSourceRef(input.sourceRef),
    channelId: normalizeBoundedText(input.channelId, 'channelId', MAX_CHANNEL_ID_LENGTH),
    turnId: normalizeBoundedText(input.turnId, 'turnId', MAX_TURN_ID_LENGTH),
    occurredAt: normalizeTimestamp(input.occurredAt, 'occurredAt'),
    divergenceType: normalizeDivergenceType(input.divergenceType),
    observation: normalizeBoundedText(
      input.observation,
      'observation',
      MAX_NARRATIVE_LENGTH,
      { allowLineBreaks: true },
    ),
    confidence: normalizeConfidence(input.confidence),
    companionReflection: normalizeBoundedText(
      input.companionReflection,
      'companionReflection',
      MAX_NARRATIVE_LENGTH,
      { allowLineBreaks: true },
    ),
    consentRevision: requirePositiveInteger(input.consentRevision, 'consentRevision'),
    consentHash: normalizeConsentHash(input.consentHash),
    stableEstimatorModel: normalizeBoundedText(
      input.stableEstimatorModel,
      'stableEstimatorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    divergenceAuditorModel: normalizeBoundedText(
      input.divergenceAuditorModel,
      'divergenceAuditorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    companionReflectorModel: normalizeBoundedText(
      input.companionReflectorModel,
      'companionReflectorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    provenance: normalizeProvenance(input.provenance),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
  };
}

function normalizeDecisionOutcome(value: unknown): 'no_divergence' | 'below_confidence' {
  if (value !== 'no_divergence' && value !== 'below_confidence') {
    throw new Error(`Unsupported introspection audit outcome ${JSON.stringify(value)}`);
  }
  return value;
}

export function normalizeDecisionInput(
  input: IntrospectionAuditDecisionAppendInput,
): IntrospectionAuditDecisionRecord {
  const outcome = normalizeDecisionOutcome(input.outcome);
  const confidence = input.confidence === null ? null : normalizeConfidence(input.confidence);
  if (outcome === 'below_confidence' && confidence === null) {
    throw new Error('Introspection below_confidence decisions require confidence');
  }
  return {
    schemaVersion: INTROSPECTION_LANDMARK_SCHEMA_VERSION,
    sourceRef: normalizeIntrospectionSourceRef(input.sourceRef),
    outcome,
    confidence,
    landmarkId: null,
    consentRevision: requirePositiveInteger(input.consentRevision, 'consentRevision'),
    consentHash: normalizeConsentHash(input.consentHash),
    provenance: normalizeProvenance(input.provenance),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
  };
}

export function mapLandmarkRow(row: IntrospectionLandmarkRow): IntrospectionLandmarkRecord {
  return {
    schemaVersion: normalizeSchemaVersion(row.schema_version),
    id: normalizeBoundedText(row.id, 'landmark id', MAX_ID_LENGTH),
    sourceRef: normalizeIntrospectionSourceRef(row.source_ref),
    channelId: normalizeBoundedText(row.channel_id, 'channelId', MAX_CHANNEL_ID_LENGTH),
    turnId: normalizeBoundedText(row.turn_id, 'turnId', MAX_TURN_ID_LENGTH),
    occurredAt: normalizeTimestamp(row.occurred_at, 'occurredAt'),
    divergenceType: normalizeDivergenceType(row.divergence_type),
    observation: normalizeBoundedText(
      row.observation,
      'observation',
      MAX_NARRATIVE_LENGTH,
      { allowLineBreaks: true },
    ),
    confidence: normalizeConfidence(row.confidence),
    companionReflection: normalizeBoundedText(
      row.companion_reflection,
      'companionReflection',
      MAX_NARRATIVE_LENGTH,
      { allowLineBreaks: true },
    ),
    consentRevision: requirePositiveInteger(row.consent_revision, 'consentRevision'),
    consentHash: normalizeConsentHash(row.consent_hash),
    stableEstimatorModel: normalizeBoundedText(
      row.stable_estimator_model,
      'stableEstimatorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    divergenceAuditorModel: normalizeBoundedText(
      row.divergence_auditor_model,
      'divergenceAuditorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    companionReflectorModel: normalizeBoundedText(
      row.companion_reflector_model,
      'companionReflectorModel',
      MAX_MODEL_ID_LENGTH,
    ),
    provenance: normalizeProvenance(row.provenance_json),
    createdAt: normalizeTimestamp(row.created_at, 'createdAt'),
  };
}

export function mapDecisionRow(
  row: IntrospectionAuditDecisionRow,
): IntrospectionAuditDecisionRecord {
  normalizeSchemaVersion(row.schema_version);
  const outcome = row.outcome;
  if (
    outcome !== 'no_divergence'
    && outcome !== 'below_confidence'
    && outcome !== 'landmark_created'
  ) {
    throw new Error(`Unsupported introspection audit outcome ${JSON.stringify(outcome)}`);
  }
  const confidence = row.confidence === null ? null : normalizeConfidence(row.confidence);
  const landmarkId = row.landmark_id === null
    ? null
    : normalizeBoundedText(row.landmark_id, 'landmark id', MAX_ID_LENGTH);
  if (outcome === 'landmark_created' && (confidence === null || landmarkId === null)) {
    throw new Error('Corrupt introspection landmark_created audit decision');
  }
  if (outcome === 'below_confidence' && (confidence === null || landmarkId !== null)) {
    throw new Error('Corrupt introspection below_confidence audit decision');
  }
  if (outcome === 'no_divergence' && landmarkId !== null) {
    throw new Error('Corrupt introspection no_divergence audit decision');
  }
  return {
    schemaVersion: INTROSPECTION_LANDMARK_SCHEMA_VERSION,
    sourceRef: normalizeIntrospectionSourceRef(row.source_ref),
    outcome,
    confidence,
    landmarkId,
    consentRevision: requirePositiveInteger(row.consent_revision, 'consentRevision'),
    consentHash: normalizeConsentHash(row.consent_hash),
    provenance: normalizeProvenance(row.provenance_json),
    createdAt: normalizeTimestamp(row.created_at, 'createdAt'),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sameLandmark(
  left: IntrospectionLandmarkRecord,
  right: IntrospectionLandmarkRecord,
): boolean {
  return left.id === right.id
    && left.sourceRef === right.sourceRef
    && left.channelId === right.channelId
    && left.turnId === right.turnId
    && left.occurredAt === right.occurredAt
    && left.divergenceType === right.divergenceType
    && left.observation === right.observation
    && left.confidence === right.confidence
    && left.companionReflection === right.companionReflection
    && left.consentRevision === right.consentRevision
    && left.consentHash === right.consentHash
    && left.stableEstimatorModel === right.stableEstimatorModel
    && left.divergenceAuditorModel === right.divergenceAuditorModel
    && left.companionReflectorModel === right.companionReflectorModel
    && canonicalJson(left.provenance) === canonicalJson(right.provenance)
    && left.createdAt === right.createdAt;
}

export function sameDecision(
  left: IntrospectionAuditDecisionRecord,
  right: IntrospectionAuditDecisionRecord,
): boolean {
  return left.sourceRef === right.sourceRef
    && left.outcome === right.outcome
    && left.confidence === right.confidence
    && left.landmarkId === right.landmarkId
    && left.consentRevision === right.consentRevision
    && left.consentHash === right.consentHash
    && canonicalJson(left.provenance) === canonicalJson(right.provenance)
    && left.createdAt === right.createdAt;
}
