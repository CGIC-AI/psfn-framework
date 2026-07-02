// ── Continuity-gap section producer (E2.6) ──
// Bare continuity-gap values (E2.5 purity rule): gap duration and offline
// timestamp are data; the notice wording lives in the editable
// runtime.continuity_notice prompt layer.

import type { InternalStateContinuityGap } from '../../../self-model/internal-state-persistence.js';

function formatGapDuration(gapMs: number): string {
  const hours = gapMs / (60 * 60 * 1000);
  if (hours < 48) {
    return `${String(Math.round(hours))} hours`;
  }
  return `${String(Math.round(hours / 24))} days`;
}

export function buildContinuityGapPromptVariables(
  gap: InternalStateContinuityGap | null | undefined,
): Record<string, string> {
  if (!gap) {
    return {
      runtime_continuity_gap_present: 'false',
      runtime_continuity_gap_duration: '',
      runtime_continuity_gap_offline_since: '',
    };
  }
  return {
    runtime_continuity_gap_present: 'true',
    runtime_continuity_gap_duration: formatGapDuration(gap.gapMs),
    runtime_continuity_gap_offline_since: gap.offlineSince,
  };
}
