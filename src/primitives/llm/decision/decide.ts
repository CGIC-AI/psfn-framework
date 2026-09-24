// decide(): the single typed-decision entry (epic psfn-framework-4lf3r).
//
// Every decision site calls `DecisionRuntime.decide` with a stable site id, a
// JSON state and typed questions. The runtime chooses the backend. A site that
// already had a model call before this primitive existed passes that exact call
// as its `localStrategy`, so the local path stays byte-identical to the
// pre-migration behaviour; new sites use the generic local backend.

import type { LocalDecisionBackend } from './local-backend.js';
import type { DecisionOutcome, DecisionRequest } from './types.js';

interface DecideOptions {
  /**
   * The site's own local implementation. When present it replaces the generic
   * local backend, so a migrated site's local behaviour is unchanged.
   */
  localStrategy?: () => Promise<DecisionOutcome>;
}

export interface DecisionRuntime {
  decide(request: DecisionRequest, options?: DecideOptions): Promise<DecisionOutcome>;
}

export interface DecisionRuntimeOptions {
  local: LocalDecisionBackend;
}

export function createDecisionRuntime(options: DecisionRuntimeOptions): DecisionRuntime {
  return {
    async decide(request, decideOptions) {
      if (decideOptions?.localStrategy) return await decideOptions.localStrategy();
      return await options.local.decide(request);
    },
  };
}
