import type { TurnID } from '../../shared/contracts/runtime.js';

export type IntrospectionTurnSensitivity = 'non_intimate' | 'intimate';

export interface IntrospectionTurnSensitivityDecision {
  sensitivity: IntrospectionTurnSensitivity;
  actor: {
    kind: 'companion';
    turnId: TurnID;
    requestId: string;
  };
}

const MAX_PENDING_DECISIONS = 512;

function decisionKey(turnId: TurnID, requestId: string): string {
  return `${turnId}\0${requestId}`;
}

/**
 * Process-local bridge from the companion's current-turn Orient action to the
 * durable TurnRecord writer. Transport messages cannot populate this bridge.
 */
export class IntrospectionTurnSensitivityDecisions {
  private readonly pending = new Map<string, IntrospectionTurnSensitivityDecision>();

  mark(input: {
    sensitivity: IntrospectionTurnSensitivity;
    turnId: TurnID;
    requestId: string;
  }): IntrospectionTurnSensitivityDecision {
    const requestId = input.requestId.trim();
    if (!input.turnId.trim() || !requestId) {
      throw new Error('Introspection turn sensitivity requires turnId and requestId');
    }
    const key = decisionKey(input.turnId, requestId);
    const existing = this.pending.get(key);
    const sensitivity = existing?.sensitivity === 'intimate' || input.sensitivity === 'intimate'
      ? 'intimate'
      : 'non_intimate';
    if (!existing && this.pending.size >= MAX_PENDING_DECISIONS) {
      throw new Error('Introspection turn sensitivity decision capacity exceeded');
    }
    const decision: IntrospectionTurnSensitivityDecision = {
      sensitivity,
      actor: {
        kind: 'companion',
        turnId: input.turnId,
        requestId,
      },
    };
    this.pending.set(key, decision);
    return decision;
  }

  consume(input: {
    turnId: TurnID;
    requestId: string;
  }): IntrospectionTurnSensitivityDecision | undefined {
    const key = decisionKey(input.turnId, input.requestId.trim());
    const decision = this.pending.get(key);
    if (decision) this.pending.delete(key);
    return decision;
  }
}
