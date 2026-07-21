import { reconcileConcernResolutionArcs } from '../../core/intention/concern-resolution-arc.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('ConcernResolutionArcStartup');

type ConcernResolutionArcReconciliationInput = Parameters<
  typeof reconcileConcernResolutionArcs
>[0];

export type ConcernResolutionArcStartupInput = ConcernResolutionArcReconciliationInput & {
  logger?: Pick<typeof log, 'error'>;
};

/** Keep derivative concern-arc repair failures visible without blocking startup. */
export async function reconcileConcernResolutionArcsAtStartup(
  input: ConcernResolutionArcStartupInput,
): Promise<void> {
  const { logger = log, ...reconciliationInput } = input;
  try {
    await reconcileConcernResolutionArcs(reconciliationInput);
  } catch (error) {
    logger.error('Concern resolution arc startup reconciliation failed; continuing startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
