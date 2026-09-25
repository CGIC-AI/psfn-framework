// Decision pre-gates (epic 4lf3r): one cheap typed question that may let a
// caller SKIP a heavy background call. Default off: a pre-gate runs only when
// its site is enabled with a threshold in settings.json decisionBackend, and it
// may skip work only when the "nothing to do" probability clears that
// threshold. Any failure, missing answer or disabled site runs the work as
// before. Callers must never gate crash-recovery or pre-compaction work.

import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';
import type { DecisionRuntime } from './decide.js';
import type { DecisionQuestion, DecisionRequest } from './types.js';

type PreGateDecisions = Pick<DecisionRuntime, 'decide' | 'siteSettings'>;

export interface DecisionPreGateVerdict {
  skip: boolean;
  /** Probability of "nothing to do", when a decision was made. */
  pNothing?: number;
}

export async function runDecisionPreGate(input: {
  decisions: PreGateDecisions | undefined;
  siteId: DecisionSiteId;
  state: DecisionRequest['state'];
  /** A noul question whose YES means "there is nothing worth doing". */
  nothingToDo: DecisionQuestion & { type: 'noul' };
  workSpec: DecisionRequest['workSpec'];
}): Promise<DecisionPreGateVerdict> {
  const site = input.decisions?.siteSettings(input.siteId);
  if (!input.decisions || site?.enabled !== true || site.threshold === undefined) return { skip: false };
  let outcome;
  try {
    outcome = await input.decisions.decide({
      siteId: input.siteId,
      state: input.state,
      questions: { nothing_to_do: input.nothingToDo },
      workSpec: input.workSpec,
    });
  } catch {
    // A failed pre-gate never skips work.
    return { skip: false };
  }
  const answer = outcome.ok ? outcome.answers.nothing_to_do : undefined;
  if (answer?.type !== 'noul') return { skip: false };
  return { skip: answer.pYes >= site.threshold, pNothing: answer.pYes };
}
