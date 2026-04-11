import type { WorkerExecutionPolicy, WorkerProfileClass } from '../types.js';

/**
 * Worker lanes are semantic runtime roles, not implementation shortcuts.
 *
 * Subagents are bounded task-focused workers.
 * Whisper is the internal metacognitive lane for self-directed appraisals,
 * reminders, and reflective notes.
 *
 * They stay separate so task delegation cannot accidentally reuse the whisper
 * path and so metacognitive work does not get mislabeled as subagent work.
 */
export const WORKER_LANES = {
  subagent: 'subagent',
  whisper: 'whisper',
} as const;

export type WorkerLane = typeof WORKER_LANES[keyof typeof WORKER_LANES];
export type SubagentWorkerLane = typeof WORKER_LANES.subagent;
export type WhisperWorkerLane = typeof WORKER_LANES.whisper;
export type TaskFocusedWorkerProfileClass = 'task_focused';
export type SubconsciousWorkerProfileClass = 'subconscious';

export const SUBAGENT_WORKER_LANE: SubagentWorkerLane = WORKER_LANES.subagent;
export const WHISPER_WORKER_LANE: WhisperWorkerLane = WORKER_LANES.whisper;
export const TASK_FOCUSED_WORKER_PROFILE_CLASS: TaskFocusedWorkerProfileClass = 'task_focused';
export const SUBCONSCIOUS_WORKER_PROFILE_CLASS: SubconsciousWorkerProfileClass = 'subconscious';

export function isSubagentWorkerLane(lane: WorkerLane): lane is SubagentWorkerLane {
  return lane === WORKER_LANES.subagent;
}

export function isWhisperWorkerLane(lane: WorkerLane): lane is WhisperWorkerLane {
  return lane === WORKER_LANES.whisper;
}

export function resolveWorkerProfileClassForLane(
  lane: WorkerLane,
): WorkerProfileClass {
  if (isSubagentWorkerLane(lane)) {
    return TASK_FOCUSED_WORKER_PROFILE_CLASS;
  }
  return SUBCONSCIOUS_WORKER_PROFILE_CLASS;
}

export function createWorkerExecutionPolicy(
  lane: WorkerLane,
): WorkerExecutionPolicy {
  if (isSubagentWorkerLane(lane)) {
    return {
      lane,
      profileClass: TASK_FOCUSED_WORKER_PROFILE_CLASS,
      modelPurpose: 'background',
      failClosed: true,
    };
  }

  return {
    lane,
    profileClass: SUBCONSCIOUS_WORKER_PROFILE_CLASS,
    modelPurpose: 'memory',
    failClosed: true,
  };
}
