import type { ProductionAutomataClassId } from './registry-contract.js';

export interface ProductionAutomataSpawnPath {
  id: string;
  classId: ProductionAutomataClassId;
  sourcePath: string;
  workerSymbol?: string;
  launchMarker?: 'queueMicrotask';
}

/**
 * Reviewable inventory of production cognitive-worker launch paths. The
 * conformance test scans worker constructors and detached Faculty launches so
 * a new automaton cannot enter production without a canonical class.
 */
export const PRODUCTION_AUTOMATA_SPAWN_PATHS = [
  {
    id: 'subagent-tool-and-post-turn',
    classId: 'subagent.bounded',
    sourcePath: 'src/faculties/subagents/faculty.ts',
    launchMarker: 'queueMicrotask',
  },
  {
    id: 'shard-execution-port',
    classId: 'shard.long_horizon',
    sourcePath: 'src/app/startup/composition/composition.ts',
  },
  {
    id: 'foreground-memory-retrieval',
    classId: 'memory.retrieval',
    sourcePath: 'src/faculties/memory/runtime-wiring.ts',
  },
  {
    id: 'background-memory-extraction',
    classId: 'memory.extraction',
    sourcePath: 'src/core/agent/background-work/types.ts',
  },
  {
    id: 'sleeptime-memory-agent',
    classId: 'memory.sleeptime',
    sourcePath: 'src/core/scheduler/post-turn-runtime/scheduler-lanes.ts',
  },
  {
    id: 'social-graph-builder-worker',
    classId: 'memory.social_graph_builder',
    sourcePath: 'src/app/agent/scheduler-runtime.ts',
    workerSymbol: 'SocialGraphBuilderWorker',
  },
  {
    id: 'concern-candidate-worker',
    classId: 'intention.concern_candidate_review',
    sourcePath: 'src/core/intention/concern-candidates.ts',
    workerSymbol: 'ConcernCandidateWorker',
  },
  {
    id: 'background-intention-hooks',
    classId: 'background.intention_post_turn_hooks',
    sourcePath: 'src/core/agent/background-work/types.ts',
  },
  {
    id: 'background-emotion-appraisal',
    classId: 'background.emotion_appraisal',
    sourcePath: 'src/core/agent/background-work/types.ts',
  },
  {
    id: 'background-auto-compaction',
    classId: 'background.auto_compaction',
    sourcePath: 'src/core/agent/background-work/types.ts',
  },
  {
    id: 'post-turn-subagent-spawn-action',
    classId: 'post_turn.subagent_spawn',
    sourcePath: 'src/core/agent/post-turn-action-runtime.ts',
  },
  {
    id: 'deferred-reflection-template',
    classId: 'scheduler.reflection',
    sourcePath: 'src/core/scheduler/post-turn-runtime.ts',
  },
  {
    id: 'free-time-lane',
    classId: 'scheduler.free_time',
    sourcePath: 'src/app/agent/startup/free-time-lane.ts',
  },
  {
    id: 'automata-bus-reviewer',
    classId: 'scheduler.automata_bus_reviewer',
    sourcePath: 'src/app/agent/scheduler-runtime.ts',
  },
] as const satisfies readonly ProductionAutomataSpawnPath[];
