import type { ProductionAutomataClassId } from '../registry-contract.js';
import {
  AUTOMATA_BUS_TOOL_ACTIONS,
  type AutomataBusToolAction,
} from './worker-access-contracts.js';

/**
 * Why a Bus-eligible class opens a governed run but never reads or writes Bus
 * notes from inside its work.
 *
 * - `companion_identity_turn`: the work is the companion itself thinking or
 *   acting (reflection, free time, long-horizon shards, sleeptime
 *   consolidation). Worker notes must not steer or enter a companion-identity
 *   prompt stack.
 * - `person_data_boundary`: the work reads or decides over person, biography,
 *   or concern material. The Bus carries process findings and never people, so
 *   the work is kept out of it entirely rather than trusted to filter.
 * - `no_worker_model_loop`: the work is deterministic, heuristic, or a strict
 *   structured-schema model call with no free-form worker turn that could read
 *   a briefing or call the tool.
 */
type AutomataClassBusExclusion =
  | 'companion_identity_turn'
  | 'person_data_boundary'
  | 'no_worker_model_loop';

/**
 * How a governed class uses the Bus once its run is open.
 *
 * `single_pass` classes leave the deterministic terminal handoff the wrapper
 * records for them and nothing else: no spawn briefing is queried and no tool
 * is formed (`formation: 'handoff_only'`). Each one names its explicit owner
 * exclusion and rationale, so the omission is policy rather than a wiring gap.
 * `bounded_loop` classes read their prior run notes from the spawn briefing
 * and carry the governed `automata_bus` tool, restricted to `allowedActions`,
 * into their own already-bounded agent turns. Neither mode owns a turn or
 * briefing budget: briefing size is `automata-policy.json > bus.query`, and
 * each class's existing worker logic still bounds its own model calls.
 */
interface AutomataClassAdapterBase {
  automatonClass: ProductionAutomataClassId;
  /** Module that opens this class's governed Bus run. */
  adapterModule: string;
}

interface AutomataBoundedLoopClassAdapter extends AutomataClassAdapterBase {
  busMode: 'bounded_loop';
  /** Tool actions the class's worker may call; the runtime enforces the same set. */
  allowedActions: readonly AutomataBusToolAction[];
}

interface AutomataSinglePassClassAdapter extends AutomataClassAdapterBase {
  busMode: 'single_pass';
  exclusion: AutomataClassBusExclusion;
  exclusionRationale: string;
}

/**
 * The runtime adapter that opens one eligible class's governed run.
 *
 * Registration alone is not coverage: `automata-certification` proves that the
 * named module exists and actually opens the governed lifecycle, so an eligible
 * class can never claim Bus participation it has no code path for.
 */
export type AutomataClassGovernedAdapter =
  | AutomataBoundedLoopClassAdapter
  | AutomataSinglePassClassAdapter;

export const AUTOMATA_CLASS_GOVERNED_ADAPTERS = [
  {
    automatonClass: 'subagent.bounded',
    adapterModule: 'src/faculties/subagents/faculty.ts',
    busMode: 'bounded_loop',
    allowedActions: AUTOMATA_BUS_TOOL_ACTIONS,
  },
  {
    // Same faculty and same governed lifecycle as an ordinary bounded subagent;
    // the trusted post-turn spawn origin selects this class instead.
    automatonClass: 'post_turn.subagent_spawn',
    adapterModule: 'src/faculties/subagents/faculty.ts',
    busMode: 'bounded_loop',
    allowedActions: AUTOMATA_BUS_TOOL_ACTIONS,
  },
  {
    // Read-only: Bus writes during extraction are runtime-owned so no person
    // fact or transcript-derived evidence can be sent through the tool.
    automatonClass: 'memory.extraction',
    adapterModule: 'src/faculties/memory/extraction/orchestrator.ts',
    busMode: 'bounded_loop',
    allowedActions: ['brief', 'search', 'runs', 'inspect'],
  },
  {
    automatonClass: 'shard.long_horizon',
    adapterModule: 'src/faculties/shards/manager.ts',
    busMode: 'single_pass',
    exclusion: 'companion_identity_turn',
    exclusionRationale:
      'A shard runs its own companion-identity prompt stack, tools, and turn budget; '
      + 'worker notes must not steer that identity, so only counts reach the handoff.',
  },
  {
    automatonClass: 'memory.sleeptime',
    adapterModule: 'src/core/scheduler/post-turn-runtime/scheduler-lanes.ts',
    busMode: 'single_pass',
    exclusion: 'companion_identity_turn',
    exclusionRationale:
      'Sleeptime is the companion consolidating its own memory under the fleet baton; '
      + 'its inputs are companion memory, which the Bus must never carry or influence.',
  },
  {
    automatonClass: 'memory.social_graph_builder',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
    exclusion: 'no_worker_model_loop',
    exclusionRationale:
      'A heuristic co-presence scan with no worker model turn; it also reads contact '
      + 'evidence, so only scan counts reach the handoff.',
  },
  {
    automatonClass: 'intention.concern_candidate_review',
    adapterModule: 'src/core/intention/concern-candidates.ts',
    busMode: 'single_pass',
    exclusion: 'person_data_boundary',
    exclusionRationale:
      'Reviews concern candidates about people through a structured decision call; '
      + 'candidate text and contact identity must stay out of the Bus.',
  },
  {
    automatonClass: 'background.intention_post_turn_hooks',
    adapterModule: 'src/app/agent/automata-background-work-lifecycle.ts',
    busMode: 'single_pass',
    exclusion: 'person_data_boundary',
    exclusionRationale:
      'Rehydrates the finished foreground turn, including the Partner message, for '
      + 'intention hooks; transcript content must never reach the Bus.',
  },
  {
    automatonClass: 'scheduler.reflection',
    adapterModule: 'src/core/scheduler/post-turn-runtime.ts',
    busMode: 'single_pass',
    exclusion: 'companion_identity_turn',
    exclusionRationale:
      'A deferred reflection template is the companion reflecting as itself; its '
      + 'content is companion material, not a process finding.',
  },
  {
    automatonClass: 'scheduler.free_time',
    adapterModule: 'src/app/agent/startup/free-time-lane.ts',
    busMode: 'single_pass',
    exclusion: 'companion_identity_turn',
    exclusionRationale:
      'Free time is the companion acting on its own initiative; worker notes must not '
      + 'enter that identity turn.',
  },
  {
    automatonClass: 'scheduler.automata_bus_reviewer',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
    exclusion: 'no_worker_model_loop',
    exclusionRationale:
      'Reviews Bus candidates through a strict structured decision schema and writes '
      + 'through governed mutation adapters, not the worker tool.',
  },
  {
    automatonClass: 'memory.biography_synthesis',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
    exclusion: 'person_data_boundary',
    exclusionRationale:
      'Mines subject-authorized memory silos for biography candidates; biography is '
      + 'person data the Bus must never carry.',
  },
  {
    automatonClass: 'memory.biography_review',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
    exclusion: 'person_data_boundary',
    exclusionRationale:
      'The companion decides biography candidates about itself and its relationships; '
      + 'biography is person data the Bus must never carry.',
  },
] as const satisfies readonly AutomataClassGovernedAdapter[];

/**
 * Call sites that open a governed run. A registered adapter module must contain
 * one of them, otherwise its class is registered but unreachable.
 */
export const AUTOMATA_GOVERNED_LIFECYCLE_ENTRYPOINTS: readonly string[] = [
  'runGovernedAutomataClass',
  'openAutomataBusWorkerRun',
];

/**
 * The handoff-only lifecycle serves exactly the declared `single_pass`
 * classes. A `bounded_loop` or unregistered class entering it would silently
 * lose the briefing and tool its policy promises, so it fails closed.
 */
export function requireSinglePassGovernedClass(automatonClass: ProductionAutomataClassId): void {
  const adapter = AUTOMATA_CLASS_GOVERNED_ADAPTERS.find(
    entry => entry.automatonClass === automatonClass,
  );
  if (!adapter) {
    throw new Error(`Automata class ${automatonClass} has no governed runtime adapter.`);
  }
  if (adapter.busMode !== 'single_pass') {
    throw new Error(
      `Automata class ${automatonClass} is declared ${adapter.busMode} and cannot run `
      + 'through the handoff-only governed lifecycle.',
    );
  }
}
