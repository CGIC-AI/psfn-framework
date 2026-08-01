import { isAgentProcessingPromptError } from '../../system/lifecycle/turn-contention.js';

export type PostTurnActionContentionKind = 'model_call_preempted' | 'agent_busy';

/** Classifies only runtime contention that is safe to reschedule without consuming an attempt. */
export function classifyPostTurnActionContention(
  error: unknown,
): PostTurnActionContentionKind | null {
  if (error instanceof Error && error.name === 'ModelCallPreemptedError') {
    return 'model_call_preempted';
  }
  return isAgentProcessingPromptError(error) ? 'agent_busy' : null;
}
