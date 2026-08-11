import {
  validateAutomataBusHistory,
  type AutomataBusEvent,
  type AutomataBusEventContext,
  type AutomataBusFindingBody,
  type AutomataBusRelationKind,
} from './contract.js';

export interface AutomataBusEffectiveFinding {
  eventId: string;
  companionId: string;
  sequence: number;
  occurredAt: string;
  context: AutomataBusEventContext;
  body: AutomataBusFindingBody;
  sourceEventType: 'finding' | 'relation';
}

export interface AutomataBusDisposition {
  targetEventId: string;
  relation: AutomataBusRelationKind;
  byEventId: string;
}

export interface AutomataBusCurrentState {
  history: AutomataBusEvent[];
  effectiveFindings: AutomataBusEffectiveFinding[];
  dispositions: AutomataBusDisposition[];
}

function invalidHistoryMessage(result: Exclude<ReturnType<typeof validateAutomataBusHistory>, { status: 'accepted' }>): string {
  return `cannot reduce Automata Bus history (${result.status}): ${result.issues.join('; ')}`;
}

/**
 * Production projection: update current state in event order while preserving the
 * immutable event history and an explicit disposition for each departed claim.
 */
export function projectAutomataBusCurrentState(
  inputs: readonly unknown[],
): AutomataBusCurrentState {
  const validated = validateAutomataBusHistory(inputs);
  if (validated.status !== 'accepted') throw new Error(invalidHistoryMessage(validated));

  const effective = new Map<string, AutomataBusEffectiveFinding>();
  const dispositions: AutomataBusDisposition[] = [];
  for (const event of validated.value) {
    if (event.type === 'finding') {
      effective.set(event.eventId, {
        eventId: event.eventId,
        companionId: event.companionId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        context: event.context,
        body: event.body,
        sourceEventType: 'finding',
      });
      continue;
    }
    effective.delete(event.body.targetEventId);
    dispositions.push({
      targetEventId: event.body.targetEventId,
      relation: event.body.relation,
      byEventId: event.eventId,
    });
    if (event.body.relation !== 'retracts' && event.body.replacement !== undefined) {
      effective.set(event.eventId, {
        eventId: event.eventId,
        companionId: event.companionId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        context: event.context,
        body: event.body.replacement,
        sourceEventType: 'relation',
      });
    }
  }

  return {
    history: [...validated.value],
    effectiveFindings: [...effective.values()].sort((left, right) => left.sequence - right.sequence),
    dispositions,
  };
}
