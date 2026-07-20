// Partner Affect shadow-observation contracts (docs/partner-affect.md, slice 1).
//
// These types define the OBSERVATION foundation only. Everything in this file
// is shadow-scoped: accepted observations and the derived shadow estimate are
// recorded for Garden inspection and evaluation, and are deliberately
// unreachable as behavioral authority. Nothing here may feed prompts, emotion
// appraisal, memory candidacy, scheduling, notifications, or world actions.
// The shadow-isolation test (partner-affect-shadow-isolation.test.ts) enforces
// that boundary mechanically.

import type { EmotionTelemetryProvenance } from './emotion-contracts.js';

export const PARTNER_AFFECT_SCHEMA_VERSION = 1 as const;

/**
 * External telemetry event type carrying one shadow Signal Observation
 * candidate. Must be admitted by the API-channel telemetry allowlist and is
 * consumed only by the shadow ingest bridge.
 */
export const PARTNER_AFFECT_OBSERVATION_EVENT_TYPE = 'external.telemetry.partner_affect.observation' as const;

/**
 * Signal Families are independence groups (docs/partner-affect.md section 6).
 * Several metrics from one family share one evidence budget; independence
 * quorums count families, never raw observations.
 */
export const PARTNER_AFFECT_SIGNAL_FAMILIES = [
  'self_report',
  'conversation',
  'sleep',
  'activity',
  'presence',
  'interaction_cadence',
  'schedule_context',
  'personal_operations',
] as const;

export type PartnerAffectSignalFamily = typeof PARTNER_AFFECT_SIGNAL_FAMILIES[number];

export function isPartnerAffectSignalFamily(value: unknown): value is PartnerAffectSignalFamily {
  return typeof value === 'string'
    && (PARTNER_AFFECT_SIGNAL_FAMILIES as readonly string[]).includes(value);
}

/**
 * Direction is partner-specific configuration, never a source claim
 * (docs/partner-affect.md section 6.4). `unknown` direction can never raise a
 * future composite; slice 1 records it so Garden can show what is calibrated.
 */
export const PARTNER_AFFECT_DIRECTIONS = [
  'higher_supports_need',
  'lower_supports_need',
  'unknown',
] as const;

export type PartnerAffectDirection = typeof PARTNER_AFFECT_DIRECTIONS[number];

export function isPartnerAffectDirection(value: unknown): value is PartnerAffectDirection {
  return typeof value === 'string'
    && (PARTNER_AFFECT_DIRECTIONS as readonly string[]).includes(value);
}

/**
 * How the observation's content relates to the partner's own voice. A
 * model/classifier anywhere in provenance forces `model_inferred`; only pure
 * self-report provenance may claim `partner_asserted`. Inference must never be
 * presented as partner-asserted fact.
 */
export const PARTNER_AFFECT_ASSERTION_BASES = [
  'partner_asserted',
  'model_inferred',
  'sensor_summary',
] as const;

export type PartnerAffectAssertionBasis = typeof PARTNER_AFFECT_ASSERTION_BASES[number];

/** Suppression reason codes. Sorted-unique in every decision record. */
export const PARTNER_AFFECT_SUPPRESSION_REASONS = [
  'shadow_disabled',
  'partner_unbound',
  'wrong_partner',
  'missing_authenticated_origin',
  'unregistered_source',
  'revoked_source',
  'consent_mismatch',
  'unknown_signal_family',
  'family_not_allowed',
  'family_not_consented',
  'raw_sensitive_payload',
  'malformed_observation',
  'invalid_window',
  'future_observation',
  'stale_observation',
  'low_confidence',
  'missing_provenance',
  'duplicate_observation',
] as const;

export type PartnerAffectSuppressionReason = typeof PARTNER_AFFECT_SUPPRESSION_REASONS[number];

/**
 * A normalized, accepted Signal Observation: a provenance-bearing,
 * time-bounded summary from one authorized source, bound to exactly one
 * canonical partner contact. Raw coordinates, biometric streams, message
 * bodies, purchase line items, and third-party content are rejected before
 * this shape exists (payload whitelist + scalar-value rule in the guard).
 */
export interface PartnerAffectObservation {
  schemaVersion: typeof PARTNER_AFFECT_SCHEMA_VERSION;
  /** Stable idempotency key: `${sourceId}:${observationId}`. */
  observationKey: string;
  observationId: string;
  sourceId: string;
  /** Exact canonical partner contact id from configuration; never inferred. */
  partnerContactId: string;
  signalFamily: PartnerAffectSignalFamily;
  metricName: string;
  /** Summarized scalar value only; streams and blobs fail closed upstream. */
  value: number;
  unit: string;
  windowStartMs: number;
  windowEndMs: number;
  observedAtMs: number;
  /** Fraction of the window actually covered by the source, [0,1]. */
  coverage: number;
  confidence: number;
  /** Explicit missingness, [0,1]; absence of data stays visible, never healthy. */
  missingness: number;
  /** Partner-configured direction; sources cannot claim it. */
  direction: PartnerAffectDirection;
  sensitivity: string;
  /** Consent record reference from the authorized-source registry. */
  consentRef: string;
  assertion: PartnerAffectAssertionBasis;
  provenance: EmotionTelemetryProvenance[];
  processingRevision: string;
  receivedAtMs: number;
}

/**
 * Structural record of a suppressed candidate. Carries reason codes and
 * routing identity only — never the rejected payload content, so revoked or
 * raw-sensitive material cannot leak through the audit trail.
 */
export interface PartnerAffectSuppressedObservation {
  schemaVersion: typeof PARTNER_AFFECT_SCHEMA_VERSION;
  observationKey: string | null;
  sourceId: string | null;
  signalFamily: PartnerAffectSignalFamily | null;
  reasons: PartnerAffectSuppressionReason[];
  detail: string;
  receivedAtMs: number;
}

export type PartnerAffectObservationDecision =
  | { status: 'accepted'; observation: PartnerAffectObservation }
  | { status: 'suppressed'; suppressed: PartnerAffectSuppressedObservation };

/**
 * Per-family evidence health inside the shadow estimate. `conflict` marks
 * disagreeing fresh values for the same family+metric from different sources;
 * conflicts stay explicit and block `ordinary`, they are never averaged away.
 */
export interface PartnerAffectFamilyEvidence {
  family: PartnerAffectSignalFamily;
  freshObservationCount: number;
  latestObservedAtMs: number | null;
  freshness: 'fresh' | 'stale' | 'missing';
  /** Max confidence among fresh observations, 0 when none. */
  confidence: number;
  /** Max coverage among fresh observations, 0 when none. */
  coverage: number;
  /** Min missingness among fresh observations, 1 when none. */
  missingness: number;
  conflict: boolean;
  contributingSourceIds: string[];
  assertionBases: PartnerAffectAssertionBasis[];
}

export const PARTNER_AFFECT_ESTIMATE_REASONS = [
  'partner_unbound',
  'no_fresh_evidence',
  'insufficient_family_quorum',
  'low_confidence_evidence',
  'conflicting_evidence',
  'quorum_met',
] as const;

export type PartnerAffectEstimateReason = typeof PARTNER_AFFECT_ESTIMATE_REASONS[number];

/**
 * Shadow-only Partner Affect Estimate, slice 1. `unknown` is the honest
 * default: missing, stale, low-confidence, or conflicting evidence is never
 * promoted to an ordinary/healthy claim. `ordinary` requires positive fresh
 * evidence across an independence quorum of families. There is deliberately
 * no posture, score, or directional claim in this slice; the estimate is a
 * deterministic evidence summary for evaluation, not behavioral authority.
 */
export interface PartnerAffectShadowEstimate {
  schemaVersion: typeof PARTNER_AFFECT_SCHEMA_VERSION;
  partnerContactId: string | null;
  computedAtMs: number;
  evidenceWindowMs: number;
  status: 'unknown' | 'ordinary';
  reasons: PartnerAffectEstimateReason[];
  families: PartnerAffectFamilyEvidence[];
  /** Every estimate is deterministic and model-free; recorded for audit. */
  derivation: 'deterministic_shadow_v1';
  policyRevision: string;
}

/** Telemetry counters emitted by the shadow ingest bridge. */
export type PartnerAffectShadowTelemetryCounter =
  | 'accepted'
  | 'suppressed'
  | 'duplicate'
  | 'store_error';

export interface PartnerAffectShadowTelemetryEvent {
  counter: PartnerAffectShadowTelemetryCounter;
  reasons: string[];
  eventId?: string;
  sourceId?: string;
  signalFamily?: string;
  timestamp: number;
}

/**
 * Registry entry for one authorized observation source. Consent is
 * source-specific and revocable; revocation stops future acceptance
 * immediately without erasing the audit trail.
 */
export interface PartnerAffectSourceAuthorization {
  sourceId: string;
  families: PartnerAffectSignalFamily[];
  consentRef: string;
  sensitivity: string;
  revoked: boolean;
}

/** Mutable policy for the shadow observation foundation (JSON-owned). */
export interface PartnerAffectShadowPolicy {
  enabled: boolean;
  /** Exact canonical partner contact id; null means unbound (inert). */
  partnerContactId: string | null;
  staleAfterMs: number;
  evidenceWindowMs: number;
  minConfidence: number;
  minIndependentFamilies: number;
  /** Tolerance for equal-metric cross-source disagreement before conflict. */
  conflictValueTolerance: number;
  allowedSignalFamilies: PartnerAffectSignalFamily[];
  /** Per-metric partner-specific direction, keyed `family.metricName`. */
  directions: Record<string, PartnerAffectDirection>;
  sources: PartnerAffectSourceAuthorization[];
  /** Bounded shadow retention; oldest rows beyond the cap are pruned. */
  maxRetainedObservations: number;
  policyRevision: string;
}
