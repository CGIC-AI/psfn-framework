import type { ChargePolicyRuntimeLane } from '../../system/config/charge-policy-config.js';
import type {
  CompletionPurpose,
  ObservabilityCallType,
  ModelPurpose,
} from '../../shared/contracts/runtime.js';

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
export type WorkerProfileClass = TaskFocusedWorkerProfileClass | SubconsciousWorkerProfileClass;

export interface WorkerExecutionPolicy {
  lane: WorkerLane;
  profileClass: WorkerProfileClass;
  modelPurpose: ModelPurpose;
  failClosed: boolean;
}

export const SUBAGENT_WORKER_LANE: SubagentWorkerLane = WORKER_LANES.subagent;
export const WHISPER_WORKER_LANE: WhisperWorkerLane = WORKER_LANES.whisper;
export const TASK_FOCUSED_WORKER_PROFILE_CLASS: TaskFocusedWorkerProfileClass = 'task_focused';
export const SUBCONSCIOUS_WORKER_PROFILE_CLASS: SubconsciousWorkerProfileClass = 'subconscious';

/**
 * Runtime classes describe how the live scheduler should treat cognitive work.
 *
 * They are intentionally broader than worker lanes:
 * - worker lanes classify dedicated worker identities like subagents/whisper
 * - runtime classes classify foreground and background cognition across the main runtime
 */
export const RUNTIME_LANE_CLASSES = {
  foregroundChat: 'foreground_chat',
  postTurnAppraisal: 'post_turn_appraisal',
  backgroundContinuation: 'background_continuation',
  maintenanceReflection: 'maintenance_reflection',
} as const;

export type RuntimeLaneClass = typeof RUNTIME_LANE_CLASSES[keyof typeof RUNTIME_LANE_CLASSES];
export type ForegroundChatRuntimeClass = typeof RUNTIME_LANE_CLASSES.foregroundChat;
export type PostTurnAppraisalRuntimeClass = typeof RUNTIME_LANE_CLASSES.postTurnAppraisal;
export type BackgroundContinuationRuntimeClass = typeof RUNTIME_LANE_CLASSES.backgroundContinuation;
export type MaintenanceReflectionRuntimeClass = typeof RUNTIME_LANE_CLASSES.maintenanceReflection;
export type ModelCallRuntimePurpose = CompletionPurpose | ModelPurpose | 'chat';

export const FOREGROUND_CHAT_RUNTIME_CLASS: ForegroundChatRuntimeClass = RUNTIME_LANE_CLASSES.foregroundChat;
export const POST_TURN_APPRAISAL_RUNTIME_CLASS: PostTurnAppraisalRuntimeClass = (
  RUNTIME_LANE_CLASSES.postTurnAppraisal
);
export const BACKGROUND_CONTINUATION_RUNTIME_CLASS: BackgroundContinuationRuntimeClass = (
  RUNTIME_LANE_CLASSES.backgroundContinuation
);
export const MAINTENANCE_REFLECTION_RUNTIME_CLASS: MaintenanceReflectionRuntimeClass = (
  RUNTIME_LANE_CLASSES.maintenanceReflection
);
const MAINTENANCE_REFLECTION_ORIGIN_STAGE_PREFIXES = [
  'heartbeat.deliberation',
  'reflection.deliberation',
] as const;

export interface RuntimeLaneBudgetProfile {
  runtimeClass: RuntimeLaneClass;
  priority: number;
  chargeLane: ChargePolicyRuntimeLane;
  modelPurpose: ModelPurpose;
  maxQueuedActions: number;
  maxRunsPerSchedulerTick: number;
  maxPendingSessionDeliveries: number;
  maxDeliveriesPerForegroundTurn: number;
  requiresForegroundIdle: boolean;
  degradationMode:
    | 'preserve_foreground'
    | 'drop_oldest_queued'
    | 'deliver_on_next_foreground_turn'
    | 'defer_until_idle';
}

const RUNTIME_LANE_BUDGET_PROFILES: Record<RuntimeLaneClass, RuntimeLaneBudgetProfile> = {
  [FOREGROUND_CHAT_RUNTIME_CLASS]: {
    runtimeClass: FOREGROUND_CHAT_RUNTIME_CLASS,
    priority: 0,
    chargeLane: 'interactive',
    modelPurpose: 'chat',
    maxQueuedActions: 0,
    maxRunsPerSchedulerTick: 0,
    maxPendingSessionDeliveries: 0,
    maxDeliveriesPerForegroundTurn: 0,
    requiresForegroundIdle: false,
    degradationMode: 'preserve_foreground',
  },
  [POST_TURN_APPRAISAL_RUNTIME_CLASS]: {
    runtimeClass: POST_TURN_APPRAISAL_RUNTIME_CLASS,
    priority: 1,
    chargeLane: 'background',
    modelPurpose: 'background',
    maxQueuedActions: 12,
    maxRunsPerSchedulerTick: 2,
    maxPendingSessionDeliveries: 0,
    maxDeliveriesPerForegroundTurn: 0,
    requiresForegroundIdle: false,
    degradationMode: 'drop_oldest_queued',
  },
  [BACKGROUND_CONTINUATION_RUNTIME_CLASS]: {
    runtimeClass: BACKGROUND_CONTINUATION_RUNTIME_CLASS,
    priority: 2,
    chargeLane: 'background',
    modelPurpose: 'background',
    maxQueuedActions: 4,
    maxRunsPerSchedulerTick: 1,
    maxPendingSessionDeliveries: 2,
    maxDeliveriesPerForegroundTurn: 1,
    requiresForegroundIdle: false,
    degradationMode: 'deliver_on_next_foreground_turn',
  },
  [MAINTENANCE_REFLECTION_RUNTIME_CLASS]: {
    runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
    priority: 3,
    chargeLane: 'maintenance',
    modelPurpose: 'memory',
    maxQueuedActions: 3,
    maxRunsPerSchedulerTick: 1,
    maxPendingSessionDeliveries: 0,
    maxDeliveriesPerForegroundTurn: 0,
    requiresForegroundIdle: true,
    degradationMode: 'defer_until_idle',
  },
};

export function isSubagentWorkerLane(lane: WorkerLane): lane is SubagentWorkerLane {
  return lane === WORKER_LANES.subagent;
}

export function isWhisperWorkerLane(lane: WorkerLane): lane is WhisperWorkerLane {
  return lane === WORKER_LANES.whisper;
}

export function isRuntimeLaneClass(value: string): value is RuntimeLaneClass {
  return Object.values(RUNTIME_LANE_CLASSES).includes(value as RuntimeLaneClass);
}

export function resolveRuntimeLaneBudgetProfile(
  runtimeClass: RuntimeLaneClass,
): RuntimeLaneBudgetProfile {
  return RUNTIME_LANE_BUDGET_PROFILES[runtimeClass];
}

export function compareRuntimeLanePriority(
  left: RuntimeLaneClass,
  right: RuntimeLaneClass,
): number {
  return resolveRuntimeLaneBudgetProfile(left).priority - resolveRuntimeLaneBudgetProfile(right).priority;
}

export function resolveRuntimeLaneClassForTurn(input: {
  callType: ObservabilityCallType;
  channelId: string;
  taskKind?: string;
  deferredContinuationId?: string | null;
}): RuntimeLaneClass {
  if (input.callType === 'background' || input.deferredContinuationId) {
    return BACKGROUND_CONTINUATION_RUNTIME_CLASS;
  }
  if (
    input.callType === 'scheduled'
    || input.taskKind === 'heartbeat'
    || input.taskKind === 'reflection'
    || input.channelId === 'internal:heartbeat'
    || input.channelId.startsWith('internal:heartbeat:')
    || input.channelId.startsWith('internal:reflection:')
  ) {
    return MAINTENANCE_REFLECTION_RUNTIME_CLASS;
  }
  return FOREGROUND_CHAT_RUNTIME_CLASS;
}

export function resolveRuntimeLaneClassForModelCall(input: {
  purpose: ModelCallRuntimePurpose;
  callType: ObservabilityCallType;
  channelId?: string;
  originStage?: string;
}): RuntimeLaneClass {
  const originStage = input.originStage?.trim() ?? '';
  if (input.purpose === 'chat' || input.callType === 'chat' || input.callType === 'tool') {
    return FOREGROUND_CHAT_RUNTIME_CLASS;
  }
  if (
    input.callType === 'scheduled'
    || input.purpose === 'memory'
    || input.purpose === 'extraction'
    || input.channelId === 'internal:heartbeat'
    || input.channelId?.startsWith('internal:heartbeat:')
    || input.channelId?.startsWith('internal:reflection:')
    || MAINTENANCE_REFLECTION_ORIGIN_STAGE_PREFIXES.some(prefix => originStage.startsWith(prefix))
    || originStage === 'heartbeat.run_template'
    || originStage === 'memory.sleeptime.run'
  ) {
    return MAINTENANCE_REFLECTION_RUNTIME_CLASS;
  }
  if (
    input.callType === 'summary'
    || input.purpose === 'summary'
    || originStage === 'intention.follow_up'
  ) {
    return POST_TURN_APPRAISAL_RUNTIME_CLASS;
  }
  if (originStage === 'tool_handoff.continue') {
    return BACKGROUND_CONTINUATION_RUNTIME_CLASS;
  }
  return BACKGROUND_CONTINUATION_RUNTIME_CLASS;
}

export function resolveRuntimeLaneClassForPostTurnActionKind(
  actionKind: string,
): RuntimeLaneClass {
  const normalized = actionKind.trim();
  if (!normalized) {
    return POST_TURN_APPRAISAL_RUNTIME_CLASS;
  }
  if (normalized === 'tool_handoff.continue') {
    return BACKGROUND_CONTINUATION_RUNTIME_CLASS;
  }
  if (
    normalized === 'heartbeat.run_template'
    || normalized === 'memory.sleeptime.run'
    || normalized === 'memory.near-turn.run'
    || normalized === 'memory.episode-synthesis.run'
  ) {
    return MAINTENANCE_REFLECTION_RUNTIME_CLASS;
  }
  return POST_TURN_APPRAISAL_RUNTIME_CLASS;
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
