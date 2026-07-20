import type { EmotionTelemetryProvenance } from './emotion-contracts.js';

/**
 * Companion-readable ADVISORY reading of the emo_sim affect model's directed
 * A->B relationship state (liking / trust / dominance / familiarity, and any
 * emotion deltas), rendered as prose per charter 8.6 (no score walls).
 *
 * This is classifier-adjacent inference, NOT self-report: the emo_sim engine
 * accumulates affect from projected conversation appraisal. The `provenance`
 * therefore carries `source: 'classifier_inferred'` (twa0 emotion-telemetry
 * contract). It is one more signal the companion weighs in her end-of-day
 * relationship/trust analysis — never an automatic promoter or demoter, and it
 * mutates no relationship or trust state.
 */
export interface DyadRelationshipAdvisory {
  /** Charter 8.6 companion-readable prose. Never raw scores. */
  prose: string;
  /** Twa0 provenance; source is always the classifier-inferred category. */
  provenance: EmotionTelemetryProvenance;
  /** When the underlying observation was captured, if known. */
  observedAtMs: number | null;
}

/**
 * Read-only advisory surface over the emo_sim affect model's latest directed
 * relationship reading.
 *
 * Contract for the two failure layers (repo working rules):
 * - Fail SOFT (omit) when there is simply no data: returns `null`. Callers
 *   (companion context) drop the signal rather than fabricating a neutral one
 *   (charter 8.5 no fake healthy state).
 * - Fail CLOSED at the infrastructure boundary: a store/read failure is logged
 *   and thrown as {@link DyadRelationshipAdvisoryUnavailableError}, never
 *   silently swallowed. The companion-context caller catches it, logs the
 *   omission, and continues without the signal.
 */
export interface DyadRelationshipAdvisoryProvider {
  describeLatestDirectedRelationship(): Promise<DyadRelationshipAdvisory | null>;
}

/**
 * Infrastructure-layer failure reading the advisory. Surfaced (not swallowed)
 * so a degraded read is always visible in logs; companion-context callers
 * treat it as an omission.
 */
export class DyadRelationshipAdvisoryUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'DyadRelationshipAdvisoryUnavailableError';
  }
}
