import type { AgentEvent, AgentMessage } from '../../boundary/pi-agent/index.js';
import type { ToolCallOutcome } from '../../shared/contracts/runtime.js';

/** Terminal failure event the scheduled loop pushes before `agent_end` when it throws. */
export type AgentLoopErrorEvent = {
  type: 'agent_error';
  error: Error;
  messages: AgentMessage[];
};

/**
 * Marker pushed once when the loop starts draining queued internal follow-ups;
 * everything after it is internal continuation, never the outward reply
 * (psfn-framework-ay73).
 */
export type UserFacingBoundaryEvent = {
  type: 'user_facing_boundary';
};

export type ToolExecutionEndEvent =
  Extract<AgentEvent, { type: 'tool_execution_end' }>
  & { outcome: ToolCallOutcome };

/** Full event alphabet carried by the scheduled agent loop stream. */
export type ScheduledAgentEvent =
  | Exclude<AgentEvent, { type: 'tool_execution_end' }>
  | ToolExecutionEndEvent
  | AgentLoopErrorEvent
  | UserFacingBoundaryEvent;
