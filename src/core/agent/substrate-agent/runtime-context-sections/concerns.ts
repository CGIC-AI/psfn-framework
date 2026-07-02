// ── Active-concerns section producer (E2.6) ──
// Concern data flows as structured ActiveConcernRuntimeData (E2.5): no more
// formatting a prose block in code and re-parsing it back into variables. The
// open-threads framing sentence lives in the runtime.attention prompt layer.

import {
  buildActiveConcernsPromptVariables,
  type ActiveConcernRuntimeData,
} from '../../../intention/concerns.js';

export function buildConcernPromptVariables(
  activeConcerns: ActiveConcernRuntimeData | null | undefined,
): Record<string, string> {
  if (!activeConcerns || activeConcerns.totalCount === 0) {
    return {
      runtime_concerns_count: '0',
      runtime_concerns_top_lines: '',
      runtime_concerns_top_priorities: '',
      runtime_concerns_omitted_count: '0',
      runtime_concerns_omitted_plural_suffix: 's',
    };
  }
  return buildActiveConcernsPromptVariables(activeConcerns);
}
