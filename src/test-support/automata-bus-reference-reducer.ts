import {
  validateAutomataBusHistory,
  type AutomataBusRelationEvent,
} from '../faculties/automata/bus/contract.js';
import type {
  AutomataBusCurrentState,
  AutomataBusDisposition,
  AutomataBusEffectiveFinding,
} from '../faculties/automata/bus/current-state.js';

/**
 * Deliberately independent conformance reducer. Unlike the production reducer's
 * incremental map, this implementation builds a target-to-successor graph and
 * walks every original finding to its terminal lineage node.
 */
export function projectAutomataBusReferenceState(
  inputs: readonly unknown[],
): AutomataBusCurrentState {
  const validated = validateAutomataBusHistory(inputs);
  if (validated.status !== 'accepted') {
    throw new Error(`cannot reference-reduce Automata Bus history: ${validated.issues.join('; ')}`);
  }

  const successorByTarget = new Map<string, AutomataBusRelationEvent>();
  const dispositions: AutomataBusDisposition[] = [];
  for (const event of validated.value) {
    if (event.type !== 'relation') continue;
    successorByTarget.set(event.body.targetEventId, event);
    dispositions.push({
      targetEventId: event.body.targetEventId,
      relation: event.body.relation,
      byEventId: event.eventId,
    });
  }

  const effectiveFindings: AutomataBusEffectiveFinding[] = [];
  for (const root of validated.value) {
    if (root.type !== 'finding') continue;
    let current: AutomataBusEffectiveFinding | undefined = {
      eventId: root.eventId,
      companionId: root.companionId,
      sequence: root.sequence,
      occurredAt: root.occurredAt,
      context: root.context,
      body: root.body,
      sourceEventType: 'finding',
    };
    let successor = successorByTarget.get(root.eventId);
    while (successor !== undefined) {
      if (successor.body.relation === 'retracts') {
        current = undefined;
        break;
      }
      const replacement = successor.body.replacement;
      if (replacement === undefined) {
        throw new Error(`validated relation ${successor.eventId} is missing its replacement`);
      }
      current = {
        eventId: successor.eventId,
        companionId: successor.companionId,
        sequence: successor.sequence,
        occurredAt: successor.occurredAt,
        context: successor.context,
        body: replacement,
        sourceEventType: 'relation',
      };
      successor = successorByTarget.get(successor.eventId);
    }
    if (current !== undefined) effectiveFindings.push(current);
  }

  effectiveFindings.sort((left, right) => left.sequence - right.sequence);
  return { history: [...validated.value], effectiveFindings, dispositions };
}
