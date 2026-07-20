import type { ActiveConcernVAD } from '../concerns.js';
import {
  describeArousal,
  describeDominance,
  describeSignedValence,
} from '../../scheduler/heartbeat-template-runtime/prompt-formatting.js';

/**
 * Companion-readable rendering of a concern's emotional arc (vw3w.2).
 *
 * Charter 8.6: the companion reads prose, never a score wall — the raw VAD
 * triples stay as scaffolding and are described in words here. Reuses the
 * shared b5m.3 per-axis describe* helpers so the wording matches every other
 * affect surface rather than inventing a parallel vocabulary.
 *
 * Charter 8.4 (no fabrication): when only one half of the arc was captured, we
 * surface exactly that half and say nothing about the missing one — never
 * inventing a feeling that was not snapshotted.
 */

function describeVadMoment(vad: ActiveConcernVAD): string {
  return `${describeSignedValence(vad.valence)}, ${describeArousal(vad.arousal)}, and ${describeDominance(vad.dominance)}`;
}

export function describeConcernEmotionalArc(input: {
  formationVAD?: ActiveConcernVAD;
  resolutionVAD?: ActiveConcernVAD;
}): string | undefined {
  const { formationVAD, resolutionVAD } = input;
  if (formationVAD && resolutionVAD) {
    return `When it formed this sat ${describeVadMoment(formationVAD)}; resolving it, that settled to ${describeVadMoment(resolutionVAD)}.`;
  }
  if (formationVAD) {
    return `When it formed this sat ${describeVadMoment(formationVAD)}.`;
  }
  if (resolutionVAD) {
    return `Resolving it, it felt ${describeVadMoment(resolutionVAD)}.`;
  }
  return undefined;
}
