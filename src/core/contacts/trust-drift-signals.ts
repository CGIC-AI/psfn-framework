import {
  evaluateLowTierTrustDriftSuggestion,
  type LowTierTrustDriftSuggestion,
  type TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import { isHighTierTrustLevel, type TrustLevel } from '../../system/trust/types.js';
import type { Contact } from './types.js';
import type { EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';

type Awaitable<T> = T | Promise<T>;

// ── Deterministic trust-drift behavior signals (bead kada.2) ──
//
// The low-tier drift evaluator (system/trust/policy.ts) consumes
// TrustDriftBehaviorSignals, but until this module nothing in the runtime ever
// COMPUTED them — they only existed when the agent hand-filled a tool call.
// This module derives them deterministically from evidence the runtime already
// records per contact:
//
//  - the per-contact emotional valence time series, fed by memory extraction
//    (faculties/memory/extraction/emotional.ts → updateEmotionalBaseline);
//  - verified identity-link challenges (contact_identity_link_verifications).
//
// Charter constraints (mirrors participant-trends): pure arithmetic, zero LLM
// calls, and conservative by construction — ambiguous evidence must produce
// signals that do NOT clear the promotion thresholds. Nothing in this module
// mutates trust; consumers surface suggestions for the companion to decide on.

/** A time-series point must be at least this positive to count as a positive interaction. */
export const POSITIVE_INTERACTION_VALENCE_MIN = 0.15;
/** A time-series point at or below this counts as a negative interaction. */
export const NEGATIVE_INTERACTION_VALENCE_MAX = -0.15;
/** Any point at or below this valence is treated as a boundary breach. */
export const BOUNDARY_BREACH_VALENCE_MAX = -0.4;
/** Points below this classifier confidence are too uncertain to count either way. */
export const SIGNAL_CONFIDENCE_MIN = 0.35;

export interface ContactTrustDriftEvidence {
  timeSeries: readonly EmotionalTimeSeriesPoint[];
  verifiedIdentityLinkCount: number;
}

export function deriveTrustDriftBehaviorSignals(
  evidence: ContactTrustDriftEvidence,
): TrustDriftBehaviorSignals {
  let positive = 0;
  let negative = 0;
  let boundaryBreaches = 0;
  for (const point of evidence.timeSeries) {
    if (!Number.isFinite(point.valence) || !Number.isFinite(point.confidence)) continue;
    if (point.confidence < SIGNAL_CONFIDENCE_MIN) continue;
    if (point.valence >= POSITIVE_INTERACTION_VALENCE_MIN) positive += 1;
    if (point.valence <= NEGATIVE_INTERACTION_VALENCE_MAX) negative += 1;
    if (point.valence <= BOUNDARY_BREACH_VALENCE_MAX) boundaryBreaches += 1;
  }
  const verifiedIdentityLinks = Number.isFinite(evidence.verifiedIdentityLinkCount)
    ? Math.max(0, Math.floor(evidence.verifiedIdentityLinkCount))
    : 0;
  return {
    positiveInteractionCount: positive,
    negativeInteractionCount: negative,
    verifiedIdentityLinks,
    // Boundary respect is only assertable from evidence we have; a breach-level
    // valence point falsifies it. No evidence at all leaves it true because the
    // promotion path still requires 3+ positives, so an evidence-free contact
    // cannot clear the threshold anyway.
    consistentBoundaryRespect: boundaryBreaches === 0,
  };
}

// ── Relationship progression score (consumed by Garden contacts page, kada.4) ──

/** Trust ladder positions used for score normalization. */
const TRUST_TIER_ORDER: Record<TrustLevel, number> = {
  public: 0,
  regular: 1,
  trusted: 2,
  primary: 3,
};

export interface ContactRelationshipScore {
  score: number;
  resolvedTier: string;
  nextTier?: string;
  progressToNextTier?: number;
  updatedAt?: string;
}

/**
 * Progress toward the next tier is only defined for `public` contacts: the
 * public→regular drift is the sole promotion the runtime can evaluate
 * autonomously. `regular` contacts report the `trusted` next tier without a
 * progress value because that promotion is a human decision (approval queue),
 * not a threshold — showing a bar for it would misstate who decides.
 */
export function computeContactRelationshipScore(input: {
  trustLevel: TrustLevel;
  signals: TrustDriftBehaviorSignals;
  updatedAt?: string;
}): ContactRelationshipScore {
  const tierOrder = TRUST_TIER_ORDER[input.trustLevel];
  const base: ContactRelationshipScore = {
    score: tierOrder / 3,
    resolvedTier: input.trustLevel,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
  };
  if (isHighTierTrustLevel(input.trustLevel)) {
    return base;
  }
  if (input.trustLevel === 'regular') {
    return { ...base, nextTier: 'trusted' };
  }
  // public → regular: average of the drift evaluator's threshold components
  // (policy.ts evaluateLowTierTrustDriftSuggestion), each clamped to [0,1].
  const positives = Math.max(0, input.signals.positiveInteractionCount);
  const negatives = Math.max(0, input.signals.negativeInteractionCount ?? 0);
  const verified = Math.max(0, input.signals.verifiedIdentityLinks ?? 0);
  const components = [
    Math.min(1, positives / 3),
    negatives === 0 ? 1 : 0,
    Math.min(1, verified),
    input.signals.consistentBoundaryRespect !== false ? 1 : 0,
  ];
  const progress = components.reduce((sum, value) => sum + value, 0) / components.length;
  const progressToNextTier = Math.round(progress * 100) / 100;
  return {
    ...base,
    score: Math.round(((tierOrder + progressToNextTier) / 3) * 100) / 100,
    nextTier: 'regular',
    progressToNextTier,
  };
}

// ── Reader for admin surfaces ──

export type ContactRelationshipScoreReaderStore = {
  getById(id: string): Awaitable<Contact | undefined>;
  getEmotionalTimeSeries(id: string, limit?: number): Awaitable<EmotionalTimeSeriesPoint[]>;
  countVerifiedIdentityLinks(contactId: string): Awaitable<number>;
};

export interface ContactRelationshipScoreReader {
  listContactRelationshipScores(
    contactIds: readonly string[],
  ): Promise<Map<string, ContactRelationshipScore>>;
}

const SCORE_TIME_SERIES_LIMIT = 64;

export function createContactRelationshipScoreReader(
  contactStore: ContactRelationshipScoreReaderStore,
): ContactRelationshipScoreReader {
  return {
    async listContactRelationshipScores(contactIds) {
      const scores = new Map<string, ContactRelationshipScore>();
      for (const contactId of contactIds) {
        const contact = await contactStore.getById(contactId);
        if (!contact) continue;
        const timeSeries = await contactStore.getEmotionalTimeSeries(contactId, SCORE_TIME_SERIES_LIMIT);
        const verifiedIdentityLinkCount = await contactStore.countVerifiedIdentityLinks(contactId);
        const signals = deriveTrustDriftBehaviorSignals({ timeSeries, verifiedIdentityLinkCount });
        scores.set(contactId, computeContactRelationshipScore({
          trustLevel: contact.trustLevel,
          signals,
          updatedAt: contact.lastSeen,
        }));
      }
      return scores;
    },
  };
}

// ── Drift review candidates (consumed by the nightly review lane) ──

export interface ContactTrustDriftReviewCandidate {
  contactId: string;
  displayName: string;
  trustLevel: TrustLevel;
  signals: TrustDriftBehaviorSignals;
  suggestion: LowTierTrustDriftSuggestion;
}

export function evaluateContactTrustDriftCandidate(input: {
  contact: Pick<Contact, 'id' | 'displayName' | 'trustLevel'>;
  evidence: ContactTrustDriftEvidence;
}): ContactTrustDriftReviewCandidate | null {
  if (isHighTierTrustLevel(input.contact.trustLevel)) return null;
  const signals = deriveTrustDriftBehaviorSignals(input.evidence);
  const suggestion = evaluateLowTierTrustDriftSuggestion(input.contact.trustLevel, signals);
  if (!suggestion) return null;
  return {
    contactId: input.contact.id,
    displayName: input.contact.displayName,
    trustLevel: input.contact.trustLevel,
    signals,
    suggestion,
  };
}
