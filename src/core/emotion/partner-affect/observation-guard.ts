// Partner Affect shadow observation guard (docs/partner-affect.md section 6.3).
//
// Fail-closed boundary between raw external telemetry payloads and the
// shadow observation store. Mirrors the identity-claim whitelist posture of
// sensor-cognition-bridge.ts: only whitelisted scalar summary fields may
// pass, so raw coordinates, biometric streams, message bodies, purchase line
// items, and third-party content are structurally unable to reach the
// composite layer regardless of how they are named or nested.
//
// Provenance, confidence, freshness, conflict, and suppression semantics
// reuse the emotion telemetry primitives (telemetry-validation.ts /
// emotion-contracts.ts) instead of growing a parallel guard vocabulary.

import { isRecord } from '../../../shared/utils/types.js';
import type { EmotionTelemetryProvenance } from '../../../shared/contracts/emotion-contracts.js';
import { normalizeEmotionTelemetryProvenance } from '../telemetry-validation.js';
import {
  PARTNER_AFFECT_SCHEMA_VERSION,
  isPartnerAffectSignalFamily,
  type PartnerAffectAssertionBasis,
  type PartnerAffectObservation,
  type PartnerAffectObservationDecision,
  type PartnerAffectShadowPolicy,
  type PartnerAffectSignalFamily,
  type PartnerAffectSourceAuthorization,
  type PartnerAffectSuppressionReason,
} from '../../../shared/contracts/partner-affect.js';

/**
 * Every key a shadow observation payload may carry. Any key outside this set
 * — including nested blobs a denylist would miss — fails the candidate
 * closed as `raw_sensitive_payload`.
 */
const OBSERVATION_PAYLOAD_WHITELISTED_KEYS: ReadonlySet<string> = new Set([
  'observationId',
  'sourceId',
  'partnerContactId',
  'signalFamily',
  'metricName',
  'value',
  'unit',
  'windowStartMs',
  'windowEndMs',
  'observedAtMs',
  'coverage',
  'confidence',
  'missingness',
  'consentRef',
  'provenance',
  'processingRevision',
]);

const PROVENANCE_ENTRY_WHITELISTED_KEYS: ReadonlySet<string> = new Set([
  'source',
  'observedAtMs',
  'modality',
  'classifier',
  'model',
  'provenanceRef',
]);

/** String caps stop free-text (message bodies, notes) riding scalar fields. */
const MAX_ID_LENGTH = 128;
const MAX_METRIC_NAME_LENGTH = 64;
const MAX_UNIT_LENGTH = 32;
const MAX_CONSENT_REF_LENGTH = 128;
const MAX_PROCESSING_REVISION_LENGTH = 64;
const MAX_PROVENANCE_ENTRIES = 8;
const TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/;

/** Tolerated forward clock skew before an observation is `future_observation`. */
export const PARTNER_AFFECT_CLOCK_SKEW_TOLERANCE_MS = 120_000;

export interface PartnerAffectObservationCandidate {
  payload: Record<string, unknown>;
  receivedAtMs: number;
}

export interface PartnerAffectObservationGuardInput {
  candidate: PartnerAffectObservationCandidate;
  policy: PartnerAffectShadowPolicy;
  nowMs: number;
}

interface FieldFailure {
  reason: PartnerAffectSuppressionReason;
  detail: string;
}

function suppress(
  reasons: readonly FieldFailure[],
  context: {
    observationKey: string | null;
    sourceId: string | null;
    signalFamily: PartnerAffectSignalFamily | null;
    receivedAtMs: number;
  },
): PartnerAffectObservationDecision {
  const uniqueReasons = [...new Set(reasons.map(failure => failure.reason))].sort();
  const detail = reasons.map(failure => failure.detail).join('; ');
  return {
    status: 'suppressed',
    suppressed: {
      schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
      observationKey: context.observationKey,
      sourceId: context.sourceId,
      signalFamily: context.signalFamily,
      reasons: uniqueReasons,
      detail,
      receivedAtMs: context.receivedAtMs,
    },
  };
}

function readToken(
  payload: Record<string, unknown>,
  key: string,
  maxLength: number,
  failures: FieldFailure[],
  options: { required: boolean },
): string | null {
  const raw = payload[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      failures.push({ reason: 'malformed_observation', detail: `${key} is required` });
    }
    return null;
  }
  if (typeof raw !== 'string') {
    failures.push({ reason: 'malformed_observation', detail: `${key} must be a string` });
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength || !TOKEN_PATTERN.test(trimmed)) {
    failures.push({
      reason: 'malformed_observation',
      detail: `${key} must be a token of 1-${String(maxLength)} allowed characters`,
    });
    return null;
  }
  return trimmed;
}

function readFinite(
  payload: Record<string, unknown>,
  key: string,
  failures: FieldFailure[],
  options: { required: boolean },
): number | null {
  const raw = payload[key];
  if (raw === undefined || raw === null) {
    if (options.required) {
      failures.push({ reason: 'malformed_observation', detail: `${key} is required` });
    }
    return null;
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    failures.push({ reason: 'malformed_observation', detail: `${key} must be a finite number` });
    return null;
  }
  return raw;
}

function readUnitInterval(
  payload: Record<string, unknown>,
  key: string,
  failures: FieldFailure[],
  options: { required: boolean },
): number | null {
  const value = readFinite(payload, key, failures, options);
  if (value === null) return null;
  if (value < 0 || value > 1) {
    failures.push({ reason: 'malformed_observation', detail: `${key} must be in range [0, 1]` });
    return null;
  }
  return value;
}

function provenanceEntriesAreWhitelisted(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (value.length > MAX_PROVENANCE_ENTRIES) return false;
  for (const entry of value) {
    if (!isRecord(entry)) return false;
    for (const key of Object.keys(entry)) {
      if (!PROVENANCE_ENTRY_WHITELISTED_KEYS.has(key)) return false;
    }
  }
  return true;
}

/**
 * Derive how the observation relates to the partner's own voice. Any
 * classifier or model anywhere in provenance forces `model_inferred`; only
 * pure self-report provenance may claim `partner_asserted`. The payload has
 * no say in this: inference can never be presented as partner-asserted fact.
 */
export function derivePartnerAffectAssertionBasis(
  provenance: readonly EmotionTelemetryProvenance[],
): PartnerAffectAssertionBasis {
  const modelInferred = provenance.some(entry => entry.classifier !== undefined || entry.model !== undefined);
  if (modelInferred) return 'model_inferred';
  if (provenance.every(entry => entry.source === 'self_report')) return 'partner_asserted';
  return 'sensor_summary';
}

function resolveSourceAuthorization(
  policy: PartnerAffectShadowPolicy,
  sourceId: string,
): PartnerAffectSourceAuthorization | undefined {
  return policy.sources.find(source => source.sourceId === sourceId);
}

/**
 * Validate and normalize one raw shadow observation candidate. Collects every
 * applicable suppression reason (rather than first-fail) so Garden can show a
 * complete explanation, and never copies rejected payload content into the
 * suppressed record.
 */
export function guardPartnerAffectObservation(
  input: PartnerAffectObservationGuardInput,
): PartnerAffectObservationDecision {
  const { candidate, policy } = input;
  const nowMs = Math.floor(input.nowMs);
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error('guardPartnerAffectObservation requires a finite non-negative nowMs');
  }
  const receivedAtMs = Math.floor(candidate.receivedAtMs);
  if (!Number.isFinite(receivedAtMs) || receivedAtMs < 0) {
    throw new Error('guardPartnerAffectObservation requires a finite non-negative receivedAtMs');
  }
  const payload = candidate.payload;
  if (!isRecord(payload)) {
    throw new Error('guardPartnerAffectObservation requires an object payload');
  }

  const failures: FieldFailure[] = [];

  // Routing identity is parsed first (leniently) so suppressed records can
  // carry structural context even when the candidate is otherwise rejected.
  const identityFailures: FieldFailure[] = [];
  const sourceId = readToken(payload, 'sourceId', MAX_ID_LENGTH, identityFailures, { required: true });
  const observationId = readToken(payload, 'observationId', MAX_ID_LENGTH, identityFailures, { required: true });
  failures.push(...identityFailures);
  const observationKey = sourceId && observationId ? `${sourceId}:${observationId}` : null;

  const rawFamily = typeof payload.signalFamily === 'string' ? payload.signalFamily.trim() : undefined;
  let signalFamily: PartnerAffectSignalFamily | null = null;
  if (rawFamily !== undefined && isPartnerAffectSignalFamily(rawFamily)) {
    signalFamily = rawFamily;
  } else {
    failures.push({ reason: 'unknown_signal_family', detail: 'signalFamily is missing or not a known Signal Family' });
  }

  const context = { observationKey, sourceId, signalFamily, receivedAtMs };

  if (!policy.enabled) {
    failures.push({ reason: 'shadow_disabled', detail: 'partner affect shadow observation is disabled' });
  }
  if (policy.partnerContactId === null) {
    failures.push({ reason: 'partner_unbound', detail: 'no canonical partner contact is bound' });
  }

  // Fail-closed payload whitelist: any unexpected key (raw coordinates,
  // biometric streams, message bodies, purchase line items, third-party
  // content, however named) rejects the candidate. Key names are not echoed
  // into the audit record because hostile payloads can smuggle content there.
  const unexpectedKeyCount = Object.keys(payload)
    .filter(key => !OBSERVATION_PAYLOAD_WHITELISTED_KEYS.has(key))
    .length;
  if (unexpectedKeyCount > 0) {
    failures.push({
      reason: 'raw_sensitive_payload',
      detail: `payload carries ${String(unexpectedKeyCount)} non-whitelisted key(s)`,
    });
  }

  const partnerContactId = readToken(payload, 'partnerContactId', MAX_ID_LENGTH, failures, { required: true });
  if (
    partnerContactId !== null
    && policy.partnerContactId !== null
    && partnerContactId !== policy.partnerContactId
  ) {
    failures.push({
      reason: 'wrong_partner',
      detail: 'observation names a contact other than the bound canonical partner',
    });
  }

  const metricName = readToken(payload, 'metricName', MAX_METRIC_NAME_LENGTH, failures, { required: true });
  const unit = readToken(payload, 'unit', MAX_UNIT_LENGTH, failures, { required: true });
  const processingRevision = readToken(
    payload,
    'processingRevision',
    MAX_PROCESSING_REVISION_LENGTH,
    failures,
    { required: true },
  );
  const claimedConsentRef = readToken(payload, 'consentRef', MAX_CONSENT_REF_LENGTH, failures, { required: false });

  const value = readFinite(payload, 'value', failures, { required: true });
  const coverage = readUnitInterval(payload, 'coverage', failures, { required: true });
  const confidence = readUnitInterval(payload, 'confidence', failures, { required: true });
  const explicitMissingness = readUnitInterval(payload, 'missingness', failures, { required: false });

  const windowStartMs = readFinite(payload, 'windowStartMs', failures, { required: true });
  const windowEndMs = readFinite(payload, 'windowEndMs', failures, { required: true });
  let observedAtMs = readFinite(payload, 'observedAtMs', failures, { required: false });
  if (windowStartMs !== null && windowEndMs !== null) {
    if (windowStartMs < 0 || windowEndMs < windowStartMs) {
      failures.push({ reason: 'invalid_window', detail: 'observation window must satisfy 0 <= start <= end' });
    } else {
      observedAtMs ??= windowEndMs;
    }
  }
  if (observedAtMs !== null) {
    if (observedAtMs < 0 || (windowStartMs !== null && observedAtMs < windowStartMs)) {
      failures.push({ reason: 'invalid_window', detail: 'observedAtMs must fall at or after the window start' });
    }
    if (observedAtMs > nowMs + PARTNER_AFFECT_CLOCK_SKEW_TOLERANCE_MS) {
      failures.push({ reason: 'future_observation', detail: 'observation claims a future timestamp' });
    } else if (nowMs - observedAtMs > policy.staleAfterMs) {
      failures.push({ reason: 'stale_observation', detail: 'observation is older than the configured staleness window' });
    }
  }

  if (confidence !== null && confidence < policy.minConfidence) {
    failures.push({ reason: 'low_confidence', detail: 'confidence is below the configured minimum' });
  }

  // Provenance: whitelist entry keys first (fail-closed against smuggled
  // content), then reuse the shared emotion telemetry provenance normalizer.
  let provenance: EmotionTelemetryProvenance[] = [];
  const rawProvenance = payload.provenance;
  if (rawProvenance === undefined || (Array.isArray(rawProvenance) && rawProvenance.length === 0)) {
    failures.push({ reason: 'missing_provenance', detail: 'provenance is required and must be non-empty' });
  } else if (!provenanceEntriesAreWhitelisted(rawProvenance)) {
    failures.push({
      reason: 'raw_sensitive_payload',
      detail: 'provenance entries carry non-whitelisted keys or exceed the entry cap',
    });
  } else {
    try {
      provenance = normalizeEmotionTelemetryProvenance(rawProvenance, 'provenance');
    } catch (error) {
      failures.push({
        reason: 'malformed_observation',
        detail: error instanceof Error ? error.message : 'provenance failed validation',
      });
    }
    if (provenance.some(entry => entry.source === 'missing' || entry.source === 'unknown')) {
      failures.push({ reason: 'missing_provenance', detail: 'provenance entries must name a concrete source' });
    }
  }

  // Consent: the authorized-source registry is the authority. A payload may
  // echo a consentRef, but it must match the registry exactly.
  let authorization: PartnerAffectSourceAuthorization | undefined;
  if (sourceId !== null) {
    authorization = resolveSourceAuthorization(policy, sourceId);
    if (!authorization) {
      failures.push({ reason: 'unregistered_source', detail: 'source is not in the authorized-source registry' });
    } else {
      if (authorization.revoked) {
        failures.push({ reason: 'revoked_source', detail: 'source consent has been revoked' });
      }
      if (claimedConsentRef !== null && claimedConsentRef !== authorization.consentRef) {
        failures.push({ reason: 'consent_mismatch', detail: 'claimed consentRef does not match the registry' });
      }
      if (signalFamily !== null && !authorization.families.includes(signalFamily)) {
        failures.push({ reason: 'family_not_consented', detail: 'source is not consented for this Signal Family' });
      }
    }
  }
  if (signalFamily !== null && !policy.allowedSignalFamilies.includes(signalFamily)) {
    failures.push({ reason: 'family_not_allowed', detail: 'Signal Family is not enabled by policy' });
  }

  if (failures.length > 0) {
    return suppress(failures, context);
  }

  // All of these are non-null after a failure-free pass; assert for narrowing.
  if (
    sourceId === null || observationId === null || observationKey === null
    || signalFamily === null || partnerContactId === null || metricName === null
    || unit === null || processingRevision === null || value === null
    || coverage === null || confidence === null || windowStartMs === null
    || windowEndMs === null || observedAtMs === null || !authorization
    || policy.partnerContactId === null
  ) {
    throw new Error('partner affect observation guard reached an inconsistent accept state');
  }

  const direction = policy.directions[`${signalFamily}.${metricName}`] ?? 'unknown';
  const missingness = explicitMissingness ?? roundUnit(1 - coverage);

  const observation: PartnerAffectObservation = {
    schemaVersion: PARTNER_AFFECT_SCHEMA_VERSION,
    observationKey,
    observationId,
    sourceId,
    partnerContactId: policy.partnerContactId,
    signalFamily,
    metricName,
    value,
    unit,
    windowStartMs: Math.floor(windowStartMs),
    windowEndMs: Math.floor(windowEndMs),
    observedAtMs: Math.floor(observedAtMs),
    coverage: roundUnit(coverage),
    confidence: roundUnit(confidence),
    missingness: roundUnit(missingness),
    direction,
    sensitivity: authorization.sensitivity,
    consentRef: authorization.consentRef,
    assertion: derivePartnerAffectAssertionBasis(provenance),
    provenance,
    processingRevision,
    receivedAtMs,
  };
  return { status: 'accepted', observation };
}

function roundUnit(value: number, precision = 4): number {
  const factor = 10 ** precision;
  const rounded = Math.round(value * factor) / factor;
  const clamped = Math.min(1, Math.max(0, rounded));
  return Object.is(clamped, -0) ? 0 : clamped;
}
