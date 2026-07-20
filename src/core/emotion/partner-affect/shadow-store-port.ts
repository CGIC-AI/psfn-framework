// Persistence port for the Partner Affect shadow observation foundation
// (docs/partner-affect.md, slice 1). Shadow-only: the store is written by the
// shadow ingest bridge and read exclusively by the Garden inspection surface
// and tests. It must never be handed to prompt assembly, emotion appraisal,
// memory candidacy, scheduling, or world-action code.

import type {
  PartnerAffectObservation,
  PartnerAffectSuppressedObservation,
} from '../../../shared/contracts/partner-affect.js';

export interface PartnerAffectObservationRecordResult {
  /** False when the (sourceId, observationId) key already existed. */
  inserted: boolean;
}

export interface PartnerAffectObservationListOptions {
  partnerContactId: string;
  /** Only observations with observedAtMs >= sinceMs. */
  sinceMs?: number;
  limit?: number;
}

export interface PartnerAffectSuppressionListOptions {
  /**
   * When provided, returns only suppression rows evaluated against exactly
   * this bound partner. Scopes the audit so rows from a prior binding or a
   * different partner do not surface. Rows recorded while unbound (null
   * partner) are excluded by a non-null filter.
   */
  partnerContactId?: string;
  limit?: number;
}

export interface PartnerAffectShadowStorePort {
  /**
   * Idempotent insert keyed on (sourceId, observationId). A replayed key is
   * reported (`inserted: false`), never an error — duplicate telemetry is an
   * expected condition, and the first accepted record stays authoritative.
   */
  recordAccepted(
    observation: PartnerAffectObservation,
  ): Promise<PartnerAffectObservationRecordResult>;

  /** Append a structural suppression audit record (no rejected content). */
  recordSuppressed(suppressed: PartnerAffectSuppressedObservation): Promise<void>;

  /** Newest-first accepted observations for exactly one partner contact. */
  listAccepted(
    options: PartnerAffectObservationListOptions,
  ): Promise<PartnerAffectObservation[]>;

  /** Newest-first suppression audit records. */
  listSuppressed(
    options?: PartnerAffectSuppressionListOptions,
  ): Promise<PartnerAffectSuppressedObservation[]>;

  /**
   * Bounded shadow retention: keep at most `maxRetained` rows per table,
   * pruning oldest first. Returns the number of rows removed.
   */
  pruneToRetentionCap(maxRetained: number): Promise<number>;

  close(): Promise<void>;
}
