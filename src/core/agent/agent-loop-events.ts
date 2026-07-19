import type { AgentEvent, AgentMessage } from '../../boundary/pi-agent/index.js';

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

/** Full event alphabet carried by the scheduled agent loop stream. */
export type ScheduledAgentEvent = AgentEvent | AgentLoopErrorEvent | UserFacingBoundaryEvent;
