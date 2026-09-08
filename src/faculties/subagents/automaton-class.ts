import type { ProductionAutomataClassId } from '../automata/registry-contract.js';
import type { SubagentExecutionSourceContext } from './types.js';

/** The production automata class an ordinary tool-requested bounded subagent run belongs to. */
export const SUBAGENT_AUTOMATON_CLASS: ProductionAutomataClassId = 'subagent.bounded';

/**
 * The class a bounded subagent run belongs to when a post-turn action spawned
 * it. Same faculty, same governed lifecycle; the distinct class is what makes
 * post-turn-originated work separable in policy, retention, and Bus history
 * instead of silently accounted as ordinary tool-requested work.
 */
export const POST_TURN_SUBAGENT_SPAWN_AUTOMATON_CLASS: ProductionAutomataClassId =
  'post_turn.subagent_spawn';

/** Every class whose durable runs this faculty owns and rehydrates. */
export const SUBAGENT_AUTOMATON_CLASSES: readonly ProductionAutomataClassId[] = [
  SUBAGENT_AUTOMATON_CLASS,
  POST_TURN_SUBAGENT_SPAWN_AUTOMATON_CLASS,
];

/**
 * Resolve the run's class from its trusted runtime spawn origin. The origin is
 * runtime-supplied, never model-supplied, so a worker cannot elect its own
 * class, policy, or retention.
 */
export function resolveSubagentAutomatonClass(
  sourceContext: Pick<SubagentExecutionSourceContext, 'spawnOrigin'> | undefined,
): ProductionAutomataClassId {
  return sourceContext?.spawnOrigin === 'post_turn'
    ? POST_TURN_SUBAGENT_SPAWN_AUTOMATON_CLASS
    : SUBAGENT_AUTOMATON_CLASS;
}
