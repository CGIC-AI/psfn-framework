import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import {
  createIcpAutonomyCandidateSchedulerMessage,
  type IcpAutonomyCandidateDispatchBinding,
} from '../../core/icp/candidate-scheduler-origin.js';

export interface IcpAutonomyCandidateDispatcher {
  dispatch(input: IcpAutonomyCandidateDispatchBinding): Promise<AgentResponse>;
}

interface IcpAutonomyCandidateAgentLoop {
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
}

/**
 * Registered production ingress for the W5-owned private candidate selector.
 * This seam owns no selection policy: it revalidates one selected candidate's
 * current broker permit, builds the canonical private turn, and runs it through
 * the ordinary agent/tool/post-turn pipeline.
 */
export function createIcpAutonomyCandidateDispatcher(input: {
  agentLoop: IcpAutonomyCandidateAgentLoop;
  now?: () => Date;
}): IcpAutonomyCandidateDispatcher {
  return {
    async dispatch(binding) {
      const timestamp = input.now?.() ?? new Date();
      const message = createIcpAutonomyCandidateSchedulerMessage(binding, timestamp);
      return await input.agentLoop.handleMessage(message);
    },
  };
}
