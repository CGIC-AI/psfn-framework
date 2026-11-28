// Decision pre-gates (epic 4lf3r): one cheap typed question that may let a
// caller SKIP a heavy background call. Default off: a pre-gate runs only when
// its site is enabled with a threshold in settings.json decisionBackend, and it
// may skip work only when the "nothing to do" probability clears that
// threshold. Any failure, missing answer or disabled site runs the work as
// before. Callers must never gate crash-recovery or pre-compaction work.

import { createComponentLogger } from '../../../shared/logger.js';
import type { DecisionSiteId } from '../../../system/config/decision-backend-config.js';
import type { DecisionRuntime } from './decide.js';
import type { DecisionQuestion, DecisionRequest } from './types.js';

type PreGateDecisions = Pick<DecisionRuntime, 'decide' | 'siteSettings'>;

const log = createComponentLogger('decision-pregate');

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
  const channelId = input.workSpec.correlation?.channelId;
  let outcome;
  try {
    outcome = await input.decisions.decide({
      siteId: input.siteId,
      state: input.state,
      questions: { nothing_to_do: input.nothingToDo },
      workSpec: input.workSpec,
    });
  } catch (error) {
    // A failed pre-gate never skips work, and the failure is reported.
    log.warn('Decision pre-gate failed; running the gated work', {
      siteId: input.siteId,
      ...(channelId ? { channelId } : {}),
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { skip: false };
  }
  const answer = outcome.ok ? outcome.answers.nothing_to_do : undefined;
  if (answer?.type !== 'noul') {
    log.warn('Decision pre-gate returned no usable answer; running the gated work', {
      siteId: input.siteId,
      ...(channelId ? { channelId } : {}),
      backend: outcome.backend,
      ...(outcome.ok ? {} : { reason: outcome.reason }),
    });
    return { skip: false };
  }
  const skip = answer.pYes >= site.threshold;
  if (skip) {
    // INFO, content-free: a skipped extraction or appraisal must be visible.
    log.info('Decision pre-gate skipped the gated work', {
      siteId: input.siteId,
      ...(channelId ? { channelId } : {}),
      pNothing: answer.pYes,
      threshold: site.threshold,
      backend: outcome.backend,
    });
  }
  return { skip, pNothing: answer.pYes };
}
