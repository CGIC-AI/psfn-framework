// ── Durable operator visibility for intake sink-gate blocks (hrmrq.77) ──
//
// Sink-gate warnings are useful runtime diagnostics, but they are not an
// operator work surface. Hard lethal-trifecta blocks are therefore mirrored
// into the canonical CogSec event store that Garden already reads. The event
// contains only structural routing facts and fixed safe text; envelope ids,
// tool arguments, and content never cross this seam.

import type { CogSecEventStore } from '../events.js';
import type {
  BlockedEgressTrifectaContext,
  BlockedEgressTrifectaIncident,
} from './sink-gates.js';

export interface IntakeSinkGateIncidentRecorderDeps {
  /** Narrow provider keeps persistence construction outside the CogSec decision layer. */
  cogSecEvents: () => Pick<CogSecEventStore, 'createEvent'>;
}

function requireContextString(
  context: BlockedEgressTrifectaContext,
  field: 'sourceChannelId' | 'logicalSessionId',
): string {
  const value = context[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Hard egress-trifecta audit is missing ${field}`);
  }
  return value.trim();
}

/**
 * Convert a blocked hard-enforcement trifecta decision into one durable,
 * operator-visible CogSec case per attempted egress. Non-blocking reviews and
 * unrelated sink decisions retain their existing audit behavior.
 */
export function createIntakeSinkGateIncidentRecorder(
  deps: IntakeSinkGateIncidentRecorderDeps,
): (incident: BlockedEgressTrifectaIncident) => void {
  return ({ assessment, context }): void => {
    if (
      assessment.verdict !== 'deny'
      || assessment.allowed
      || !assessment.triggered
      || assessment.enforcement !== 'hard'
    ) {
      return;
    }

    const sourceChannelId = requireContextString(context, 'sourceChannelId');
    const logicalSessionId = requireContextString(context, 'logicalSessionId');
    deps.cogSecEvents().createEvent({
      type: 'intake_firewall',
      severity: 'critical',
      status: 'applied',
      sourceChannelId,
      affectedLogicalSessionIds: [logicalSessionId],
      actor: 'system:intake-sink-gate',
      safeAgentSummary: 'The intake firewall blocked an outbound tool action because external content and private context met in the same path. Operator review recommended.',
    });
  };
}
