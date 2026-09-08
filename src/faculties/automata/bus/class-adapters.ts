import type { ProductionAutomataClassId } from '../registry-contract.js';

/**
 * How a governed class uses the Bus once its run is open.
 *
 * `single_pass` classes leave the deterministic terminal handoff the wrapper
 * records for them and nothing else; their work is one bounded pass with no
 * model turn that could usefully search or append mid-run. `bounded_loop`
 * classes additionally carry the governed `automata_bus` tool into their own
 * already-bounded agent turns. Neither mode owns a turn budget: the class's
 * existing worker logic still bounds its own model calls.
 */
type AutomataClassBusMode = 'single_pass' | 'bounded_loop';

/**
 * The runtime adapter that opens one eligible class's governed run.
 *
 * Registration alone is not coverage: `automata-certification` proves that the
 * named module exists and actually opens the governed lifecycle, so an eligible
 * class can never claim Bus participation it has no code path for.
 */
export interface AutomataClassGovernedAdapter {
  automatonClass: ProductionAutomataClassId;
  /** Module that opens this class's governed Bus run. */
  adapterModule: string;
  busMode: AutomataClassBusMode;
}

export const AUTOMATA_CLASS_GOVERNED_ADAPTERS = [
  {
    automatonClass: 'subagent.bounded',
    adapterModule: 'src/faculties/subagents/faculty.ts',
    busMode: 'bounded_loop',
  },
  {
    // Same faculty and same governed lifecycle as an ordinary bounded subagent;
    // the trusted post-turn spawn origin selects this class instead.
    automatonClass: 'post_turn.subagent_spawn',
    adapterModule: 'src/faculties/subagents/faculty.ts',
    busMode: 'bounded_loop',
  },
  {
    automatonClass: 'memory.extraction',
    adapterModule: 'src/faculties/memory/extraction/orchestrator.ts',
    busMode: 'bounded_loop',
  },
  {
    automatonClass: 'shard.long_horizon',
    adapterModule: 'src/faculties/shards/manager.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'memory.sleeptime',
    adapterModule: 'src/core/scheduler/post-turn-runtime/scheduler-lanes.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'memory.social_graph_builder',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'intention.concern_candidate_review',
    adapterModule: 'src/core/intention/concern-candidates.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'background.intention_post_turn_hooks',
    adapterModule: 'src/app/agent/automata-background-work-lifecycle.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'scheduler.reflection',
    adapterModule: 'src/core/scheduler/post-turn-runtime.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'scheduler.free_time',
    adapterModule: 'src/app/agent/startup/free-time-lane.ts',
    busMode: 'single_pass',
  },
  {
    automatonClass: 'scheduler.automata_bus_reviewer',
    adapterModule: 'src/app/agent/scheduler-runtime.ts',
    busMode: 'single_pass',
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
