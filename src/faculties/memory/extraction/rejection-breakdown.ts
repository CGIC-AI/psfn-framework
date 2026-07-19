import type { ExtractionRejectionReason } from './types.js';

export function createEmptyRejectionBreakdown(): Record<ExtractionRejectionReason, number> {
  return {
    low_importance: 0,
    low_confidence: 0,
    low_novelty: 0,
    low_signal: 0,
    cogsec_risk: 0,
    ambiguous_speaker: 0,
    write_cap: 0,
  };
}
