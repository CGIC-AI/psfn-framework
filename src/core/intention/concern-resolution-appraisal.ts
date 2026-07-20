import type { EventBus } from '../../shared/event-bus.js';
import type { ActiveConcern, ActiveConcernVAD } from './concerns.js';

/**
 * Resolution-as-appraisal (vw3w.1).
 *
 * The symmetric counterpart to concern-formation VAD capture. When a concern
 * resolves, the resolving path snapshots the live emotional VAD (resolutionVAD)
 * and persists it alongside the formation snapshot. This module turns that pair
 * into an observable "resolution appraisal" carrying the relief delta
 * (resolutionVad − formationVad).
 *
 * Charter 8.3: resolution is not forced to feel good. The delta preserves its
 * natural sign — relief (valence up), release (arousal down), or anticlimax
 * (valence down / flat) are all captured as-is. Nothing here fabricates a VAD:
 * when either the formation or the resolution snapshot is missing, no appraisal
 * is produced (fail-open on absence, never counterfeit).
 */

export type ConcernResolutionAppraisalSource = 'decision' | 'grooming_stale' | 'grooming_cap';

export interface ConcernResolutionAppraisalEvent {
  concernId: string;
  resolutionGenerationId: string;
  source: ConcernResolutionAppraisalSource;
  formationVad: ActiveConcernVAD;
  resolutionVad: ActiveConcernVAD;
  reliefDelta: ActiveConcernVAD;
  resolvedAt?: string;
  timestamp: number;
}

/** Component-wise resolutionVad − formationVad. Sign is preserved (no clamping). */
export function computeConcernReliefDelta(
  formationVad: ActiveConcernVAD,
  resolutionVad: ActiveConcernVAD,
): ActiveConcernVAD {
  return {
    valence: resolutionVad.valence - formationVad.valence,
    arousal: resolutionVad.arousal - formationVad.arousal,
    dominance: resolutionVad.dominance - formationVad.dominance,
  };
}

/**
 * Build the resolution-appraisal payload for a resolved concern, or null when
 * the arc is incomplete (no formation snapshot, or no resolution snapshot was
 * captured). The resolution VAD is read from the resolved concern itself
 * (persisted by the resolving path) so grooming and decision paths share one
 * code path.
 */
export function buildConcernResolutionAppraisalEvent(input: {
  concern: Pick<ActiveConcern, 'id' | 'formationVAD' | 'resolutionVAD' | 'resolvedAt' | 'resolutionGenerationId'>;
  source: ConcernResolutionAppraisalSource;
  now?: () => number;
}): ConcernResolutionAppraisalEvent | null {
  const { formationVAD, resolutionVAD, resolutionGenerationId } = input.concern;
  if (!formationVAD || !resolutionVAD || !resolutionGenerationId) {
    return null;
  }
  return {
    concernId: input.concern.id,
    resolutionGenerationId,
    source: input.source,
    formationVad: { ...formationVAD },
    resolutionVad: { ...resolutionVAD },
    reliefDelta: computeConcernReliefDelta(formationVAD, resolutionVAD),
    ...(input.concern.resolvedAt ? { resolvedAt: input.concern.resolvedAt } : {}),
    timestamp: (input.now ?? Date.now)(),
  };
}

/**
 * Emit a resolution appraisal for a resolved concern when the full arc is
 * available. No-op when the concern lacks either VAD snapshot or when no event
 * bus is wired. Never throws for a missing arc — resolution persistence is the
 * source of truth and must not be blocked by appraisal emission.
 */
export async function emitConcernResolutionAppraisal(
  eventBus: EventBus | null | undefined,
  input: {
    concern: Pick<ActiveConcern, 'id' | 'formationVAD' | 'resolutionVAD' | 'resolvedAt' | 'resolutionGenerationId'>;
    source: ConcernResolutionAppraisalSource;
    now?: () => number;
  },
): Promise<boolean> {
  if (!eventBus) {
    return false;
  }
  const event = buildConcernResolutionAppraisalEvent(input);
  if (!event) {
    return false;
  }
  await eventBus.emitRequired('intention.concern.resolution_appraisal', event);
  return true;
}
