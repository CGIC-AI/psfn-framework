export const RUNTIME_LANE_CLASSES: {
  readonly foregroundChat: 'foreground_chat';
  readonly postTurnAppraisal: 'post_turn_appraisal';
  readonly backgroundContinuation: 'background_continuation';
  readonly maintenanceReflection: 'maintenance_reflection';
} = {
  foregroundChat: 'foreground_chat',
  postTurnAppraisal: 'post_turn_appraisal',
  backgroundContinuation: 'background_continuation',
  maintenanceReflection: 'maintenance_reflection',
};

export type RuntimeLaneClass = typeof RUNTIME_LANE_CLASSES[keyof typeof RUNTIME_LANE_CLASSES];
export type ForegroundChatRuntimeClass = typeof RUNTIME_LANE_CLASSES.foregroundChat;
export type PostTurnAppraisalRuntimeClass = typeof RUNTIME_LANE_CLASSES.postTurnAppraisal;
export type BackgroundContinuationRuntimeClass = typeof RUNTIME_LANE_CLASSES.backgroundContinuation;
export type MaintenanceReflectionRuntimeClass = typeof RUNTIME_LANE_CLASSES.maintenanceReflection;
